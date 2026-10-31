const { describe, test } = require("node:test");
const assert = require("node:assert");
const {
    NO_PROGRESS_MS,
    imageTag,
    releaseOf,
    extractDeployment,
    extractCronJob,
    deploymentState,
    oldVersionStillUp,
    releaseStatus,
    withProgressClock,
} = require("../../../server/deploy-board/rollout-state");
const { deployment } = require("./k8s-fixtures");

/**
 * @param {object} o Overrides.
 * @returns {object} Kept Deployment.
 */
function kept(o) {
    return extractDeployment(deployment(o));
}

describe("Estado da virada", () => {
    test("tag da imagem: com registro, porta, digest e sem tag", () => {
        assert.strictEqual(imageTag("tiwinker/portal:abc1234"), "abc1234");
        assert.strictEqual(imageTag("registry:5000/team/app:2.5.3-winker.16"), "2.5.3-winker.16");
        assert.strictEqual(imageTag("tiwinker/chatwoot:prod@sha256:ffff"), "prod");
        assert.strictEqual(imageTag("registry:5000/team/app"), "latest");
    });

    test("release: anotação do Helm, depois o rótulo instance, depois o nome", () => {
        assert.strictEqual(releaseOf({ name: "x", annotations: { "meta.helm.sh/release-name": "a" }, labels: { "app.kubernetes.io/instance": "b" } }), "a");
        assert.strictEqual(releaseOf({ name: "x", labels: { "app.kubernetes.io/instance": "b" } }), "b");
        assert.strictEqual(releaseOf({ name: "x" }), "x");
    });

    test("virada do winker-prod com maxSurge 1: 9 de 17 é atualizando, 9/17", () => {
        // maxSurge 1 / maxUnavailable 0: 9 novas prontas, 8 antigas ainda no ar, 1 nova subindo.
        const d = kept({ generation: 11, updated: 10, available: 17, total: 18 });
        assert.strictEqual(deploymentState(d), "updating");
        assert.ok(oldVersionStillUp(d));
        const s = releaseStatus([kept({ generation: 11, updated: 9, available: 17, total: 18 })]);
        assert.deepStrictEqual(s, { state: "updating", updated: 9, available: 17, desired: 17 });
    });

    test("concluído só com o critério do kubectl: geração observada, atualizadas = disponíveis = réplicas, sem antigas", () => {
        assert.strictEqual(deploymentState(kept({})), "done");
        // Controle: cada condição que falta, sozinha, segura o "concluído".
        assert.strictEqual(deploymentState(kept({ generation: 11, observedGeneration: 10 })), "updating");
        assert.strictEqual(deploymentState(kept({ updated: 16 })), "updating");
        assert.strictEqual(deploymentState(kept({ total: 18 })), "updating");
        assert.strictEqual(deploymentState(kept({ available: 16 })), "updating");
    });

    test("ProgressDeadlineExceeded é travado, e uma release com um travado está travada", () => {
        const stuck = kept({
            name: "connector-access",
            updated: 2,
            available: 4,
            total: 5,
            replicas: 4,
            conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }],
        });
        assert.strictEqual(deploymentState(stuck), "stuck");
        assert.strictEqual(releaseStatus([kept({}), stuck]).state, "stuck");
    });

    test("release de vários Deployments soma réplicas e só conclui quando todos concluem", () => {
        const workers = [
            kept({ name: "w1", replicas: 3, updated: 3, available: 3 }),
            kept({ name: "w2", replicas: 5, updated: 2, available: 5, total: 6 }),
            kept({ name: "w3", replicas: 2, updated: 2, available: 2 }),
        ];
        assert.deepStrictEqual(releaseStatus(workers), { state: "updating", updated: 7, available: 10, desired: 10 });
        workers[1] = kept({ name: "w2", replicas: 5 });
        assert.strictEqual(releaseStatus(workers).state, "done");
    });

    test("réplicas 0 conta como concluído, mesmo com status vazio", () => {
        const zero = extractDeployment({ metadata: { name: "z", namespace: "n" }, spec: { replicas: 0 }, status: {} });
        assert.strictEqual(deploymentState(zero), "done");
        assert.ok(!oldVersionStillUp(zero));
    });

    test("o HPA escalando não deixa versão antiga no ar: não é virada", () => {
        // 8 → 17: as 9 novas já são da versão atual (atualizadas), só ainda não estão prontas.
        const scaling = kept({ generation: 12, observedGeneration: 12, replicas: 17, updated: 17, available: 8, total: 17 });
        assert.ok(!oldVersionStillUp(scaling));
        // A revisão, que é quem marca a virada, não muda com a escala.
        assert.strictEqual(scaling.revision, kept({}).revision);
    });

    test("template novo com a mesma tag (rollme do chat) muda a revisão, e a tag continua a mesma", () => {
        const before = kept({ namespace: "chat", name: "chatwoot-web", release: "chatwoot", tag: "prod", revision: 40 });
        const after = kept({ namespace: "chat", name: "chatwoot-web", release: "chatwoot", tag: "prod", revision: 41 });
        assert.notStrictEqual(before.revision, after.revision);
        assert.deepStrictEqual(before.images, after.images);
        assert.deepStrictEqual(after.images, ["prod", "1.27"]);
    });

    test("sem progresso: 2 min sem mais atualizadas nem disponíveis; qualquer aumento zera o relógio", () => {
        const t0 = 1_000_000;
        let c = withProgressClock(null, { state: "updating", updated: 3, available: 17, desired: 17 }, t0);
        assert.strictEqual(c.state, "updating");
        c = withProgressClock(c, { state: "updating", updated: 3, available: 17, desired: 17 }, t0 + NO_PROGRESS_MS - 1);
        assert.strictEqual(c.state, "updating");
        c = withProgressClock(c, { state: "updating", updated: 3, available: 17, desired: 17 }, t0 + NO_PROGRESS_MS);
        assert.strictEqual(c.state, "noProgress");
        c = withProgressClock(c, { state: "updating", updated: 4, available: 17, desired: 17 }, t0 + NO_PROGRESS_MS + 5);
        assert.strictEqual(c.state, "updating");
        assert.strictEqual(c.lastProgressAt, t0 + NO_PROGRESS_MS + 5);
        // Travado e concluído não viram "sem progresso".
        assert.strictEqual(withProgressClock(c, { state: "stuck", updated: 4, available: 17, desired: 17 }, t0 * 9).state, "stuck");
    });

    test("env, volumes e o resto do template não sobrevivem à extração", () => {
        const secret = "segredo-plantado-7f3a";
        const d = deployment({});
        d.spec.template.spec.containers[0].env = [{ name: "DB_PASSWORD", value: secret }];
        d.spec.template.spec.containers[0].envFrom = [{ secretRef: { name: secret } }];
        d.spec.template.spec.volumes = [{ name: "creds", secret: { secretName: secret } }];
        d.spec.template.metadata = { annotations: { token: secret } };
        d.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"] = JSON.stringify({ secret });
        // Controle positivo: o segredo está no objeto que entra.
        assert.ok(JSON.stringify(d).includes(secret));

        const out = extractDeployment(d);
        assert.ok(!JSON.stringify(out).includes(secret));
        assert.deepStrictEqual(Object.keys(out).sort(), [
            "available",
            "conditions",
            "generation",
            "images",
            "name",
            "namespace",
            "observedGeneration",
            "release",
            "replicas",
            "revision",
            "total",
            "updated",
        ]);

        const cron = {
            metadata: { namespace: "gateway", name: "c1", generation: 3, annotations: { "meta.helm.sh/release-name": "gateway-cron" } },
            spec: { jobTemplate: { spec: { template: { spec: { containers: [{ image: "x:abc1234", env: [{ value: secret }] }] } } } } },
        };
        const cronOut = extractCronJob(cron);
        assert.ok(!JSON.stringify(cronOut).includes(secret));
        assert.deepStrictEqual(cronOut, { namespace: "gateway", name: "c1", release: "gateway-cron", generation: 3, images: ["abc1234"] });
    });
});
