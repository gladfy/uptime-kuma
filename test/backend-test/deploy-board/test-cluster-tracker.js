const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert");
const { ClusterTracker, JOIN_MS } = require("../../../server/deploy-board/cluster-tracker");
const { NO_PROGRESS_MS } = require("../../../server/deploy-board/rollout-state");
const { DeployBoardStore, DONE_VISIBLE_MS } = require("../../../server/deploy-board/store");
const { deployment, cronJob } = require("./k8s-fixtures");

const RELEASES = ["condominio/winker-prod", "gateway/gateway-worker", "gateway/gateway-cron", "chat/chatwoot"];

describe("Viradas por release", () => {
    let clock;
    let published;
    let tracker;

    beforeEach(() => {
        clock = 1_000_000;
        published = [];
        tracker = new ClusterTracker({ releases: RELEASES, now: () => clock, onRollout: (r) => published.push(r) });
    });

    /**
     * @param {string} release "<namespace>/<release>".
     * @returns {object|undefined} Last published state of the latest rollout of that release.
     */
    function last(release) {
        const [ns, name] = release.split("/");
        return published.filter((r) => r.namespace === ns && r.release === name).at(-1);
    }

    test("linha de base: release concluída no boot não vira deploy", () => {
        tracker.replace("condominio", "deployments", [deployment({})], true);
        assert.deepStrictEqual(published, []);
    });

    test("Kuma sobe no meio da virada do gateway-prod: aparece em andamento, marcada como achada no boot", () => {
        const releases = ["gateway/gateway-prod"];
        tracker = new ClusterTracker({ releases, now: () => clock, onRollout: (r) => published.push(r) });
        tracker.replace(
            "gateway",
            "deployments",
            [deployment({ namespace: "gateway", name: "gateway-prod", release: "gateway-prod", replicas: 16, updated: 6, total: 17 })],
            true
        );
        const r = last("gateway/gateway-prod");
        assert.strictEqual(r.state, "updating");
        assert.strictEqual(r.atBoot, true);
        assert.strictEqual(`${r.updated}/${r.desired}`, "6/16");
    });

    test("revisão nova começa a virada, que conclui junto com o critério do kubectl", () => {
        tracker.replace("condominio", "deployments", [deployment({})], true);
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 8, generation: 11, updated: 1, total: 18 }));
        assert.strictEqual(last("condominio/winker-prod").state, "updating");
        assert.strictEqual(last("condominio/winker-prod").updated, 1);

        clock += 12 * 60 * 1000;
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 8, generation: 11 }));
        const done = last("condominio/winker-prod");
        assert.strictEqual(done.state, "done");
        assert.strictEqual(done.endedAt, clock);
        assert.strictEqual(done.endedAt - done.startedAt, 12 * 60 * 1000);
    });

    test("HPA muda réplicas e geração o dia todo: nenhuma virada", () => {
        tracker.replace("condominio", "deployments", [deployment({ replicas: 8 })], true);
        tracker.apply("deployments", "MODIFIED", deployment({ replicas: 17, generation: 11, updated: 17, available: 8, total: 17 }));
        tracker.apply("deployments", "MODIFIED", deployment({ replicas: 17, generation: 11 }));
        tracker.apply("deployments", "MODIFIED", deployment({ replicas: 9, generation: 12 }));
        assert.deepStrictEqual(published, []);
    });

    test("virada concluída fica concluída: o HPA escalando depois não a reabre", () => {
        tracker.replace("condominio", "deployments", [deployment({})], true);
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 8, generation: 11 }));
        const count = published.length;
        clock += 60 * 1000;
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 8, generation: 12, replicas: 20, updated: 20, available: 17, total: 20 }));
        assert.strictEqual(published.length, count);
        assert.strictEqual(last("condominio/winker-prod").state, "done");
    });

    test("relista depois do 410 sem mudança de revisão não cria virada falsa", () => {
        tracker.replace("condominio", "deployments", [deployment({ replicas: 8 })], true);
        tracker.replace("condominio", "deployments", [deployment({ replicas: 12, generation: 11 })], false);
        assert.deepStrictEqual(published, []);
        // Controle: a mesma relista com revisão nova é virada.
        tracker.replace("condominio", "deployments", [deployment({ replicas: 12, generation: 12, revision: 8, updated: 2, total: 13 })], false);
        assert.strictEqual(last("condominio/winker-prod").state, "updating");
    });

    test("release fora da configuração é ignorada", () => {
        tracker.replace("gateway", "deployments", [deployment({ namespace: "gateway", name: "render-chrome", release: "render-chrome" })], true);
        tracker.apply("deployments", "MODIFIED", deployment({ namespace: "gateway", name: "render-chrome", release: "render-chrome", revision: 9 }));
        assert.deepStrictEqual(published, []);
    });

    test("gateway-worker: os Deployments que o helm aplica em sequência são uma virada só, que soma as réplicas", () => {
        const w = (name, o = {}) => deployment({ namespace: "gateway", name, release: "gateway-worker", replicas: 3, ...o });
        tracker.replace("gateway", "deployments", [w("a"), w("b"), w("c")], true);

        tracker.apply("deployments", "MODIFIED", w("a", { revision: 8, updated: 1, total: 4 }));
        clock += 5000;
        tracker.apply("deployments", "MODIFIED", w("b", { revision: 8, updated: 0, total: 4 }));
        const ids = new Set(published.map((r) => r.id));
        assert.strictEqual(ids.size, 1);
        const r = last("gateway/gateway-worker");
        assert.strictEqual(r.state, "updating");
        // "c" ainda não foi tocado pelo helm e está inteiro na revisão dele: conta, como a spec manda.
        assert.strictEqual(`${r.updated}/${r.desired}`, "4/9");
    });

    test("revisão nova enquanto a anterior ainda vira: a anterior é substituída e outra começa", () => {
        tracker.replace("condominio", "deployments", [deployment({})], true);
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 8, updated: 3, total: 18 }));
        const first = last("condominio/winker-prod").id;
        clock += 5 * 60 * 1000;
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 9, updated: 0, total: 18 }));

        const states = published.filter((r) => r.id === first).map((r) => r.state);
        assert.strictEqual(states.at(-1), "superseded");
        assert.notStrictEqual(last("condominio/winker-prod").id, first);
        assert.strictEqual(last("condominio/winker-prod").state, "updating");
    });

    test("gateway-cron: 95 CronJobs na imagem nova numa virada só, concluída e sem réplicas", () => {
        const crons = Array.from({ length: 95 }, (_, i) => cronJob({ name: `c${i}` }));
        tracker.replace("gateway", "cronjobs", crons, true);
        assert.deepStrictEqual(published, []);

        for (let i = 0; i < 95; i++) {
            clock += 300;
            tracker.apply("cronjobs", "MODIFIED", cronJob({ name: `c${i}`, generation: 2, tag: "2222222bbbb" }));
        }
        const r = last("gateway/gateway-cron");
        assert.strictEqual(new Set(published.map((p) => p.id)).size, 1);
        assert.strictEqual(r.state, "done");
        assert.strictEqual(r.cronJobsUpdated, 95);
        assert.strictEqual(r.desired, 0);
        assert.deepStrictEqual(r.images, ["2222222bbbb"]);
    });

    test("CronJob que muda junto conta, e não segura o concluído", () => {
        tracker.replace("gateway", "deployments", [deployment({ namespace: "gateway", name: "w", release: "gateway-worker", replicas: 2 })], true);
        tracker.replace("gateway", "cronjobs", [cronJob({ name: "limpeza", release: "gateway-worker" })], true);
        tracker.apply("deployments", "MODIFIED", deployment({ namespace: "gateway", name: "w", release: "gateway-worker", replicas: 2, revision: 8 }));
        tracker.apply("cronjobs", "MODIFIED", cronJob({ name: "limpeza", release: "gateway-worker", generation: 2, tag: "2222222bbbb" }));
        const r = last("gateway/gateway-worker");
        assert.strictEqual(r.state, "done");
        assert.strictEqual(r.cronJobsUpdated, 1);
    });

    test("CronJob suspenso ou com horário trocado à mão (geração sobe, imagem não) não é deploy", () => {
        tracker.replace("gateway", "cronjobs", [cronJob({ name: "c1" })], true);
        tracker.apply("cronjobs", "MODIFIED", cronJob({ name: "c1", generation: 2 }));
        assert.deepStrictEqual(published, []);
        // Controle: a imagem nova, sim.
        tracker.apply("cronjobs", "MODIFIED", cronJob({ name: "c1", generation: 3, tag: "2222222bbbb" }));
        assert.strictEqual(last("gateway/gateway-cron").cronJobsUpdated, 1);
    });

    test("Deployment novo nasce sem revisão e recebe a 1 logo depois: uma virada só, nada substituído", () => {
        tracker.replace("condominio", "deployments", [], true);
        const created = deployment({ updated: 0, available: 0, total: 0 });
        delete created.metadata.annotations["deployment.kubernetes.io/revision"];
        tracker.apply("deployments", "ADDED", created);
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 1, updated: 1, available: 0, total: 1 }));
        assert.strictEqual(new Set(published.map((r) => r.id)).size, 1);
        assert.ok(published.every((r) => r.state !== "superseded"));
        // Controle: a revisão 2 depois disso é virada nova.
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 2, updated: 1, total: 18 }));
        assert.strictEqual(new Set(published.map((r) => r.id)).size, 2);
    });

    test("revisão nova sobre virada TRAVADA não a substitui: ela continua publicada como travada", () => {
        tracker.replace("condominio", "deployments", [deployment({})], true);
        const stuck = [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }];
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 8, updated: 3, total: 18, conditions: stuck }));
        const first = last("condominio/winker-prod").id;
        clock += 20 * 60 * 1000;
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 9, updated: 1, total: 18 }));
        assert.deepStrictEqual(published.filter((r) => r.id === first).map((r) => r.state), ["stuck"]);
        assert.strictEqual(last("condominio/winker-prod").state, "updating");
    });

    test("sem progresso por 2 min vira 'noProgress' no tick, e volta a 'updating' quando anda", () => {
        tracker.replace("condominio", "deployments", [deployment({})], true);
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 8, updated: 4, total: 18 }));
        clock += NO_PROGRESS_MS;
        tracker.tick();
        assert.strictEqual(last("condominio/winker-prod").state, "noProgress");
        tracker.apply("deployments", "MODIFIED", deployment({ revision: 8, updated: 5, total: 18 }));
        assert.strictEqual(last("condominio/winker-prod").state, "updating");
    });

    test("Deployment removido some da soma da release", () => {
        const w = (name, o = {}) => deployment({ namespace: "gateway", name, release: "gateway-worker", replicas: 3, ...o });
        tracker.replace("gateway", "deployments", [w("a"), w("b")], true);
        tracker.apply("deployments", "MODIFIED", w("a", { revision: 8, updated: 1, total: 4 }));
        tracker.apply("deployments", "DELETED", w("b"));
        assert.strictEqual(last("gateway/gateway-worker").desired, 3);
    });

    test("a janela que junta objetos numa virada é curta", () => {
        assert.ok(JOIN_MS <= 2 * 60 * 1000);
    });
});

describe("Rastreador ligado ao estado do painel", () => {
    test("connector-access travado e deploy posterior da MESMA release: o travado fica até o novo concluir, e os dois vão para 'Hoje'", () => {
        let clock = 1_000_000;
        const store = new DeployBoardStore({ now: () => clock });
        store.setProjects([{ name: "connector-server", source: "bitbucket", releases: [{ namespace: "connector", release: "connector-access" }] }]);
        const tracker = new ClusterTracker({ releases: ["connector/connector-access"], now: () => clock, onRollout: (r) => store.upsertRollout(r) });
        const access = (o) => deployment({ namespace: "connector", name: "connector-access", release: "connector-access", replicas: 4, ...o });
        const stuck = [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }];

        tracker.replace("connector", "deployments", [access({})], true);
        tracker.apply("deployments", "MODIFIED", access({ revision: 8, tag: "aaaaaaa1111", updated: 2, available: 4, total: 5, conditions: stuck }));
        clock += 20 * 60 * 1000;
        tracker.apply("deployments", "MODIFIED", access({ revision: 9, tag: "bbbbbbb2222", updated: 1, available: 4, total: 5 }));

        let snap = store.snapshot();
        assert.deepStrictEqual(snap.deploys.map((d) => `${d.version}:${d.state}`), ["aaaaaaa:stuck", "bbbbbbb:updating"]);
        assert.deepStrictEqual(snap.history, []);

        clock += 5 * 60 * 1000;
        tracker.apply("deployments", "MODIFIED", access({ revision: 9, tag: "bbbbbbb2222" }));
        snap = store.snapshot();
        assert.deepStrictEqual(snap.deploys.map((d) => `${d.version}:${d.state}`), ["bbbbbbb:done"]);
        assert.deepStrictEqual(snap.history.map((h) => `${h.version}:${h.outcome}`), ["aaaaaaa:stuck"]);

        clock += DONE_VISIBLE_MS;
        store.tick();
        assert.deepStrictEqual(store.snapshot().history.map((h) => `${h.version}:${h.outcome}`), ["bbbbbbb:done", "aaaaaaa:stuck"]);
        store.close();
    });
});
