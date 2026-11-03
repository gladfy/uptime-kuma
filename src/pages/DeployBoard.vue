<template>
    <div class="deploy-board" :class="{ 'is-dark': $root.isDark, 'is-wall': wall, 'is-idle': idle }">
        <div v-if="!$root.loggedIn" class="db-login">
            <Login v-if="$root.allowLoginDialog" />
        </div>

        <div v-else-if="notFound" class="db-notfound">
            <p>{{ $t("deployBoardNotFound", [slug]) }}</p>
        </div>

        <div v-else class="db-shell">
            <header class="db-top">
                <div class="db-ident">
                    <span class="db-eyebrow">{{ $t("deployBoardEyebrow") }}</span>
                    <h1 class="db-title">
                        {{ $t("deployBoardTitle") }}
                        <span v-if="mock !== null" class="db-mock">{{ $t("deployBoardMock", mock) }}</span>
                    </h1>
                </div>

                <!-- One bar, three readings. A dot only where it says something: never for "no deploy". -->
                <div class="db-summary">
                    <div
                        v-for="seg in summary"
                        :key="seg.id"
                        class="db-seg"
                        :class="'is-' + seg.id"
                        :data-tone="seg.tone"
                        :title="seg.hint || null"
                    >
                        <span class="db-seg-key">{{ seg.key }}</span>
                        <span class="db-seg-value">
                            <span v-if="seg.dot" class="db-dot" :class="'is-' + seg.tone" aria-hidden="true"></span>
                            {{ seg.title }}
                        </span>
                        <span class="db-seg-sub">
                            <b v-if="seg.rate !== undefined" class="db-seg-rate" :class="{ 'is-ok': seg.rate === 100 }">{{ seg.rate }}%</b>
                            <template v-if="seg.parts">
                                <template v-for="(part, i) in seg.parts" :key="i">
                                    <template v-if="i">, </template>
                                    <span :class="{ 'db-seg-bad': part.bad }">{{ part.text }}</span>
                                </template>
                            </template>
                            <template v-else>{{ seg.sub }}</template>
                        </span>
                    </div>
                </div>

                <div class="db-clock">
                    <span class="db-clock-time">{{ clockTime }}</span>
                    <span class="db-clock-date">{{ clockDate }}</span>
                </div>

                <div class="db-controls">
                    <span v-if="soundOn && soundBlocked" class="db-sound-blocked">{{ $t("deployBoardSoundBlocked") }}</span>
                    <button
                        type="button"
                        class="db-theme db-sound db-control"
                        :class="{ 'is-on': soundOn, 'is-blocked': soundOn && soundBlocked }"
                        :title="soundToggleTitle"
                        :aria-label="soundToggleLabel"
                        :aria-pressed="String(soundOn)"
                        @click="toggleSound"
                    >
                        <font-awesome-icon :icon="soundOn ? 'volume-up' : 'volume-mute'" />
                    </button>
                    <button
                        type="button"
                        class="db-theme db-control"
                        :title="themeToggleLabel"
                        :aria-label="themeToggleLabel"
                        @click="toggleTheme"
                    >
                        <font-awesome-icon :icon="$root.isDark ? 'sun' : 'moon'" />
                    </button>
                </div>
            </header>

            <main class="db-main">
                <DeployColumn
                    :board="board"
                    :failures="failures"
                    :now="now"
                    :format-duration="formatDuration"
                    @dismiss="dismiss"
                />

                <section
                    class="db-services"
                    :class="{ 'is-stale': !kumaConnected }"
                    :aria-label="$t('deployBoardServices')"
                >
                    <div class="db-services-head">
                        <h2 class="db-section-title">
                            {{ $t("deployBoardServices") }}
                            <span v-if="curationLoaded" class="db-section-count">{{ $t("deployBoardMonitorCount", monitors.length) }}</span>
                        </h2>
                    </div>

                    <p v-if="!kumaConnected" class="db-warning">{{ $t("deployBoardKumaNoReadDetail") }}</p>
                    <p v-else-if="curationFailed" class="db-warning">{{ $t("deployBoardCurationFailed") }}</p>

                    <div class="db-services-body">
                        <AlertBand v-if="downMonitors.length" :monitors="downMonitors" :now="now" />
                        <MonitorGrid :monitors="gridMonitors" :fill="wall" />
                    </div>
                </section>
            </main>

            <SourcesFooter
                :sources="board ? board.sources : null"
                :kuma-connected="kumaConnected"
                :now="now"
                :format-duration="formatDuration"
            />
        </div>
    </div>
</template>

<script>
import axios from "axios";
import dayjs from "dayjs";
import Login from "../components/Login.vue";
import MonitorGrid from "../components/deploy-board/MonitorGrid.vue";
import AlertBand from "../components/deploy-board/AlertBand.vue";
import DeployColumn from "../components/deploy-board/DeployColumn.vue";
import SourcesFooter from "../components/deploy-board/SourcesFooter.vue";
import { UP, DOWN, PENDING, MAINTENANCE } from "../util.ts";
import { soundEvents } from "../components/deploy-board/sound-events.mjs";
import { SoundPlayer } from "../components/deploy-board/sound-player.js";
import { mockCount, withMockDeploys } from "../components/deploy-board/mock-deploys.js";

/**
 * How often the list of monitors is read again from the status page. Matches the 5-minute cache of
 * /api/status-page/:slug: reading more often would only get the same copy.
 */
const CURATION_MS = 5 * 60 * 1000;

/** Heartbeat bars per monitor. */
const BEATS = 24;

/** Board requests refused (socket not logged in yet) are retried this many times, this far apart. */
const BOARD_RETRIES = 5;
const BOARD_RETRY_MS = 2000;

/** Width from which the board is a one-screen wall layout. Mirrors the media query below. */
const WALL_QUERY = "(min-width: 1180px)";

/** The buttons fade out this long after the last mouse move, touch or key. */
const IDLE_MS = 2500;

/** What counts as someone at the screen. */
const ACTIVITY_EVENTS = ["mousemove", "pointerdown", "touchstart", "keydown"];

/** States and outcomes that are a failure: a card that stays until someone dismisses it. */
const FAILED = ["failed", "stuck"];

/** Where this browser keeps the failures someone dismissed. */
const DISMISSED_KEY = "deployBoardDismissed";
const DISMISSED_MAX = 200;

/**
 * @returns {string[]} Ids of the dismissed failures (empty when the browser keeps nothing).
 */
function dismissedSaved() {
    try {
        const ids = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
        return Array.isArray(ids) ? ids : [];
    } catch (e) {
        return [];
    }
}

/** Where this browser remembers that sound is on. */
const SOUND_KEY = "deployBoardSound";

/**
 * @returns {boolean} Whether sound is on in this browser: on unless someone muted it here.
 */
function soundSaved() {
    try {
        return localStorage.getItem(SOUND_KEY) !== "off";
    } catch (e) {
        return true;
    }
}

/** Kuma heartbeat status → tone used by the board. */
const TONES = {
    [UP]: "up",
    [PENDING]: "pending",
    [DOWN]: "down",
    [MAINTENANCE]: "maintenance",
};

export default {
    components: {
        Login,
        MonitorGrid,
        AlertBand,
        DeployColumn,
        SourcesFooter,
    },

    data() {
        return {
            slug: "",
            curated: [],
            curationLoaded: false,
            curationFailed: false,
            notFound: false,
            board: null,
            now: Date.now(),
            wall: window.matchMedia(WALL_QUERY).matches,
            idle: false,
            dismissed: dismissedSaved(),
            soundOn: soundSaved(),
            // After a reload the browser plays nothing until someone clicks the page.
            soundBlocked: soundSaved() && !navigator.userActivation?.hasBeenActive,
            // ?mock=deploys&n=N: the column drawn with N made-up deploys (see mock-deploys.js).
            mock: mockCount(this.$route.query),
        };
    },

    computed: {
        /** @returns {boolean} Whether the socket to Kuma is up */
        kumaConnected() {
            return !!this.$root.socket?.connected;
        },

        /** @returns {object[]} Curated monitors with their live state */
        monitors() {
            return this.curated.map((entry) => this.liveMonitor(entry));
        },

        /**
         * Monitors that are down, the longest down first, for the band above the grid. Pending ones
         * only get their pill: the band is for what is out.
         * @returns {object[]} Monitors with their deploy line
         */
        downMonitors() {
            return this.monitors
                .filter((m) => m.tone === "down")
                .sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity))
                .map((m) => ({ ...m, deployLine: this.incidentDeployLine(m) }));
        },

        /**
         * Failed and stuck deploys nobody dismissed nor fixed: the ones on screen with their whole card, and the
         * ones the server already moved to the history with what the history keeps. The column draws
         * them and the header counts them, so dismissing one quiets both.
         * @returns {object[]} Deploys, as DeployCard takes them
         */
        failures() {
            if (!this.board) {
                return [];
            }
            // A stuck rollout still on the server's screen is still happening: it leaves when the
            // server moves it to the history, not when someone dismisses it.
            const live = this.board.deploys
                .filter((d) => FAILED.includes(d.state))
                .map((d) => ({ ...d, dismissible: d.state !== "stuck" }));
            const seen = new Set(live.map((d) => d.id));
            const past = this.board.history
                .filter((h) => FAILED.includes(h.outcome) && !seen.has(h.id))
                .map((h) => ({
                    id: h.id,
                    project: h.project,
                    version: h.version,
                    state: h.outcome,
                    label: h.outcome,
                    missed: h.missed,
                    startedAt: h.startedAt,
                    endedAt: h.endedAt,
                    confirmed: true,
                    releases: (h.releases || []).map((r) => ({ ...r, updated: 0, desired: 0, cronJobsUpdated: 0 })),
                    links: h.links,
                    rollback: null,
                    pipeline: null,
                    steps: null,
                    dismissible: true,
                }));
            // A failure a later deploy of the same project fixed leaves by itself; one nobody fixed
            // stays until someone dismisses it.
            const fixed = (f) =>
                [...this.board.deploys.filter((d) => d.state === "done"), ...this.board.history.filter((h) => h.outcome === "done")].some(
                    (d) => d.project === f.project && d.startedAt > f.startedAt
                );
            return [...live, ...past].filter((d) => !(d.dismissible && this.dismissed.includes(d.id)) && !fixed(d));
        },

        /** @returns {object[]} Every monitor in its place, with its deploy mark: none leaves the grid */
        gridMonitors() {
            return this.monitors.map((m) => ({ ...m, mark: this.deployMark(m) }));
        },

        /** @returns {{tone: string, title: string, sub: string}} Services verdict of the top bar */
        servicesVerdict() {
            if (!this.kumaConnected) {
                return {
                    tone: "muted",
                    title: this.$t("deployBoardKumaNoRead"),
                    sub: this.$t("deployBoardKumaNoReadShort"),
                };
            }
            if (!this.curationLoaded) {
                return { tone: "muted", title: this.$t("deployBoardReading"), sub: "" };
            }
            const down = this.monitors.filter((m) => m.tone === "down");
            const pending = this.monitors.filter((m) => m.tone === "pending");
            if (down.length) {
                return { tone: "bad", title: this.$t("deployBoardServicesDown", [down.length]), sub: names(down) };
            }
            if (pending.length) {
                return {
                    tone: "warn",
                    title: this.$t("deployBoardServicesPending", [pending.length]),
                    sub: names(pending),
                };
            }
            const up = this.monitors.filter((m) => m.tone === "up").length;
            const maintenance = this.monitors.filter((m) => m.tone === "maintenance").length;
            const sub = maintenance
                ? this.$t("deployBoardServicesSummaryMaintenance", [up, this.monitors.length, maintenance])
                : this.$t("deployBoardServicesSummary", [up, this.monitors.length]);
            return { tone: "ok", title: this.$t("deployBoardServicesAllUp"), sub };
        },

        /**
         * The three segments of the top bar. The services and deploys ones carry a dot only for a
         * state (normal, running, failing); "no deploy now" and the counters have none.
         * @returns {object[]} Segments: key, title, sub, tone, dot, rate, hint.
         */
        summary() {
            const segments = [
                { id: "services", key: this.$t("deployBoardServices"), ...this.servicesVerdict },
                { id: "deploys", key: this.$t("deployBoardDeploys"), ...this.deploysVerdict },
            ];
            for (const seg of segments) {
                seg.dot = seg.tone !== "idle" && seg.tone !== "muted";
            }
            if (this.stats) {
                const rate = this.stats.successRate;
                segments.push({
                    id: "stats",
                    key: this.$t("deployBoardStatsKey"),
                    title: this.$t("deployBoardStatsTotal", this.stats.total),
                    sub: rate === null ? this.$t("deployBoardStatsSuccessNone") : this.$t("deployBoardStatsSuccessWord"),
                    rate: rate === null ? undefined : rate,
                    tone: "idle",
                    dot: false,
                    hint: this.statsDetail,
                });
            }
            return segments;
        },

        /** @returns {object|null} Counters of the last 24 hours, from the server */
        stats() {
            return this.board ? this.board.stats : null;
        },

        /** @returns {string} Every counter, for the tooltip */
        statsDetail() {
            const s = this.stats;
            return this.$t("deployBoardStatsDetail", [
                s.done,
                s.stuck,
                s.failed,
                s.replaced,
                s.noRollout ?? 0,
                s.cancelled ?? 0,
                s.lost ?? 0,
                s.inProgress,
            ]);
        },

        /** @returns {string} What the sound button does */
        soundToggleLabel() {
            return this.$t(this.soundOn ? "deployBoardSoundOff" : "deployBoardSoundOn");
        },

        /** @returns {string} The same, with where the recordings come from */
        soundToggleTitle() {
            return `${this.soundToggleLabel}. ${this.$t("deployBoardSoundCredits")}`;
        },

        /** @returns {string} What the theme button does */
        themeToggleLabel() {
            return this.$t(this.$root.isDark ? "deployBoardThemeToLight" : "deployBoardThemeToDark");
        },

        /**
         * Deploys verdict of the top bar: how many are running, and below how many are on each step
         * and how many failed. Never the names of the projects: with a few deploys the line wrapped.
         * @returns {{tone: string, title: string, sub?: string, parts?: object[]}} Verdict.
         */
        deploysVerdict() {
            if (!this.board) {
                return { tone: "muted", title: this.$t("deployBoardReading"), sub: "" };
            }
            const anyOn = Object.values(this.board.sources).some((s) => s.state !== "unconfigured");
            if (!anyOn) {
                return { tone: "muted", title: this.$t("deployBoardNoSourcesShort"), sub: "" };
            }
            const count = (states) => this.board.deploys.filter((d) => states.includes(d.state)).length;
            const steps = [
                ["deployBoardSummaryRollout", count(["updating", "noProgress"])],
                ["deployBoardSummaryPipeline", count(["pipeline"])],
                ["deployBoardSummaryBuilt", count(["built"])],
            ];
            const running = steps.reduce((sum, [, n]) => sum + n, 0);
            const parts = steps.filter(([, n]) => n > 0).map(([key, n]) => ({ text: this.$t(key, n) }));
            if (this.failures.length) {
                parts.push({ text: this.$t("deployBoardSummaryFailed", this.failures.length), bad: true });
            }
            if (running > 0) {
                return { tone: "rolling", title: this.$t("deployBoardVerdictRolling", [running]), parts };
            }
            const last = [...this.board.deploys, ...this.board.history]
                .filter((d) => d.endedAt)
                .sort((a, b) => b.endedAt - a.endedAt)[0];
            const sub = last ? this.$t("deployBoardLastDeploy", [last.project, this.formatDuration(this.now - last.endedAt)]) : "";
            // Only failures on screen (a stuck rollout is still happening): red, with the triangle.
            if (this.failures.length) {
                return { tone: "bad", title: this.$t("deployBoardVerdictFailures", this.failures.length), sub };
            }
            if (this.board.sources.cluster.state === "stale") {
                return { tone: "muted", title: this.$t("deployBoardClusterNoRead"), sub: this.board.sources.cluster.detail || "" };
            }
            // Nothing running is not news: grey, with no dot.
            return { tone: "idle", title: this.$t("deployBoardNoDeploysNow"), sub };
        },

        /**
         * Deploys that a monitor can be linked to, with the sources: a monitor is only linked while
         * every source its tags point to (cluster, Amplify) is being read, so nothing is claimed.
         * @returns {{active: object[], ended: object[], sources: object}|null} Deploys, or null.
         */
        linkedDeploys() {
            if (!this.board) {
                return null;
            }
            // On screen but over (failed, cancelled, replaced): no longer "in deploy".
            const active = this.board.deploys.filter((d) => !ENDED_STATES.includes(d.state));
            const ended = [
                ...this.board.deploys.filter((d) => d.state === "done"),
                ...this.board.history.filter((h) => h.outcome === "done"),
            ];
            return { active, ended, sources: this.board.sources };
        },

        /** @returns {string} Wall clock */
        clockTime() {
            return dayjs(this.now).format("HH:mm:ss");
        },

        /** @returns {string} Today's date, in the UI language */
        clockDate() {
            return new Date(this.now).toLocaleDateString(this.$i18n.locale, {
                weekday: "long",
                day: "numeric",
                month: "long",
            });
        },
    },

    watch: {
        "$root.loggedIn": {
            handler(loggedIn) {
                if (!loggedIn) {
                    return;
                }
                if (this.reading) {
                    // Logged in again on the same page: what was on screen is from the old session.
                    this.soundBaseline = true;
                    this.requestBoard();
                    this.fetchCuration();
                } else {
                    this.startReading();
                }
            },
            immediate: true,
        },

        // After a reconnect the server does not push the board by itself: ask again.
        kumaConnected(connected) {
            if (!connected) {
                // What changed while the socket was down was not seen happening: no sound for it.
                this.soundBaseline = true;
            } else if (this.$root.loggedIn) {
                this.requestBoard();
            }
        },
    },

    created() {
        this.soundBaseline = true;
        this.mockStart = Date.now();
        this.player = new SoundPlayer((blocked) => {
            this.soundBlocked = blocked;
        });
        if (this.soundOn) {
            this.player.load();
        }
    },

    mounted() {
        document.body.classList.add("deploy-board-body");
        // A click anywhere is what the browser waits for to let the page play sound.
        this.onFirstGesture = () => {
            this.soundBlocked = false;
        };
        document.addEventListener("pointerdown", this.onFirstGesture);
        document.addEventListener("keydown", this.onFirstGesture);
        // Seen from across the room the buttons are noise: they show while someone is at the screen.
        this.onActivity = () => {
            this.idle = false;
            clearTimeout(this.idleTimer);
            this.idleTimer = setTimeout(() => {
                this.idle = true;
            }, IDLE_MS);
        };
        for (const name of ACTIVITY_EVENTS) {
            document.addEventListener(name, this.onActivity, { passive: true });
        }
        this.onActivity();
        this.slug = String(this.$route.params.slug || "").toLowerCase();
        this.clockTimer = setInterval(() => {
            this.now = Date.now();
        }, 1000);
        this.wallQuery = window.matchMedia(WALL_QUERY);
        this.onWallChange = (e) => {
            this.wall = e.matches;
        };
        this.wallQuery.addEventListener("change", this.onWallChange);
        // Chrome does not freeze a background tab that holds a Web Lock: the socket goes on
        // receiving and the sounds go on playing in a tab that is not in front. Shared, so a second
        // tab with the board (the TV and a desk) holds it too instead of waiting for the first.
        navigator.locks
            ?.request(
                "deploy-board-awake",
                { mode: "shared" },
                () =>
                    new Promise((resolve) => {
                        this.releaseAwake = resolve;
                    })
            )
            .catch(() => {});
    },

    beforeUnmount() {
        document.body.classList.remove("deploy-board-body");
        clearInterval(this.clockTimer);
        clearInterval(this.curationTimer);
        clearTimeout(this.boardRetryTimer);
        this.wallQuery?.removeEventListener("change", this.onWallChange);
        document.removeEventListener("pointerdown", this.onFirstGesture);
        document.removeEventListener("keydown", this.onFirstGesture);
        for (const name of ACTIVITY_EVENTS) {
            document.removeEventListener(name, this.onActivity);
        }
        clearTimeout(this.idleTimer);
        this.player.stop();
        this.releaseAwake?.();
        if (this.onBoardUpdate) {
            this.$root.getSocket()?.off("deployBoardUpdate", this.onBoardUpdate);
        }
    },

    methods: {
        /**
         * Switch between light and dark through Kuma's own theme setting (Settings → Appearance), so
         * the choice is remembered in this browser like the rest of Kuma.
         * @returns {void}
         */
        toggleTheme() {
            this.$root.userTheme = this.$root.isDark ? "light" : "dark";
        },

        /**
         * Turn sound on or off, remembered in this browser. Turning it on rings the bell once: the
         * click is what lets the browser play, and it tells the person it works.
         * @returns {void}
         */
        toggleSound() {
            this.soundOn = !this.soundOn;
            try {
                localStorage.setItem(SOUND_KEY, this.soundOn ? "on" : "off");
            } catch (e) {
                // Not remembered in this browser; it still works until the page is closed.
            }
            if (this.soundOn) {
                this.soundBlocked = false;
                this.player.preview("done");
            } else {
                this.player.stop();
            }
        },

        /**
         * Take a snapshot from the server and play what was seen happening since the last one.
         * @param {object} snapshot Board snapshot.
         * @returns {void}
         */
        applyBoard(snapshot) {
            // The sounds compare the server's snapshots, never the made-up deploys of the mock.
            const previous = this.soundBaseline ? null : this.serverBoard;
            this.soundBaseline = false;
            const events = soundEvents(previous, snapshot);
            if (this.soundOn) {
                this.player.enqueue(events);
            } else {
                // Turning sound on later must not play what already happened.
                this.player.skip(events);
            }
            this.serverBoard = snapshot;
            this.board = this.mock === null ? snapshot : withMockDeploys(snapshot, this.mock, this.mockStart);
        },

        /**
         * Start reading once logged in. Nothing about deploys or monitors is fetched before.
         * @returns {void}
         */
        startReading() {
            if (this.reading) {
                return;
            }
            this.reading = true;
            this.slug = String(this.$route.params.slug || "").toLowerCase();

            this.onBoardUpdate = (snapshot) => {
                this.applyBoard(snapshot);
            };
            this.$root.getSocket().on("deployBoardUpdate", this.onBoardUpdate);
            this.requestBoard();

            this.fetchCuration();
            this.curationTimer = setInterval(this.fetchCuration, CURATION_MS);
        },

        /**
         * Ask the server for the whole board state.
         *
         * Retries a refusal a few times: after a reconnect the client sends `loginByToken` first, but
         * the server finishes it asynchronously, so a request sent right behind it can arrive before
         * the socket is logged in again. Without the retry the board stays stale until the next change.
         * @param {number} attempt Attempt number, starting at 0.
         * @returns {void}
         */
        requestBoard(attempt = 0) {
            clearTimeout(this.boardRetryTimer);
            this.$root.getSocket().emit("getDeployBoard", (res) => {
                if (res && res.ok) {
                    this.applyBoard(res.board);
                } else if (attempt < BOARD_RETRIES && this.$root.loggedIn) {
                    this.boardRetryTimer = setTimeout(() => this.requestBoard(attempt + 1), BOARD_RETRY_MS);
                }
            });
        },

        /**
         * Read which monitors the status page shows, in its order. A failed read keeps the last list.
         * @returns {void}
         */
        fetchCuration() {
            axios
                .get(`/api/status-page/${encodeURIComponent(this.slug)}`)
                .then((res) => {
                    if (!res.data?.config?.published) {
                        this.notFound = true;
                        return;
                    }
                    this.curated = curatedMonitors(res.data.publicGroupList || []);
                    this.curationLoaded = true;
                    this.curationFailed = false;
                    this.notFound = false;
                })
                .catch((error) => {
                    if (error.response && error.response.status === 404) {
                        this.notFound = true;
                    } else {
                        this.curationFailed = true;
                    }
                });
        },

        /**
         * One curated monitor with its live state from the socket.
         * @param {{id: number, name: string}} entry Curated monitor.
         * @returns {object} { id, name, tone, label, since, beats }
         */
        liveMonitor(entry) {
            const monitor = this.$root.monitorList[entry.id];
            const list = this.$root.heartbeatList[entry.id] || [];
            const last = list[list.length - 1];

            let tone;
            if (monitor && !monitor.active) {
                tone = "paused";
            } else if (last && TONES[last.status]) {
                tone = TONES[last.status];
            } else {
                tone = "unknown";
            }

            return {
                id: entry.id,
                name: monitor?.name || entry.name,
                releases: deployTags(monitor),
                tone,
                label: this.$t(LABEL_KEYS[tone]),
                since: last ? sinceOf(list) : null,
                downChecks: tone === "down" ? runLength(list) : 0,
                beats: beatsOf(list),
            };
        },

        /**
         * Mark of a monitor in the grid. Only the deploy changes it; the colour stays Kuma's. Only a
         * deploy that reached the service marks it: the rollout in the cluster, or the publication in
         * the Amplify. In the merge and the pipeline the service has not been touched yet.
         * @param {object} monitor Live monitor.
         * @returns {string|null} "rolling", "stuck" or null.
         */
        deployMark(monitor) {
            const deploys = this.linkedDeploys;
            if (!deploys || !monitor.releases.length || !sourcesRead(monitor.releases, deploys.sources)) {
                return null;
            }
            const touching = deploys.active.filter((d) => reachedService(d) && touches(d, monitor.releases));
            if (touching.some((d) => d.state === "stuck")) {
                return "stuck";
            }
            return touching.length ? "rolling" : null;
        },

        /**
         * Line about deploys in the alert band of a monitor that is down. Omitted when a
         * source of its tags is not being read: "no related deploy" can only be said by who reads it.
         * @param {object} monitor Live monitor.
         * @returns {string|null} The line, or null.
         */
        incidentDeployLine(monitor) {
            const deploys = this.linkedDeploys;
            if (!deploys) {
                return null;
            }
            if (!monitor.releases.length) {
                return ["cluster", "amplify"].some((id) => deploys.sources[id]?.state === "active")
                    ? this.$t("deployBoardIncidentNoTag")
                    : null;
            }
            if (!sourcesRead(monitor.releases, deploys.sources)) {
                return null;
            }
            const running = deploys.active.find((d) => touches(d, monitor.releases));
            if (running) {
                return this.$t("deployBoardIncidentDeploying", [running.project]);
            }
            const start = monitor.since ?? this.now;
            const before = deploys.ended
                .filter((d) => touches(d, monitor.releases) && d.endedAt <= start && start - d.endedAt <= RELATED_MS)
                .sort((a, b) => b.endedAt - a.endedAt)[0];
            if (before) {
                const link = linksOf(before).find((l) => monitor.releases.includes(l));
                const line = this.$t("deployBoardIncidentAfter", [this.formatDuration(start - before.endedAt), link.split("/")[1]]);
                return before.version ? `${line} · ${before.version}` : line;
            }
            return this.$t("deployBoardIncidentNoneRecent");
        },

        /**
         * Take a failure off the screen, in this browser: its card and its count in the header.
         * @param {string} id Deploy id.
         * @returns {void}
         */
        dismiss(id) {
            this.dismissed = [...this.dismissed, id].slice(-DISMISSED_MAX);
            try {
                localStorage.setItem(DISMISSED_KEY, JSON.stringify(this.dismissed));
            } catch (e) {
                // Not kept: it comes back after a reload.
            }
        },

        /**
         * Short duration: "12 s", "3 min", "1 h 05 min".
         * @param {number} ms Milliseconds.
         * @returns {string} Formatted duration.
         */
        formatDuration(ms) {
            const seconds = Math.max(0, Math.round(ms / 1000));
            if (seconds < 60) {
                return `${seconds} s`;
            }
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) {
                return `${minutes} min`;
            }
            return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
        },
    },
};

/** A rollout that ended this long before an outage is named in its highlight. */
const RELATED_MS = 60 * 60 * 1000;

/** Deploy states that are over, though the card is still on screen. */
const ENDED_STATES = ["done", "failed", "cancelled", "superseded"];

/**
 * What a monitor is linked to, from its Kuma tags named "deploy": "<namespace>/<release>" of the
 * cluster, or "amplify/<app>".
 * @param {object|undefined} monitor Monitor from the socket list.
 * @returns {string[]} Tag values.
 */
function deployTags(monitor) {
    return (monitor?.tags || [])
        .filter((t) => t.name === "deploy" && typeof t.value === "string" && t.value.includes("/"))
        .map((t) => t.value.trim());
}

/**
 * @param {string[]} tags Tag values of a monitor.
 * @param {object} sources Sources of the board.
 * @returns {boolean} Whether every source its tags point to is being read: "no related deploy" can
 * only be said by who reads the source.
 */
function sourcesRead(tags, sources) {
    return tags.every((t) => sources[t.startsWith("amplify/") ? "amplify" : "cluster"]?.state === "active");
}

/** States of a deploy rolling out in the cluster: the service is being changed. */
const ROLLOUT_STATES = ["updating", "noProgress", "stuck"];

/** Amplify step that puts the new build out, and the states in which it has started. */
const AMPLIFY_PUBLISH_JOB = "deploy";
const STARTED_JOB_STATES = ["running", "success"];

/**
 * @param {object} deploy Deploy on screen.
 * @returns {boolean} Whether it reached the service: rolling out in the cluster, or past the start
 * of the Amplify "deploy" step.
 */
function reachedService(deploy) {
    if (deploy.pipeline?.source === "amplify") {
        return (deploy.pipeline.jobs || []).some((j) => j.name === AMPLIFY_PUBLISH_JOB && STARTED_JOB_STATES.includes(j.state));
    }
    return ROLLOUT_STATES.includes(deploy.state);
}

/**
 * @param {object} deploy Deploy or history entry.
 * @returns {string[]} The tag values it answers to (older servers send only the releases).
 */
function linksOf(deploy) {
    return deploy.links || deploy.releases.map((r) => `${r.namespace}/${r.release}`);
}

/**
 * @param {object} deploy Deploy or history entry.
 * @param {string[]} tags Tag values of a monitor.
 * @returns {boolean} Whether the deploy touches any of them.
 */
function touches(deploy, tags) {
    return linksOf(deploy).some((l) => tags.includes(l));
}

/** Tone → i18n key of its label. */
const LABEL_KEYS = {
    up: "deployBoardStatusUp",
    pending: "deployBoardStatusPending",
    down: "deployBoardStatusDown",
    maintenance: "deployBoardStatusMaintenance",
    paused: "deployBoardStatusPaused",
    unknown: "deployBoardStatusUnknown",
};

/**
 * Monitors of the status page, in its order. A group shown with its children is replaced by them,
 * like on the status page itself; a monitor listed twice appears once.
 * @param {object[]} groups publicGroupList of /api/status-page/:slug.
 * @returns {{id: number, name: string}[]} Curated monitors.
 */
function curatedMonitors(groups) {
    const out = [];
    const seen = new Set();
    const add = (id, name) => {
        if (!seen.has(id)) {
            seen.add(id);
            out.push({ id, name });
        }
    };
    for (const group of groups) {
        for (const monitor of group.monitorList || []) {
            if (monitor.showChildren && Array.isArray(monitor.childrenList)) {
                for (const child of monitor.childrenList) {
                    add(child.id, child.name);
                }
            } else {
                add(monitor.id, monitor.name);
            }
        }
    }
    return out;
}

/**
 * When the current state began: the oldest heartbeat of the latest run of equal statuses.
 * Bounded by what the socket delivered, so for long states it is "at least since".
 * @param {object[]} list Heartbeats, oldest first.
 * @returns {number|null} Epoch ms.
 */
function sinceOf(list) {
    if (!list.length) {
        return null;
    }
    const status = list[list.length - 1].status;
    let i = list.length - 1;
    while (i > 0 && list[i - 1].status === status) {
        i--;
    }
    const time = dayjs.utc(list[i].time);
    return time.isValid() ? time.valueOf() : null;
}

/**
 * @param {object[]} list Heartbeats, oldest first.
 * @returns {number} How many of the latest ones in a row have the status of the last one.
 */
function runLength(list) {
    let n = 0;
    for (let i = list.length - 1; i >= 0 && list[i].status === list[list.length - 1].status; i--) {
        n++;
    }
    return n;
}

/**
 * The last BEATS statuses as tones, oldest first, padded on the left when there are fewer.
 * @param {object[]} list Heartbeats, oldest first.
 * @returns {string[]} Tones ("empty" for padding).
 */
function beatsOf(list) {
    const tail = list.slice(-BEATS).map((hb) => TONES[hb.status] || "empty");
    return Array(BEATS - tail.length)
        .fill("empty")
        .concat(tail);
}

/**
 * @param {object[]} monitors Monitors.
 * @returns {string} Their names, comma separated.
 */
function names(monitors) {
    return monitors.map((m) => m.name).join(", ");
}
</script>

<!-- The @font-face rules stay out of the scoped block: at-rules are not scoped. Same file as the TV panel. -->
<!-- eslint-disable-next-line vue-scoped-css/enforce-style-type -->
<style>
@import "../assets/fonts/plus-jakarta-sans.css";

/* Kuma's heartbeat toasts would sit on top of the monitors of a wall screen; the board already
   promotes every outage to its highlight block. Only while this page is open. */
/* stylelint-disable-next-line selector-class-pattern -- class name owned by vue-toastification */
body.deploy-board-body .Vue-Toastification__container {
    display: none;
}

/* Buttons and links of the whole board, children included, fade out with no one at the screen; a
   keyboard focus brings its own back. Here, unscoped, because they live in the child components. */
.deploy-board.is-idle .db-control {
    opacity: 0;
    pointer-events: none;
}

.deploy-board.is-idle .db-control:focus-visible {
    opacity: 1;
    pointer-events: auto;
}
</style>

<style lang="scss" scoped>
/* Layout: deploys in a narrow column on the left, the status page monitors filling the rest. */
.deploy-board {
    --db-bg: #f4f2f6;
    --db-panel: #fff;
    --db-panel-2: #f0edf3;
    --db-line: #e3dee8;
    --db-line-2: #d2ccd8;
    --db-ink: #1c1921;
    --db-ink-2: #565060;
    --db-ink-3: #77717f;
    --db-brand: #b11e58;
    --db-ok: #157a3b;
    --db-ok-soft: #e2f3e8;
    --db-warn: #9a5806;
    --db-warn-soft: #fbeed6;
    --db-bad: #c42828;
    --db-bad-soft: #fbe3e3;
    // Solid red with white text: deep enough in both themes for the text to read.
    --db-bad-solid: #c42828;
    --db-on-bad: #fff;
    --db-maint: #535e8d;
    --db-maint-soft: #e8eaf4;
    // "Deploy em andamento", on both columns. Brand magenta is only identity.
    --db-deploy: #1765c4;
    --db-deploy-soft: #e2edfa;
    --db-gap: 8px;

    position: fixed;
    inset: 0;
    z-index: 1;
    overflow-x: hidden;
    overflow-y: auto;
    background: var(--db-bg);
    color: var(--db-ink);
    font-family:
        "Plus Jakarta Sans",
        system-ui,
        -apple-system,
        "Segoe UI",
        Roboto,
        Arial,
        sans-serif;
    // The type scale is fixed (12.5 / 13.5 / 15 / 17 / 21 / 32): the base is the 15.
    font-size: 15px;
    line-height: 1.35;
    -webkit-font-smoothing: antialiased;

    &.is-dark {
        --db-bg: #110f14;
        --db-panel: #1a171e;
        --db-panel-2: #231f28;
        --db-line: #2e2934;
        --db-line-2: #3d3744;
        --db-ink: #efecf2;
        --db-ink-2: #aca5b4;
        --db-ink-3: #7f7887;
        --db-brand: #ea7aa5;
        --db-ok: #3cc784;
        --db-ok-soft: #15301f;
        --db-warn: #eaae42;
        --db-warn-soft: #35290f;
        --db-bad: #f2625f;
        --db-bad-soft: #3b1a1c;
        --db-bad-solid: #c8302e;
        --db-maint: #959ec7;
        --db-maint-soft: #23263a;
        --db-deploy: #5aa7ff;
        --db-deploy-soft: #13263b;

        color-scheme: dark;
    }
}

.db-login,
.db-notfound {
    display: grid;
    place-items: center;
    min-height: 100%;
    padding: 32px max(16px, env(safe-area-inset-right, 0px)) 32px max(16px, env(safe-area-inset-left, 0px));
}

.db-shell {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 100%;
    padding-block: 12px;
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
}

.db-top {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 12px 16px;
}

.db-ident {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    min-width: 0;
}

.db-eyebrow {
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--db-brand);
}

.db-title {
    margin: 0;
    font-size: 21px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.05;
}

// A TV left on the mock must not pass for the real thing.
.db-mock {
    margin-left: 8px;
    padding: 2px 8px;
    border: 1px dashed var(--db-warn);
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0;
    vertical-align: middle;
    color: var(--db-warn);
}

/* The three readings in one bar, split by hairlines. */
.db-summary {
    display: flex;
    flex: 1 1 36em;
    flex-wrap: wrap;
    max-width: 62em;
    min-width: 0;
    background: var(--db-panel);
    border: 1px solid var(--db-line);
    border-radius: 14px;
}

.db-seg {
    display: grid;
    flex: 1 1 12em;
    align-content: center;
    gap: 2px;
    min-width: 0;
    padding: 12px 20px;

    & + & {
        border-left: 1px solid var(--db-line);
    }

    // Its line counts every step: "2 na virada, 2 na pipeline, 1 aguardando virada, 1 falhou".
    &.is-deploys {
        flex: 1.6 1 16em;
    }
}

.db-seg-key {
    font-size: 12.5px;
    color: var(--db-ink-3);
}

.db-seg-value {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 21px;
    font-weight: 600;
    line-height: 1.2;

    [data-tone="bad"] > & {
        color: var(--db-bad);
    }

    [data-tone="warn"] > & {
        color: var(--db-warn);
    }

    [data-tone="rolling"] > & {
        color: var(--db-deploy);
    }

    [data-tone="idle"] > &,
    [data-tone="muted"] > & {
        color: var(--db-ink-2);
    }
}

.db-seg-sub {
    font-size: 12.5px;
    color: var(--db-ink-3);
    overflow-wrap: anywhere;

    // The deploys line stays one line, whatever happens.
    .is-deploys > & {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
}

.db-seg-bad {
    font-weight: 600;
    color: var(--db-bad);
}

.db-seg-rate {
    font-weight: 600;
    color: var(--db-ink-2);

    &.is-ok {
        color: var(--db-ok);
    }
}

.db-dot {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--db-ok);

    &.is-warn {
        background: var(--db-warn);
    }

    &.is-rolling {
        background: var(--db-deploy);
        animation: db-dot-pulse 1.8s ease-in-out infinite;
    }

    // Red, pulsing, and a triangle: the critical state is told apart by shape too.
    &.is-bad {
        width: 10px;
        height: 9px;
        border-radius: 0;
        background: var(--db-bad);
        clip-path: polygon(50% 0, 100% 100%, 0 100%);
        animation: db-dot-pulse 1.8s ease-in-out infinite;
    }
}

@keyframes db-dot-pulse {
    50% {
        opacity: 0.35;
    }
}

@media (prefers-reduced-motion: reduce) {
    .db-dot.is-rolling,
    .db-dot.is-bad {
        animation: none;
    }
}

.db-clock {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-end;
    gap: 4px;
    margin-left: auto;
}

.db-clock-time {
    font-size: 32px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
}

.db-clock-date {
    font-size: 13.5px;
    color: var(--db-ink-3);
}

.db-controls {
    position: relative;
    align-self: center;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
}

.db-sound {
    &.is-on {
        color: var(--db-brand);
    }

    &.is-blocked {
        border-color: var(--db-warn);
        color: var(--db-warn);
    }
}

// Floats under the buttons: showing up must not push the header into a second line.
.db-sound-blocked {
    position: absolute;
    top: calc(100% + 0.4em);
    right: 0;
    z-index: 2;
    padding: 4px 8px;
    border: 1px solid var(--db-warn);
    border-radius: 999px;
    background: var(--db-warn-soft);
    font-size: 12.5px;
    font-weight: 600;
    white-space: nowrap;
    color: var(--db-warn);
}

.db-theme {
    align-self: center;
    display: grid;
    place-items: center;
    width: 2.2em;
    height: 2.2em;
    padding: 0;
    border: 1px solid var(--db-line);
    border-radius: 50%;
    background: var(--db-panel);
    color: var(--db-ink-2);
    cursor: pointer;

    &:hover {
        color: var(--db-brand);
        border-color: var(--db-line-2);
    }

    &:focus-visible {
        outline: 2px solid var(--db-brand);
        outline-offset: 2px;
    }
}

.db-main {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
}

.db-services {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    min-height: 0;

    &.is-stale .db-services-body {
        opacity: 0.4;
        filter: grayscale(0.7);
    }
}

.db-services-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.db-services-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 16px;
}

.db-section-count {
    margin-left: 8px;
    font-size: 13.5px;
    font-weight: 400;
    color: var(--db-ink-3);
}

.db-section-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--db-ink-2);
}

.db-warning {
    margin: 0;
    font-weight: 700;
    color: var(--db-warn);
}

/* Wall layout: one screen, no scroll, two columns; the grid measures the space it gets. */
@media (min-width: 1180px) {
    .deploy-board {
        overflow: hidden;
    }

    .db-shell {
        height: 100%;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
    }

    .db-main {
        display: grid;
        grid-template-columns: minmax(340px, 29%) minmax(0, 1fr);
        gap: 20px;
        min-height: 0;
    }

    .db-services-body {
        flex: 1 1 0;
        min-height: 0;
    }
}

@media (max-width: 680px) {
    .db-summary {
        flex-basis: 100%;
        max-width: none;
    }

    // Stacked, the hairlines go between the rows.
    .db-seg {
        flex-basis: 100%;

        & + & {
            border-left: 0;
            border-top: 1px solid var(--db-line);
        }
    }

    .db-clock {
        align-items: flex-start;
    }
}
</style>
