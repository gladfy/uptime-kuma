const fs = require("fs");

/** Pipeline sources a project can come from. */
const PIPELINE_SOURCES = ["bitbucket", "github"];

/** A Kubernetes namespace or Helm release name (DNS-1123 label, dots allowed in releases). */
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const RELEASE_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/**
 * Fields of a project's pipeline. All present (a pipeline on Bitbucket or GitHub) or all absent (a
 * repository on CodeCommit or an infrastructure chart: the rollout only).
 */
const PIPELINE_FIELDS = ["source", "repo", "branch"];

/**
 * A GitHub workflow file. Other workflows run on the same push (tests, CodeQL), and a failing test
 * must not paint the deploy as failed: when set, only this one counts.
 */
const WORKFLOW_RE = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;

/** owner/name, as Bitbucket and GitHub write it. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** AWS region, e.g. us-east-1. */
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** What the footer and the card call a cluster: short, it goes beside a release name. */
const LABEL_MAX = 20;

/**
 * Validate the parsed configuration file of the deploy board.
 *
 * Every error names the field, because whoever reads it is looking at a ConfigMap and needs to know
 * which line to fix.
 * @param {any} raw Parsed JSON.
 * @returns {{config: object|null, error: string|null}} Normalized config, or the first error.
 */
function validateDeployBoardConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return fail("the root must be an object");
    }

    if (!Array.isArray(raw.namespaces) || raw.namespaces.length === 0) {
        return fail("namespaces: expected a non-empty list");
    }
    for (let i = 0; i < raw.namespaces.length; i++) {
        if (typeof raw.namespaces[i] !== "string" || !NAMESPACE_RE.test(raw.namespaces[i])) {
            return fail(`namespaces[${i}]: not a valid namespace name`);
        }
    }
    const namespaces = [...new Set(raw.namespaces)];

    // Clusters besides the one the pod runs in. Their releases are "<cluster>:<namespace>/<release>".
    const clustersRaw = raw.clusters === undefined ? [] : raw.clusters;
    if (!Array.isArray(clustersRaw)) {
        return fail("clusters: expected a list");
    }
    const clusters = [];
    for (let i = 0; i < clustersRaw.length; i++) {
        const c = clustersRaw[i];
        const at = `clusters[${i}]`;
        if (!c || typeof c !== "object" || Array.isArray(c)) {
            return fail(`${at}: expected an object`);
        }
        if (typeof c.name !== "string" || !NAMESPACE_RE.test(c.name)) {
            return fail(`${at}.name: expected a lowercase name, e.g. "oci"`);
        }
        if (clusters.some((other) => other.name === c.name)) {
            return fail(`${at}.name: "${c.name}" is repeated`);
        }
        if (
            c.label !== undefined &&
            (typeof c.label !== "string" || c.label.trim() === "" || c.label.length > LABEL_MAX)
        ) {
            return fail(`${at}.label: expected a text of up to ${LABEL_MAX} characters`);
        }
        if (!Array.isArray(c.namespaces) || c.namespaces.length === 0) {
            return fail(`${at}.namespaces: expected a non-empty list`);
        }
        for (let j = 0; j < c.namespaces.length; j++) {
            if (typeof c.namespaces[j] !== "string" || !NAMESPACE_RE.test(c.namespaces[j])) {
                return fail(`${at}.namespaces[${j}]: not a valid namespace name`);
            }
        }
        clusters.push({
            name: c.name,
            label: c.label === undefined ? c.name.toUpperCase() : c.label.trim(),
            namespaces: [...new Set(c.namespaces)],
        });
    }

    const projectsRaw = raw.projects === undefined ? [] : raw.projects;
    if (!Array.isArray(projectsRaw)) {
        return fail("projects: expected a list");
    }

    const projects = [];
    const names = new Set();
    for (let i = 0; i < projectsRaw.length; i++) {
        const p = projectsRaw[i];
        const at = `projects[${i}]`;

        if (!p || typeof p !== "object" || Array.isArray(p)) {
            return fail(`${at}: expected an object`);
        }
        if (typeof p.name !== "string" || p.name.trim() === "") {
            return fail(`${at}.name: expected a non-empty text`);
        }
        if (names.has(p.name)) {
            return fail(`${at}.name: "${p.name}" is repeated`);
        }
        names.add(p.name);
        const present = PIPELINE_FIELDS.filter((f) => p[f] !== undefined);
        if (present.length > 0) {
            // Part of them is almost always a typo, and would leave the webhook never matching.
            const missing = PIPELINE_FIELDS.find((f) => p[f] === undefined);
            if (missing) {
                return fail(
                    `${at}.${missing}: required with ${present.join(" and ")} (source, repo and branch go together)`
                );
            }
            if (!PIPELINE_SOURCES.includes(p.source)) {
                return fail(`${at}.source: expected one of ${PIPELINE_SOURCES.join(", ")}`);
            }
            if (typeof p.repo !== "string" || !REPO_RE.test(p.repo)) {
                return fail(`${at}.repo: expected "<owner>/<name>"`);
            }
            if (typeof p.branch !== "string" || p.branch.trim() === "") {
                return fail(`${at}.branch: expected a non-empty text`);
            }
        }
        if (p.workflow !== undefined) {
            if (p.source !== "github") {
                return fail(`${at}.workflow: only for source github`);
            }
            if (typeof p.workflow !== "string" || !WORKFLOW_RE.test(p.workflow)) {
                return fail(`${at}.workflow: expected ".github/workflows/<file>.yml"`);
            }
        }
        if (!Array.isArray(p.releases)) {
            return fail(`${at}.releases: expected a list`);
        }

        const releases = [];
        for (let j = 0; j < p.releases.length; j++) {
            const ref = p.releases[j];
            const parsed = typeof ref === "string" ? parseReleaseRef(ref) : null;
            if (!parsed || !NAMESPACE_RE.test(parsed.namespace) || !RELEASE_RE.test(parsed.release)) {
                return fail(
                    `${at}.releases[${j}]: expected "<namespace>/<release>" or "<cluster>:<namespace>/<release>"`
                );
            }
            const cluster = parsed.cluster === null ? null : clusters.find((c) => c.name === parsed.cluster);
            if (cluster === undefined) {
                return fail(`${at}.releases[${j}]: cluster "${parsed.cluster}" is not in clusters`);
            }
            // A release in a namespace nobody watches would never show a rollout, silently.
            if (!(cluster ? cluster.namespaces : namespaces).includes(parsed.namespace)) {
                const list = cluster ? `clusters "${cluster.name}" namespaces` : "namespaces";
                return fail(`${at}.releases[${j}]: namespace "${parsed.namespace}" is not in ${list}`);
            }
            releases.push(parsed);
        }

        projects.push({
            name: p.name,
            source: p.source ?? null,
            repo: p.repo ?? null,
            branch: p.branch ?? null,
            workflow: p.workflow ?? null,
            releases,
        });
    }

    let amplify = null;
    if (raw.amplify !== undefined) {
        if (!raw.amplify || typeof raw.amplify !== "object" || Array.isArray(raw.amplify)) {
            return fail("amplify: expected an object");
        }
        if (typeof raw.amplify.region !== "string" || !REGION_RE.test(raw.amplify.region)) {
            return fail("amplify.region: expected an AWS region, e.g. us-east-1");
        }
        amplify = { region: raw.amplify.region };
    }

    return {
        config: { namespaces, clusters, projects, amplify },
        error: null,
    };
}

/**
 * @param {string} ref "<namespace>/<release>" (the cluster the pod runs in) or
 * "<cluster>:<namespace>/<release>", as the configuration and the "deploy" tag of the monitors write it.
 * @returns {{cluster: string|null, namespace: string, release: string}|null} Its parts, or null when
 * it has neither form.
 */
function parseReleaseRef(ref) {
    const match = /^(?:([^:/]+):)?([^:/]+)\/([^:/]+)$/.exec(ref);
    return match ? { cluster: match[1] ?? null, namespace: match[2], release: match[3] } : null;
}

/**
 * @param {{cluster?: string|null, namespace: string, release: string}} r Release.
 * @returns {string} How the configuration and the monitor tags write it (see parseReleaseRef).
 */
function releaseRef(r) {
    return `${r.cluster ? `${r.cluster}:` : ""}${r.namespace}/${r.release}`;
}

/**
 * Read the configuration file named by DEPLOY_BOARD_CONFIG.
 *
 * Never throws: a broken file must not keep Kuma from booting. The caller turns `status` into
 * "every deploy source off" and logs `error`.
 * @param {object} env Environment (process.env by default).
 * @returns {{status: "missing"|"invalid"|"ok", path: string|null, config: object|null, error: string|null}} Result.
 */
function loadDeployBoardConfig(env = process.env) {
    const path = env.DEPLOY_BOARD_CONFIG || null;
    if (!path) {
        return { status: "missing", path: null, config: null, error: null };
    }

    let text;
    try {
        text = fs.readFileSync(path, "utf8");
    } catch (e) {
        return {
            status: "invalid",
            path,
            config: null,
            error: `${path}: cannot read the file (${e.code || e.message})`,
        };
    }

    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return { status: "invalid", path, config: null, error: `${path}: invalid JSON (${e.message})` };
    }

    const { config, error } = validateDeployBoardConfig(raw);
    if (error) {
        return { status: "invalid", path, config: null, error: `${path}: ${error}` };
    }
    return { status: "ok", path, config, error: null };
}

/**
 * @param {string} message Error message.
 * @returns {{config: null, error: string}} Failed validation.
 */
function fail(message) {
    return { config: null, error: message };
}

module.exports = {
    PIPELINE_SOURCES,
    validateDeployBoardConfig,
    loadDeployBoardConfig,
    parseReleaseRef,
    releaseRef,
};
