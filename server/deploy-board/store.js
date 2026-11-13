const { releaseRollback } = require("./rollback");
const { releaseRef } = require("./config");

/**
 * The deploy sources the server reads. Kuma itself is read by the browser, not here. "cluster" is
 * the cluster the pod runs in; each other cluster of the configuration adds "cluster:<name>".
 */
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
    "pipeline",
    "steps",
    "links",
];
const HISTORY_PUBLIC_FIELDS = ["id", "project", "version", "outcome", "startedAt", "endedAt", "missed", "releases", "links"];

/**
 * Fields of a rollout kept in a history record, which is also what goes to the database. Built field
 * by field, like the snapshot: whatever else the tracker attaches to a rollout stays out.
 */
const ROLLOUT_RECORD_FIELDS = [
    "id",
    "cluster",
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

/**
 * A green pipeline of a project in the cluster with no rollout this long after it ended gets the
 * warning "pipeline verde, nenhuma virada vista" (only while the cluster is being read)...
 */
const NO_ROLLOUT_MS = 10 * 60 * 1000;

/** ...and leaves the screen for the history this long after it ended. */
const NO_ROLLOUT_LEAVE_MS = 60 * 60 * 1000;

/**
 * A merge whose pipeline never reports (a "[skip ci]" commit, or a run of a workflow that is not the
 * configured one) is dropped after this long: there was no deploy.
 */
const MERGE_WAIT_MS = 15 * 60 * 1000;

/**
 * A run still "running" with no news for this long is taken as lost: its last event never came (a
 * delivery GitHub does not resend). It stops counting as the pipeline of later rollouts, and a deploy
 * with nothing else leaves the screen as "sem notícia". The longest pipeline today (the condominio's
 * helm --timeout 60m) fits well inside.
 */
const RUN_SILENT_MS = 2 * 60 * 60 * 1000;

/** How often the store checks what is due to leave the screen. */
const TICK_MS = 30 * 1000;

/** Counters of the last HISTORY_MS, as the header shows them. Nothing else leaves in `stats`. */
const STATS_FIELDS = [
    "total",
    "done",
    "stuck",
    "failed",
    "replaced",
    "noRollout",
    "cancelled",
    "lost",
    "inProgress",
    "successRate",
];

/** States of a deploy derived from its rollouts, worst first. */
const STATE_ORDER = ["stuck", "noProgress", "updating", "done"];

/** Order of the cards: what needs attention first, then what is moving, then what ended well. */
const DEPLOY_ORDER = ["failed", "stuck", "noProgress", "updating", "built", "pipeline", "cancelled", "done"];

/** Label of the card for each rollout state. */
const STATE_LABELS = {
    updating: "rolling",
    noProgress: "noProgress",
    stuck: "stuck",
    done: "live",
    superseded: "replaced",
    pipeline: "inPipeline",
    built: "built",
    failed: "failed",
    cancelled: "cancelled",
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
        this.projects = new Map();
        this.configProjects = [];
        this.amplifyApps = [];
        // What each release runs now, from the cluster (see ClusterTracker.commitsOf).
        this.commitsOf = () => null;
        // Per cluster source: namespaces whose rollout state cannot be vouched for.
        this.staleNamespaces = new Map();
        this.lastDoneStartedAt = new Map();
        this.sequence = 0;
        this.listeners = new Set();
        this.lastEmitAt = null;
        this.emitTimer = null;
        this.tickTimer = null;
    }

    /**
     * A source for another cluster, "unconfigured" until its collector starts. Safe to call again.
     * @param {string} name Cluster name, from the configuration.
     * @param {string} label What the footer and the card call it.
     * @returns {string} The source id.
     */
    addClusterSource(name, label) {
        const id = clusterSourceId(name);
        this.sources[id] = this.sources[id] || { state: "unconfigured", lastDataAt: null, detail: null };
        this.sources[id].label = label;
        this.changed();
        return id;
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
        this.configProjects = projects;
        this.rebuildProjects();
    }

    /**
     * The Amplify apps with a production branch, as discovered: each is a project of its own, with
     * no release in the cluster. An app named like a project of the configuration is left out, so a
     * card never mixes the two.
     * @param {string[]} names App names.
     * @returns {string[]} The names left out.
     */
    setAmplifyApps(names) {
        const taken = new Set(this.configProjects.map((p) => p.name));
        this.amplifyApps = names.filter((name) => !taken.has(name));
        this.rebuildProjects();
        return names.filter((name) => taken.has(name));
    }

    /**
     * @returns {void}
     */
    rebuildProjects() {
        this.projectOfRelease.clear();
        this.projects.clear();
        for (const project of this.configProjects) {
            this.projects.set(project.name, {
                name: project.name,
                source: project.source,
                releases: project.releases,
            });
            for (const r of project.releases) {
                this.projectOfRelease.set(releaseRef(r), { name: project.name, source: project.source });
            }
        }
        for (const name of this.amplifyApps) {
            this.projects.set(name, { name, source: "amplify", releases: [] });
        }
    }

    /**
     * Namespaces whose rollout state cannot be vouched for (denied or not answering).
     * @param {string[]} namespaces Namespaces.
     * @param {string} sourceId Cluster source they belong to.
     * @returns {void}
     */
    setStaleNamespaces(namespaces, sourceId = "cluster") {
        const next = new Set(namespaces);
        const current = this.staleNamespaces.get(sourceId) || new Set();
        if (next.size === current.size && [...next].every((ns) => current.has(ns))) {
            return;
        }
        this.staleNamespaces.set(sourceId, next);
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
        const project = this.projectOfRelease.get(releaseRef(rollout));
        if (!project) {
            return;
        }
        let deploy = this.deploys.find((d) => d.rollouts.has(rollout.id));
        if (!deploy) {
            deploy = this.deployFor(project, rollout);
        }
        const wasEnded = deploy.endedAt !== null;
        deploy.rollouts.set(rollout.id, { ...rollout });
        refresh(deploy, this.waitsRollout(deploy));
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
     * What a webhook said about the pipeline of a commit (see bitbucket-events.js and
     * github-events.js). It joins the deploy of the same project and commit, on screen or in the
     * history; without one, a rollout already on screen whose tag has no commit and that started
     * while this pipeline ran (the chat's "prod"; the Kuma, whose own deploy is always seen after
     * the fact); otherwise it starts a deploy.
     * @param {object} event Merge, run or job of a project.
     * @returns {void}
     */
    pipelineEvent(event) {
        const project = this.projects.get(event.project);
        if (!project || !project.source) {
            return;
        }
        if (event.kind === "merge") {
            // When it reached the branch is when it was received: the commit's own date can be an hour
            // older (committed, reviewed, pushed), and would make the merge look stale on arrival.
            event = { ...event, at: this.now() };
        }
        // A run that starts after the commit's deploy went live is a deploy of its own (a rerun of an
        // old commit): joined, the card would count the days between them. An open one comes first.
        const sameCommitOpen = (d) =>
            d.project === project.name &&
            d.sha === event.sha &&
            !startsAfter(event, d.state === "done" ? d.endedAt : null);
        let deploy =
            this.deploys
                .filter(sameCommitOpen)
                .sort(
                    (a, b) => (a.endedAt === null ? 0 : 1) - (b.endedAt === null ? 0 : 1) || b.startedAt - a.startedAt
                )[0] ||
            this.reopen(project, event.sha, (h) => !startsAfter(event, h.outcome === "done" ? h.endedAt : null));
        if (!deploy && event.kind === "run") {
            deploy = this.deploys.find(
                (d) =>
                    d.project === project.name &&
                    !d.sha &&
                    !d.pipeline &&
                    d.rollouts.size > 0 &&
                    runCovers(event, Math.min(...[...d.rollouts.values()].map((r) => r.startedAt)), this.now())
            );
            if (deploy) {
                deploy.sha = event.sha;
                deploy.version = event.sha.slice(0, 7);
            }
        }
        if (!deploy) {
            // A status with no branch is only taken for a commit already known to be on the branch;
            // a job only for a run already known; a "[skip ci]" merge has no pipeline to wait for.
            if ((event.kind === "run" && !event.branchKnown) || event.kind === "job" || isSkipCi(event)) {
                return;
            }
            deploy = this.newDeploy(project, event.sha, event.sha.slice(0, 7), eventTime(event) ?? this.now());
        }

        deploy.pipeline = deploy.pipeline || newPipeline(project.source);
        if (!applyPipelineEvent(deploy.pipeline, event, this.now())) {
            return;
        }
        const wasEnded = deploy.endedAt !== null;
        refresh(deploy, this.waitsRollout(deploy));
        this.closeIfLive(deploy);
        // Saved when it ends, and again when a pipeline of an ended deploy reports (the chat's
        // workflow finishes after the rollout it waits for).
        if (deploy.endedAt !== null) {
            this.save(recordOf(deploy, outcomeOf(deploy), deploy.endedAt));
        }
        if (!wasEnded && deploy.state === "done") {
            const last = this.lastDoneStartedAt.get(project.name) ?? -Infinity;
            this.lastDoneStartedAt.set(project.name, Math.max(last, deploy.startedAt));
        }
        this.settle();
        this.changed();
    }

    /**
     * @param {object} deploy Internal deploy.
     * @returns {string[]} The cluster sources its project rolls in, from its releases. A project with
     * none (the Prefect flows: the pipeline pushes an image that the next flow run pulls, and nothing
     * rolls in the cluster) has no rollout to wait for: its green pipeline is the end of the deploy.
     */
    clusterSourcesOf(deploy) {
        const releases = this.projects.get(deploy.project)?.releases || [];
        return [...new Set(releases.map((r) => clusterSourceId(r.cluster)))];
    }

    /**
     * @param {object} deploy Internal deploy.
     * @returns {boolean} Whether the clusters of its project that have a collector are all being read:
     * only then "no rollout" can be said.
     */
    clusterActive(deploy) {
        const configured = this.clusterSourcesOf(deploy).filter((id) => this.sources[id]?.state !== "unconfigured");
        return configured.length > 0 && configured.every((id) => this.sources[id].state === "active");
    }

    /**
     * @param {object} deploy Internal deploy.
     * @returns {boolean} Whether there is a cluster of its project to follow at all. While it does not
     * answer (stale), a green pipeline still waits for its rollout: it is not "No ar" for lack of news.
     * A cluster whose credential is not there yet leaves its projects as if there were no cluster.
     */
    clusterConfigured(deploy) {
        return this.clusterSourcesOf(deploy).some(
            (id) => (this.sources[id]?.state ?? "unconfigured") !== "unconfigured"
        );
    }

    /**
     * @param {object} deploy Internal deploy.
     * @returns {boolean} Whether a green pipeline of it still waits for a rollout. An Amplify app has
     * none: its job publishes the site itself.
     */
    waitsRollout(deploy) {
        return deploy.pipelineSource !== "amplify" && this.clusterConfigured(deploy);
    }

    /**
     * @param {object} rollout Rollout, or release, with `cluster` and `namespace`.
     * @returns {boolean} Whether its state can be vouched for: its cluster is read, or only other
     * namespaces of that cluster fail.
     */
    rolloutRead(rollout) {
        const id = clusterSourceId(rollout.cluster);
        const state = this.sources[id]?.state;
        const stale = this.staleNamespaces.get(id) || new Set();
        return state === "active" || (state === "stale" && stale.size > 0 && !stale.has(rollout.namespace));
    }

    /**
     * @param {Function} lookup Release (see releaseRef) → the commits its objects run, or null.
     * @returns {void}
     */
    setCommitsLookup(lookup) {
        this.commitsOf = lookup;
    }

    /**
     * Whether every release of the deploy's project already runs its commit: a green pipeline of it
     * has nothing to roll (a rerun of the commit in production), so there is no rollout to wait for.
     * @param {object} deploy Internal deploy.
     * @returns {boolean} Whether it is live already.
     */
    alreadyLive(deploy) {
        const releases = this.projects.get(deploy.project)?.releases || [];
        if (!deploy.sha || !releases.length) {
            return false;
        }
        return releases.every((r) => {
            if (this.sources[clusterSourceId(r.cluster)]?.state !== "active") {
                return false;
            }
            const commits = this.commitsOf(releaseRef(r));
            return commits?.length > 0 && commits.every((c) => sameCommit(c, deploy.sha));
        });
    }

    /**
     * End, as live, a green pipeline whose commit the cluster already runs.
     * @param {object} deploy Internal deploy.
     * @returns {boolean} Whether it ended now.
     */
    closeIfLive(deploy) {
        if (deploy.state !== "built" || !this.alreadyLive(deploy)) {
            return false;
        }
        deploy.state = "done";
        deploy.endedAt = pipelineEnd(deploy.pipeline);
        return true;
    }

    /**
     * A deploy with nothing in it yet, on screen.
     * @param {{name: string, source: string}} project Project.
     * @param {string|null} sha Commit, when known.
     * @param {string|null} version What the card shows as the version.
     * @param {number} startedAt Start.
     * @returns {object} The deploy.
     */
    newDeploy(project, sha, version, startedAt) {
        const deploy = {
            // The creation time keeps it apart from the ids of deploys loaded after a restart.
            id: `${project.name}:${this.now()}-${++this.sequence}`,
            project: project.name,
            pipelineSource: project.source,
            sha,
            version,
            rollouts: new Map(),
            pipeline: null,
            state: "pipeline",
            startedAt,
            endedAt: null,
        };
        this.deploys.push(deploy);
        return deploy;
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
        for (const [id, s] of Object.entries(this.sources)) {
            sources[id] = { state: s.state, lastDataAt: s.lastDataAt, detail: s.detail };
            if (s.label !== undefined) {
                sources[id].label = s.label;
            }
        }
        const deploys = [...this.deploys]
            .sort(
                (a, b) => DEPLOY_ORDER.indexOf(a.state) - DEPLOY_ORDER.indexOf(b.state) || b.startedAt - a.startedAt
            )
            .map((d) => pickPublic(this.publicDeploy(d), DEPLOY_PUBLIC_FIELDS));
        return {
            generatedAt: this.now(),
            sources,
            deploys,
            history: this.history.map((h) =>
                pickPublic(
                    {
                        ...h,
                        // The label is the configuration's, not the record's: it may change.
                        releases: (h.releases || []).map((r) => ({ ...r, clusterLabel: this.clusterLabel(r.cluster) })),
                        links: linksOf(h.releases || [], h.pipeline?.source === "amplify" ? h.project : null),
                    },
                    HISTORY_PUBLIC_FIELDS
                )
            ),
            stats: this.stats(),
        };
    }

    /**
     * Deploys of the last HISTORY_MS by outcome, and the success rate. Counted per deploy (a commit
     * with integration and production is one), from the history and the cards on screen. A replaced
     * deploy is out of the rate: nobody finished it, a newer one took its place. So is a green
     * pipeline that never rolled: it may be a run of a commit already live, and nothing failed.
     * @returns {object} Counters, with `successRate` from 0 to 100, or null with nothing ended.
     */
    stats() {
        const counts = { done: 0, stuck: 0, failed: 0, replaced: 0, noRollout: 0, cancelled: 0, lost: 0, inProgress: 0 };
        for (const h of this.history) {
            if (counts[h.outcome] !== undefined) {
                counts[h.outcome]++;
            }
        }
        for (const d of this.deploys) {
            if (["done", "stuck", "failed", "cancelled"].includes(d.state)) {
                counts[d.state]++;
            } else if (d.state === "superseded") {
                counts.replaced++;
            } else {
                counts.inProgress++;
            }
        }
        const ended = counts.done + counts.stuck + counts.failed;
        // Cancelled and lost are out of the rate too: nothing was deployed, and nothing failed.
        const total = ended + counts.replaced + counts.noRollout + counts.cancelled + counts.lost + counts.inProgress;
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
        const rollouts = liveRollouts(deploy);
        const missed = isMissed(rollouts);
        const noRollout = this.noRollout(deploy);
        return {
            id: deploy.id,
            project: deploy.project,
            version: deploy.version,
            state: deploy.state,
            label: deployLabel(deploy.state, {
                pipelineConfigured,
                hasPipeline: deploy.pipeline !== null,
                missed,
                noRollout,
            }),
            missed,
            startedAt: deploy.startedAt,
            endedAt: deploy.endedAt,
            confirmed:
                deploy.pipelineSource === "amplify"
                    ? this.sources.amplify.state === "active"
                    : rollouts.length
                      ? rollouts.every((r) => this.rolloutRead(r))
                      : this.clusterSourcesOf(deploy).every((id) => this.sources[id]?.state === "active"),
            releases: rollouts.map((r) => ({
                cluster: r.cluster ?? null,
                clusterLabel: this.clusterLabel(r.cluster),
                namespace: r.namespace,
                release: r.release,
                state: r.state,
                updated: r.updated,
                desired: r.desired,
                cronJobsUpdated: r.cronJobsUpdated,
                atBoot: r.atBoot,
            })),
            rollback:
                ROLLBACK_STATES.includes(deploy.state) && rollouts.length > 0 ? this.rollbackOf(deploy, rollouts) : null,
            pipeline: deploy.pipeline ? publicPipeline(deploy.pipeline) : null,
            steps: deploySteps(deploy, { pipelineConfigured, clusterConfigured: this.waitsRollout(deploy), noRollout }),
            links: linksOf(rollouts, deploy.pipelineSource === "amplify" ? deploy.project : null),
        };
    }

    /**
     * @param {object} deploy Internal deploy.
     * @returns {boolean} Whether it is a green pipeline with no rollout NO_ROLLOUT_MS after it ended,
     * while the cluster is read (without it, a missing rollout is a missing source).
     */
    noRollout(deploy) {
        const end = deploy.pipeline ? pipelineEnd(deploy.pipeline) : null;
        return (
            deploy.state === "built" && this.clusterActive(deploy) && end !== null && this.now() - end >= NO_ROLLOUT_MS
        );
    }

    /**
     * The command to go back each release of a deploy (see rollback.js).
     * @param {object} deploy Internal deploy.
     * @param {object[]} rollouts Its live rollouts.
     * @returns {{releases: object[]}} One plan per release.
     */
    rollbackOf(deploy, rollouts) {
        return {
            releases: rollouts.map((r) => ({
                ...releaseRollback(r, this.earlierDone(deploy, r)),
                clusterLabel: this.clusterLabel(r.cluster),
            })),
        };
    }

    /**
     * @param {string|null|undefined} cluster Cluster name.
     * @returns {string|null} What the card calls it, or null for the pod's own (no mark).
     */
    clusterLabel(cluster) {
        return cluster ? (this.sources[clusterSourceId(cluster)]?.label ?? cluster) : null;
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
                (r) => r.state === "done" && releaseRef(r) === releaseRef(rollout) && r.startedAt < rollout.startedAt
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
        const ref = releaseRef(rollout);
        const sameRelease = (d) => [...d.rollouts.values()].some((r) => releaseRef(r) === ref);
        const fits = (d) => {
            if (d.project !== project.name || sameRelease(d)) {
                return false;
            }
            if (sha) {
                return d.sha === sha;
            }
            return !d.sha && d.endedAt === null && rollout.startedAt - d.startedAt <= GROUP_WINDOW_MS;
        };

        let deploy = sha ? null : this.pipelineFor(project, rollout, sameRelease);
        deploy = deploy || this.deploys.find(fits);
        if (!deploy && sha) {
            deploy = this.reopen(project, sha, (h) => !h.rollouts.some((r) => releaseRef(r) === ref));
        }
        if (!deploy) {
            deploy = this.newDeploy(project, sha, sha ? sha.slice(0, 7) : rollout.images[0] || null, rollout.startedAt);
            deploy.state = "updating";
        }
        return deploy;
    }

    /**
     * For a rollout whose tag has no commit: the latest deploy of the project whose pipeline was
     * running when the rollout began, or ended green up to GROUP_WINDOW_MS before, and that no rollout
     * with a commit took.
     * @param {{name: string}} project Project of the rollout.
     * @param {object} rollout Rollout.
     * @param {Function} sameRelease Whether a deploy already has this release.
     * @returns {object|null} The deploy, or null.
     */
    pipelineFor(project, rollout, sameRelease) {
        const candidates = this.deploys.filter(
            (d) =>
                d.project === project.name &&
                d.pipeline &&
                !sameRelease(d) &&
                [...d.rollouts.values()].every((r) => !shaOf(r.images)) &&
                [...d.pipeline.runs.values()].some((run) => runCovers(run, rollout.startedAt, this.now()))
        );
        return candidates.sort((a, b) => b.startedAt - a.startedAt)[0] || null;
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
            pipeline: record.pipeline ? pipelineFromRecord(record.pipeline) : null,
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
            if (this.closeIfLive(deploy)) {
                this.save(recordOf(deploy, "done", deploy.endedAt));
                const last = this.lastDoneStartedAt.get(deploy.project) ?? -Infinity;
                this.lastDoneStartedAt.set(deploy.project, Math.max(last, deploy.startedAt));
                moved = true;
            }
            let outcome = null;
            if (deploy.state === "superseded") {
                outcome = "replaced";
            } else if (deploy.state === "done" && now - deploy.endedAt >= DONE_VISIBLE_MS) {
                outcome = "done";
            } else if (deploy.state === "stuck" && (this.lastDoneStartedAt.get(deploy.project) ?? -Infinity) > deploy.startedAt) {
                outcome = "stuck";
            } else if ((deploy.state === "failed" || deploy.state === "cancelled") && now - deploy.endedAt >= DONE_VISIBLE_MS) {
                outcome = deploy.state;
            } else if (deploy.state === "pipeline" && deploy.rollouts.size === 0 && pipelineSilent(deploy.pipeline, now)) {
                deploy.endedAt = now;
                outcome = "lost";
            } else if (
                deploy.state === "built" &&
                this.clusterActive(deploy) &&
                now - pipelineEnd(deploy.pipeline) >= NO_ROLLOUT_LEAVE_MS
            ) {
                deploy.endedAt = pipelineEnd(deploy.pipeline);
                outcome = "noRollout";
            } else if (
                deploy.state === "pipeline" &&
                deploy.rollouts.size === 0 &&
                deploy.pipeline.runs.size === 0 &&
                now - deploy.startedAt >= MERGE_WAIT_MS
            ) {
                // A merge whose pipeline never reported: not a deploy, so not in the history either.
                this.deploys.splice(this.deploys.indexOf(deploy), 1);
                moved = true;
                continue;
            }
            if (outcome) {
                this.toHistory(deploy, outcome, now);
                moved = true;
            } else if (this.noRollout(deploy) && !deploy.noRolloutShown) {
                // The warning shows up with time, not with an event: broadcast it.
                deploy.noRolloutShown = true;
                moved = true;
            }
        }

        const before = this.history.length;
        this.history = this.history.filter((h) => now - h.endedAt < HISTORY_MS).slice(0, HISTORY_MAX);
        return moved || this.history.length !== before;
    }

    /**
     * @param {object} deploy Internal deploy.
     * @param {string} outcome "done", "stuck", "replaced", "failed" or "noRollout".
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
 * @param {string|null|undefined} cluster Cluster name, or null for the pod's own.
 * @returns {string} The source that reads it.
 */
function clusterSourceId(cluster) {
    return cluster ? `cluster:${cluster}` : "cluster";
}

/**
 * The values of the Kuma tag "deploy" a deploy answers to: "<namespace>/<release>" of each release
 * ("<cluster>:<namespace>/<release>" outside the pod's own cluster), and "amplify/<app>" for an
 * Amplify app. The page links monitors to deploys by them.
 * @param {{cluster?: string|null, namespace: string, release: string}[]} releases Releases of the deploy.
 * @param {string|null} amplifyApp App, when the deploy is of an Amplify app.
 * @returns {string[]} Tag values.
 */
function linksOf(releases, amplifyApp) {
    const links = releases.map(releaseRef);
    return amplifyApp ? [...links, `amplify/${amplifyApp}`] : links;
}

/**
 * Label of a deploy card. "No pipeline" is only said when the pipeline source of the project is
 * being read: with the source off, a missing pipeline is a missing source, not a manual deploy.
 * @param {string} state Deploy state.
 * @param {object} options Options.
 * @param {boolean} options.pipelineConfigured Whether the project's pipeline source is configured.
 * @param {boolean} options.hasPipeline Whether a pipeline run was matched to the deploy.
 * @param {boolean} options.missed Whether it rolled while the board was down: then its pipeline may
 * have reported while nobody listened, and "no pipeline" cannot be said.
 * @param {boolean} options.noRollout Whether it is a green pipeline that no rollout followed.
 * @returns {string} Label id.
 */
function deployLabel(state, { pipelineConfigured, hasPipeline, missed = false, noRollout = false }) {
    if (noRollout) {
        return "noRollout";
    }
    if (pipelineConfigured && !hasPipeline && !missed) {
        return "noPipeline";
    }
    return STATE_LABELS[state];
}

/** Where each deploy state stands among the steps, and how that step is going. */
const STATE_STEPS = {
    built: ["built", "current"],
    updating: ["rollout", "current"],
    noProgress: ["rollout", "warn"],
    stuck: ["rollout", "failed"],
    superseded: ["rollout", "warn"],
    done: ["live", "done"],
    failed: ["pipeline", "failed"],
    cancelled: ["pipeline", "warn"],
};

/**
 * The steps of a deploy, from the merge to "No ar", for the card to say "step N of M". A project
 * has only the steps its sources can see: without a pipeline source it starts at the rollout,
 * without the cluster a green pipeline is the end.
 *
 * The steps before the current one are "done", or "skipped" when the project has a pipeline and
 * this deploy came without one (by hand, or while the board was down).
 * @param {object} deploy Internal deploy.
 * @param {object} options Options.
 * @param {boolean} options.pipelineConfigured Whether the project's pipeline source is configured.
 * @param {boolean} options.clusterConfigured Whether there is a cluster source.
 * @param {boolean} options.noRollout Whether it is a green pipeline that no rollout followed.
 * @returns {{key: string, status: string}[]|null} Steps, each "done", "skipped", "current", "warn",
 * "failed" or "pending"; null when the state has no place among them.
 */
function deploySteps(deploy, { pipelineConfigured, clusterConfigured, noRollout }) {
    const withPipeline = pipelineConfigured || deploy.pipeline !== null;
    const keys = [
        ...(withPipeline ? ["merge", "pipeline"] : []),
        ...(clusterConfigured ? [...(withPipeline ? ["built"] : []), "rollout"] : []),
        "live",
    ];
    let [current, status] = STATE_STEPS[deploy.state] || [
        deploy.pipeline && pipelineState(deploy.pipeline) !== "merged" ? "pipeline" : "merge",
        "current",
    ];
    if (noRollout) {
        [current, status] = ["rollout", "warn"];
    }
    const at = keys.indexOf(current);
    if (at === -1) {
        return null;
    }
    const before = deploy.pipeline === null ? ["merge", "pipeline", "built"] : [];
    return keys.map((key, i) => {
        if (i < at) {
            return { key, status: before.includes(key) ? "skipped" : "done" };
        }
        return { key, status: i === at ? status : "pending" };
    });
}

/**
 * Recompute a deploy. With rollouts, they say where it is (a replaced one does not count while
 * another is alive); without, the pipeline does. It starts at the earliest of the merge, the
 * pipeline and the rollouts, so "took N" is the time from the merge to "No ar".
 * @param {object} deploy Internal deploy.
 * @param {boolean} clusterConfigured Whether there is a cluster source: without it, a green pipeline
 * is as far as the board can follow, and the deploy ends there.
 * @returns {void}
 */
function refresh(deploy, clusterConfigured) {
    const all = [...deploy.rollouts.values()];
    const live = all.filter((r) => r.state !== "superseded");
    const starts = [...all.map((r) => r.startedAt), ...(deploy.pipeline ? pipelineStarts(deploy.pipeline) : [])];
    const known = starts.filter(Number.isFinite);
    // An event with an unreadable date keeps the start the deploy already had.
    if (known.length) {
        deploy.startedAt = Math.min(...known);
    }
    if (all.length === 0) {
        const state = deploy.pipeline ? pipelineState(deploy.pipeline) : "merged";
        if (state === "failed" || state === "stopped") {
            // Stopped (cancelled by a newer push, by hand, or skipped) is not a failure.
            deploy.state = state === "failed" ? "failed" : "cancelled";
            deploy.endedAt = pipelineEnd(deploy.pipeline);
        } else if (state === "success") {
            deploy.state = clusterConfigured ? "built" : "done";
            deploy.endedAt = clusterConfigured ? null : pipelineEnd(deploy.pipeline);
        } else {
            deploy.state = "pipeline";
            deploy.endedAt = null;
        }
        return;
    }
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
 * @param {string} outcome "done", "stuck", "replaced", "failed" or "noRollout".
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
        releases: rollouts.map((r) => ({ cluster: r.cluster ?? null, namespace: r.namespace, release: r.release })),
        rollouts,
        pipeline: deploy.pipeline ? pipelineRecord(deploy.pipeline) : null,
    };
}

/**
 * @param {object} deploy Internal deploy that ended.
 * @returns {string} Its outcome for the history.
 */
function outcomeOf(deploy) {
    return { superseded: "replaced", failed: "failed", stuck: "stuck", cancelled: "cancelled" }[deploy.state] || "done";
}

/**
 * @param {string} source "bitbucket" or "github".
 * @returns {object} Pipeline of a deploy, before any event.
 */
function newPipeline(source) {
    return { source, merge: null, runs: new Map(), jobs: new Map() };
}

/** Run and job states that are an end. */
const FINAL_STATES = ["success", "failed", "stopped"];

/**
 * Whether an event is older news than what the board already has of the same run or job. Webhooks
 * come in any order: a late "in_progress" must not undo the "completed" that came before it. A newer
 * attempt (a re-run) always wins; within an attempt, the sender's own time decides, and at the same
 * time an end is not undone by a non-end.
 * @param {object} before What the board has.
 * @param {object} event What arrived.
 * @returns {boolean} Whether to ignore the event.
 */
function isOlderNews(before, event) {
    const was = before.attempt ?? 1;
    const now = event.attempt ?? 1;
    if (now !== was) {
        return now < was;
    }
    if (before.updatedAt != null && event.updatedAt != null && event.updatedAt !== before.updatedAt) {
        return event.updatedAt < before.updatedAt;
    }
    return FINAL_STATES.includes(before.state) && !FINAL_STATES.includes(event.state);
}

/**
 * Apply one webhook event to the pipeline of a deploy. Each event carries the whole state of its run
 * or job, so the newest one wins (see isOlderNews).
 * @param {object} pipeline Pipeline of the deploy.
 * @param {object} event Merge, run or job.
 * @param {number} now Current time: when the board last heard of the run.
 * @returns {boolean} Whether it was taken (a job of an unknown run, or older news, is not).
 */
function applyPipelineEvent(pipeline, event, now) {
    if (event.kind === "merge") {
        pipeline.merge = { at: event.at, message: event.message };
    } else if (event.kind === "run") {
        const before = pipeline.runs.get(event.runId);
        if (before && isOlderNews(before, event)) {
            return false;
        }
        if (before && (event.attempt ?? 1) > (before.attempt ?? 1)) {
            // A re-run: the jobs of the attempt before are not this one's.
            for (const [jobId, job] of pipeline.jobs) {
                if (job.runId === event.runId) {
                    pipeline.jobs.delete(jobId);
                }
            }
        }
        pipeline.runs.set(event.runId, {
            runId: event.runId,
            name: event.name,
            state: event.state,
            url: event.url ?? before?.url ?? null,
            // The commit message, for a source with no merge event (Amplify).
            message: event.message ?? before?.message ?? null,
            startedAt: runStart(before, event),
            endedAt: event.endedAt,
            attempt: event.attempt ?? 1,
            updatedAt: event.updatedAt ?? null,
            seenAt: now,
        });
    } else if (event.kind === "job") {
        const run = pipeline.runs.get(event.runId);
        const before = pipeline.jobs.get(event.jobId);
        if (!run || (event.attempt ?? 1) < (run.attempt ?? 1) || (before && isOlderNews(before, event))) {
            return false;
        }
        pipeline.jobs.set(event.jobId, {
            runId: event.runId,
            name: event.name,
            state: event.state,
            startedAt: event.startedAt,
            endedAt: event.endedAt,
            attempt: event.attempt ?? 1,
            updatedAt: event.updatedAt ?? null,
        });
        run.seenAt = now;
    } else {
        return false;
    }
    return true;
}

/**
 * State of a pipeline: running while any run runs; otherwise that of the latest run, so a rerun that
 * passed counts over the run that failed before it.
 * @param {object} pipeline Pipeline.
 * @returns {string} "merged" (no run yet), "queued", "running", "success", "failed" or "stopped".
 */
function pipelineState(pipeline) {
    const runs = [...pipeline.runs.values()];
    if (runs.length === 0) {
        return "merged";
    }
    if (runs.some((r) => r.state === "running")) {
        return "running";
    }
    if (runs.some((r) => r.state === "queued")) {
        return "queued";
    }
    return runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0].state;
}

/**
 * @param {object} pipeline Pipeline.
 * @returns {number[]} When its merge and its runs started.
 */
function pipelineStarts(pipeline) {
    return [pipeline.merge?.at, ...[...pipeline.runs.values()].map((r) => r.startedAt)];
}

/**
 * @param {object} pipeline Pipeline.
 * @returns {number|null} When its last run ended, or null while one runs or none did.
 */
function pipelineEnd(pipeline) {
    const runs = [...pipeline.runs.values()];
    if (runs.length === 0 || runs.some((r) => r.endedAt === null)) {
        return null;
    }
    return Math.max(...runs.map((r) => r.endedAt ?? 0));
}

/**
 * Whether a run is the one behind a rollout without a commit in its tag: running when the rollout
 * began, or green up to GROUP_WINDOW_MS before it.
 * @param {object} run Run.
 * @param {number} rolloutStart When the rollout began.
 * @param {number} now Current time, to tell a run still going from one whose end was lost.
 * @returns {boolean} Whether it covers it.
 */
function runCovers(run, rolloutStart, now) {
    if (run.startedAt !== null && run.startedAt > rolloutStart) {
        return false;
    }
    if (run.endedAt === null) {
        // Still running, unless its end was lost: a silent run must not take the rollouts of days later.
        return run.seenAt === undefined || now - run.seenAt < RUN_SILENT_MS;
    }
    // Ended after the rollout began (the chat's helm --wait, the Kuma's own deploy job): it was
    // running then, whatever its result.
    if (run.endedAt >= rolloutStart) {
        return true;
    }
    return run.state === "success" && rolloutStart - run.endedAt <= GROUP_WINDOW_MS;
}

/**
 * @param {object} pipeline Pipeline.
 * @param {number} now Current time.
 * @returns {boolean} Whether it has runs, none ended, and no news of any for RUN_SILENT_MS.
 */
function pipelineSilent(pipeline, now) {
    const runs = [...pipeline.runs.values()];
    return runs.length > 0 && runs.every((r) => r.endedAt === null && now - (r.seenAt ?? 0) >= RUN_SILENT_MS);
}

/**
 * @param {object} event Pipeline event.
 * @returns {number|null} When it happened.
 */
function eventTime(event) {
    return event.at ?? event.startedAt ?? null;
}

/**
 * When a run started. Within an attempt the start of the first event stays: a late "completed" may
 * come without it, or (Bitbucket) with the creation of the status, days old on a rerun. A run that
 * runs again after it ended is a rerun, and starts again.
 * @param {object|undefined} before What the board has of the run.
 * @param {object} event What arrived.
 * @returns {number|null} Start.
 */
function runStart(before, event) {
    const again =
        !before ||
        (event.attempt ?? 1) !== (before.attempt ?? 1) ||
        (FINAL_STATES.includes(before.state) && !FINAL_STATES.includes(event.state));
    return (again ? event.startedAt ?? before?.startedAt : before.startedAt ?? event.startedAt) ?? null;
}

/**
 * @param {object} event Pipeline event.
 * @param {number|null} endedAt When a deploy went live, or null when it did not.
 * @returns {boolean} Whether it is a run that started after that.
 */
function startsAfter(event, endedAt) {
    return event.kind === "run" && endedAt != null && event.startedAt != null && event.startedAt > endedAt;
}

/**
 * @param {string} a Commit, full or short.
 * @param {string} b Commit, full or short.
 * @returns {boolean} Whether they are the same commit.
 */
function sameCommit(a, b) {
    return a.startsWith(b) || b.startsWith(a);
}

/**
 * @param {object} event Pipeline event.
 * @returns {boolean} Whether it is a merge that asks for no pipeline: there will be no deploy.
 */
function isSkipCi(event) {
    return event.kind === "merge" && (event.skipCi === true || /\[(skip ci|ci skip)\]/i.test(event.message || ""));
}

/**
 * What the card shows of a pipeline: no more than the spec lists.
 * @param {object} pipeline Pipeline.
 * @returns {object} Public pipeline.
 */
function publicPipeline(pipeline) {
    const runs = [...pipeline.runs.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    const latest = runs[0] || null;
    const jobs = latest
        ? [...pipeline.jobs.entries()]
              .filter(([, j]) => j.runId === latest.runId && (j.attempt ?? 1) === (latest.attempt ?? 1))
              .sort(([, a], [, b]) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity))
              .map(([id, j]) => ({ id, name: j.name, state: j.state, startedAt: j.startedAt, endedAt: j.endedAt }))
        : [];
    return {
        source: pipeline.source,
        state: pipelineState(pipeline),
        name: latest?.name || null,
        url: latest?.url || null,
        mergedAt: pipeline.merge?.at ?? null,
        message: pipeline.merge?.message ?? latest?.message ?? null,
        startedAt: latest?.startedAt ?? null,
        endedAt: pipelineEnd(pipeline),
        jobs,
    };
}

/**
 * @param {object} pipeline Pipeline.
 * @returns {object} The same, with lists instead of maps, for the database.
 */
function pipelineRecord(pipeline) {
    return {
        source: pipeline.source,
        merge: pipeline.merge,
        runs: [...pipeline.runs.values()],
        jobs: [...pipeline.jobs.entries()].map(([jobId, j]) => ({ jobId, ...j })),
    };
}

/**
 * @param {object} record Pipeline as saved.
 * @returns {object} Pipeline of a deploy.
 */
function pipelineFromRecord(record) {
    return {
        source: record.source,
        merge: record.merge || null,
        runs: new Map((record.runs || []).map((r) => [r.runId, { ...r }])),
        jobs: new Map((record.jobs || []).map(({ jobId, ...j }) => [jobId, j])),
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
    NO_ROLLOUT_MS,
    NO_ROLLOUT_LEAVE_MS,
    MERGE_WAIT_MS,
    RUN_SILENT_MS,
    deployLabel,
    deploySteps,
    DeployBoardStore,
};
