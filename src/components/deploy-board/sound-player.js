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
        }
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
            // Without this, the stopped sound's handler would fire on the next play of the same
            // recording and start a second sound on top of it.
            this.current.audio.removeEventListener("ended", this.current.finish);
            this.current.audio.pause();
            this.current = null;
        }
        this.playing = false;
    }

    /**
     * @returns {void}
     */
    next() {
        if (this.playing || this.queue.length === 0) {
            return;
        }
        const a = this.audio[this.queue.shift()];
        this.playing = true;
        const finish = () => {
            a.removeEventListener("ended", finish);
            this.current = null;
            this.playing = false;
            this.next();
        };
        a.addEventListener("ended", finish);
        this.current = { audio: a, finish };
        a.currentTime = 0;
        a.play().then(
            () => this.onBlocked(false),
            (e) => {
                if (this.current?.finish !== finish) {
                    // Stopped while starting (stop() paused it): an AbortError, not a refusal.
                    return;
                }
                a.removeEventListener("ended", finish);
                this.current = null;
                this.queue = [];
                this.playing = false;
                // Autoplay refused: nothing will play until someone clicks the page.
                this.onBlocked(e?.name === "NotAllowedError");
            }
        );
    }
}
