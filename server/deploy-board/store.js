const { releaseRollback } = require("./rollback");

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
const DEPLOY_PUBLIC_FIELDS = [
    "id",
    "project",
    "version",
    "label",
    "state",
    "startedAt",
    "endedAt",
    "missed",
    "confirmed",
    "releases",
    "rollback",
];
const HISTORY_PUBLIC_FIELDS = ["id", "project", "version", "outcome", "startedAt", "endedAt", "missed", "releases"];

/**
 * Fields of a rollout kept in a history record, which is also what goes to the database. Built field
 * by field, like the snapshot: whatever else the tracker attaches to a rollout stays out.
 */
const ROLLOUT_RECORD_FIELDS = [
    "id",
    "namespace",
    "release",
    "state",
    "updated",
    "desired",
    "cronJobsUpdated",
    "atBoot",
    "missed",
    "startedAt",
    "endedAt",
    "images",
    "deployments",
    "before",
];

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

/** Counters of the last HISTORY_MS, as the header shows them. Nothing else leaves in `stats`. */
const STATS_FIELDS = ["total", "done", "stuck", "failed", "replaced", "inProgress", "successRate"];

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

/** Deploy states with a "how to go back" on the card. */
const ROLLBACK_STATES = ["done", "stuck"];

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
     * @param {Function|null} options.persist Called with the record of a deploy whenever it ends.
     */
    constructor({ now = () => Date.now(), emitIntervalMs = EMIT_INTERVAL_MS, persist = null } = {}) {
        this.now = now;
        this.emitIntervalMs = emitIntervalMs;
        this.persist = persist;
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
        const wasEnded = deploy.endedAt !== null;
        deploy.rollouts.set(rollout.id, { ...rollout });
        refresh(deploy);
        if (deploy.state === "done") {
            const last = this.lastDoneStartedAt.get(project.name) ?? -Infinity;
            this.lastDoneStartedAt.set(project.name, Math.max(last, deploy.startedAt));
        }
        // Saved as it ends, not only as it leaves the screen: a restart in those 10 minutes would lose it.
        if (!wasEnded && deploy.endedAt !== null) {
            this.save(recordOf(deploy, deploy.state === "superseded" ? "replaced" : "done", deploy.endedAt));
        }
        this.settle();
        this.changed();
    }

    /**
     * Put back the history read from the database at boot, before the cluster is read, so that the
     * first rollout can already join a deploy loaded here.
     * @param {object[]} records History records, as saved.
     * @returns {void}
     */
    restore(records) {
        const now = this.now();
        const known = new Set(this.history.map((h) => h.id));
        for (const record of records) {
            if (known.has(record.id) || now - record.endedAt >= HISTORY_MS) {
                continue;
            }
            // Rollout ids are a counter of the tracker that started over with the process: renamed, so
            // a new rollout can never be taken for one of these.
            const rollouts = (record.rollouts || []).map((r) => ({ ...pickPublic(r, ROLLOUT_RECORD_FIELDS), id: `${r.id}@${record.id}` }));
            this.history.push({ ...record, rollouts });
            if (record.outcome === "done") {
                const last = this.lastDoneStartedAt.get(record.project) ?? -Infinity;
                this.lastDoneStartedAt.set(record.project, Math.max(last, record.startedAt));
            }
        }
        this.history.sort((a, b) => b.endedAt - a.endedAt);
        this.history = this.history.slice(0, HISTORY_MAX);
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
            stats: this.stats(),
        };
    }

    /**
     * Deploys of the last HISTORY_MS by outcome, and the success rate. Counted per deploy (a commit
     * with integration and production is one), from the history and the cards on screen. A replaced
     * deploy is out of the rate: nobody finished it, a newer one took its place.
     * @returns {object} Counters, with `successRate` from 0 to 100, or null with nothing ended.
     */
    stats() {
        const counts = { done: 0, stuck: 0, failed: 0, replaced: 0, inProgress: 0 };
        for (const h of this.history) {
            if (counts[h.outcome] !== undefined) {
                counts[h.outcome]++;
            }
        }
        for (const d of this.deploys) {
            if (d.state === "done" || d.state === "stuck") {
                counts[d.state]++;
            } else if (d.state === "superseded") {
                counts.replaced++;
            } else {
                counts.inProgress++;
            }
        }
        const ended = counts.done + counts.stuck + counts.failed;
        const total = ended + counts.replaced + counts.inProgress;
        const successRate = ended === 0 ? null : Math.round((100 * counts.done) / ended);
        return pickPublic({ total, ...counts, successRate }, STATS_FIELDS);
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
            missed: isMissed(rollouts),
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
            rollback: ROLLBACK_STATES.includes(deploy.state) ? this.rollbackOf(deploy, rollouts) : null,
        };
    }

    /**
     * The command to go back each release of a deploy (see rollback.js).
     * @param {object} deploy Internal deploy.
     * @param {object[]} rollouts Its live rollouts.
     * @returns {{releases: object[]}} One plan per release.
     */
    rollbackOf(deploy, rollouts) {
        return { releases: rollouts.map((r) => releaseRollback(r, this.earlierDone(deploy, r))) };
    }

    /**
     * Finished rollouts of the same release in other deploys, on screen or in the history, that
     * started before this one: newest first.
     * @param {object} deploy Deploy the rollout belongs to.
     * @param {object} rollout Rollout.
     * @returns {object[]} Rollouts.
     */
    earlierDone(deploy, rollout) {
        const others = [
            ...this.deploys.filter((d) => d !== deploy && d.state === "done").map((d) => [...d.rollouts.values()]),
            ...this.history.filter((h) => h.outcome === "done" && h.id !== deploy.id).map((h) => h.rollouts || []),
        ].flat();
        return others
            .filter(
                (r) =>
                    r.state === "done" &&
                    r.namespace === rollout.namespace &&
                    r.release === rollout.release &&
                    r.startedAt < rollout.startedAt
            )
            .sort((a, b) => b.startedAt - a.startedAt);
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
        if (!deploy && sha) {
            deploy = this.reopen(project, sha, (h) => !h.rollouts.some((r) => r.namespace === rollout.namespace && r.release === rollout.release));
        }
        if (!deploy) {
            deploy = {
                // The creation time keeps it apart from the ids of deploys loaded after a restart.
                id: `${project.name}:${this.now()}-${++this.sequence}`,
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
     * Bring a deploy of the history back to the screen: the integration and the production of the same
     * commit roll tens of minutes apart, and are one deploy.
     * @param {{name: string, source: string}} project Project of the rollout.
     * @param {string} sha Commit in the image tag.
     * @param {Function} accepts Whether a history record may take the rollout.
     * @returns {object|null} The reopened deploy, or null when none fits.
     */
    reopen(project, sha, accepts) {
        const index = this.history.findIndex((h) => h.project === project.name && h.sha === sha && accepts(h));
        if (index === -1) {
            return null;
        }
        const [record] = this.history.splice(index, 1);
        const deploy = {
            id: record.id,
            project: project.name,
            pipelineSource: project.source,
            sha,
            version: record.version,
            rollouts: new Map(record.rollouts.map((r) => [r.id, { ...r }])),
            state: "done",
            startedAt: record.startedAt,
            // Open again: when it ends it is saved again, even if the rollout that reopened it arrives done.
            endedAt: null,
        };
        this.deploys.push(deploy);
        return deploy;
    }

    /**
     * Hand a record to the database. Never throws: losing a write must not stop the board.
     * @param {object} record History record.
     * @returns {void}
     */
    save(record) {
        if (!this.persist) {
            return;
        }
        try {
            this.persist(record);
        } catch (e) {
            // The repository logs its own failures; the board goes on in memory.
        }
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
        const record = recordOf(deploy, outcome, deploy.endedAt ?? now);
        this.history.unshift(record);
        this.save(record);
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
 * The history record of a deploy: what the "Today" list shows and what the database keeps. The
 * rollouts are kept (to join a later rollout of the same commit) but never leave by the snapshot.
 * @param {object} deploy Internal deploy.
 * @param {string} outcome "done", "stuck" or "replaced".
 * @param {number} endedAt When it ended.
 * @returns {object} Record.
 */
function recordOf(deploy, outcome, endedAt) {
    const rollouts = [...deploy.rollouts.values()].map((r) => pickPublic(r, ROLLOUT_RECORD_FIELDS));
    return {
        id: deploy.id,
        project: deploy.project,
        version: deploy.version,
        sha: deploy.sha,
        outcome,
        missed: isMissed(rollouts),
        startedAt: deploy.startedAt,
        endedAt,
        releases: rollouts.map((r) => ({ namespace: r.namespace, release: r.release })),
        rollouts,
    };
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
 * @param {object[]} rollouts Rollouts of a deploy.
 * @returns {boolean} Whether all of them rolled while the board was down: then no duration is known.
 */
function isMissed(rollouts) {
    return rollouts.length > 0 && rollouts.every((r) => r.missed === true);
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
    ROLLOUT_RECORD_FIELDS,
    STATS_FIELDS,
    DONE_VISIBLE_MS,
    HISTORY_MS,
    HISTORY_MAX,
    GROUP_WINDOW_MS,
    deployLabel,
    DeployBoardStore,
};
