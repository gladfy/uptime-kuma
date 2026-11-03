<template>
    <section class="db-deploys" :class="{ 'has-cards': cards.length > 0 }" :aria-label="$t('deployBoardDeploys')">
        <p v-if="!board" class="db-empty">{{ $t("deployBoardReading") }}</p>
        <p v-else-if="noSourceOn" class="db-empty">{{ $t("deployBoardNoSources") }}</p>

        <!-- A failure stays until someone dismisses it; a deploy that went live becomes a line below. -->
        <template v-if="failureCards.length">
            <h2 class="db-section-title">
                {{ $t("deployBoardFailures") }}
                <span class="db-section-count">{{ failureCards.length }}</span>
            </h2>
            <div class="db-cards">
                <DeployCard
                    v-for="deploy in failureCards"
                    :key="deploy.id"
                    :data-id="deploy.id"
                    :hidden="hiddenIds.includes(deploy.id)"
                    :deploy="deploy"
                    :now="now"
                    :format-duration="formatDuration"
                    :dismissible="deploy.dismissible"
                    :level="levels[deploy.id] || 'full'"
                    @dismiss="$emit('dismiss', $event)"
                />
            </div>
        </template>

        <template v-if="running.length">
            <h2 class="db-section-title">
                {{ $t("deployBoardRunning") }}
                <span class="db-section-count">{{ running.length }}</span>
            </h2>
            <div class="db-cards">
                <DeployCard
                    v-for="deploy in running"
                    :key="deploy.id"
                    :data-id="deploy.id"
                    :hidden="hiddenIds.includes(deploy.id)"
                    :deploy="deploy"
                    :now="now"
                    :format-duration="formatDuration"
                    :level="levels[deploy.id] || 'full'"
                />
            </div>
        </template>
        <!-- In place of the cards that did not fit even compact. -->
        <p class="db-more" :hidden="hiddenIds.length === 0">{{ $t("deployBoardMore", hiddenIds.length) }}</p>

        <div ref="history" class="db-history">
            <h2 class="db-section-title">
                {{ $t("deployBoardHistory") }}
                <span class="db-section-count">{{ $t("deployBoardStatsTotal", historyRows.length) }}</span>
            </h2>
            <p v-if="historyRows.length === 0" class="db-muted">{{ $t("deployBoardHistoryEmpty") }}</p>
            <ol v-else ref="list" class="db-history-list" :class="{ 'is-clipped': clipped }">
                <li
                    v-for="item in historyRows"
                    :key="item.id"
                    class="db-history-item"
                    :class="['is-' + outcomeClass(item.outcome), { 'is-fresh': isFresh(item) }]"
                >
                    <span class="db-history-outcome" role="img" :aria-label="$t(OUTCOME_KEYS[item.outcome])" :title="$t(OUTCOME_KEYS[item.outcome])">
                        {{ OUTCOME_MARKS[item.outcome] || "·" }}
                    </span>
                    <span class="db-history-name">
                        <span class="db-history-project">{{ item.project }}</span>
                        <code v-if="item.version" class="db-history-version">{{ item.version }}</code>
                        <!-- A small button in the name, so the line keeps its height while it is hidden. -->
                        <button
                            v-if="item.rollback"
                            type="button"
                            class="db-history-back db-control"
                            :aria-expanded="String(backOpen === item.id)"
                            @click="backOpen = backOpen === item.id ? null : item.id"
                        >
                            {{ $t("deployBoardRollbackButton") }}
                        </button>
                    </span>
                    <span class="db-history-took" :class="{ 'is-unknown': item.missed }">
                        {{ item.missed ? "—" : formatDuration(item.endedAt - item.startedAt) }}
                    </span>
                    <span class="db-history-when">{{ $t("deployBoardAgo", [formatDuration(now - item.endedAt)]) }}</span>
                    <RollbackPanel
                        v-if="item.rollback && backOpen === item.id"
                        :rollback="item.rollback"
                        :toggle="false"
                        class="db-history-rollback"
                    />
                </li>
            </ol>
            <p v-if="historyRows.some((item) => item.missed)" class="db-history-note">{{ $t("deployBoardMissedNote") }}</p>
        </div>
    </section>
</template>

<script>
import DeployCard from "./DeployCard.vue";
import RollbackPanel from "./RollbackPanel.vue";

/** States of a rollout in the cluster: after the failures, the first cards promoted to medium. */
const ROLLOUT_STATES = ["updating", "noProgress"];

/** States of a deploy still moving: it has a card under "Em andamento". */
const RUNNING_STATES = ["pipeline", "built", "updating", "noProgress"];

/** An ended deploy on screen → the outcome of its line in the history. */
const ENDED_OUTCOMES = { done: "done", cancelled: "cancelled", superseded: "replaced" };

/** A deploy that went live is highlighted at the top of the history this long. */
const FRESH_MS = 15 * 60 * 1000;

/**
 * Outcome → a mark that reads at a glance; the word is its title and its accessible name. ✓ and ✕
 * differ in shape, not only in colour.
 */
const OUTCOME_MARKS = {
    done: "✓",
    stuck: "✕",
    failed: "✕",
    noRollout: "!",
    cancelled: "–",
    replaced: "↻",
    lost: "?",
};

/** Outcome of a finished deploy → i18n key. */
const OUTCOME_KEYS = {
    done: "deployBoardOutcomeDone",
    stuck: "deployBoardOutcomeStuck",
    replaced: "deployBoardOutcomeReplaced",
    failed: "deployBoardOutcomeFailed",
    noRollout: "deployBoardOutcomeNoRollout",
    cancelled: "deployBoardOutcomeCancelled",
    lost: "deployBoardOutcomeLost",
};

/**
 * @param {object} a Deploy.
 * @param {object} b Deploy.
 * @returns {number} The one that started first goes first; the same start, by id.
 */
function byStart(a, b) {
    return a.startedAt - b.startedAt || String(a.id).localeCompare(String(b.id));
}

export default {
    components: {
        DeployCard,
        RollbackPanel,
    },

    props: {
        /** Board snapshot from the server, or null before the first read */
        board: {
            type: Object,
            default: null,
        },
        /** Current time, in ms */
        now: {
            type: Number,
            required: true,
        },
        /** Formats a duration in ms */
        formatDuration: {
            type: Function,
            required: true,
        },
        /** Failures nobody dismissed (the page keeps the list: the header counts the same ones) */
        failures: {
            type: Array,
            default: () => [],
        },
    },

    emits: ["dismiss"],

    data() {
        return { OUTCOME_KEYS, OUTCOME_MARKS, clipped: false, backOpen: null, levels: {}, hiddenIds: [] };
    },

    computed: {
        /** @returns {boolean} True when no deploy source is configured at all */
        noSourceOn() {
            return Object.values(this.board.sources).every((s) => s.state === "unconfigured");
        },

        /** @returns {object[]} Every card, in the order of the screen: the failures first */
        cards() {
            return [...this.failureCards, ...this.running];
        },

        /** @returns {object[]} The failures, the oldest first */
        failureCards() {
            return [...this.failures].sort(byStart);
        },

        /**
         * What changes the height of the cards: the list, and what each card has inside. The time
         * text changes every second, but on a line of its own that does not wrap.
         * @returns {string} Key that changes when the levels must be picked again.
         */
        layoutKey() {
            return JSON.stringify(
                this.cards.map((d) => [
                    d.id,
                    d.state,
                    d.label,
                    d.dismissible,
                    d.releases.length,
                    d.releases.some((r) => r.atBoot),
                    d.confirmed,
                    !!d.rollback,
                    d.pipeline?.state,
                    d.pipeline?.jobs.length,
                    d.pipeline?.message,
                ])
            );
        },

        /**
         * Deploys still moving, the oldest first: a card keeps its place as its deploy goes from one
         * step to the next (the server sends them by state).
         * @returns {object[]} Deploys.
         */
        running() {
            return this.board ? this.board.deploys.filter((d) => RUNNING_STATES.includes(d.state)).sort(byStart) : [];
        },

        /**
         * The history, with the deploys that ended and are still on the server's screen (a deploy that
         * went live is a line here, not a card), newest first.
         * @returns {object[]} Lines: outcome, project, version, times, and the way back while it has one
         */
        historyRows() {
            if (!this.board) {
                return [];
            }
            const ended = this.board.deploys
                .filter((d) => ENDED_OUTCOMES[d.state])
                .map((d) => ({ ...d, outcome: ENDED_OUTCOMES[d.state] }));
            const ids = new Set(ended.map((d) => d.id));
            return [...ended, ...this.board.history.filter((h) => !ids.has(h.id))].sort((a, b) => b.endedAt - a.endedAt);
        },
    },

    watch: {
        // "post": after the cards are in the DOM and before the browser paints them.
        layoutKey: {
            handler() {
                this.fit();
            },
            flush: "post",
        },
        "historyRows.length"() {
            this.$nextTick(this.measure);
        },
        // The way back opens inside the list: it grows without anything changing size.
        backOpen() {
            this.$nextTick(this.measure);
        },
    },

    mounted() {
        // The history, not the column: on a wall screen the column keeps its height, and what changes
        // is the room the cards above leave to the history.
        this.observer = new ResizeObserver(() => this.measure());
        this.observer.observe(this.$refs.history);
        // The column itself for the levels: it changes size with the window, not with the cards.
        this.columnObserver = new ResizeObserver(() => this.fit());
        this.columnObserver.observe(this.$el);
        // The web font is wider than the fallback: what fitted before it loads may not fit after.
        // "ready" may already be resolved when the page has not asked for the font yet.
        this.onFonts = () => this.fit();
        document.fonts?.ready.then(this.onFonts);
        document.fonts?.addEventListener("loadingdone", this.onFonts);
        this.fit();
        this.measure();
    },

    beforeUnmount() {
        this.observer?.disconnect();
        this.columnObserver?.disconnect();
        document.fonts?.removeEventListener("loadingdone", this.onFonts);
    },

    methods: {
        /**
         * Pick the level of each card by measuring the column, all in one go before the browser
         * paints: every card full; else every card medium; else every card compact, with the
         * failures and then the rollouts promoted to medium one at a time while they fit; and when
         * not even compact fits, the cards from the end (never the first) hidden behind "+N".
         *
         * The levels and the hidden cards are written to the DOM while measuring, and the same
         * values are kept in the data at the end: the render that follows changes nothing on screen.
         * @returns {void}
         */
        fit() {
            const column = this.$el;
            const more = column?.querySelector?.(".db-more");
            if (!more) {
                return;
            }
            const cards = this.cards
                .map((deploy) => ({ deploy, el: column.querySelector(`.db-card[data-id="${CSS.escape(deploy.id)}"]`) }))
                .filter((c) => c.el);
            const overflows = () => column.scrollHeight > column.clientHeight + 1;
            const levels = {};
            const setLevel = (card, level) => {
                card.el.dataset.level = level;
                levels[card.deploy.id] = level;
            };
            const setHidden = (card, hidden) => {
                card.el.hidden = hidden;
            };
            for (const card of cards) {
                setHidden(card, false);
            }
            more.hidden = true;

            let hidden = [];
            const pick = () => {
                for (const level of ["full", "medium"]) {
                    cards.forEach((c) => setLevel(c, level));
                    if (!overflows()) {
                        return;
                    }
                }
                cards.forEach((c) => setLevel(c, "compact"));
                if (!overflows()) {
                    const failed = cards.filter((c) => this.failureCards.includes(c.deploy));
                    const rolling = cards.filter((c) => !failed.includes(c) && ROLLOUT_STATES.includes(c.deploy.state));
                    for (const card of [...failed, ...rolling]) {
                        setLevel(card, "medium");
                        if (overflows()) {
                            setLevel(card, "compact");
                        }
                    }
                    return;
                }
                more.hidden = false;
                for (let i = cards.length - 1; i > 0 && overflows(); i--) {
                    setHidden(cards[i], true);
                    hidden.push(cards[i].deploy.id);
                }
            };
            pick();
            if (!hidden.length) {
                more.hidden = true;
            }
            this.levels = levels;
            this.hiddenIds = hidden;
        },

        /**
         * Fade the bottom of the history only when it does not fit: a list that fits ends clean.
         * @returns {void}
         */
        measure() {
            const list = this.$refs.list;
            this.clipped = !!list && list.scrollHeight > list.clientHeight + 1;
        },

        /**
         * @param {object} item Line of the history.
         * @returns {boolean} Whether it went live in the last FRESH_MS
         */
        isFresh(item) {
            return item.outcome === "done" && this.now - item.endedAt < FRESH_MS;
        },

        /**
         * @param {string} outcome Outcome of a history entry.
         * @returns {string} Kebab-case class suffix.
         */
        outcomeClass(outcome) {
            return outcome === "noRollout" ? "no-rollout" : outcome;
        },
    },
};
</script>

<style lang="scss" scoped>
.db-deploys {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}

.db-section-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--db-ink-2);
}

.db-section-count {
    margin-left: 8px;
    font-size: 13.5px;
    font-weight: 400;
    color: var(--db-ink-3);
}

.db-empty {
    margin: 0;
    padding: 12px 16px;
    border: 1px dashed var(--db-line-2);
    border-radius: 14px;
    color: var(--db-ink-2);
    text-wrap: pretty;
}

.db-cards {
    display: grid;
    flex-shrink: 0;
    gap: 8px;
}

/* On a wall screen the history gives way first: cards are never cut, the oldest lines are. With
   cards on screen it keeps room for three lines; the cards change level to leave it that. */
.db-history {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow: hidden;

    // The title and three lines of about 33 px, above the fade of the bottom.
    .has-cards > & {
        min-height: 150px;
    }
}

.db-more {
    flex-shrink: 0;
    margin: 0;
    padding: 8px 14px;
    border-radius: 10px;
    background: var(--db-deploy-soft);
    color: var(--db-deploy);
    font-size: 13.5px;
    font-weight: 600;
}

.db-history-list {
    display: grid;
    align-content: start;
    gap: 4px;
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow: hidden;
    list-style: none;
    font-size: 13.5px;

    // Cut softly, without a scrollbar, when it does not fit.
    &.is-clipped {
        mask-image: linear-gradient(to bottom, #000 calc(100% - 24px), transparent);
    }
}

/* Mark, name, duration and time since, the two numbers each in a column of its own. Fixed widths:
   every line is its own grid, and only fixed columns line up from one line to the next. */
.db-history-item {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) 6em 8em;
    align-items: baseline;
    gap: 8px;
    padding-block: 4px;
    border-bottom: 1px solid var(--db-line);
}

.db-history-name {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
}

.db-history-project {
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
}

.db-history-version {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13.5px;
    color: var(--db-ink-3);
}

.db-history-took,
.db-history-when {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--db-ink-3);
}

.db-history-took.is-unknown {
    color: var(--db-line-2);
}

.db-history-note {
    margin: 0;
    font-size: 12.5px;
    color: var(--db-ink-3);
}

.db-history-outcome {
    justify-self: center;
    font-weight: 700;
    color: var(--db-ok);

    .is-stuck &,
    .is-failed & {
        color: var(--db-bad);
    }

    .is-no-rollout & {
        color: var(--db-warn);
    }

    .is-replaced &,
    .is-cancelled &,
    .is-lost & {
        color: var(--db-ink-3);
    }
}

/* Went live in the last minutes: the deploy's moment, in a calm green. */
.db-history-item.is-fresh {
    margin-inline: -8px;
    padding-inline: 8px;
    border-radius: 8px;
    background: var(--db-ok-soft);

    .db-history-when {
        color: var(--db-ok);
        font-weight: 600;
    }
}

.db-history-rollback {
    grid-column: 1 / -1;
}

.db-history-back {
    flex-shrink: 0;
    padding: 0 8px;
    border: 1px solid var(--db-line-2);
    border-radius: 999px;
    background: var(--db-panel);
    color: var(--db-ink-2);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;

    &:focus-visible {
        outline: 2px solid var(--db-deploy);
        outline-offset: 2px;
    }
}

.db-muted {
    margin: 0;
    font-size: 13.5px;
    color: var(--db-ink-3);
}
</style>
