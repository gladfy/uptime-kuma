const { describe, test, before } = require("node:test");
const assert = require("node:assert");

let servicesGoneDown;

before(async () => {
    // The function lives with the page (ESM); Node 20 imports it from CommonJS as it is.
    ({ servicesGoneDown } = await import("../../../src/components/deploy-board/service-alert.mjs"));
});

/**
 * @param {object} tones State of each monitor, by id.
 * @returns {{id: number, tone: string}[]} Monitors as the page has them.
 */
const monitors = (tones) => Object.entries(tones).map(([id, tone]) => ({ id: Number(id), tone }));

/**
 * @param {object|null} before States at the last look, or null for none.
 * @param {object} now States now.
 * @returns {number[]} Monitors seen going down.
 */
const down = (before, now) =>
    servicesGoneDown(before && new Map(Object.entries(before).map(([id, t]) => [Number(id), t])), monitors(now)).down;

describe("Sirene de serviço fora", () => {
    test("serviço que estava no ar e cai: toca", () => {
        assert.deepStrictEqual(down({ 1: "up", 2: "up" }, { 1: "down", 2: "up" }), [1]);
    });

    test("de pendente e de manutenção para fora também toca", () => {
        assert.deepStrictEqual(down({ 1: "pending", 2: "maintenance" }, { 1: "down", 2: "down" }), [1, 2]);
    });

    test("vários caindo juntos voltam juntos, para uma sirene só", () => {
        assert.deepStrictEqual(down({ 1: "up", 2: "up", 3: "up" }, { 1: "down", 2: "down", 3: "up" }), [1, 2]);
    });

    test("serviço que continua fora não toca de novo", () => {
        assert.deepStrictEqual(down({ 1: "down" }, { 1: "down" }), []);
    });

    test("caiu, voltou e caiu de novo: toca na segunda queda", () => {
        const first = servicesGoneDown(new Map([[1, "up"]]), monitors({ 1: "down" }));
        const back = servicesGoneDown(first.tones, monitors({ 1: "up" }));
        const again = servicesGoneDown(back.tones, monitors({ 1: "down" }));
        assert.deepStrictEqual([first.down, back.down, again.down], [[1], [], [1]]);
    });

    test("abrir a página ou reconectar com um serviço já fora não toca", () => {
        assert.deepStrictEqual(down(null, { 1: "down" }), []);
    });

    test("batidas chegando depois de abrir (sem estado lido antes) não tocam", () => {
        assert.deepStrictEqual(down({ 1: "unknown" }, { 1: "down" }), []);
    });

    test("monitor religado que já volta fora não toca", () => {
        assert.deepStrictEqual(down({ 1: "paused" }, { 1: "down" }), []);
    });

    test("monitor que entrou na lista agora, já fora, não toca", () => {
        assert.deepStrictEqual(down({ 1: "up" }, { 1: "up", 2: "down" }), []);
    });

    test("o estado devolvido é o de agora, para a próxima comparação", () => {
        const { tones } = servicesGoneDown(null, monitors({ 1: "up", 2: "down" }));
        assert.deepStrictEqual(
            [...tones],
            [
                [1, "up"],
                [2, "down"],
            ]
        );
    });
});
