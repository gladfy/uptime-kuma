const { log } = require("../../src/util");
const { loadDeployBoardConfig } = require("./config");
const { DeployBoardStore, HISTORY_MS } = require("./store");
const { broadcastToLoggedIn } = require("./broadcast");
const { ClusterTracker } = require("./cluster-tracker");
const { KubernetesSource } = require("./kubernetes-source");
const { DeployHistoryRepository } = require("./history-repository");

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
     * @param {object} options.kubernetes Extra options of the KubernetesSource (tests).
     * @param {DeployHistoryRepository} options.history Where ended deploys are kept.
     */
    constructor({
        env = process.env,
        store = new DeployBoardStore(),
        kubernetes = {},
        history = new DeployHistoryRepository(),
    } = {}) {
        this.env = env;
        this.store = store;
        this.history = history;
        this.store.persist = this.store.persist || ((record) => this.history.save(record));
        this.kubernetesOptions = kubernetes;
        this.ready = Promise.resolve();
        this.pruneTimer = null;
        this.cluster = null;
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
                if (this.history.available()) {
                    // The history goes in first, so the first rollout can join a deploy loaded from it.
                    this.ready = this.loadHistory()
                        .then(() => this.startCluster(loaded.config))
                        .catch((e) => log.error("deploy-board", `Could not start the cluster source: ${e.message}`));
                } else {
                    this.startCluster(loaded.config);
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
     * Put the history of the database back on the board, and keep the database to a week.
     * @returns {Promise<void>} Never rejects.
     */
    async loadHistory() {
        try {
            const now = this.store.now();
            await this.history.prune(now - HISTORY_RETENTION_MS);
            const records = await this.history.load(now - HISTORY_MS);
            this.store.restore(records);
            log.info("deploy-board", `History loaded: ${records.length} deploys of the last 24 hours`);
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
     * Start reading rollouts from the cluster. Outside Kubernetes the source stays "unconfigured".
     * @param {object} config Normalized configuration.
     * @returns {void}
     */
    startCluster(config) {
        this.store.setProjects(config.projects);
        const releases = config.projects.flatMap((p) => p.releases.map((r) => `${r.namespace}/${r.release}`));
        const tracker = new ClusterTracker({
            releases,
            now: this.store.now,
            onRollout: (rollout) => this.store.upsertRollout(rollout),
        });
        this.cluster = new KubernetesSource({
            namespaces: config.namespaces,
            tracker,
            store: this.store,
            env: this.env,
            now: this.store.now,
            ...this.kubernetesOptions,
        });
        if (this.cluster.start()) {
            this.store.startTicking();
            log.info("deploy-board", `Watching ${config.namespaces.length} namespaces for ${releases.length} releases`);
        } else {
            log.info("deploy-board", "No Kubernetes service account in this pod; the cluster source is off.");
        }
    }

    /**
     * Stop the collectors and timers (shutdown and tests).
     * @returns {void}
     */
    stop() {
        clearInterval(this.pruneTimer);
        this.cluster?.stop();
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
    HISTORY_RETENTION_MS,
    DeployBoard,
    deployBoard,
};
