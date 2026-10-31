const { log } = require("../../src/util");
const { loadDeployBoardConfig } = require("./config");
const { DeployBoardStore } = require("./store");
const { broadcastToLoggedIn } = require("./broadcast");
const { ClusterTracker } = require("./cluster-tracker");
const { KubernetesSource } = require("./kubernetes-source");

/**
 * The deploy board: configuration, state and (from phase 2 on) the sources that feed it.
 */
class DeployBoard {
    /**
     * @param {object} options Options.
     * @param {object} options.env Environment (process.env by default).
     * @param {DeployBoardStore} options.store State (a new one by default).
     * @param {object} options.kubernetes Extra options of the KubernetesSource (tests).
     */
    constructor({ env = process.env, store = new DeployBoardStore(), kubernetes = {} } = {}) {
        this.env = env;
        this.store = store;
        this.kubernetesOptions = kubernetes;
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
                this.startCluster(loaded.config);
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
    DeployBoard,
    deployBoard,
};
