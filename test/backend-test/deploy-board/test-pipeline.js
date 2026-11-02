const { describe, test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const {
    DeployBoardStore,
    DONE_VISIBLE_MS,
    NO_ROLLOUT_MS,
    NO_ROLLOUT_LEAVE_MS,
    MERGE_WAIT_MS,
    RUN_SILENT_MS,
} = require("../../../server/deploy-board/store");

const SHA = "c13dc62f43f7a1b2c3d4e5f6a7b8c9d0e1f2a3b4";
const SHA2 = "0f9e8d7c6b5a0f9e8d7c6b5a0f9e8d7c6b5a0f9e";
const MIN = 60 * 1000;

const PROJECTS = [
    {
        name: "condominio",
        source: "bitbucket",
        releases: [
            { namespace: "condominio", release: "winker-prod" },
            { namespace: "condominio", release: "winker-integration" },
        ],
    },
    { name: "chat", source: "github", releases: [{ namespace: "chat", release: "chatwoot" }] },
    { name: "uptime-kuma", source: "github", releases: [{ namespace: "monitor-infra", release: "uptime-kuma" }] },
    { name: "agua-gas", source: null, releases: [{ namespace: "microservices-prod", release: "agua-gas" }] },
];

describe("Pipeline e virada viram um deploy só", () => {
    let clock;
    let store;
    let saved;

    beforeEach(() => {
        mock.timers.enable({ apis: ["setTimeout"] });
        clock = Date.UTC(2026, 10, 2, 19, 0, 0);
        saved = [];
        store = new DeployBoardStore({ now: () => clock, persist: (r) => saved.push(r) });
        store.setProjects(PROJECTS);
        for (const id of ["cluster", "bitbucket", "github"]) {
            store.setSource(id, "active");
        }
    });

    afterEach(() => {
        store.close();
        mock.timers.reset();
    });

    /**
     * @param {number} ms Milliseconds to move the clock.
     * @returns {void}
     */
    function tick(ms) {
        clock += ms;
    }

    /**
     * @param {string} project Project.
     * @param {string} sha Commit.
     * @param {string} state Run state.
     * @param {object} o Fields to replace.
     * @returns {void}
     */
    function run(project, sha, state, o = {}) {
        const source = project === "condominio" ? "bitbucket" : "github";
        const ended = state !== "running" && state !== "queued";
        store.pipelineEvent({
            kind: "run",
            source,
            project,
            sha,
            branchKnown: true,
            runId: o.runId || `${project}-${sha.slice(0, 4)}`,
            name: "Pipeline",
            state,
            url: "https://bitbucket.org/winker/condominio/pipelines/results/1",
            startedAt: o.startedAt ?? clock,
            endedAt: ended ? (o.endedAt ?? clock) : null,
            ...o,
        });
    }

    /**
     * @param {string} project Project.
     * @param {string} sha Commit.
     * @param {string} message Commit message.
     * @returns {void}
     */
    function merge(project, sha, message = "Merged develop into master") {
        store.pipelineEvent({ kind: "merge", source: "bitbucket", project, sha, message, at: clock });
    }

    /**
     * @param {string} namespace Namespace.
     * @param {string} release Release.
     * @param {string} tag Image tag.
     * @param {object} o Fields to replace.
     * @returns {void}
     */
    function rollout(namespace, release, tag, o = {}) {
        store.upsertRollout({
            id: `${namespace}/${release}:${o.seq || 1}`,
            namespace,
            release,
            atBoot: false,
            missed: false,
            startedAt: o.startedAt ?? clock,
            endedAt: o.state === "done" ? clock : null,
            state: "updating",
            updated: 0,
            desired: 2,
            cronJobsUpdated: 0,
            images: [tag],
            ...o,
        });
    }

    /**
     * @returns {object[]} Deploys of the snapshot.
     */
    function cards() {
        return store.snapshot().deploys;
    }

    test("condominio: merge, pipeline e virada com o SHA completo são um cartão, do merge ao No ar", () => {
        merge("condominio", SHA);
        let [card] = cards();
        assert.strictEqual(card.label, "inPipeline");
        assert.strictEqual(card.version, SHA.slice(0, 7));
        assert.strictEqual(card.pipeline.message, "Merged develop into master");
        const mergedAt = clock;

        tick(MIN);
        run("condominio", SHA, "running");
        tick(7 * MIN);
        run("condominio", SHA, "success", { startedAt: mergedAt + MIN });
        [card] = cards();
        assert.strictEqual(card.state, "built");
        assert.strictEqual(card.label, "built");

        tick(MIN);
        rollout("condominio", "winker-integration", SHA);
        assert.strictEqual(cards().length, 1, "a virada entrou no cartão da pipeline");
        tick(2 * MIN);
        rollout("condominio", "winker-integration", SHA, { state: "done" });
        [card] = cards();
        assert.strictEqual(card.label, "live");
        assert.strictEqual(card.pipeline.state, "success");
        assert.strictEqual(card.endedAt - card.startedAt, 11 * MIN, "conta do merge ao No ar");
    });

    test("a produção do mesmo commit, 30 min depois, volta do histórico com a pipeline junto", () => {
        merge("condominio", SHA);
        run("condominio", SHA, "success");
        rollout("condominio", "winker-integration", SHA, { state: "done" });
        tick(DONE_VISIBLE_MS);
        store.tick();
        assert.strictEqual(cards().length, 0);
        tick(20 * MIN);
        rollout("condominio", "winker-prod", SHA, { seq: 2 });
        const [card] = cards();
        assert.deepStrictEqual(card.releases.map((r) => r.release).sort(), ["winker-integration", "winker-prod"]);
        assert.strictEqual(card.pipeline.message, "Merged develop into master");
    });

    test("chat com tag prod: a virada que começa com o workflow rodando entra no cartão dele, com a versão do commit", () => {
        run("chat", SHA, "running");
        tick(6 * MIN);
        rollout("chat", "chatwoot", "prod");
        let [card] = cards();
        assert.strictEqual(cards().length, 1);
        assert.strictEqual(card.version, SHA.slice(0, 7));
        tick(3 * MIN);
        rollout("chat", "chatwoot", "prod", { state: "done" });
        assert.strictEqual(saved.length, 1, "gravado ao concluir");
        // O workflow termina depois da virada (helm --wait): o registro é gravado de novo, com ele verde.
        tick(MIN);
        run("chat", SHA, "success", { startedAt: clock - 10 * MIN });
        [card] = cards();
        assert.strictEqual(card.pipeline.state, "success");
        assert.strictEqual(saved.at(-1).pipeline.runs[0].state, "success");
    });

    test("tag sem commit e nenhuma pipeline rodando nem verde nos últimos 20 min: deploy sem pipeline", () => {
        run("chat", SHA, "success");
        tick(25 * MIN);
        rollout("chat", "chatwoot", "prod");
        const labels = cards()
            .map((c) => c.label)
            .sort();
        // A pipeline de 25 min atrás fica no cartão dela, já com o aviso de que nenhuma virada veio.
        assert.deepStrictEqual(labels, ["noPipeline", "noRollout"]);
    });

    test("Kuma: a virada dele é vista no boot, depois do fato; o workflow que termina depois entra nela, e não há 'sem pipeline'", () => {
        const runStart = clock;
        tick(4 * MIN);
        // Boot: a virada perdida entra concluída, sem pipeline conhecida (os eventos chegaram com o painel fora).
        rollout("monitor-infra", "uptime-kuma", "2.5.3-winker.25", { state: "done", missed: true, atBoot: true });
        let [card] = cards();
        assert.strictEqual(card.label, "live", "perdida não é acusada de deploy manual");
        tick(MIN);
        run("uptime-kuma", SHA, "success", { startedAt: runStart });
        assert.strictEqual(cards().length, 1, "o workflow entrou no cartão da virada");
        [card] = cards();
        assert.strictEqual(card.pipeline.state, "success");
        assert.strictEqual(card.version, SHA.slice(0, 7));
    });

    test("dois deploys do mesmo projeto sobrepostos: cada virada vai para o seu commit", () => {
        run("condominio", SHA, "success");
        tick(MIN);
        run("condominio", SHA2, "running");
        rollout("condominio", "winker-integration", SHA);
        tick(MIN);
        run("condominio", SHA2, "success");
        rollout("condominio", "winker-prod", SHA2, { seq: 2 });
        const byVersion = Object.fromEntries(cards().map((c) => [c.version, c.releases.map((r) => r.release)]));
        assert.deepStrictEqual(byVersion, {
            [SHA.slice(0, 7)]: ["winker-integration"],
            [SHA2.slice(0, 7)]: ["winker-prod"],
        });
    });

    test("fonte de pipeline desligada: a virada aparece só como virada, sem 'sem pipeline'", () => {
        store.setSource("bitbucket", "unconfigured");
        rollout("condominio", "winker-prod", SHA);
        assert.strictEqual(cards()[0].label, "rolling");
        assert.strictEqual(cards()[0].pipeline, null);
        // Com a fonte ligada e nenhuma pipeline do commit, é deploy sem pipeline.
        store.setSource("bitbucket", "active");
        assert.strictEqual(cards()[0].label, "noPipeline");
    });

    test("projeto sem origem: evento de pipeline ignorado, e nunca 'sem pipeline'", () => {
        store.pipelineEvent({
            kind: "run",
            project: "agua-gas",
            sha: SHA,
            branchKnown: true,
            runId: "1",
            state: "running",
            startedAt: clock,
            endedAt: null,
        });
        assert.strictEqual(cards().length, 0);
        rollout("microservices-prod", "agua-gas", "1.2.3");
        assert.strictEqual(cards()[0].label, "rolling");
    });

    test("pipeline verde sem virada: aviso depois de 10 min com o cluster lido, e vai para o histórico depois de 1 h", () => {
        run("condominio", SHA, "success");
        tick(NO_ROLLOUT_MS - 1);
        store.tick();
        assert.strictEqual(cards()[0].label, "built");
        tick(1);
        store.tick();
        assert.strictEqual(cards()[0].label, "noRollout");
        tick(NO_ROLLOUT_LEAVE_MS - NO_ROLLOUT_MS);
        store.tick();
        const snap = store.snapshot();
        assert.deepStrictEqual(snap.deploys, []);
        assert.strictEqual(snap.history[0].outcome, "noRollout");
        assert.strictEqual(snap.stats.noRollout, 1);
        assert.strictEqual(snap.stats.successRate, null, "fora da taxa de sucesso");
    });

    test("cluster desligado: pipeline verde é o fim do que se vê, sem aviso de virada", () => {
        store.setSource("cluster", "unconfigured");
        run("condominio", SHA, "success");
        const [card] = cards();
        assert.strictEqual(card.state, "done");
        assert.strictEqual(card.label, "live");
        tick(NO_ROLLOUT_MS);
        store.tick();
        assert.notStrictEqual(cards()[0]?.label, "noRollout");
    });

    test("pipeline que falha: cartão 'Falhou', e depois 'Com falha' no histórico e na conta", () => {
        merge("condominio", SHA);
        run("condominio", SHA, "running");
        tick(4 * MIN);
        run("condominio", SHA, "failed");
        const [card] = cards();
        assert.strictEqual(card.state, "failed");
        assert.strictEqual(card.label, "failed");
        assert.strictEqual(saved.at(-1).outcome, "failed", "gravado ao falhar");
        tick(DONE_VISIBLE_MS);
        store.tick();
        const snap = store.snapshot();
        assert.strictEqual(snap.history[0].outcome, "failed");
        assert.strictEqual(snap.stats.failed, 1);
        assert.strictEqual(snap.stats.successRate, 0);
    });

    test("reexecução que passa conta sobre a que falhou antes", () => {
        run("condominio", SHA, "failed", { runId: "a" });
        tick(MIN);
        run("condominio", SHA, "running", { runId: "b" });
        assert.strictEqual(cards()[0].state, "pipeline");
        tick(MIN);
        run("condominio", SHA, "success", { runId: "b", startedAt: clock - MIN });
        assert.strictEqual(cards()[0].state, "built");
    });

    test("status sem branch só entra num commit já conhecido na branch", () => {
        run("condominio", SHA, "running", { branchKnown: false });
        assert.strictEqual(cards().length, 0);
        merge("condominio", SHA);
        run("condominio", SHA, "running", { branchKnown: false });
        assert.strictEqual(cards()[0].pipeline.state, "running");
    });

    test("merge com [skip ci] não abre deploy, e merge cuja pipeline nunca chega some em 15 min", () => {
        merge("condominio", SHA, "ci: ajusta pipeline [skip ci]");
        assert.strictEqual(cards().length, 0);
        merge("condominio", SHA2);
        tick(MERGE_WAIT_MS);
        store.tick();
        assert.deepStrictEqual(store.snapshot().deploys, []);
        assert.deepStrictEqual(store.snapshot().history, [], "não houve deploy");
    });

    test("jobs do GitHub: os da execução mais recente, em ordem; job de execução desconhecida é descartado", () => {
        run("chat", SHA, "running", { runId: "r1" });
        const job = (jobId, name, startedAt, o = {}) =>
            store.pipelineEvent({
                kind: "job",
                project: "chat",
                sha: SHA,
                runId: "r1",
                jobId,
                name,
                state: "running",
                startedAt,
                endedAt: null,
                ...o,
            });
        job("2", "deploy", clock + 2 * MIN);
        job("1", "build", clock, { state: "success", endedAt: clock + 2 * MIN });
        job("9", "fantasma", clock, { runId: "r9" });
        assert.deepStrictEqual(
            cards()[0].pipeline.jobs.map((j) => `${j.name}:${j.state}`),
            ["build:success", "deploy:running"]
        );
    });

    test("evento atrasado não desfaz o fim: 'concluída com falha' e depois um 'rodando' velho continua falha", () => {
        run("chat", SHA, "failed", { updatedAt: clock });
        run("chat", SHA, "running", { updatedAt: clock - MIN });
        assert.strictEqual(cards()[0].state, "failed");
        // Sem hora do remetente, o fim também não é desfeito por um não-fim.
        run("chat", SHA, "running", { updatedAt: null });
        assert.strictEqual(cards()[0].state, "failed");
    });

    test("Bitbucket: rerun dos passos que falharam usa a mesma chave com hora mais nova, e vale", () => {
        run("condominio", SHA, "failed", { runId: "k", updatedAt: clock });
        tick(5 * MIN);
        run("condominio", SHA, "running", { runId: "k", updatedAt: clock });
        assert.strictEqual(cards()[0].state, "pipeline");
        tick(5 * MIN);
        run("condominio", SHA, "success", { runId: "k", updatedAt: clock, startedAt: clock - 10 * MIN });
        assert.strictEqual(cards()[0].state, "built");
    });

    test("execução sem notícia por 2 h: sai da tela como 'sem notícia' e não captura a virada de depois", () => {
        run("chat", SHA, "running");
        tick(RUN_SILENT_MS);
        store.tick();
        const snap = store.snapshot();
        assert.deepStrictEqual(snap.deploys, []);
        assert.strictEqual(snap.history[0].outcome, "lost");
        assert.strictEqual(snap.stats.lost, 1);
        assert.strictEqual(snap.stats.successRate, null);
        // Uma virada de tag prod depois disso não vai para aquele commit.
        rollout("chat", "chatwoot", "prod");
        assert.strictEqual(cards()[0].version, "prod");
        assert.strictEqual(cards()[0].pipeline, null);
    });

    test("execução que só parou de mandar notícia não captura virada sem SHA de dias depois", () => {
        run("chat", SHA, "running");
        rollout("chat", "chatwoot", "prod", { state: "done" });
        tick(DONE_VISIBLE_MS);
        store.tick();
        tick(3 * 24 * 60 * MIN);
        rollout("chat", "chatwoot", "prod", { seq: 2 });
        const fresh = cards().find((c) => c.releases.length && c.state === "updating");
        assert.strictEqual(fresh.version, "prod", "a virada de 3 dias depois é um deploy dela");
    });

    test("execução sem notícia num deploy que ficou na tela (travado) não captura a virada de outra release horas depois", () => {
        const local = new DeployBoardStore({ now: () => clock });
        local.setProjects([
            {
                name: "jambonz",
                source: "github",
                releases: [
                    { namespace: "jambonz-prod", release: "jambonz-worker" },
                    { namespace: "jambonz-prod", release: "jambonz-vad" },
                ],
            },
        ]);
        local.setSource("cluster", "active");
        local.setSource("github", "active");
        const roll = (release, o) =>
            local.upsertRollout({
                id: `jambonz-prod/${release}:1`,
                namespace: "jambonz-prod",
                release,
                atBoot: false,
                missed: false,
                startedAt: clock,
                endedAt: null,
                state: "updating",
                updated: 0,
                desired: 2,
                cronJobsUpdated: 0,
                images: ["latest"],
                ...o,
            });
        local.pipelineEvent({
            kind: "run",
            project: "jambonz",
            sha: SHA,
            branchKnown: true,
            runId: "r",
            name: "x",
            state: "running",
            startedAt: clock,
            endedAt: null,
        });
        roll("jambonz-worker", { state: "stuck" });
        assert.strictEqual(local.snapshot().deploys.length, 1, "a virada entrou na execução que rodava");
        tick(3 * 60 * MIN);
        roll("jambonz-vad", { startedAt: clock });
        const vad = local.snapshot().deploys.find((d) => d.releases.some((r) => r.release === "jambonz-vad"));
        assert.strictEqual(vad.pipeline, null, "a execução calada há 3 h não é a pipeline desta virada");
        local.close();
    });

    test("execução cancelada (fila do Kuma, parada à mão): 'Cancelada', fora da taxa, sem falha", () => {
        run("uptime-kuma", SHA, "stopped");
        const [card] = cards();
        assert.strictEqual(card.state, "cancelled");
        assert.strictEqual(card.label, "cancelled");
        assert.strictEqual(store.snapshot().stats.failed, 0);
        tick(DONE_VISIBLE_MS);
        store.tick();
        const snap = store.snapshot();
        assert.strictEqual(snap.history[0].outcome, "cancelled");
        assert.strictEqual(snap.stats.cancelled, 1);
        assert.strictEqual(snap.stats.successRate, null);
    });

    test("a hora do merge é a da chegada, não a do commit: commit de 30 min atrás não some", () => {
        store.pipelineEvent({
            kind: "merge",
            source: "bitbucket",
            project: "condominio",
            sha: SHA,
            message: "Merged",
            at: clock - 30 * MIN,
        });
        const [card] = cards();
        assert.strictEqual(card.pipeline.mergedAt, clock);
        assert.strictEqual(card.startedAt, clock);
    });

    test("cluster sem leitura (um namespace negado): pipeline verde espera a virada, não vira 'No ar'", () => {
        store.setSource("cluster", "stale", "condominio: 403");
        run("condominio", SHA, "success");
        let [card] = cards();
        assert.strictEqual(card.state, "built");
        tick(NO_ROLLOUT_MS);
        store.tick();
        [card] = cards();
        assert.strictEqual(card.label, "built", "sem leitura não se diz 'nenhuma virada'");
        assert.strictEqual(store.snapshot().stats.done, 0);
    });

    test("re-run no GitHub: os jobs da tentativa anterior saem, e evento da tentativa velha não volta", () => {
        const job = (jobId, name, attempt, o = {}) =>
            store.pipelineEvent({
                kind: "job",
                project: "chat",
                sha: SHA,
                runId: "r1",
                jobId,
                name,
                attempt,
                state: "failed",
                startedAt: clock,
                endedAt: clock,
                ...o,
            });
        run("chat", SHA, "failed", { runId: "r1", attempt: 1 });
        job("1", "build", 1);
        tick(MIN);
        run("chat", SHA, "running", { runId: "r1", attempt: 2 });
        job("2", "build", 2, { state: "running", endedAt: null });
        job("1", "build", 1, { state: "failed" });
        const jobs = cards()[0].pipeline.jobs;
        assert.deepStrictEqual(
            jobs.map((j) => `${j.id}:${j.name}:${j.state}`),
            ["2:build:running"]
        );
        run("chat", SHA, "failed", { runId: "r1", attempt: 1, updatedAt: clock + MIN });
        assert.strictEqual(cards()[0].pipeline.state, "running", "a tentativa 1 não volta por cima da 2");
    });

    test("pedido de pular a pipeline no rodapé da mensagem (skip-checks) não abre deploy", () => {
        store.pipelineEvent({
            kind: "merge",
            source: "github",
            project: "chat",
            sha: SHA,
            message: "docs",
            skipCi: true,
            at: clock,
        });
        assert.strictEqual(cards().length, 0);
    });

    test("evento com data ilegível não estraga o início do deploy", () => {
        store.pipelineEvent({
            kind: "merge",
            source: "bitbucket",
            project: "condominio",
            sha: SHA,
            message: "x",
            at: null,
        });
        assert.strictEqual(cards()[0].startedAt, clock);
    });

    test("o que sai da pipeline para o navegador é só o que o cartão mostra", () => {
        merge("condominio", SHA);
        run("condominio", SHA, "running");
        assert.deepStrictEqual(Object.keys(cards()[0].pipeline).sort(), [
            "endedAt",
            "jobs",
            "mergedAt",
            "message",
            "name",
            "source",
            "startedAt",
            "state",
            "url",
        ]);
    });

    test("depois de um reinício, o histórico carregado do banco traz a pipeline junto", () => {
        merge("condominio", SHA);
        run("condominio", SHA, "success");
        rollout("condominio", "winker-integration", SHA, { state: "done" });
        const record = JSON.parse(JSON.stringify(saved.at(-1)));
        const restarted = new DeployBoardStore({ now: () => clock });
        restarted.setProjects(PROJECTS);
        restarted.setSource("cluster", "active");
        restarted.setSource("bitbucket", "active");
        restarted.restore([record]);
        tick(20 * MIN);
        restarted.upsertRollout({
            id: "condominio/winker-prod:1",
            namespace: "condominio",
            release: "winker-prod",
            atBoot: false,
            missed: false,
            startedAt: clock,
            endedAt: null,
            state: "updating",
            updated: 0,
            desired: 2,
            cronJobsUpdated: 0,
            images: [SHA],
        });
        const [card] = restarted.snapshot().deploys;
        assert.strictEqual(card.label, "rolling", "a pipeline veio junto: nada de 'sem pipeline'");
        assert.strictEqual(card.pipeline.message, "Merged develop into master");
        restarted.close();
    });
});

describe("Webhooks ligados pelo ambiente", () => {
    test("só a fonte com segredo fica ativa, e o push assinado da master vira cartão", () => {
        const fs = require("fs");
        const os = require("os");
        const path = require("path");
        const { DeployBoard } = require("../../../server/deploy-board");
        process.env.UPTIME_KUMA_HIDE_LOG = ["info_deploy-board", "error_deploy-board"].join(",");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-board-webhook-"));
        const file = path.join(dir, "config.json");
        fs.writeFileSync(
            file,
            JSON.stringify({
                namespaces: ["condominio"],
                projects: [
                    {
                        name: "condominio",
                        source: "bitbucket",
                        repo: "winker/condominio",
                        branch: "master",
                        releases: ["condominio/winker-prod"],
                    },
                ],
            })
        );
        const store = new DeployBoardStore();
        const board = new DeployBoard({
            env: { DEPLOY_BOARD_CONFIG: file, DEPLOY_BOARD_BITBUCKET_SECRET: "s" },
            store,
            history: { available: () => false, save: () => Promise.resolve(), saveObject: () => Promise.resolve() },
        });
        try {
            board.start(null);
            assert.strictEqual(store.sources.bitbucket.state, "active");
            assert.strictEqual(store.sources.github.state, "unconfigured");
            assert.strictEqual(board.webhookSecret("github"), null);
            const out = board.receiveWebhook("bitbucket", "repo:push", {
                repository: { full_name: "winker/condominio" },
                push: {
                    changes: [
                        {
                            new: {
                                type: "branch",
                                name: "master",
                                target: {
                                    hash: SHA,
                                    message: "Merged develop into master",
                                    date: "2026-11-02T19:00:00Z",
                                },
                            },
                        },
                    ],
                },
            });
            assert.deepStrictEqual(out, { repo: "winker/condominio", kept: 1 });
            assert.strictEqual(store.snapshot().deploys[0].label, "inPipeline");
            assert.notStrictEqual(store.sources.bitbucket.lastDataAt, null, "o rodapé sabe quando chegou o último");
        } finally {
            board.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
