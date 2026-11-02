/**
 * Bitbucket Cloud webhook payloads → the few facts the board keeps. Pure: no I/O, no clock.
 *
 * Only the fields of the spec leave: SHA, branch, the first line of the commit message, the state
 * and the link of a pipeline. Authors, file lists and the rest of the payload never do.
 */

/** Bitbucket commit status state → pipeline state of the board. */
const STATES = {
    INPROGRESS: "running",
    SUCCESSFUL: "success",
    FAILED: "failed",
    STOPPED: "stopped",
};

/** The first line of a commit message is cut here. */
const MESSAGE_MAX = 120;

/** A full commit hash. */
const HASH_RE = /^[0-9a-f]{40}$/;

/**
 * @param {any} value Commit message.
 * @returns {string} Its first line, at most MESSAGE_MAX characters.
 */
function firstLine(value) {
    const line = String(value || "")
        .split("\n")[0]
        .trim();
    return line.length > MESSAGE_MAX ? `${line.slice(0, MESSAGE_MAX - 1)}…` : line;
}

/**
 * @param {any} value Time from the payload.
 * @returns {number|null} In ms, or null when absent or unreadable.
 */
function timeOf(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {string} url Link from the payload.
 * @returns {string|null} The link, when it points to Bitbucket; anything else is not shown.
 */
function bitbucketLink(url) {
    return typeof url === "string" && url.startsWith("https://bitbucket.org/") ? url : null;
}

/**
 * @param {object} payload Webhook body.
 * @param {object[]} projects Normalized projects of the configuration.
 * @returns {object|null} The project of the repository, when it comes from Bitbucket.
 */
function projectOf(payload, projects) {
    const repo = String(payload?.repository?.full_name || "").toLowerCase();
    return projects.find((p) => p.source === "bitbucket" && p.repo.toLowerCase() === repo) || null;
}

/**
 * Read a Bitbucket webhook.
 * @param {string} eventKey X-Event-Key header ("repo:push", "repo:commit_status_updated"...).
 * @param {object} payload Parsed body.
 * @param {object[]} projects Normalized projects of the configuration.
 * @returns {{repo: string, events: object[]}} The repository (for the log) and what the board
 * keeps; no events when the repository or the branch is not configured.
 */
function parseBitbucket(eventKey, payload, projects) {
    const repo = String(payload?.repository?.full_name || "");
    const project = projectOf(payload, projects);
    if (!project) {
        return { repo, events: [] };
    }
    const events = [];

    if (eventKey === "repo:push") {
        for (const change of payload?.push?.changes || []) {
            const target = change?.new;
            // A deleted branch has no "new"; a tag is not a merge.
            if (target?.type !== "branch" || target.name !== project.branch) {
                continue;
            }
            const sha = String(target.target?.hash || "");
            if (!HASH_RE.test(sha)) {
                continue;
            }
            events.push({
                kind: "merge",
                source: "bitbucket",
                project: project.name,
                sha,
                message: firstLine(target.target?.message),
                at: timeOf(target.target?.date),
            });
        }
    } else if (eventKey === "repo:commit_status_created" || eventKey === "repo:commit_status_updated") {
        const status = payload?.commit_status || {};
        const state = STATES[status.state];
        // The hash is in commit.hash, or at the end of the link to the commit.
        const sha = String(
            status.commit?.hash ||
                String(status.links?.commit?.href || "")
                    .split("/")
                    .pop() ||
                ""
        );
        // A status without branch (refname) is only taken for a commit already merged into the branch.
        const branch = typeof status.refname === "string" && status.refname !== "" ? status.refname : null;
        if (state && HASH_RE.test(sha) && (branch === null || branch === project.branch)) {
            const ended = state !== "running";
            events.push({
                kind: "run",
                source: "bitbucket",
                project: project.name,
                sha,
                branchKnown: branch !== null,
                runId: String(status.key || status.name || "pipeline"),
                name: String(status.name || "").slice(0, MESSAGE_MAX),
                state,
                url: bitbucketLink(status.url),
                startedAt: timeOf(status.created_on),
                endedAt: ended ? timeOf(status.updated_on) : null,
            });
        }
    }
    return { repo, events };
}

module.exports = {
    MESSAGE_MAX,
    firstLine,
    timeOf,
    parseBitbucket,
};
