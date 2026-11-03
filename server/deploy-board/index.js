const { log } = require("../../src/util");
const { loadDeployBoardConfig, parseReleaseRef, releaseRef } = require("./config");
const { DeployBoardStore, HISTORY_MS } = require("./store");
const { broadcastToLoggedIn } = require("./broadcast");
const { ClusterTracker } = require("./cluster-tracker");
const { KubernetesSource } = require("./kubernetes-source");
const { DeployHistoryRepository } = require("./history-repository");
const { parseBitbucket } = require("./bitbucket-events");
const { parseGithub } = require("./github-events");
const { AmplifySource } = require("./amplify-source");

/** Where the secret of each webhook comes from. Never in the configuration file. */
const WEBHOOK_SECRET_ENVS = {
    bitbucket: "DEPLOY_BOARD_BITBUCKET_SECRET",
    github: "DEPLOY_BOARD_GITHUB_SECRET",
};

/** Webhook body → events, per source. */
const PARSERS = {
    bitbucket: parseBitbucket,
    github: parseGithub,
};

/**
 * Where the credential of each other cluster is mounted, one directory per cluster name with `server`
 * (the API URL), `token` and `ca.crt`: a Secret created by hand, like the one of the webhooks. Not
 * under the directory of the configuration, which is a read-only ConfigMap volume.
 */
const CLUSTERS_DIR = "/etc/deploy-board-clusters";

/** The database keeps a week of deploys; the screen shows the last HISTORY_MS of them. */
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * The deploy board: configuration, state and (from phase 2 on) the sources that feed it.
 */
class DeployBoard {
    /**
     * @param {object} options Options.
     * @param {object} options.env Environment (process.env by default).
     * @param {DeployBoardStore} options.store State (a new one by default).
     * @param {object} options.kubernetes Extra options of the KubernetesSource of the pod's cluster,
     * and `clusters` with those of each other cluster by name (tests).
     * @param {DeployHistoryRepository} options.history Where ended deploys are kept.
     * @param {object} options.amplify Extra options of the AmplifySource (tests).
     */
    constructor({
        env = process.env,
        store = new DeployBoardStore(),
        kubernetes = {},
        history = new DeployHistoryRepository(),
        amplify = {},
    } = {}) {
        this.env = env;
        this.store = store;
        this.history = history;
        this.store.persist = this.store.persist || ((record) => this.history.save(record));
        this.kubernetesOptions = kubernetes;
        this.amplifyOptions = amplify;
        this.amplify = null;
        this.ready = Promise.resolve();
        this.pruneTimer = null;
        this.known = new Map();
        this.clusters = [];
        this.config = null;
        this.configStatus = "missing";
        this.started = false;
    }

    /**
     * Load the configuration and start broadcasting. Safe to call more than once.
     *
     * Never throws: a broken deploy board must not take the monitors down with it. Every source
     * starts as "unconfigured", and each collector switches on the one it serves.
     * @param {object|null} io Socket.io server, to broadcast to logged-in sockets.
     * @returns {void}
     */
    start(io = null) {
        if (this.started) {
            return;
        }
        this.started = true;

        try {
            const loaded = loadDeployBoardConfig(this.env);
            this.configStatus = loaded.status;
            this.config = loaded.config;

            if (loaded.status === "invalid") {
                log.error("deploy-board", `Configuration ignored, every deploy source is off. ${loaded.error}`);
            } else if (loaded.status === "missing") {
                log.info("deploy-board", "DEPLOY_BOARD_CONFIG is not set; every deploy source is off.");
            } else {
                log.info("deploy-board", `Configuration loaded from ${loaded.path}`);
                // Before the history and the cluster: a webhook may arrive in the meantime.
                this.store.setProjects(loaded.config.projects);
                this.startWebhooks();
                if (this.history.available()) {
                    // The history goes in first, so the first rollout can join a deploy loaded from it.
                    this.ready = this.loadHistory()
                        .then(() => this.startSources(loaded.config))
                        .catch((e) => log.error("deploy-board", `Could not start the deploy sources: ${e.message}`));
                } else {
                    this.startSources(loaded.config);
                }
            }
        } catch (e) {
            this.configStatus = "invalid";
            this.config = null;
            log.error("deploy-board", `Could not start: ${e.message}`);
        }

        if (io) {
            this.store.onChange((snapshot) => broadcastToLoggedIn(io, snapshot));
        }
    }

    /**
     * @param {string} source "bitbucket" or "github".
     * @returns {string|null} Its webhook secret, or null while it is not configured.
     */
    webhookSecret(source) {
        const name = WEBHOOK_SECRET_ENVS[source];
        const value = name ? this.env[name] : undefined;
        return typeof value === "string" && value !== "" ? value : null;
    }

    /**
     * Switch on the pipeline sources that have a secret. They are push: "active" means the route
     * accepts their webhooks, and the footer shows when the last one came.
     * @returns {void}
     */
    startWebhooks() {
        const on = Object.keys(WEBHOOK_SECRET_ENVS).filter((source) => this.webhookSecret(source));
        for (const source of on) {
            this.store.setSource(source, "active");
        }
        if (on.length) {
            // "Pipeline verde, nenhuma virada vista" and the cards leaving the screen are a matter of time.
            this.store.startTicking();
            log.info("deploy-board", `Webhooks on for ${on.join(", ")}`);
        }
    }

    /**
     * A webhook whose signature was already checked.
     * @param {string} source "bitbucket" or "github".
     * @param {string} eventName Event header.
     * @param {object} payload Parsed body.
     * @returns {{repo: string, kept: number}} The repository and how many events the board kept.
     */
    receiveWebhook(source, eventName, payload) {
        this.store.markData(source);
        const projects = this.config ? this.config.projects : [];
        const { repo, events } = PARSERS[source](eventName, payload, projects);
        for (const event of events) {
            this.store.pipelineEvent(event);
        }
        return { repo, kept: events.length };
    }

    /**
     * Put the history of the database back on the board, and keep the database to a week.
     * @returns {Promise<void>} Never rejects.
     */
    async loadHistory() {
        try {
            const now = this.store.now();
            await this.history.prune(now - HISTORY_RETENTION_MS);
            const records = await this.history.load(now - HISTORY_MS);
            this.store.restore(records);
            this.known = await this.history.loadObjects();
            log.info(
                "deploy-board",
                `History loaded: ${records.length} deploys of the last 24 hours, last version of ${this.known.size} objects`
            );
            this.pruneTimer = setInterval(
                () => this.history.prune(this.store.now() - HISTORY_RETENTION_MS),
                PRUNE_EVERY_MS
            );
            this.pruneTimer.unref?.();
        } catch (e) {
            log.error("deploy-board", `Could not load the history: ${e.message}`);
        }
    }

    /**
     * @param {object} config Normalized configuration.
     * @returns {void}
     */
    startSources(config) {
        this.startCluster(config);
        this.startAmplify(config);
    }

    /**
     * Start reading the jobs of the Amplify apps. Without `amplify.region` the source stays
     * "unconfigured"; without an AWS credential it says so after the first read.
     * @param {object} config Normalized configuration.
     * @returns {void}
     */
    startAmplify(config) {
        this.amplify = new AmplifySource({
            region: config.amplify?.region || null,
            store: this.store,
            ...this.amplifyOptions,
        });
        if (this.amplify.start()) {
            this.store.startTicking();
            log.info("deploy-board", `Reading the Amplify apps of ${config.amplify.region}`);
        } else {
            log.info("deploy-board", "No amplify.region in the configuration; the Amplify source is off.");
        }
    }

    /**
     * Start reading rollouts from the cluster the pod runs in, and from each other cluster of the
     * configuration. A cluster without a credential stays "unconfigured" and does not stop the others.
     * @param {object} config Normalized configuration.
     * @returns {void}
     */
    startCluster(config) {
        this.store.setProjects(config.projects);
        // Test options: those of the pod's own cluster, and `clusters` by name for the others.
        const { clusters: perCluster = {}, ...own } = this.kubernetesOptions;
        const trackers = new Map();
        const clusters = [{ name: null, namespaces: config.namespaces }, ...(config.clusters || [])];
        for (const cluster of clusters) {
            const sourceId = cluster.name ? this.store.addClusterSource(cluster.name, cluster.label) : "cluster";
            const releases = config.projects
                .flatMap((p) => p.releases)
                .filter((r) => r.cluster === cluster.name)
                .map((r) => `${r.namespace}/${r.release}`);
            const tracker = new ClusterTracker({
                releases,
                cluster: cluster.name,
                now: this.store.now,
                onRollout: (rollout) => this.store.upsertRollout(rollout),
                known: this.known,
                onSeen: (key, signature) => this.history.saveObject(key, signature, this.store.now()),
            });
            trackers.set(cluster.name, tracker);
            const dir = `${this.env.DEPLOY_BOARD_CLUSTERS_DIR || CLUSTERS_DIR}/${cluster.name}`;
            const source = new KubernetesSource({
                namespaces: cluster.namespaces,
                tracker,
                store: this.store,
                env: this.env,
                now: this.store.now,
                sourceId,
                ...(cluster.name
                    ? { serviceAccountDir: dir, serverFile: `${dir}/server`, ...perCluster[cluster.name] }
                    : own),
            });
            this.clusters.push(source);
            const where = cluster.name ? `cluster ${cluster.name}` : "the cluster";
            if (source.start()) {
                this.store.startTicking();
                log.info(
                    "deploy-board",
                    `Watching ${cluster.namespaces.length} namespaces of ${where} for ${releases.length} releases`
                );
            } else if (cluster.name) {
                log.info("deploy-board", `No credential in ${dir}; the source of cluster ${cluster.name} is off.`);
            } else {
                log.info("deploy-board", "No Kubernetes service account in this pod; the cluster source is off.");
            }
        }
        this.store.setCommitsLookup((ref) => {
            const r = parseReleaseRef(ref);
            return r ? (trackers.get(r.cluster)?.commitsOf(releaseRef({ ...r, cluster: null })) ?? null) : null;
        });
    }

    /**
     * Stop the collectors and timers (shutdown and tests).
     * @returns {void}
     */
    stop() {
        clearInterval(this.pruneTimer);
        for (const source of this.clusters) {
            source.stop();
        }
        this.amplify?.stop();
        this.store.close();
    }

    /**
     * @returns {object} Current board state for the browser.
     */
    getSnapshot() {
        return this.store.snapshot();
    }
}

const deployBoard = new DeployBoard();

module.exports = {
    CLUSTERS_DIR,
    WEBHOOK_SECRET_ENVS,
    HISTORY_RETENTION_MS,
    DeployBoard,
    deployBoard,
};
