/** The deploy sources the server reads. Kuma itself is read by the browser, not here. */
const SOURCE_IDS = ["cluster", "bitbucket", "github", "amplify"];

/**
 * Situation of a source:
 * - unconfigured: nothing to read from (no config, no credential); never an alarm;
 * - active: reading normally;
 * - stale: configured, but the last read failed or is too old; the screen must not vouch for it.
 */
const SOURCE_STATES = ["unconfigured", "active", "stale"];

/** At most one broadcast per this many milliseconds. */
const EMIT_INTERVAL_MS = 1000;

/**
 * Fields of a deploy, and of a history entry, that may reach the browser. Anything else stays on
 * the server, so a field added to the internal record never leaks by default.
 */
const DEPLOY_PUBLIC_FIELDS = ["id", "project", "version", "label", "state", "startedAt", "endedAt", "confirmed", "releases"];
const HISTORY_PUBLIC_FIELDS = ["id", "project", "version", "outcome", "startedAt", "endedAt", "releases"];

/** A finished deploy stays on screen this long before going to the history. */
const DONE_VISIBLE_MS = 10 * 60 * 1000;

/** The history keeps the last 24 hours, and never more than this many entries. */
const HISTORY_MS = 24 * 60 * 60 * 1000;
const HISTORY_MAX = 500;

/**
 * Rollouts of the same project without a commit in the image tag (the chat's "prod") are one deploy
 * while they start this close to the first one.
 */
const GROUP_WINDOW_MS = 20 * 60 * 1000;

/** How often the store checks what is due to leave the screen. */
const TICK_MS = 30 * 1000;

/** Order of the cards: what needs attention first. */
const STATE_ORDER = ["stuck", "noProgress", "updating", "done"];

/** Label of the card for each rollout state. */
const STATE_LABELS = {
    updating: "rolling",
    noProgress: "noProgress",
    stuck: "stuck",
    done: "live",
    superseded: "replaced",
};

/** An image tag that is a commit: the full SHA or a prefix of it. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * In-memory state of the deploy board, and the single place the browser payload is built from.
 */
class DeployBoardStore {
    /**
     * @param {object} options Options.
     * @param {Function} options.now Clock, in milliseconds (injectable for tests).
     * @param {number} options.emitIntervalMs Minimum time between broadcasts.
     */
    constructor({ now = () => Date.now(), emitIntervalMs = EMIT_INTERVAL_MS } = {}) {
        this.now = now;
        this.emitIntervalMs = emitIntervalMs;
        this.sources = {};
        for (const id of SOURCE_IDS) {
            this.sources[id] = { state: "unconfigured", lastDataAt: null, detail: null };
        }
        this.deploys = [];
        this.history = [];
        this.projectOfRelease = new Map();
        this.staleNamespaces = new Set();
        this.lastDoneStartedAt = new Map();
        this.sequence = 0;
        this.listeners = new Set();
        this.lastEmitAt = null;
        this.emitTimer = null;
        this.tickTimer = null;
    }

    /**
     * Set the situation of a source.
     * @param {string} id Source id.
     * @param {string} state One of SOURCE_STATES.
     * @param {string|null} detail Short human-readable reason (e.g. which namespace was denied).
     * @returns {void}
     * @throws {Error} Unknown source or state.
     */
    setSource(id, state, detail = null) {
        const source = this.requireSource(id);
        if (!SOURCE_STATES.includes(state)) {
            throw new Error(`Unknown source state: ${state}`);
        }
        if (source.state === state && source.detail === detail) {
            return;
        }
        source.state = state;
        source.detail = detail;
        this.changed();
    }

    /**
     * Record that a source delivered data now. A stale source becomes active again.
     * @param {string} id Source id.
     * @returns {void}
     */
    markData(id) {
        const source = this.requireSource(id);
        source.lastDataAt = this.now();
        if (source.state === "stale") {
            source.state = "active";
            source.detail = null;
        }
        this.changed();
    }

    /**
     * Which project each release belongs to, from the configuration. A rollout of a release outside
     * every project is not shown.
     * @param {object[]} projects Normalized `projects` of the configuration.
     * @returns {void}
     */
    setProjects(projects) {
        this.projectOfRelease.clear();
        for (const project of projects) {
            for (const r of project.releases) {
                this.projectOfRelease.set(`${r.namespace}/${r.release}`, { name: project.name, source: project.source });
            }
        }
    }

    /**
     * Namespaces whose rollout state cannot be vouched for (denied or not answering).
     * @param {string[]} namespaces Namespaces.
     * @returns {void}
     */
    setStaleNamespaces(namespaces) {
        const next = new Set(namespaces);
        if (next.size === this.staleNamespaces.size && [...next].every((ns) => this.staleNamespaces.has(ns))) {
            return;
        }
        this.staleNamespaces = next;
        this.changed();
    }

    /**
     * A rollout from the cluster tracker, new or updated. It joins the deploy of its project with the
     * same commit in the image tag; without a commit, the open deploy of the project started up to
     * GROUP_WINDOW_MS earlier; otherwise it starts a deploy of its own.
     * @param {object} rollout Rollout as published by ClusterTracker.
     * @returns {void}
     */
    upsertRollout(rollout) {
        const project = this.projectOfRelease.get(`${rollout.namespace}/${rollout.release}`);
        if (!project) {
            return;
        }
        let deploy = this.deploys.find((d) => d.rollouts.has(rollout.id));
        if (!deploy) {
            deploy = this.deployFor(project, rollout);
        }
        deploy.rollouts.set(rollout.id, { ...rollout });
        refresh(deploy);
        if (deploy.state === "done") {
            const last = this.lastDoneStartedAt.get(project.name) ?? -Infinity;
            this.lastDoneStartedAt.set(project.name, Math.max(last, deploy.startedAt));
        }
        this.settle();
        this.changed();
    }

    /**
     * Move what is due to the history: finished deploys after DONE_VISIBLE_MS, replaced rollouts at
     * once, and stuck deploys once a later deploy of the same project finished. Called on every
     * change and by a timer, since leaving the screen is a matter of time.
     * @returns {void}
     */
    tick() {
        if (this.settle()) {
            this.changed();
        }
    }

    /**
     * Run tick() every TICK_MS until close().
     * @param {number} ms Interval.
     * @returns {void}
     */
    startTicking(ms = TICK_MS) {
        if (!this.tickTimer) {
            this.tickTimer = setInterval(() => this.tick(), ms);
        }
    }

    /**
     * The payload sent to the browser. Built field by field on purpose.
     * @returns {object} Snapshot.
     */
    snapshot() {
        const sources = {};
        for (const id of SOURCE_IDS) {
            const s = this.sources[id];
            sources[id] = { state: s.state, lastDataAt: s.lastDataAt, detail: s.detail };
        }
        const deploys = [...this.deploys]
            .sort(
                (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.startedAt - a.startedAt
            )
            .map((d) => pickPublic(this.publicDeploy(d), DEPLOY_PUBLIC_FIELDS));
        return {
            generatedAt: this.now(),
            sources,
            deploys,
            history: this.history.map((h) => pickPublic(h, HISTORY_PUBLIC_FIELDS)),
        };
    }

    /**
     * @param {object} deploy Internal deploy.
     * @returns {object} Deploy with its derived fields: label, confirmation, release lines.
     */
    publicDeploy(deploy) {
        // A project without a pipeline source has nothing to match a rollout against: never "no pipeline".
        const pipelineConfigured =
            deploy.pipelineSource !== null && this.sources[deploy.pipelineSource]?.state !== "unconfigured";
        const cluster = this.sources.cluster.state;
        const rollouts = liveRollouts(deploy);
        return {
            id: deploy.id,
            project: deploy.project,
            version: deploy.version,
            state: deploy.state,
            label: deployLabel(deploy.state, { pipelineConfigured, hasPipeline: false }),
            startedAt: deploy.startedAt,
            endedAt: deploy.endedAt,
            confirmed:
                cluster === "active" ||
                (cluster === "stale" &&
                    this.staleNamespaces.size > 0 &&
                    rollouts.every((r) => !this.staleNamespaces.has(r.namespace))),
            releases: rollouts.map((r) => ({
                namespace: r.namespace,
                release: r.release,
                state: r.state,
                updated: r.updated,
                desired: r.desired,
                cronJobsUpdated: r.cronJobsUpdated,
                atBoot: r.atBoot,
            })),
        };
    }

    /**
     * @param {{name: string, source: string}} project Project of the rollout.
     * @param {object} rollout Rollout.
     * @returns {object} The deploy the rollout belongs to (created when none fits).
     */
    deployFor(project, rollout) {
        const sha = shaOf(rollout.images);
        const sameRelease = (d) =>
            [...d.rollouts.values()].some((r) => r.namespace === rollout.namespace && r.release === rollout.release);
        const fits = (d) => {
            if (d.project !== project.name || sameRelease(d)) {
                return false;
            }
            if (sha) {
                return d.sha === sha;
            }
            return !d.sha && d.endedAt === null && rollout.startedAt - d.startedAt <= GROUP_WINDOW_MS;
        };

        let deploy = this.deploys.find(fits);
        if (!deploy) {
            deploy = {
                id: `${project.name}:${++this.sequence}`,
                project: project.name,
                pipelineSource: project.source,
                sha,
                version: sha ? sha.slice(0, 7) : rollout.images[0] || null,
                rollouts: new Map(),
                state: "updating",
                startedAt: rollout.startedAt,
                endedAt: null,
            };
            this.deploys.push(deploy);
        }
        return deploy;
    }

    /**
     * @returns {boolean} Whether anything moved.
     */
    settle() {
        const now = this.now();
        let moved = false;
        for (const deploy of [...this.deploys]) {
            let outcome = null;
            if (deploy.state === "superseded") {
                outcome = "replaced";
            } else if (deploy.state === "done" && now - deploy.endedAt >= DONE_VISIBLE_MS) {
                outcome = "done";
            } else if (deploy.state === "stuck" && (this.lastDoneStartedAt.get(deploy.project) ?? -Infinity) > deploy.startedAt) {
                outcome = "stuck";
            }
            if (outcome) {
                this.toHistory(deploy, outcome, now);
                moved = true;
            }
        }

        const before = this.history.length;
        this.history = this.history.filter((h) => now - h.endedAt < HISTORY_MS).slice(0, HISTORY_MAX);
        return moved || this.history.length !== before;
    }

    /**
     * @param {object} deploy Internal deploy.
     * @param {string} outcome "done", "stuck" or "replaced".
     * @param {number} now Current time.
     * @returns {void}
     */
    toHistory(deploy, outcome, now) {
        this.deploys.splice(this.deploys.indexOf(deploy), 1);
        this.history.unshift({
            id: deploy.id,
            project: deploy.project,
            version: deploy.version,
            outcome,
            startedAt: deploy.startedAt,
            endedAt: deploy.endedAt ?? now,
            releases: [...deploy.rollouts.values()].map((r) => ({ namespace: r.namespace, release: r.release })),
        });
    }

    /**
     * Subscribe to changes. The listener gets the snapshot, at most once per emit interval.
     * @param {Function} listener Called with the snapshot.
     * @returns {Function} Unsubscribe.
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Schedule a broadcast: right away if the last one is old enough, otherwise once at the end of
     * the interval, carrying everything that changed in between.
     * @returns {void}
     */
    changed() {
        if (this.emitTimer) {
            return;
        }
        const elapsed = this.lastEmitAt === null ? Infinity : this.now() - this.lastEmitAt;
        if (elapsed >= this.emitIntervalMs) {
            this.emit();
        } else {
            this.emitTimer = setTimeout(() => {
                this.emitTimer = null;
                this.emit();
            }, this.emitIntervalMs - elapsed);
        }
    }

    /**
     * Send the snapshot to every listener. A listener that throws does not stop the others.
     * @returns {void}
     */
    emit() {
        this.lastEmitAt = this.now();
        const snapshot = this.snapshot();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            } catch (e) {
                // Broadcasting is best effort; the next change sends the whole state again.
            }
        }
    }

    /**
     * Stop a pending broadcast (used on shutdown and in tests).
     * @returns {void}
     */
    close() {
        clearTimeout(this.emitTimer);
        clearInterval(this.tickTimer);
        this.emitTimer = null;
    }

    /**
     * @param {string} id Source id.
     * @returns {object} The source record.
     * @throws {Error} Unknown source.
     */
    requireSource(id) {
        const source = this.sources[id];
        if (!source) {
            throw new Error(`Unknown deploy source: ${id}`);
        }
        return source;
    }
}

/**
 * Label of a deploy card. "No pipeline" is only said when the pipeline source of the project is
 * being read: with the source off, a missing pipeline is a missing source, not a manual deploy.
 * @param {string} state Deploy state.
 * @param {object} options Options.
 * @param {boolean} options.pipelineConfigured Whether the project's pipeline source is configured.
 * @param {boolean} options.hasPipeline Whether a pipeline run was matched to the deploy.
 * @returns {string} Label id.
 */
function deployLabel(state, { pipelineConfigured, hasPipeline }) {
    if (pipelineConfigured && !hasPipeline) {
        return "noPipeline";
    }
    return STATE_LABELS[state];
}

/**
 * Recompute a deploy from its rollouts. A replaced rollout does not count while another of the
 * deploy is alive.
 * @param {object} deploy Internal deploy.
 * @returns {void}
 */
function refresh(deploy) {
    const all = [...deploy.rollouts.values()];
    const live = all.filter((r) => r.state !== "superseded");
    deploy.startedAt = Math.min(...all.map((r) => r.startedAt));
    if (live.length === 0) {
        deploy.state = "superseded";
        deploy.endedAt = Math.max(...all.map((r) => r.endedAt ?? r.startedAt));
        return;
    }
    deploy.state = STATE_ORDER.find((s) => live.some((r) => r.state === s)) || "done";
    deploy.endedAt = deploy.state === "done" ? Math.max(...live.map((r) => r.endedAt)) : null;
}

/**
 * @param {object} deploy Internal deploy.
 * @returns {object[]} Its rollouts that were not replaced, or all of them when every one was.
 */
function liveRollouts(deploy) {
    const all = [...deploy.rollouts.values()];
    const live = all.filter((r) => r.state !== "superseded");
    return live.length ? live : all;
}

/**
 * @param {string[]} images Image tags.
 * @returns {string|null} The first tag that is a commit.
 */
function shaOf(images) {
    return images.find((tag) => SHA_RE.test(tag)) || null;
}

/**
 * @param {object} record Internal record.
 * @param {string[]} fields Allowed fields.
 * @returns {object} Only the allowed fields.
 */
function pickPublic(record, fields) {
    const out = {};
    for (const field of fields) {
        if (record[field] !== undefined) {
            out[field] = record[field];
        }
    }
    return out;
}

module.exports = {
    SOURCE_IDS,
    SOURCE_STATES,
    EMIT_INTERVAL_MS,
    DEPLOY_PUBLIC_FIELDS,
    HISTORY_PUBLIC_FIELDS,
    DONE_VISIBLE_MS,
    HISTORY_MS,
    HISTORY_MAX,
    GROUP_WINDOW_MS,
    deployLabel,
    DeployBoardStore,
};
