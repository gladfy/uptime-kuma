const { describe, test, before } = require("node:test");
const assert = require("node:assert");

let soundEvents;
let freshEvents;

before(async () => {
    // The function lives with the page (ESM); Node 20 imports it from CommonJS as it is.
    ({ soundEvents, freshEvents } = await import("../../../src/components/deploy-board/sound-events.mjs"));
});

/**
 * @param {string} id Deploy id.
 * @param {string} state Deploy state.
 * @param {string[]} releases Release names in the condominio namespace.
 * @param {object} o Fields to replace.
 * @returns {object} Deploy as the snapshot carries it.
 */
function deploy(id, state, releases = ["winker-integration"], o = {}) {
    return {
        id,
        project: "condominio",
        state,
        missed: false,
        releases: releases.map((release) => ({ namespace: "condominio", release, atBoot: false })),
        ...o,
    };
}

/**
 * @param {object[]} deploys Deploys on screen.
 * @param {object[]} history History entries.
 * @returns {object} Snapshot.
 */
function snap(deploys, history = []) {
    return { deploys, history };
}

/**
 * @param {object|null} a Snapshot before.
 * @param {object} b Snapshot now.
 * @returns {string[]} Events, without the keys.
 */
function events(a, b) {
    return soundEvents(a, b).map((e) => e.event);
}

describe("Sons: o que cada mudança toca", () => {
    test("virada que começa num projeto sem pipeline: buzina de iniciado e depois os dois toques", () => {
        assert.deepStrictEqual(events(snap([]), snap([deploy("c:1", "updating")])), ["started", "rolling"]);
    });

    test("chegou a No ar: o sino", () => {
        assert.deepStrictEqual(events(snap([deploy("c:1", "updating")]), snap([deploy("c:1", "done")])), ["done"]);
    });

    test("travou: a buzina de falha", () => {
        assert.deepStrictEqual(events(snap([deploy("c:1", "updating")]), snap([deploy("c:1", "stuck")])), ["failed"]);
        // Sem progresso não toca, nem quando passa a travado depois.
        assert.deepStrictEqual(events(snap([deploy("c:1", "updating")]), snap([deploy("c:1", "noProgress")])), []);
        assert.deepStrictEqual(events(snap([deploy("c:1", "noProgress")]), snap([deploy("c:1", "stuck")])), ["failed"]);
    });

    test("condominio: a produção do mesmo commit volta do histórico, toca a virada e depois o sino de novo", () => {
        const integration = deploy("c:1", "done");
        const prod = deploy("c:1", "updating", ["winker-integration", "winker-prod"]);
        assert.deepStrictEqual(events(snap([], [integration]), snap([prod])), ["rolling"]);
        const done = deploy("c:1", "done", ["winker-integration", "winker-prod"]);
        assert.deepStrictEqual(events(snap([prod]), snap([done])), ["done"]);
        // Ainda na tela: a produção entra no deploy concluído da integração.
        assert.deepStrictEqual(events(snap([integration]), snap([prod])), ["rolling"]);
    });

    test("carga da página, reconexão e reinício do servidor não tocam nada", () => {
        const everything = snap(
            [deploy("c:1", "updating"), deploy("g:1", "stuck"), deploy("a:1", "done")],
            [deploy("x:1", "done")]
        );
        assert.deepStrictEqual(events(null, everything), []);
    });

    test("deploy achado no boot ou perdido com o painel fora do ar não toca", () => {
        const atBoot = deploy("c:1", "updating", ["winker-prod"]);
        atBoot.releases[0].atBoot = true;
        assert.deepStrictEqual(
            events(snap([]), snap([atBoot, deploy("k:1", "done", ["uptime-kuma"], { missed: true })])),
            []
        );
    });

    test("substituído e escala do HPA (snapshot igual) não tocam", () => {
        const s = snap([deploy("c:1", "updating")]);
        assert.deepStrictEqual(events(s, snap([deploy("c:1", "updating")])), []);
        assert.deepStrictEqual(events(s, snap([deploy("c:1", "superseded")])), []);
    });

    test("o mesmo evento do mesmo deploy não repete, mesmo que o estado vá e volte", () => {
        const played = new Set();
        const a = snap([deploy("c:1", "updating")]);
        const b = snap([deploy("c:1", "stuck")]);
        assert.strictEqual(freshEvents(soundEvents(a, b), played).length, 1);
        // Destravou e travou de novo: o mesmo "falhou" da mesma etapa não toca outra vez.
        assert.strictEqual(freshEvents(soundEvents(b, a), played).length, 0);
        assert.strictEqual(freshEvents(soundEvents(a, b), played).length, 0);
        // A etapa seguinte do mesmo deploy é outra: o sino da produção toca depois do da integração.
        const done1 = snap([deploy("c:1", "done")]);
        const done2 = snap([deploy("c:1", "done", ["winker-integration", "winker-prod"])]);
        assert.deepStrictEqual(
            freshEvents(soundEvents(b, done1), played).map((e) => e.event),
            ["done"]
        );
        assert.deepStrictEqual(
            freshEvents(soundEvents(done1, done2), played).map((e) => e.event),
            ["rolling", "done"]
        );
    });

    test("vários deploys ao mesmo tempo: um som por deploy e por transição, na ordem da tela", () => {
        const out = soundEvents(
            snap([deploy("c:1", "updating")]),
            snap([deploy("c:1", "done"), deploy("g:1", "updating")])
        );
        assert.deepStrictEqual(
            out.map((e) => `${e.deployId}:${e.event}`),
            ["c:1:done", "g:1:started", "g:1:rolling"]
        );
    });

    test("com a pipeline (fase 4), o iniciado não vem da virada", () => {
        assert.deepStrictEqual(
            events(snap([]), snap([deploy("c:1", "updating", undefined, { pipeline: { state: "success" } })])),
            ["rolling"]
        );
    });
});
