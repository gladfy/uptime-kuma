const { describe, test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const {
    DeployBoardStore,
    SOURCE_IDS,
    DEPLOY_PUBLIC_FIELDS,
    HISTORY_PUBLIC_FIELDS,
    EMIT_INTERVAL_MS,
    DONE_VISIBLE_MS,
    HISTORY_MS,
    HISTORY_MAX,
    GROUP_WINDOW_MS,
    ROLLOUT_RECORD_FIELDS,
    STATS_FIELDS,
} = require("../../../server/deploy-board/store");

const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const SHA2 = "0f9e8d7c6b5a0f9e8d7c6b5a0f9e8d7c6b5a0f9e";

/** Projects of the configuration, already normalized. */
const PROJECTS = [
    {
        name: "condominio",
        source: "bitbucket",
        releases: [
            { namespace: "condominio", release: "winker-prod" },
            { namespace: "condominio", release: "winker-integration" },
        ],
    },
    {
        name: "connector-server",
        source: "bitbucket",
        releases: [
            { namespace: "connector", release: "connector-access" },
            { namespace: "connector", release: "connector-worker" },
        ],
    },
    { name: "chat", source: "github", releases: [{ namespace: "chat", release: "chatwoot" }] },
];

describe("Estado do painel de deploys", () => {
    let clock;
    let store;

    beforeEach(() => {
        mock.timers.enable({ apis: ["setTimeout"] });
        clock = 1_000_000;
        store = new DeployBoardStore({ now: () => clock });
    });

    afterEach(() => {
        store.close();
        mock.timers.reset();
    });

    /**
     * Advance the injected clock and the mocked timers together.
     * @param {number} ms Milliseconds.
     * @returns {void}
     */
    function advance(ms) {
        clock += ms;
        mock.timers.tick(ms);
    }

    /**
     * A rollout as the cluster tracker publishes it.
     * @param {object} o Overrides.
     * @returns {object} Rollout.
     */
    function rollout(o = {}) {
        return {
            id: "condominio/winker-prod:1",
            namespace: "condominio",
            release: "winker-prod",
            atBoot: false,
            startedAt: clock,
            endedAt: null,
            state: "updating",
            updated: 9,
            desired: 17,
            cronJobsUpdated: 0,
            images: [SHA, "1.27"],
            ...o,
        };
    }

    test("toda fonte nasce não configurada, e o snapshot traz as quatro", () => {
        const { sources } = store.snapshot();
        assert.deepStrictEqual(Object.keys(sources), SOURCE_IDS);
        for (const id of SOURCE_IDS) {
            assert.deepStrictEqual(sources[id], { state: "unconfigured", lastDataAt: null, detail: null });
        }
    });

    test("estado desconhecido e fonte desconhecida lançam", () => {
        assert.throws(() => store.setSource("cluster", "ok"), /Unknown source state/);
        assert.throws(() => store.setSource("jenkins", "active"), /Unknown deploy source/);
    });

    test("dado novo reativa a fonte sem leitura e limpa o motivo", () => {
        store.setSource("cluster", "stale", "403 em gateway");
        store.markData("cluster");
        assert.deepStrictEqual(store.snapshot().sources.cluster, {
            state: "active",
            lastDataAt: clock,
            detail: null,
        });
    });

    test("o snapshot só leva os campos permitidos de um deploy e do histórico", () => {
        store.setProjects(PROJECTS);
        store.setSource("cluster", "active");
        store.upsertRollout(rollout({ token: "segredo-plantado" }));
        store.deploys[0].env = { DB_PASSWORD: "segredo-plantado" };
        // Controle positivo: o registro interno tem os campos; o que sai é só a lista permitida.
        assert.ok(JSON.stringify([...store.deploys[0].rollouts.values()]).includes("segredo-plantado"));
        assert.ok(!JSON.stringify(store.snapshot()).includes("segredo-plantado"));
        assert.deepStrictEqual(Object.keys(store.snapshot().deploys[0]).sort(), [...DEPLOY_PUBLIC_FIELDS].sort());

        store.upsertRollout(rollout({ state: "done", endedAt: clock }));
        advance(DONE_VISIBLE_MS);
        store.tick();
        const { history } = store.snapshot();
        assert.strictEqual(history.length, 1);
        assert.deepStrictEqual(Object.keys(history[0]).sort(), [...HISTORY_PUBLIC_FIELDS].sort());
        assert.ok(!JSON.stringify(history).includes("segredo-plantado"));
    });

    test("difusão: a primeira mudança sai na hora, as seguintes juntam numa só por intervalo", () => {
        const received = [];
        store.onChange((s) => received.push(s));

        store.setSource("cluster", "active");
        assert.strictEqual(received.length, 1);

        store.setSource("github", "active");
        store.setSource("bitbucket", "active");
        assert.strictEqual(received.length, 1, "dentro do intervalo nada sai");

        advance(EMIT_INTERVAL_MS);
        assert.strictEqual(received.length, 2);
        // A emissão atrasada carrega tudo que mudou no intervalo.
        assert.strictEqual(received[1].sources.github.state, "active");
        assert.strictEqual(received[1].sources.bitbucket.state, "active");
    });

    test("mudança que não muda nada não difunde", () => {
        const received = [];
        store.onChange((s) => received.push(s));
        store.setSource("cluster", "unconfigured");
        assert.strictEqual(received.length, 0);
    });

    test("um ouvinte que lança não impede os outros", () => {
        const received = [];
        store.onChange(() => {
            throw new Error("socket fechado");
        });
        store.onChange((s) => received.push(s));
        store.setSource("amplify", "active");
        assert.strictEqual(received.length, 1);
    });

    describe("deploys vindos do cluster", () => {
        beforeEach(() => {
            store.setProjects(PROJECTS);
            store.setSource("cluster", "active");
        });

        test("virada vira deploy do projeto, com a linha da release e o SHA curto", () => {
            store.upsertRollout(rollout());
            const [d] = store.snapshot().deploys;
            assert.strictEqual(d.project, "condominio");
            assert.strictEqual(d.version, SHA.slice(0, 7));
            assert.strictEqual(d.state, "updating");
            assert.strictEqual(d.confirmed, true);
            assert.deepStrictEqual(d.releases, [
                { namespace: "condominio", release: "winker-prod", state: "updating", updated: 9, desired: 17, cronJobsUpdated: 0, atBoot: false },
            ]);
        });

        test("fonte de pipeline desligada: o rótulo é o da virada, nunca 'Sem pipeline'", () => {
            const labels = {};
            for (const state of ["updating", "noProgress", "stuck", "done"]) {
                store.upsertRollout(rollout({ state, endedAt: state === "done" ? clock : null }));
                labels[state] = store.snapshot().deploys[0].label;
            }
            assert.deepStrictEqual(labels, { updating: "rolling", noProgress: "noProgress", stuck: "stuck", done: "live" });
        });

        test("fonte de pipeline do projeto configurada e nenhuma pipeline casada: 'Sem pipeline'", () => {
            store.setSource("bitbucket", "active");
            store.upsertRollout(rollout());
            assert.strictEqual(store.snapshot().deploys[0].label, "noPipeline");
            // A fonte de OUTRO projeto não conta: o chat é do GitHub.
            store.upsertRollout(rollout({ id: "chat/chatwoot:1", namespace: "chat", release: "chatwoot", images: ["prod"] }));
            const chat = store.snapshot().deploys.find((d) => d.project === "chat");
            assert.strictEqual(chat.label, "rolling");
        });

        test("projeto sem origem de pipeline nunca é 'Sem pipeline', mesmo com as fontes de pipeline ligadas", () => {
            store.setProjects([
                ...PROJECTS,
                { name: "temporal", source: null, releases: [{ namespace: "temporal", release: "temporal" }] },
            ]);
            store.setSource("bitbucket", "active");
            store.setSource("github", "active");
            store.upsertRollout(rollout({ id: "temporal/temporal:1", namespace: "temporal", release: "temporal", images: ["1.26.2"] }));
            const temporal = store.snapshot().deploys.find((d) => d.project === "temporal");
            assert.strictEqual(temporal.label, "rolling");
            // Controle: na mesma situação, o projeto com origem ganha o rótulo.
            store.upsertRollout(rollout());
            const condominio = store.snapshot().deploys.find((d) => d.project === "condominio");
            assert.strictEqual(condominio.label, "noPipeline");
        });

        test("releases do mesmo commit são um deploy só; outro commit é outro deploy", () => {
            store.upsertRollout(rollout());
            store.upsertRollout(rollout({ id: "condominio/winker-integration:1", release: "winker-integration", desired: 2, updated: 0 }));
            assert.strictEqual(store.snapshot().deploys.length, 1);
            assert.deepStrictEqual(store.snapshot().deploys[0].releases.map((r) => r.release), ["winker-prod", "winker-integration"]);

            store.upsertRollout(rollout({ id: "connector/connector-access:1", namespace: "connector", release: "connector-access", images: [SHA2] }));
            assert.strictEqual(store.snapshot().deploys.length, 2);
        });

        test("sem SHA na tag (chat 'prod'): junta pela janela do projeto, e fora dela é outro deploy", () => {
            const chat = (n, o) => rollout({ id: `chat/chatwoot:${n}`, namespace: "chat", release: "chatwoot", images: ["prod"], ...o });
            PROJECTS[2].releases.push({ namespace: "chat", release: "chatwoot-extra" });
            try {
                store.setProjects(PROJECTS);
                store.upsertRollout(chat(1));
                advance(GROUP_WINDOW_MS - 1000);
                store.upsertRollout(chat(2, { release: "chatwoot-extra" }));
                assert.strictEqual(store.snapshot().deploys.length, 1);
            } finally {
                PROJECTS[2].releases.pop();
            }
        });

        test("release fora de todo projeto não aparece", () => {
            store.upsertRollout(rollout({ id: "gateway/render-chrome:1", namespace: "gateway", release: "render-chrome" }));
            assert.deepStrictEqual(store.snapshot().deploys, []);
        });

        test("ordem dos cartões: travado, sem progresso, atualizando, concluído", () => {
            store.upsertRollout(rollout({ id: "a", state: "done", endedAt: clock }));
            store.upsertRollout(rollout({ id: "b", namespace: "connector", release: "connector-access", state: "stuck", images: [SHA2] }));
            store.upsertRollout(rollout({ id: "c", namespace: "chat", release: "chatwoot", images: ["prod"] }));
            store.upsertRollout(rollout({ id: "d", namespace: "connector", release: "connector-worker", state: "noProgress", images: ["3333333"] }));
            assert.deepStrictEqual(store.snapshot().deploys.map((d) => d.state), ["stuck", "noProgress", "updating", "done"]);
        });

        test("concluído fica 10 min na tela e vai para o histórico com a duração", () => {
            const startedAt = clock;
            store.upsertRollout(rollout());
            advance(12 * 60 * 1000);
            store.upsertRollout(rollout({ startedAt, state: "done", endedAt: clock }));
            advance(DONE_VISIBLE_MS - 1);
            store.tick();
            assert.strictEqual(store.snapshot().deploys.length, 1);
            advance(1);
            store.tick();
            const snap = store.snapshot();
            assert.strictEqual(snap.deploys.length, 0);
            assert.strictEqual(snap.history[0].outcome, "done");
            assert.strictEqual(snap.history[0].endedAt - snap.history[0].startedAt, 12 * 60 * 1000);
            assert.deepStrictEqual(snap.history[0].releases, [{ namespace: "condominio", release: "winker-prod" }]);
        });

        test("virada travada sai quando um deploy posterior do projeto conclui, e os dois ficam no histórico", () => {
            const access = (o) => rollout({ namespace: "connector", release: "connector-access", images: [SHA2], ...o });
            store.upsertRollout(access({ id: "connector/connector-access:1", state: "stuck" }));
            advance(DONE_VISIBLE_MS * 3);
            store.tick();
            assert.strictEqual(store.snapshot().deploys[0].state, "stuck", "travado não sai sozinho com o tempo");

            store.upsertRollout(rollout({ id: "connector/connector-worker:1", namespace: "connector", release: "connector-worker", images: [SHA], state: "done", endedAt: clock }));
            const snap = store.snapshot();
            assert.deepStrictEqual(snap.deploys.map((d) => d.state), ["done"]);
            assert.strictEqual(snap.history[0].outcome, "stuck");
            advance(DONE_VISIBLE_MS);
            store.tick();
            assert.deepStrictEqual(store.snapshot().history.map((h) => h.outcome), ["done", "stuck"]);
        });

        test("virada substituída por outra revisão vai para o histórico como substituída", () => {
            store.upsertRollout(rollout());
            store.upsertRollout(rollout({ state: "superseded", endedAt: clock + 1000 }));
            const snap = store.snapshot();
            assert.deepStrictEqual(snap.deploys, []);
            assert.strictEqual(snap.history[0].outcome, "replaced");
        });

        test("histórico: só as últimas 24 h, no máximo 500, os mais recentes primeiro", () => {
            for (let i = 0; i < HISTORY_MAX + 20; i++) {
                store.upsertRollout(rollout({ id: `r${i}`, images: [`${String(i).padStart(7, "0")}`], state: "superseded", endedAt: clock }));
                advance(1000);
            }
            let { history } = store.snapshot();
            assert.strictEqual(history.length, HISTORY_MAX);
            assert.ok(history[0].endedAt > history[1].endedAt);

            advance(HISTORY_MS);
            store.tick();
            history = store.snapshot().history;
            assert.strictEqual(history.length, 0);
        });

        test("namespace sem leitura: os deploys dele não estão confirmados, os outros sim", () => {
            store.upsertRollout(rollout());
            store.upsertRollout(rollout({ id: "chat/chatwoot:1", namespace: "chat", release: "chatwoot", images: ["prod"] }));
            store.setSource("cluster", "stale", "chat: 403");
            store.setStaleNamespaces(["chat"]);
            const byProject = Object.fromEntries(store.snapshot().deploys.map((d) => [d.project, d.confirmed]));
            assert.deepStrictEqual(byProject, { condominio: true, chat: false });
        });
    });

    describe("histórico gravado e reaberto pelo commit", () => {
        const integration = (o) => rollout({ id: "condominio/winker-integration:1", release: "winker-integration", desired: 2, updated: 2, ...o });
        const prod = (o) => rollout({ id: "condominio/winker-prod:1", ...o });

        beforeEach(() => {
            store.setProjects(PROJECTS);
            store.setSource("cluster", "active");
        });

        test("integration e prod do mesmo commit, 26 min depois: um registro com as duas releases (31/10)", () => {
            store.upsertRollout(integration({ state: "done", endedAt: clock }));
            advance(DONE_VISIBLE_MS);
            store.tick();
            assert.strictEqual(store.snapshot().history.length, 1, "o integration já saiu para o histórico");

            advance(16 * 60 * 1000);
            store.upsertRollout(prod({ startedAt: clock }));
            let snap = store.snapshot();
            assert.strictEqual(snap.history.length, 0, "o registro voltou a ser cartão");
            assert.strictEqual(snap.deploys.length, 1);
            assert.strictEqual(snap.deploys[0].state, "updating");
            assert.deepStrictEqual(snap.deploys[0].releases.map((r) => r.release), ["winker-integration", "winker-prod"]);

            store.upsertRollout(prod({ startedAt: clock, state: "done", endedAt: clock + 1000, updated: 17 }));
            advance(DONE_VISIBLE_MS + 1000);
            store.tick();
            snap = store.snapshot();
            assert.strictEqual(snap.history.length, 1);
            assert.deepStrictEqual(snap.history[0].releases.map((r) => r.release), ["winker-integration", "winker-prod"]);
        });

        test("a mesma release no mesmo commit, publicada de novo, é outro deploy", () => {
            store.upsertRollout(integration({ state: "done", endedAt: clock }));
            advance(DONE_VISIBLE_MS);
            store.tick();
            store.upsertRollout(integration({ id: "condominio/winker-integration:2", startedAt: clock }));
            const snap = store.snapshot();
            assert.strictEqual(snap.history.length, 1, "o registro antigo fica no histórico");
            assert.strictEqual(snap.deploys.length, 1);
            assert.notStrictEqual(snap.deploys[0].id, snap.history[0].id);
        });

        test("grava ao encerrar e ao sair da tela, só com os campos permitidos", () => {
            const saved = [];
            store.persist = (record) => saved.push(record);
            store.upsertRollout(prod({ token: "segredo-plantado" }));
            assert.strictEqual(saved.length, 0, "em andamento não grava");
            // Controle: o campo plantado está no registro interno, então a ausência abaixo é da lista permitida.
            assert.ok(JSON.stringify([...store.deploys[0].rollouts.values()]).includes("segredo-plantado"));

            store.upsertRollout(prod({ token: "segredo-plantado", state: "done", endedAt: clock }));
            assert.strictEqual(saved.length, 1, "grava assim que conclui, ainda na tela");
            advance(DONE_VISIBLE_MS);
            store.tick();
            assert.strictEqual(saved.length, 2, "grava de novo ao sair para o histórico");
            assert.strictEqual(saved[0].id, saved[1].id, "o mesmo registro, para o upsert");
            assert.strictEqual(saved[1].outcome, "done");

            assert.deepStrictEqual(Object.keys(saved[1]).sort(), ["endedAt", "id", "missed", "outcome", "pipeline", "project", "releases", "rollouts", "sha", "startedAt", "version"]);
            for (const r of saved[1].rollouts) {
                assert.ok(Object.keys(r).every((k) => ROLLOUT_RECORD_FIELDS.includes(k)), Object.keys(r).join(","));
            }
            assert.ok(!JSON.stringify(saved).includes("segredo-plantado"));
        });

        test("uma gravação que lança não derruba o painel", () => {
            store.persist = () => {
                throw new Error("banco fora");
            };
            store.upsertRollout(prod({ state: "done", endedAt: clock }));
            assert.strictEqual(store.snapshot().deploys[0].state, "done");
        });

        test("restore: o histórico volta, fora das 24 h fica de fora, e o commit carregado reabre", () => {
            const saved = [];
            store.persist = (record) => saved.push(record);
            store.upsertRollout(integration({ state: "done", endedAt: clock }));
            advance(DONE_VISIBLE_MS);
            store.tick();
            const record = saved[saved.length - 1];
            const old = { ...record, id: "condominio:velho", endedAt: clock - HISTORY_MS - 1 };

            // Um processo novo, depois do reinício.
            const next = new DeployBoardStore({ now: () => clock });
            try {
                next.setProjects(PROJECTS);
                next.setSource("cluster", "active");
                next.restore([record, old]);
                assert.deepStrictEqual(next.snapshot().history.map((h) => h.id), [record.id]);

                // O contador do rastreador recomeçou: o mesmo id de virada não pode cair no registro carregado.
                next.upsertRollout(prod({ id: "condominio/winker-integration:1", namespace: "condominio", release: "winker-prod" }));
                const snap = next.snapshot();
                assert.strictEqual(snap.history.length, 0);
                assert.deepStrictEqual(snap.deploys.map((d) => d.id), [record.id], "reabriu o registro carregado");
                assert.deepStrictEqual(snap.deploys[0].releases.map((r) => r.release), ["winker-integration", "winker-prod"]);
            } finally {
                next.close();
            }
        });

        test("o id de um deploy novo não colide com o de um carregado", () => {
            store.upsertRollout(prod({ state: "done", endedAt: clock }));
            const first = store.snapshot().deploys[0].id;
            const next = new DeployBoardStore({ now: () => clock + 1 });
            try {
                next.setProjects(PROJECTS);
                next.upsertRollout(prod({ images: [SHA2, "1.27"] }));
                assert.notStrictEqual(next.snapshot().deploys[0].id, first);
            } finally {
                next.close();
            }
        });
    });

    describe("indicadores das últimas 24 h", () => {
        /**
         * @param {string} id Deploy id.
         * @param {string} outcome Outcome.
         * @param {number} ago How long ago it ended.
         * @returns {object} History record.
         */
        function ended(id, outcome, ago) {
            return { id, project: "condominio", version: "x", sha: null, outcome, startedAt: clock - ago - 1000, endedAt: clock - ago, releases: [], rollouts: [] };
        }

        beforeEach(() => {
            store.setProjects(PROJECTS);
            store.setSource("cluster", "active");
        });

        test("o cenário da spec: 11 concluídos, 1 travado, 2 substituídos e 1 em andamento", () => {
            const records = [];
            for (let i = 0; i < 11; i++) {
                records.push(ended(`d${i}`, "done", (i + 1) * 60 * 1000));
            }
            records.push(ended("s", "stuck", 30 * 60 * 1000), ended("r1", "replaced", 40 * 60 * 1000), ended("r2", "replaced", 50 * 60 * 1000));
            store.restore(records);
            store.upsertRollout(rollout());
            assert.deepStrictEqual(store.snapshot().stats, { total: 15, done: 11, stuck: 1, failed: 0, replaced: 2, noRollout: 0, inProgress: 1, successRate: 92 });
            assert.deepStrictEqual(Object.keys(store.snapshot().stats).sort(), [...STATS_FIELDS].sort());
        });

        test("conta por deploy: integration e prod do mesmo commit são um, e o reaberto conta uma vez", () => {
            const integration = rollout({ id: "condominio/winker-integration:1", release: "winker-integration", state: "done", endedAt: clock });
            store.upsertRollout(integration);
            advance(DONE_VISIBLE_MS);
            store.tick();
            assert.strictEqual(store.snapshot().stats.total, 1);

            store.upsertRollout(rollout({ startedAt: clock }));
            assert.deepStrictEqual(
                (({ total, done, inProgress }) => ({ total, done, inProgress }))(store.snapshot().stats),
                { total: 1, done: 0, inProgress: 1 },
                "reaberto: um deploy, em andamento"
            );
            store.upsertRollout(rollout({ startedAt: clock, state: "done", endedAt: clock + 1000 }));
            assert.strictEqual(store.snapshot().stats.total, 1);
            assert.strictEqual(store.snapshot().stats.done, 1);
        });

        test("sem nenhum encerrado a taxa é null, e não 0 nem 100", () => {
            assert.strictEqual(store.snapshot().stats.successRate, null);
            store.upsertRollout(rollout());
            assert.strictEqual(store.snapshot().stats.successRate, null, "em andamento não entra na taxa");
            store.restore([ended("r", "replaced", 1000)]);
            assert.strictEqual(store.snapshot().stats.successRate, null, "substituído também não");
        });

        test("passadas 24 h o deploy sai da conta", () => {
            store.restore([ended("d", "done", 1000)]);
            assert.strictEqual(store.snapshot().stats.total, 1);
            advance(HISTORY_MS);
            store.tick();
            assert.deepStrictEqual(store.snapshot().stats, { total: 0, done: 0, stuck: 0, failed: 0, replaced: 0, noRollout: 0, inProgress: 0, successRate: null });
        });
    });
});
