const fs = require("fs");
const http = require("http");
const https = require("https");
const { KINDS } = require("./cluster-tracker");

/** Mounted by Kubernetes in every pod that has a ServiceAccount token. */
const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** API path of each kind, per namespace. */
const PATHS = {
    deployments: (ns) => `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments`,
    cronjobs: (ns) => `/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/cronjobs`,
};

/**
 * The API server closes each watch after this long, so even a quiet namespace answers at least once
 * a minute and "no answer for 2 minutes" can mean a dead connection.
 */
const WATCH_TIMEOUT_S = 60;

/** A watch silent for this long is a half-open connection: drop it and list again. */
const IDLE_MS = (WATCH_TIMEOUT_S + 30) * 1000;

/** Without any answer from a namespace for this long, the board stops vouching for it. */
const STALE_MS = 2 * 60 * 1000;

/** Retry delays after a failure, doubling between these bounds. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 60 * 1000;

/** How often the health of the streams and the "no progress" clock are evaluated. */
const TICK_MS = 15 * 1000;

/** A list or watch answered with a status other than 200. */
class HttpError extends Error {
    /**
     * @param {number} status HTTP status.
     */
    constructor(status) {
        super(`HTTP ${status}`);
        this.status = status;
    }
}

/**
 * Reads Deployments and CronJobs of the configured namespaces with list + watch, and feeds the
 * tracker. Read-only, with the pod's own ServiceAccount.
 */
class KubernetesSource {
    /**
     * @param {object} options Options.
     * @param {string[]} options.namespaces Namespaces to watch.
     * @param {object} options.tracker ClusterTracker.
     * @param {object} options.store DeployBoardStore (for the situation of the source).
     * @param {object} options.env Environment.
     * @param {string|null} options.baseUrl API server URL; derived from the environment when null.
     * @param {string} options.serviceAccountDir Where the token and CA are mounted.
     * @param {Function} options.now Clock, in ms.
     * @param {number} options.tickMs Health and clock evaluation interval.
     * @param {number} options.retryMinMs First retry delay.
     */
    constructor({
        namespaces,
        tracker,
        store,
        env = process.env,
        baseUrl = null,
        serviceAccountDir = SERVICE_ACCOUNT_DIR,
        now = () => Date.now(),
        tickMs = TICK_MS,
        retryMinMs = RETRY_MIN_MS,
    }) {
        this.namespaces = namespaces;
        this.tracker = tracker;
        this.store = store;
        this.now = now;
        this.tickMs = tickMs;
        this.retryMinMs = retryMinMs;
        this.tokenFile = `${serviceAccountDir}/token`;
        this.caFile = `${serviceAccountDir}/ca.crt`;
        this.baseUrl =
            baseUrl ||
            (env.KUBERNETES_SERVICE_HOST
                ? `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT || 443}`
                : null);
        this.streams = [];
        this.requests = new Set();
        this.stopped = false;
        this.timer = null;
    }

    /**
     * @returns {boolean} Whether there is a cluster to read from: an API address and a token.
     */
    isConfigured() {
        return !!this.baseUrl && fs.existsSync(this.tokenFile);
    }

    /**
     * Start a list + watch loop per namespace and kind. Without a token the source stays
     * "unconfigured" and nothing is started.
     * @returns {boolean} Whether the source started.
     */
    start() {
        if (!this.isConfigured()) {
            this.store.setSource("cluster", "unconfigured");
            return false;
        }
        if (this.baseUrl.startsWith("https:")) {
            this.agent = new https.Agent({ ca: fs.existsSync(this.caFile) ? fs.readFileSync(this.caFile) : undefined, keepAlive: true });
        }
        this.store.setSource("cluster", "active");

        const startedAt = this.now();
        for (const namespace of this.namespaces) {
            for (const kind of KINDS) {
                const stream = { namespace, kind, baselined: false, lastContactAt: startedAt, error: null };
                this.streams.push(stream);
                this.run(stream);
            }
        }
        this.timer = setInterval(() => this.tick(), this.tickMs);
        return true;
    }

    /**
     * Stop every loop and open request.
     * @returns {void}
     */
    stop() {
        this.stopped = true;
        clearInterval(this.timer);
        for (const req of this.requests) {
            req.destroy();
        }
        this.requests.clear();
    }

    /**
     * List, then watch until the watch expires; list again on 410 or failure, with growing delays.
     * @param {object} stream Namespace, kind and health of one loop.
     * @returns {Promise<void>} Resolves when stopped.
     */
    async run(stream) {
        let delay = this.retryMinMs;
        while (!this.stopped) {
            try {
                const list = await this.list(stream);
                this.tracker.replace(stream.namespace, stream.kind, list.items || [], !stream.baselined);
                stream.baselined = true;
                this.contact(stream);
                delay = this.retryMinMs;

                let resourceVersion = list.metadata?.resourceVersion;
                while (!this.stopped) {
                    const outcome = await this.watch(stream, resourceVersion);
                    if (outcome.gone) {
                        break;
                    }
                    resourceVersion = outcome.resourceVersion;
                    this.contact(stream);
                }
            } catch (e) {
                if (this.stopped) {
                    return;
                }
                stream.error = e.status === 403 ? "403" : e.status ? String(e.status) : "error";
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay = Math.min(delay * 2, RETRY_MAX_MS);
            }
        }
    }

    /**
     * @param {object} stream Stream.
     * @returns {void}
     */
    contact(stream) {
        stream.lastContactAt = this.now();
        stream.error = null;
        this.contacted = true;
    }

    /**
     * Situation of the source from its streams, and the "no progress" clock of the rollouts.
     * @returns {void}
     */
    tick() {
        const now = this.now();
        const failing = new Map();
        for (const stream of this.streams) {
            if (stream.error === "403") {
                failing.set(stream.namespace, "403");
            } else if (now - stream.lastContactAt > STALE_MS && !failing.has(stream.namespace)) {
                failing.set(stream.namespace, stream.error || "no answer");
            }
        }

        if (this.contacted) {
            this.contacted = false;
            this.store.markData("cluster");
        }
        const detail = [...failing].map(([ns, why]) => `${ns}: ${why}`).join(", ") || null;
        this.store.setStaleNamespaces([...failing.keys()]);
        this.store.setSource("cluster", failing.size ? "stale" : "active", detail);
        this.tracker.tick();
    }

    /**
     * @param {object} stream Stream.
     * @returns {Promise<object>} The parsed list.
     */
    list(stream) {
        return new Promise((resolve, reject) => {
            const req = this.request(PATHS[stream.kind](stream.namespace), (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new HttpError(res.statusCode));
                    return;
                }
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                    } catch (e) {
                        reject(e);
                    }
                });
                res.on("error", reject);
            });
            req.on("error", reject);
        });
    }

    /**
     * One watch request, read line by line.
     * @param {object} stream Stream.
     * @param {string} resourceVersion Where to resume from.
     * @returns {Promise<{gone: boolean, resourceVersion?: string}>} How it ended.
     */
    watch(stream, resourceVersion) {
        const query = new URLSearchParams({
            watch: "1",
            resourceVersion: resourceVersion || "",
            timeoutSeconds: String(WATCH_TIMEOUT_S),
            allowWatchBookmarks: "true",
        });
        let current = resourceVersion;

        return new Promise((resolve, reject) => {
            let idle = null;
            let settled = false;
            const finish = (fn, value) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(idle);
                    fn(value);
                }
            };

            const req = this.request(`${PATHS[stream.kind](stream.namespace)}?${query}`, (res) => {
                if (res.statusCode === 410) {
                    res.resume();
                    finish(resolve, { gone: true });
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    finish(reject, new HttpError(res.statusCode));
                    return;
                }

                const armIdle = () => {
                    clearTimeout(idle);
                    idle = setTimeout(() => {
                        req.destroy();
                        finish(reject, new Error("watch idle"));
                    }, IDLE_MS);
                };
                armIdle();

                let buffer = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                    armIdle();
                    this.contact(stream);
                    buffer += chunk;
                    let newline;
                    while ((newline = buffer.indexOf("\n")) >= 0) {
                        const line = buffer.slice(0, newline).trim();
                        buffer = buffer.slice(newline + 1);
                        if (!line) {
                            continue;
                        }
                        let outcome;
                        try {
                            outcome = this.handleEvent(stream, line);
                        } catch (e) {
                            req.destroy();
                            finish(reject, e);
                            return;
                        }
                        if (outcome.gone) {
                            req.destroy();
                            finish(resolve, { gone: true });
                            return;
                        }
                        current = outcome.resourceVersion || current;
                    }
                });
                res.on("end", () => finish(resolve, { gone: false, resourceVersion: current }));
                res.on("error", (e) => finish(reject, e));
            });
            req.on("error", (e) => finish(reject, e));
        });
    }

    /**
     * @param {object} stream Stream.
     * @param {string} line One JSON line of the watch.
     * @returns {{gone: boolean, resourceVersion?: string}} What the event says about the watch.
     * @throws {Error} Unparseable line or an error event other than 410.
     */
    handleEvent(stream, line) {
        const event = JSON.parse(line);
        if (event.type === "ERROR") {
            if (event.object?.code === 410) {
                return { gone: true };
            }
            throw new HttpError(event.object?.code || 500);
        }
        const resourceVersion = event.object?.metadata?.resourceVersion;
        if (event.type !== "BOOKMARK") {
            this.tracker.apply(stream.kind, event.type, event.object);
        }
        return { gone: false, resourceVersion };
    }

    /**
     * GET on the API server with the current token. The token is read on every request: the
     * projected token of a ServiceAccount is rotated by the kubelet.
     * @param {string} path Path and query.
     * @param {Function} onResponse Response callback.
     * @returns {object} The request.
     */
    request(path, onResponse) {
        const token = fs.readFileSync(this.tokenFile, "utf8").trim();
        const url = new URL(path, this.baseUrl);
        const transport = url.protocol === "https:" ? https : http;
        const req = transport.get(
            url,
            {
                agent: this.agent,
                headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            },
            onResponse
        );
        this.requests.add(req);
        req.on("close", () => this.requests.delete(req));
        return req;
    }
}

module.exports = {
    WATCH_TIMEOUT_S,
    STALE_MS,
    KubernetesSource,
};
