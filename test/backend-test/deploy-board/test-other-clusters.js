process.env.UPTIME_KUMA_HIDE_LOG = ["error_deploy-board", "info_deploy-board"].join(",");

const { describe, test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { DeployBoardStore } = require("../../../server/deploy-board/store");
const { ClusterTracker } = require("../../../server/deploy-board/cluster-tracker");
const { KubernetesSource } = require("../../../server/deploy-board/kubernetes-source");
const { DeployBoard } = require("../../../server/deploy-board");
const { deployment } = require("./k8s-fixtures");

const SHA = "c13dc62f43f7a1b2c3d4e5f6a7b8c9d0e1f2a3b4";
const OCI_RELEASE = { cluster: "oci", namespace: "ia-rag-prod", release: "rag-prod" };

/** Projects as the configuration normalizes them: one in the EKS, one in the OKE. */
const PROJECTS = [
    {
        name: "condominio",
        source: "bitbucket",
        releases: [{ cluster: null, namespace: "condominio", release: "winker-prod" }],
    },
    { name: "ia-rag", source: "bitbucket", releases: [OCI_RELEASE] },
];

/**
 * @param {object} o Fields to replace.
 * @returns {object} A rollout of rag-prod in the OKE, as the tracker of that cluster publishes it.
 */
function ociRollout(o = {}) {
    return {
        id: "oci:ia-rag-prod/rag-prod:1",
        ...OCI_RELEASE,
        atBoot: false,
        missed: false,
        startedAt: 0,
        endedAt: null,
        state: "updating",
        updated: 1,
        desired: 2,
        cronJobsUpdated: 0,
        images: [SHA],
        deployments: [],
        before: {},
        ...o,
    };
}

describe("Outro cluster (OKE) ao lado do EKS", () => {
    let clock;
    let store;

    beforeEach(() => {
        mock.timers.enable({ apis: ["setTimeout"] });
        clock = Date.UTC(2026, 10, 3, 19, 0, 0);
        store = new DeployBoardStore({ now: () => clock });
        store.setProjects(PROJECTS);
        store.addClusterSource("oci", "OCI");
        for (const id of ["cluster", "cluster:oci", "bitbucket"]) {
            store.setSource(id, "active");
        }
    });

    afterEach(() => {
        store.close();
        mock.timers.reset();
    });

    /**
     * @param {string} state Run state.
     * @returns {void}
     */
    function ragRun(state) {
        store.pipelineEvent({
            kind: "run",
            source: "bitbucket",
            project: "ia-rag",
            sha: SHA,
            branchKnown: true,
            runId: "ia-rag-1",
            name: "Pipeline",
            state,
            url: "https://bitbucket.org/winker/ia-rag/pipelines/results/1",
            startedAt: clock - 5 * 60 * 1000,
            endedAt: state === "running" ? null : clock,
        });
    }

    test("merge do ia-rag: pipeline e virada do OKE no mesmo cartão, pelo SHA", () => {
        ragRun("success");
        assert.strictEqual(store.snapshot().deploys[0].state, "built", "espera a virada no OKE");
        store.upsertRollout(ociRollout({ startedAt: clock }));

        const { deploys, sources } = store.snapshot();
        assert.strictEqual(deploys.length, 1);
        const [d] = deploys;
        assert.strictEqual(d.project, "ia-rag");
        assert.strictEqual(d.state, "updating");
        assert.strictEqual(d.confirmed, true);
        assert.deepStrictEqual(
            d.releases.map((r) => [r.cluster, r.clusterLabel, r.release]),
            [["oci", "OCI", "rag-prod"]]
        );
        assert.deepStrictEqual(d.links, ["oci:ia-rag-prod/rag-prod"]);
        assert.deepStrictEqual(sources["cluster:oci"], {
            state: "active",
            lastDataAt: null,
            detail: null,
            label: "OCI",
        });
    });

    test("OKE sem resposta: só as releases dele ficam sem confirmação, o EKS segue confirmado", () => {
        store.upsertRollout({
            ...ociRollout(),
            id: "condominio/winker-prod:1",
            cluster: null,
            namespace: "condominio",
            release: "winker-prod",
        });
        store.upsertRollout(ociRollout());
        store.setStaleNamespaces(["ia-rag-prod"], "cluster:oci");
        store.setSource("cluster:oci", "stale", "ia-rag-prod: no answer");

        const byProject = Object.fromEntries(store.snapshot().deploys.map((d) => [d.project, d.confirmed]));
        assert.deepStrictEqual(byProject, { condominio: true, "ia-rag": false });
    });

    test("namespace sem resposta num cluster não tira a confirmação do mesmo namespace no outro", () => {
        store.upsertRollout({
            ...ociRollout(),
            id: "condominio/winker-prod:1",
            cluster: null,
            namespace: "condominio",
            release: "winker-prod",
        });
        store.upsertRollout(ociRollout());
        // Cada cluster perde um namespace diferente, e o do EKS tem o nome do namespace do ia-rag no OKE.
        store.setStaleNamespaces(["ia-process-document-prod"], "cluster:oci");
        store.setSource("cluster:oci", "stale", "ia-process-document-prod: no answer");
        store.setStaleNamespaces(["ia-rag-prod"], "cluster");
        store.setSource("cluster", "stale", "ia-rag-prod: 403");

        const byProject = Object.fromEntries(store.snapshot().deploys.map((d) => [d.project, d.confirmed]));
        assert.deepStrictEqual(byProject, { condominio: true, "ia-rag": true });
    });

    test("credencial do OKE ainda não montada: pipeline verde do ia-rag fecha como No ar, sem esperar virada", () => {
        store.setSource("cluster:oci", "unconfigured");
        ragRun("success");
        const [d] = store.snapshot().deploys;
        assert.strictEqual(d.state, "done");
        assert.notStrictEqual(d.label, "noRollout");
        assert.ok(!d.steps.some((s) => s.key === "rollout"), "sem o passo da virada");

        // O projeto do EKS continua esperando a virada dele.
        store.pipelineEvent({
            kind: "run",
            source: "bitbucket",
            project: "condominio",
            sha: SHA,
            branchKnown: true,
            runId: "condominio-1",
            name: "Pipeline",
            state: "success",
            url: "https://bitbucket.org/winker/condominio/pipelines/results/1",
            startedAt: clock,
            endedAt: clock,
        });
        assert.strictEqual(store.snapshot().deploys.find((x) => x.project === "condominio").state, "built");
    });

    test("pipeline rodada de novo num commit que o OKE já roda: fecha como No ar, pela release do OKE", () => {
        const asked = [];
        store.setCommitsLookup((ref) => {
            asked.push(ref);
            return ref === "oci:ia-rag-prod/rag-prod" ? [SHA] : null;
        });
        ragRun("success");
        assert.strictEqual(store.snapshot().deploys[0].state, "done");
        assert.ok(asked.includes("oci:ia-rag-prod/rag-prod"));
    });

    test("mesmo commit no OKE sem leitura: não se afirma que já está no ar", () => {
        store.setCommitsLookup(() => [SHA]);
        store.setSource("cluster:oci", "stale", "ia-rag-prod: no answer");
        ragRun("success");
        assert.strictEqual(store.snapshot().deploys[0].state, "built");
    });

    test("mesmo namespace e release nos dois clusters: a virada do OKE vai só para o projeto do OKE", () => {
        store.setProjects([
            { name: "rag-eks", source: null, releases: [{ cluster: null, namespace: "ia", release: "ia-rag" }] },
            { name: "rag-oci", source: null, releases: [{ cluster: "oci", namespace: "ia", release: "ia-rag" }] },
        ]);
        store.upsertRollout(ociRollout({ id: "oci:ia/ia-rag:1", namespace: "ia", release: "ia-rag" }));
        assert.deepStrictEqual(
            store.snapshot().deploys.map((d) => d.project),
            ["rag-oci"]
        );
    });

    test("Como voltar de release do OKE leva o cluster, para quem copia saber onde rodar", () => {
        store.upsertRollout(ociRollout({ state: "done", endedAt: clock, updated: 2 }));
        const [plan] = store.snapshot().deploys[0].rollback.releases;
        assert.strictEqual(plan.cluster, "oci");
        assert.strictEqual(plan.clusterLabel, "OCI");
    });
});

describe("Rastreador de outro cluster", () => {
    test("a memória das versões vistas separa o objeto do OKE do de mesmo nome no EKS", () => {
        const eksKey = "deployments/ia/ia-rag";
        const known = new Map([[eksKey, "3"]]);
        const seen = [];
        const published = [];
        const options = {
            releases: ["ia/ia-rag"],
            known,
            onSeen: (key) => seen.push(key),
            onRollout: (r) => published.push(r),
        };
        const object = deployment({ namespace: "ia", name: "ia-rag", release: "ia-rag", revision: 5, tag: SHA });

        const oci = new ClusterTracker({ ...options, cluster: "oci" });
        oci.replace("ia", "deployments", [object], true);
        assert.deepStrictEqual(published, [], "o EKS ter visto a revisão 3 não faz o OKE achar que virou no boot");
        assert.deepStrictEqual(seen, ["oci:deployments/ia/ia-rag"]);

        // O mesmo objeto no tracker do EKS virou enquanto o painel estava fora.
        const eks = new ClusterTracker(options);
        eks.replace("ia", "deployments", [object], true);
        assert.strictEqual(published.length, 1);
        assert.strictEqual(published[0].cluster, null);
        assert.strictEqual(published[0].missed, true);
        assert.ok(!published[0].id.startsWith("oci:"));
    });

    test("a virada sai com o cluster e o id prefixado por ele", () => {
        const published = [];
        const tracker = new ClusterTracker({
            releases: ["ia/ia-rag"],
            cluster: "oci",
            onRollout: (r) => published.push(r),
        });
        tracker.replace(
            "ia",
            "deployments",
            [deployment({ namespace: "ia", name: "ia-rag", release: "ia-rag", revision: 5 })],
            true
        );
        tracker.apply(
            "deployments",
            "MODIFIED",
            deployment({ namespace: "ia", name: "ia-rag", release: "ia-rag", revision: 6, updated: 0 })
        );
        assert.strictEqual(published.at(-1).cluster, "oci");
        assert.match(published.at(-1).id, /^oci:ia\/ia-rag:\d+$/);
    });
});

describe("Credencial de outro cluster", () => {
    let dir;
    let store;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-board-oci-"));
        store = new DeployBoardStore();
        store.addClusterSource("oci", "OCI");
    });

    afterEach(() => {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /**
     * @returns {KubernetesSource} Source reading the credential in `dir`.
     */
    function ociSource() {
        return new KubernetesSource({
            namespaces: ["ia-rag-prod"],
            tracker: {},
            store,
            env: { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
            sourceId: "cluster:oci",
            serviceAccountDir: dir,
            serverFile: path.join(dir, "server"),
        });
    }

    test("Secret ainda não criado: a fonte do OKE fica não configurada e não usa a API do EKS", () => {
        fs.writeFileSync(path.join(dir, "token"), "t");
        const source = ociSource();
        assert.strictEqual(source.baseUrl, null);
        assert.strictEqual(source.start(), false);
        assert.strictEqual(store.snapshot().sources["cluster:oci"].state, "unconfigured");
    });

    test("endereço sem https não vale: o token não sai por texto aberto", () => {
        fs.writeFileSync(path.join(dir, "token"), "t");
        fs.writeFileSync(path.join(dir, "server"), "http://64.181.165.202:6443\n");
        assert.strictEqual(ociSource().isConfigured(), false);
    });

    test("endereço e token montados: configurada", () => {
        fs.writeFileSync(path.join(dir, "token"), "t");
        fs.writeFileSync(path.join(dir, "server"), "https://64.181.165.202:6443\n");
        const source = ociSource();
        assert.strictEqual(source.baseUrl, "https://64.181.165.202:6443");
        assert.strictEqual(source.isConfigured(), true);
    });
});

describe("Painel com dois clusters", () => {
    let dir;
    let server;
    let baseUrl;
    let routes;
    let watches;
    let requests;
    let board;

    const DEPLOYMENTS = (ns) => `/apis/apps/v1/namespaces/${ns}/deployments`;
    const HISTORY = { available: () => false, save() {}, saveObject() {} };

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-board-two-"));
        for (const name of ["eks", "oci"]) {
            fs.mkdirSync(path.join(dir, name));
            fs.writeFileSync(path.join(dir, name, "token"), `token-${name}\n`);
        }
        routes = {};
        watches = [];
        requests = [];
        server = http.createServer((req, res) => {
            const url = new URL(req.url, "http://x");
            requests.push({ path: url.pathname, auth: req.headers.authorization });
            res.writeHead(200, { "Content-Type": "application/json" });
            if (url.searchParams.get("watch") === "1") {
                watches.push({ path: url.pathname, res });
                return;
            }
            res.end(JSON.stringify({ metadata: { resourceVersion: "100" }, items: routes[url.pathname] || [] }));
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
        board?.stop();
        for (const w of watches) {
            w.res.destroy();
        }
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /**
     * @param {object} kubernetes Options of the cluster sources.
     * @returns {DeployBoard} Started board, with the EKS and the OKE of the configuration.
     */
    function startBoard(kubernetes) {
        const file = path.join(dir, "config.json");
        fs.writeFileSync(
            file,
            JSON.stringify({
                namespaces: ["condominio"],
                clusters: [{ name: "oci", namespaces: ["ia-rag-prod"] }],
                projects: [
                    { name: "condominio", releases: ["condominio/winker-prod"] },
                    { name: "ia-rag", releases: ["oci:ia-rag-prod/rag-prod"] },
                ],
            })
        );
        board = new DeployBoard({
            env: { DEPLOY_BOARD_CONFIG: file, DEPLOY_BOARD_CLUSTERS_DIR: path.join(dir, "nada") },
            history: HISTORY,
            kubernetes,
        });
        board.start(null);
        return board;
    }

    /**
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

    test("sem o Secret do OKE: o EKS lê normalmente e a fonte do OKE aparece não configurada, com o nome", async () => {
        startBoard({ baseUrl, serviceAccountDir: path.join(dir, "eks"), tickMs: 60 * 60 * 1000 });
        const { sources } = board.getSnapshot();
        assert.strictEqual(sources.cluster.state, "active");
        assert.deepStrictEqual(
            { state: sources["cluster:oci"].state, label: sources["cluster:oci"].label },
            { state: "unconfigured", label: "OCI" }
        );
        await until(() => requests.length > 0, "leitura do EKS");
        assert.ok(
            requests.every((r) => r.path.includes("/condominio/")),
            "nada pedido em nome do OKE"
        );
    });

    test("virada no OKE chega ao cartão do ia-rag, lida com o token do OKE", async () => {
        routes[DEPLOYMENTS("ia-rag-prod")] = [
            deployment({ namespace: "ia-rag-prod", name: "rag-prod", release: "rag-prod", revision: 4, replicas: 2 }),
        ];
        startBoard({
            baseUrl,
            serviceAccountDir: path.join(dir, "eks"),
            tickMs: 60 * 60 * 1000,
            clusters: { oci: { baseUrl, serviceAccountDir: path.join(dir, "oci"), tickMs: 60 * 60 * 1000 } },
        });
        await until(() => watches.some((w) => w.path === DEPLOYMENTS("ia-rag-prod")), "watch do OKE");
        assert.strictEqual(board.getSnapshot().sources["cluster:oci"].state, "active");

        const watch = watches.find((w) => w.path === DEPLOYMENTS("ia-rag-prod"));
        const object = deployment({
            namespace: "ia-rag-prod",
            name: "rag-prod",
            release: "rag-prod",
            revision: 5,
            replicas: 2,
            updated: 1,
            tag: SHA,
            resourceVersion: 101,
        });
        watch.res.write(JSON.stringify({ type: "MODIFIED", object }) + "\n");
        await until(() => board.getSnapshot().deploys.length > 0, "cartão do ia-rag");

        const [d] = board.getSnapshot().deploys;
        assert.strictEqual(d.project, "ia-rag");
        assert.strictEqual(d.version, SHA.slice(0, 7));
        assert.deepStrictEqual(d.links, ["oci:ia-rag-prod/rag-prod"]);
        const oci = requests.filter((r) => r.path.includes("/ia-rag-prod/"));
        assert.ok(oci.length > 0 && oci.every((r) => r.auth === "Bearer token-oci"));
        assert.ok(requests.filter((r) => r.path.includes("/condominio/")).every((r) => r.auth === "Bearer token-eks"));
    });
});
