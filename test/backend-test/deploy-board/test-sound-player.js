const { describe, test, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const { register } = require("node:module");

// The player is browser code: its recordings are Vite imports of .mp3 files and it is an ES module
// in a CommonJS package. Here each .mp3 becomes its own name and the player loads as a module.
register(
    "data:text/javascript," +
        encodeURIComponent(`
export async function load(url, context, next) {
    if (url.endsWith(".mp3")) {
        return { format: "module", source: "export default " + JSON.stringify(url.split("/").pop()), shortCircuit: true };
    }
    if (url.endsWith("/sound-player.js")) {
        return next(url, { ...context, format: "module" });
    }
    return next(url, context);
}`)
);

/** Every element created, in order. */
let created = [];

/**
 * An HTMLAudioElement with the events in the order the browser sends them. At the end of playback
 * "pause" and then "ended" fire in the same task, with `ended` already true.
 */
class FakeAudio extends EventTarget {
    /**
     * @param {string} src File.
     */
    constructor(src) {
        super();
        this.src = src;
        this.paused = true;
        this.ended = false;
        this.currentTime = 0;
        this.duration = 2;
        this.plays = 0;
        this.refuse = null;
        created.push(this);
    }

    /**
     * @returns {Promise<void>} Resolved, or rejected with `refuse`.
     */
    play() {
        this.plays += 1;
        if (this.refuse) {
            const e = new Error("refused");
            e.name = this.refuse;
            return Promise.reject(e);
        }
        this.paused = false;
        this.ended = false;
        return Promise.resolve();
    }

    /**
     * @returns {void}
     */
    pause() {
        if (!this.paused) {
            this.paused = true;
            this.dispatchEvent(new Event("pause"));
        }
    }

    /**
     * The recording reaches its end.
     * @returns {void}
     */
    finishPlaying() {
        this.ended = true;
        this.paused = true;
        this.dispatchEvent(new Event("pause"));
        this.dispatchEvent(new Event("ended"));
    }
}

/**
 * @param {string} event Sound.
 * @param {string} key Unique key (deploy, event, stage).
 * @returns {object} A sound event, as soundEvents() returns.
 */
function sound(event, key) {
    return { deployId: key, event, key };
}

/**
 * Lets the promises of play() settle.
 * @returns {Promise<void>} Resolved on the next turn of the loop.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("Tocador dos sons", () => {
    let SoundPlayer;
    let fetches;
    let held;
    let blocked;
    let player;

    before(async () => {
        ({ SoundPlayer } = await import("../../../src/components/deploy-board/sound-player.js"));
    });

    beforeEach(() => {
        created = [];
        fetches = [];
        blocked = [];
        global.Audio = FakeAudio;
        held = null;
        global.fetch = (url) => {
            fetches.push(url);
            const answer = { ok: true, blob: () => Promise.resolve(new Blob(["mp3"])) };
            // With `held` set, the downloads wait for the test to let them through.
            return held ? held.then(() => answer) : Promise.resolve(answer);
        };
        player = new SoundPlayer((b) => blocked.push(b));
        player.load();
    });

    afterEach(() => {
        player.stop();
        mock.timers.reset();
    });

    /**
     * @param {string} event Sound.
     * @returns {FakeAudio} Its element.
     */
    const el = (event) => player.audio[event];

    test("o mesmo som duas vezes seguidas: o segundo toca inteiro, e o terceiro espera por ele", async () => {
        player.enqueue([sound("started", "a"), sound("started", "b"), sound("done", "c")]);
        await settle();
        assert.strictEqual(el("started").plays, 1);
        el("started").finishPlaying();
        await settle();
        assert.strictEqual(el("started").plays, 2, "o segundo começou");
        assert.strictEqual(el("done").plays, 0, "o terceiro espera o segundo acabar");
        el("started").finishPlaying();
        await settle();
        assert.strictEqual(el("done").plays, 1);
    });

    test("som pausado de fora libera a fila", async () => {
        player.enqueue([sound("started", "a"), sound("built", "b")]);
        await settle();
        el("started").pause();
        await settle();
        assert.strictEqual(el("built").plays, 1);
    });

    test("som que nunca termina é parado no tempo-limite, e o seguinte não toca por cima", async () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        player.enqueue([sound("started", "a"), sound("built", "b")]);
        await settle();
        mock.timers.tick(2000 + 2999);
        await settle();
        assert.strictEqual(el("built").plays, 0);
        mock.timers.tick(1);
        await settle();
        assert.strictEqual(el("started").paused, true, "o que estourou o tempo foi parado");
        assert.strictEqual(el("built").plays, 1);
    });

    test("arquivo que falha (com o evento de erro antes da recusa): a fila segue e ele é baixado de novo", async () => {
        await settle();
        const before = fetches.length;
        el("started").refuse = "NotSupportedError";
        player.enqueue([sound("started", "a"), sound("built", "b")]);
        el("started").dispatchEvent(new Event("error"));
        await settle();
        assert.strictEqual(el("built").plays, 1);
        assert.strictEqual(fetches.length, before + 1, "baixado de novo");
        assert.deepStrictEqual(blocked.filter(Boolean), [], "não é bloqueio do navegador");
    });

    test("navegador que não deixa tocar: a fila é esvaziada e o painel avisa", async () => {
        el("started").refuse = "NotAllowedError";
        player.enqueue([sound("started", "a"), sound("built", "b")]);
        await settle();
        assert.deepStrictEqual(blocked, [true]);
        assert.strictEqual(el("built").plays, 0);
    });

    test("as gravações passam a tocar da memória, sem cortar o som que toca", async () => {
        mock.timers.enable({ apis: ["setTimeout"] });
        let letThrough;
        held = new Promise((resolve) => {
            letThrough = resolve;
        });
        const slow = new SoundPlayer();
        slow.load();
        slow.enqueue([sound("started", "a")]);
        letThrough();
        await settle();
        assert.match(slow.audio.built.src, /^blob:/);
        assert.strictEqual(slow.audio.started.src, "started.mp3", "a que toca não é trocada no meio");
        slow.audio.started.finishPlaying();
        mock.timers.tick(1000);
        assert.match(slow.audio.started.src, /^blob:/, "trocada depois de acabar");
        slow.stop();
    });

    test("parar no meio não deixa o som seguinte começar", async () => {
        player.enqueue([sound("started", "a"), sound("built", "b")]);
        await settle();
        player.stop();
        el("started").finishPlaying();
        await settle();
        assert.strictEqual(el("built").plays, 0);
    });
});
