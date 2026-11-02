import started from "../../assets/deploy-board-sounds/started.mp3";
import built from "../../assets/deploy-board-sounds/built.mp3";
import rolling from "../../assets/deploy-board-sounds/rolling.mp3";
import done from "../../assets/deploy-board-sounds/done.mp3";
import failed from "../../assets/deploy-board-sounds/failed.mp3";
import { freshEvents } from "./sound-events.mjs";

/** Recording of each sound (see src/assets/deploy-board-sounds/CREDITS.md). */
const FILES = { started, built, rolling, done, failed };

/** More than this many waiting and the oldest are dropped: a burst must not play for a minute. */
const QUEUE_MAX = 4;

/**
 * What ends a sound. "pause" too: paused from outside (a media key, the OS taking the audio) it
 * never reaches "ended", and the queue would wait for it forever.
 */
const END_EVENTS = ["ended", "pause", "error"];

/** A sound that neither ends nor fails is given up this long after its length. */
const GUARD_MS = 3000;
const GUARD_UNKNOWN_MS = 20000;

/**
 * Plays the board's sounds one at a time. The files are only fetched once sound is turned on.
 */
export class SoundPlayer {
    /**
     * @param {Function} onBlocked Called with true when the browser refuses to play (no click on the
     * page yet), and with false once a sound plays.
     */
    constructor(onBlocked = () => {}) {
        this.onBlocked = onBlocked;
        this.audio = null;
        this.kept = {};
        this.queue = [];
        this.playing = false;
        this.played = new Set();
        this.current = null;
    }

    /**
     * Load the recordings. Called when sound is turned on.
     * @returns {void}
     */
    load() {
        if (this.audio) {
            return;
        }
        this.audio = {};
        for (const [event, url] of Object.entries(FILES)) {
            const a = new Audio(url);
            a.preload = "auto";
            this.audio[event] = a;
            this.keep(event);
        }
    }

    /**
     * Keep a recording in the page's memory. The file names carry the hash of the build: after a
     * deploy of the Kuma the old names are gone, and a page open since before would get a 404 the
     * next time the browser read the file again. Until the copy is in, the file plays from the server.
     * @param {string} event Sound.
     * @returns {void}
     */
    keep(event) {
        if (this.kept[event] || typeof fetch !== "function" || typeof URL.createObjectURL !== "function") {
            return;
        }
        this.kept[event] = "fetching";
        fetch(FILES[event])
            .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((blob) => {
                const a = this.audio[event];
                // Swapped only while it does not play, so a sound is never cut.
                const swap = () => {
                    if (this.current?.audio === a) {
                        setTimeout(swap, 1000);
                        return;
                    }
                    a.src = URL.createObjectURL(blob);
                    this.kept[event] = "kept";
                };
                swap();
            })
            .catch(() => {
                // Tried again when the sound next fails.
                this.kept[event] = null;
            });
    }

    /**
     * Queue the sounds not played yet.
     * @param {object[]} events Result of soundEvents().
     * @returns {void}
     */
    enqueue(events) {
        const fresh = freshEvents(events, this.played);
        if (!this.audio || fresh.length === 0) {
            return;
        }
        this.queue.push(...fresh.map((e) => e.event));
        this.queue = this.queue.slice(-QUEUE_MAX);
        this.next();
    }

    /**
     * Play one sound now, out of the queue (the button that turns sound on uses it as a test).
     * @param {string} event Sound.
     * @returns {void}
     */
    preview(event) {
        this.load();
        this.queue = [event];
        this.next();
    }

    /**
     * Remember sounds as played without playing them: what was on screen while sound was off.
     * @param {object[]} events Result of soundEvents().
     * @returns {void}
     */
    skip(events) {
        freshEvents(events, this.played);
    }

    /**
     * Stop and forget the queue.
     * @returns {void}
     */
    stop() {
        this.queue = [];
        if (this.current) {
            // Without this, the stopped sound's handlers would fire on the next play of the same
            // recording and start a second sound on top of it.
            const { audio, release } = this.current;
            this.current = null;
            release();
            audio.pause();
        }
        this.playing = false;
    }

    /**
     * Play the next sound of the queue. Whatever ends it (the end, a pause from outside, an error or,
     * failing all, the guard time) moves the queue on: one sound that never ends must not silence
     * the board for good.
     * @returns {void}
     */
    next() {
        if (this.playing || this.queue.length === 0) {
            return;
        }
        const event = this.queue.shift();
        const a = this.audio[event];
        this.playing = true;
        let guard = null;
        const release = () => {
            clearTimeout(guard);
            for (const name of END_EVENTS) {
                a.removeEventListener(name, finish);
            }
        };
        const finish = () => {
            if (this.current?.finish !== finish) {
                return;
            }
            release();
            this.current = null;
            this.playing = false;
            this.next();
        };
        for (const name of END_EVENTS) {
            a.addEventListener(name, finish);
        }
        this.current = { audio: a, finish, release };
        a.currentTime = 0;
        a.play().then(
            () => {
                this.onBlocked(false);
                if (this.current?.finish === finish) {
                    const length = Number.isFinite(a.duration) ? a.duration * 1000 + GUARD_MS : GUARD_UNKNOWN_MS;
                    guard = setTimeout(finish, length);
                }
            },
            (e) => {
                if (this.current?.finish !== finish) {
                    // Stopped while starting (stop() paused it): an AbortError, not a refusal.
                    return;
                }
                release();
                this.current = null;
                this.playing = false;
                if (e?.name === "NotAllowedError") {
                    // Autoplay refused: nothing will play until someone clicks the page.
                    this.queue = [];
                    this.onBlocked(true);
                    return;
                }
                // The file failed (gone from the server, the browser dropped it): fetched again
                // for the next time, and the queue goes on.
                this.onBlocked(false);
                this.kept[event] = null;
                this.keep(event);
                this.next();
            }
        );
    }
}
