const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { DeployBoardStore } = require("../../../server/deploy-board/store");
const { AmplifySource, IDLE_MS, BUSY_MS, DISCOVER_MS, FAILED_CYCLES } = require("../../../server/deploy-board/amplify-source");

const SHA = "85dde7da0820766d0f196b90a7611e33b8d0416f";
const SHA2 = "516ef6ba30f5346e6ee077b52abde6f1f9dc173f";
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 2, 19, 0, 0);

/**
 * @param {string} message Error message.
 * @param {string} name Error name, as the SDK sets it.
 * @returns {Error} Error.
 */
function sdkError(message, name) {
    const e = new Error(message);
    e.name = name;
    return e;
}

describe("Amplify por consulta", () => {
    let clock;
    let store;
    let api;
    let source;
    let delays;
    let calls;

    beforeEach(() => {
        clock = T0;
        store = new DeployBoardStore({ now: () => clock });
        store.setProjects([
            { name: "condominio", source: "bitbucket", releases: [{ namespace: "condominio", release: "winker-prod" }] },
        ]);
        store.setSource("cluster", "active");
        delays = [];
        calls = [];
        api = {
            apps: [
                { appId: "d1ymgc35qf7bzb", name: "pro" },
                { appId: "dhavjgei1lfd2", name: "guest-link" },
            ],
            branches: {
                d1ymgc35qf7bzb: [
                    { branchName: "homolog", stage: "NONE" },
                    { branchName: "main", stage: "PRODUCTION" },
                ],
                dhavjgei1lfd2: [{ branchName: "master", stage: "PRODUCTION" }],
            },
            jobs: { "d1ymgc35qf7bzb/main": [], "dhavjgei1lfd2/master": [], "d1ymgc35qf7bzb/homolog": [] },
            steps: {},
            fail: null,
            listApps: async () => {
                calls.push("listApps");
                if (api.fail) {
                    throw api.fail;
                }
                return { apps: api.apps };
            },
            listBranches: async (appId) => ({ branches: api.branches[appId] }),
            listJobs: async (appId, branch) => {
                calls.push(`listJobs ${appId}/${branch}`);
                if (api.fail) {
                    throw api.fail;
                }
                // Newest first, as the API answers.
                return { jobSummaries: [...api.jobs[`${appId}/${branch}`]].reverse() };
            },
            getJob: async (appId, branch, jobId) => {
                calls.push(`getJob ${jobId}`);
                return { job: { steps: api.steps[jobId] || [] } };
            },
        };
        source = new AmplifySource({
            region: "us-east-1",
            store,
            api,
            setTimer: (fn, ms) => delays.push(ms),
            clearTimer: () => {},
        });
    });

    afterEach(() => {
        store.close();
    });

    /**
     * @param {string} jobId Job id.
     * @param {string} status Amplify status.
     * @param {object} o Fields to replace.
     * @returns {object} Job summary.
     */
    function job(jobId, status, o = {}) {
        const ended = ["SUCCEED", "FAILED", "CANCELLED"].includes(status);
        return {
            jobId,
            status,
            commitId: SHA,
            commitMessage: "Merge pull request #1165 from gladfy/feat/bulk-move-icon\n\nFlow: novo ícone",
            startTime: new Date(o.start ?? clock),
            endTime: ended ? new Date(o.end ?? clock) : undefined,
            ...o,
        };
    }

    /**
     * @param {string} name Step name.
     * @param {string} status Amplify status.
     * @returns {object} Step.
     */
    function step(name, status) {
        const ended = ["SUCCEED", "FAILED", "CANCELLED"].includes(status);
        return { stepName: name, status, startTime: new Date(clock), endTime: ended ? new Date(clock) : undefined };
    }

    /**
     * @param {string} project Project.
     * @returns {object|undefined} Its card.
     */
    function card(project = "pro") {
        return store.snapshot().deploys.find((d) => d.project === project);
    }

    test("só a branch de produção conta, e o que já tinha acabado na primeira leitura não aparece", async () => {
        api.jobs["d1ymgc35qf7bzb/main"] = [job("378", "SUCCEED", { commitId: SHA2, start: clock - 30 * MIN, end: clock - 25 * MIN })];
        api.jobs["d1ymgc35qf7bzb/homolog"] = [job("12", "RUNNING")];
        await source.cycle();
        assert.deepStrictEqual(store.snapshot().deploys, []);
        assert.deepStrictEqual(store.snapshot().history, [], "nem no histórico: acabou com o painel sem olhar");
        assert.ok(!calls.some((c) => c.includes("homolog")), "a homolog nem é lida");
        assert.strictEqual(store.snapshot().sources.amplify.state, "active");
        assert.strictEqual(delays.at(-1), IDLE_MS, "nada rodando: a cada 60 s");
    });

    test("build do pro: cartão com os passos, a cada 15 s enquanto roda, e No ar quando termina", async () => {
        await source.cycle();
        clock += MIN;
        api.jobs["d1ymgc35qf7bzb/main"] = [job("379", "RUNNING")];
        api.steps["379"] = [step("BUILD", "RUNNING"), step("DEPLOY", "PENDING"), step("VERIFY", "PENDING")];
        await source.cycle();
        let c = card();
        assert.strictEqual(c.label, "inPipeline");
        assert.strictEqual(c.version, SHA.slice(0, 7));
        assert.strictEqual(c.pipeline.message, "Merge pull request #1165 from gladfy/feat/bulk-move-icon");
        assert.deepStrictEqual(
            c.pipeline.jobs.map((j) => `${j.name}:${j.state}`),
            ["build:running", "deploy:queued", "verify:queued"]
        );
        assert.deepStrictEqual(c.links, ["amplify/pro"]);
        assert.deepStrictEqual(c.releases, []);
        assert.ok(c.confirmed);
        assert.match(c.pipeline.url, /^https:\/\/us-east-1\.console\.aws\.amazon\.com\/amplify\/apps\/d1ymgc35qf7bzb\/branches\/main\/deployments\/379$/);
        assert.strictEqual(delays.at(-1), BUSY_MS, "rodando: a cada 15 s");

        // O passo anda com o job ainda RUNNING: é lido de novo.
        clock += 15 * 1000;
        api.steps["379"] = [step("BUILD", "SUCCEED"), step("DEPLOY", "RUNNING"), step("VERIFY", "PENDING")];
        await source.cycle();
        assert.deepStrictEqual(card().pipeline.jobs.map((j) => j.state), ["success", "running", "queued"]);

        clock += MIN;
        api.jobs["d1ymgc35qf7bzb/main"] = [job("379", "SUCCEED", { start: T0 + MIN })];
        api.steps["379"] = [step("BUILD", "SUCCEED"), step("DEPLOY", "SUCCEED"), step("VERIFY", "SUCCEED")];
        await source.cycle();
        c = card();
        assert.strictEqual(c.state, "done", "o Amplify publica sozinho: não espera virada no cluster");
        assert.strictEqual(c.label, "live");
        assert.deepStrictEqual(c.steps.map((s) => `${s.key}:${s.status}`), ["merge:done", "pipeline:done", "live:done"]);
        assert.strictEqual(delays.at(-1), IDLE_MS);

        // Acabado, ele não é lido de novo.
        const before = calls.filter((x) => x === "getJob 379").length;
        clock += MIN;
        await source.cycle();
        assert.strictEqual(calls.filter((x) => x === "getJob 379").length, before);
    });

    test("job que falha no build: cartão 'Falhou' com o passo em vermelho e os outros parados", async () => {
        await source.cycle();
        api.jobs["dhavjgei1lfd2/master"] = [job("88", "FAILED")];
        api.steps["88"] = [step("BUILD", "FAILED"), step("DEPLOY", "CANCELLED"), step("VERIFY", "CANCELLED")];
        await source.cycle();
        const c = card("guest-link");
        assert.strictEqual(c.label, "failed");
        assert.deepStrictEqual(c.pipeline.jobs.map((j) => `${j.name}:${j.state}`), ["build:failed", "deploy:stopped", "verify:stopped"]);
    });

    test("job que já rodava quando o painel subiu aparece na primeira leitura", async () => {
        api.jobs["d1ymgc35qf7bzb/main"] = [job("379", "RUNNING", { start: clock - 3 * MIN })];
        await source.cycle();
        assert.strictEqual(card().startedAt, clock - 3 * MIN);
    });

    test(`${FAILED_CYCLES} ciclos com erro: sem leitura, e o deploy em andamento deixa de ser confirmado`, async () => {
        await source.cycle();
        api.jobs["d1ymgc35qf7bzb/main"] = [job("379", "RUNNING")];
        await source.cycle();
        api.fail = sdkError("Rate exceeded", "TooManyRequestsException");
        for (let i = 1; i < FAILED_CYCLES; i++) {
            await source.cycle();
            assert.strictEqual(store.snapshot().sources.amplify.state, "active", `ainda vale no ciclo ${i}`);
        }
        await source.cycle();
        assert.strictEqual(store.snapshot().sources.amplify.state, "stale");
        assert.strictEqual(card().confirmed, false);
        api.fail = null;
        await source.cycle();
        assert.strictEqual(store.snapshot().sources.amplify.state, "active");
        assert.strictEqual(card().confirmed, true);
    });

    test("sem credencial: a fonte fica 'não configurada', e tenta de novo só na próxima descoberta", async () => {
        api.fail = sdkError("Could not load credentials from any providers", "CredentialsProviderError");
        await source.cycle();
        assert.strictEqual(store.snapshot().sources.amplify.state, "unconfigured");
        assert.strictEqual(delays.at(-1), DISCOVER_MS);
    });

    test("sem região na configuração, a fonte nem começa", () => {
        const off = new AmplifySource({ region: null, store, api, setTimer: (fn, ms) => delays.push(ms) });
        assert.strictEqual(off.start(), false);
        assert.deepStrictEqual(delays, []);
    });

    test("app com o nome de um projeto da configuração fica de fora, e os outros seguem", async () => {
        api.apps.push({ appId: "dz", name: "condominio" });
        api.branches.dz = [{ branchName: "main", stage: "PRODUCTION" }];
        api.jobs["dz/main"] = [];
        await source.cycle();
        assert.ok(!calls.includes("listJobs dz/main"));
        assert.ok(calls.includes("listJobs dhavjgei1lfd2/master"));
        // O projeto da configuração continua do Bitbucket, com a virada: o app não tomou o lugar dele.
        store.pipelineEvent({ kind: "merge", source: "bitbucket", project: "condominio", sha: SHA, message: "m", at: clock });
        const c = card("condominio");
        assert.strictEqual(c.pipeline.source, "bitbucket");
        assert.strictEqual(c.steps.length, 5);
    });

    test("as apps são descobertas de novo a cada 30 min, não a cada ciclo", async () => {
        await source.cycle();
        clock += MIN;
        await source.cycle();
        assert.strictEqual(calls.filter((c) => c === "listApps").length, 1);
        clock += DISCOVER_MS;
        await source.cycle();
        assert.strictEqual(calls.filter((c) => c === "listApps").length, 2);
    });

    test("no histórico, o deploy do Amplify leva a tag do monitor", async () => {
        await source.cycle();
        api.jobs["d1ymgc35qf7bzb/main"] = [job("379", "SUCCEED")];
        await source.cycle();
        clock += 11 * MIN;
        store.tick();
        const [entry] = store.snapshot().history;
        assert.strictEqual(entry.project, "pro");
        assert.deepStrictEqual(entry.links, ["amplify/pro"]);
    });
});
