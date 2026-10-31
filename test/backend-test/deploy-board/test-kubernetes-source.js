const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { KubernetesSource } = require("../../../server/deploy-board/kubernetes-source");
const { ClusterTracker } = require("../../../server/deploy-board/cluster-tracker");
const { DeployBoardStore } = require("../../../server/deploy-board/store");
const { deployment } = require("./k8s-fixtures");

const DEPLOYMENTS = (ns) => `/apis/apps/v1/namespaces/${ns}/deployments`;
const CRONJOBS = (ns) => `/apis/batch/v1/namespaces/${ns}/cronjobs`;

/**
 * Wait until a condition holds.
 * @param {Function} condition Returns truthy when done.
 * @param {string} what Description for the failure.
 * @returns {Promise<void>} Resolves when it holds.
 */
async function until(condition, what) {
    const deadline = Date.now() + 3000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for: ${what}`);
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}

describe("Coletor do cluster", () => {
    let dir;
    let server;
    let baseUrl;
    let routes;
    let watches;
    let requests;
    let store;
    let source;
    let rollouts;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-board-k8s-"));
        fs.writeFileSync(path.join(dir, "token"), "token-de-teste\n");
        routes = {};
        watches = [];
        requests = [];

        server = http.createServer((req, res) => {
            const url = new URL(req.url, "http://x");
            requests.push({ path: url.pathname, watch: url.searchParams.get("watch") === "1", auth: req.headers.authorization });
            const route = routes[url.pathname] || { list: () => ({ status: 200, body: { metadata: { resourceVersion: "1" }, items: [] } }) };

            if (url.searchParams.get("watch") === "1") {
                const status = route.watchStatus ? route.watchStatus() : 200;
                res.writeHead(status, { "Content-Type": "application/json" });
                if (status !== 200) {
                    res.end("{}");
                    return;
                }
                watches.push({ path: url.pathname, resourceVersion: url.searchParams.get("resourceVersion"), res });
                return;
            }
            const { status, body } = route.list();
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;

        store = new DeployBoardStore();
        rollouts = [];
    });

    afterEach(async () => {
        source?.stop();
        store.close();
        for (const w of watches) {
            w.res.destroy();
        }
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /**
     * @param {string[]} namespaces Namespaces.
     * @param {string[]} releases Tracked releases.
     * @returns {KubernetesSource} Started source.
     */
    function startSource(namespaces, releases) {
        const tracker = new ClusterTracker({ releases, onRollout: (r) => rollouts.push(r) });
        source = new KubernetesSource({
            namespaces,
            tracker,
            store,
            baseUrl,
            serviceAccountDir: dir,
            tickMs: 60 * 60 * 1000,
            retryMinMs: 10,
        });
        assert.strictEqual(source.start(), true);
        return source;
    }

    /**
     * @param {object} obj Deployment.
     * @returns {Function} List route returning it.
     */
    function listOf(obj) {
        return () => ({ status: 200, body: { metadata: { resourceVersion: "100" }, items: [obj] } });
    }

    test("sem token da conta de serviço: fonte não configurada e nada é iniciado", () => {
        fs.rmSync(path.join(dir, "token"));
        source = new KubernetesSource({ namespaces: ["condominio"], tracker: {}, store, baseUrl, serviceAccountDir: dir });
        assert.strictEqual(source.start(), false);
        assert.strictEqual(store.snapshot().sources.cluster.state, "unconfigured");
        assert.strictEqual(requests.length, 0);

        // Fora do Kubernetes nem o endereço da API existe.
        const outside = new KubernetesSource({ namespaces: ["condominio"], tracker: {}, store, env: {} });
        assert.strictEqual(outside.isConfigured(), false);
    });

    test("lista, depois watch com o resourceVersion da lista e o token da conta de serviço", async () => {
        routes[DEPLOYMENTS("condominio")] = { list: listOf(deployment({})) };
        startSource(["condominio"], ["condominio/winker-prod"]);
        await until(() => watches.some((w) => w.path === DEPLOYMENTS("condominio")), "watch de deployments");

        const watch = watches.find((w) => w.path === DEPLOYMENTS("condominio"));
        assert.strictEqual(watch.resourceVersion, "100");
        assert.ok(requests.every((r) => r.auth === "Bearer token-de-teste"));
        assert.ok(requests.some((r) => r.path === CRONJOBS("condominio")), "também observa CronJobs");
        assert.deepStrictEqual(rollouts, [], "a linha de base não é virada");
        assert.strictEqual(store.snapshot().sources.cluster.state, "active");
    });

    test("evento partido no meio da linha chega inteiro ao rastreador", async () => {
        routes[DEPLOYMENTS("condominio")] = { list: listOf(deployment({})) };
        startSource(["condominio"], ["condominio/winker-prod"]);
        await until(() => watches.some((w) => w.path === DEPLOYMENTS("condominio")), "watch");
        const watch = watches.find((w) => w.path === DEPLOYMENTS("condominio"));

        const line = JSON.stringify({ type: "MODIFIED", object: deployment({ revision: 8, updated: 2, total: 18, resourceVersion: 101 }) }) + "\n";
        const cut = Math.floor(line.length / 2);
        watch.res.write(line.slice(0, cut));
        await new Promise((r) => setTimeout(r, 20));
        assert.deepStrictEqual(rollouts, [], "meia linha não é evento");
        watch.res.write(line.slice(cut));

        await until(() => rollouts.length > 0, "virada publicada");
        assert.strictEqual(rollouts[0].state, "updating");
        assert.strictEqual(rollouts[0].updated, 2);
    });

    test("410 no watch: lista de novo, retoma, e nenhuma virada aparece para o que não mudou", async () => {
        let lists = 0;
        let watchCalls = 0;
        routes[DEPLOYMENTS("condominio")] = {
            list: () => {
                lists++;
                return listOf(deployment({ replicas: lists === 1 ? 8 : 12, generation: 10 + lists }))();
            },
            watchStatus: () => (++watchCalls === 1 ? 410 : 200),
        };
        startSource(["condominio"], ["condominio/winker-prod"]);
        await until(() => lists === 2 && watches.some((w) => w.path === DEPLOYMENTS("condominio")), "relista e watch retomado");
        assert.deepStrictEqual(rollouts, []);
    });

    test("410 dentro do stream (evento ERROR) também relista", async () => {
        let lists = 0;
        routes[DEPLOYMENTS("condominio")] = {
            list: () => {
                lists++;
                return listOf(deployment({}))();
            },
        };
        startSource(["condominio"], ["condominio/winker-prod"]);
        await until(() => watches.some((w) => w.path === DEPLOYMENTS("condominio")), "watch");
        watches.find((w) => w.path === DEPLOYMENTS("condominio")).res.write(
            JSON.stringify({ type: "ERROR", object: { kind: "Status", code: 410, reason: "Expired" } }) + "\n"
        );
        await until(() => lists === 2, "relista");
        assert.deepStrictEqual(rollouts, []);
    });

    test("403 num namespace: o rodapé nomeia o namespace e os outros continuam observados", async () => {
        routes[DEPLOYMENTS("condominio")] = { list: listOf(deployment({})) };
        routes[DEPLOYMENTS("chat")] = { list: () => ({ status: 403, body: { kind: "Status", code: 403 } }) };
        routes[CRONJOBS("chat")] = { list: () => ({ status: 403, body: { kind: "Status", code: 403 } }) };
        startSource(["condominio", "chat"], ["condominio/winker-prod", "chat/chatwoot"]);

        await until(() => requests.filter((r) => r.path === DEPLOYMENTS("chat")).length >= 2, "nova tentativa no chat");
        await until(() => watches.some((w) => w.path === DEPLOYMENTS("condominio")), "watch do condominio");
        source.tick();
        const { cluster } = store.snapshot().sources;
        assert.strictEqual(cluster.state, "stale");
        assert.strictEqual(cluster.detail, "chat: 403");
        assert.deepStrictEqual([...store.staleNamespaces], ["chat"]);

        // O condominio continua sendo lido.
        watches
            .find((w) => w.path === DEPLOYMENTS("condominio"))
            .res.write(JSON.stringify({ type: "MODIFIED", object: deployment({ revision: 8, updated: 1, total: 18 }) }) + "\n");
        await until(() => rollouts.length > 0, "virada no condominio");
    });

    test("watch que termina normalmente é reaberto do último resourceVersion, sem nova lista", async () => {
        let lists = 0;
        routes[DEPLOYMENTS("condominio")] = {
            list: () => {
                lists++;
                return listOf(deployment({}))();
            },
        };
        startSource(["condominio"], ["condominio/winker-prod"]);
        await until(() => watches.some((w) => w.path === DEPLOYMENTS("condominio")), "watch");
        const first = watches.find((w) => w.path === DEPLOYMENTS("condominio"));
        first.res.write(JSON.stringify({ type: "BOOKMARK", object: { metadata: { resourceVersion: "250" } } }) + "\n");
        first.res.end();

        await until(() => watches.filter((w) => w.path === DEPLOYMENTS("condominio")).length === 2, "watch reaberto");
        assert.strictEqual(watches.filter((w) => w.path === DEPLOYMENTS("condominio"))[1].resourceVersion, "250");
        assert.strictEqual(lists, 1);
    });
});
