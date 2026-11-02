<template>
    <section class="db-deploys" :aria-label="$t('deployBoardDeploys')">
        <p v-if="!board" class="db-empty">{{ $t("deployBoardReading") }}</p>
        <p v-else-if="noSourceOn" class="db-empty">{{ $t("deployBoardNoSources") }}</p>

        <!-- A failure stays until someone dismisses it; a deploy that went live becomes a line below. -->
        <template v-if="failures.length">
            <h2 class="db-section-title">{{ $t("deployBoardFailures") }}</h2>
            <div class="db-cards">
                <DeployCard
                    v-for="deploy in failures"
                    :key="deploy.id"
                    :deploy="deploy"
                    :now="now"
                    :format-duration="formatDuration"
                    dismissible
                    @dismiss="dismiss"
                />
            </div>
        </template>

        <template v-if="running.length">
            <h2 class="db-section-title">{{ $t("deployBoardRunning") }}</h2>
            <div class="db-cards">
                <DeployCard v-for="deploy in running" :key="deploy.id" :deploy="deploy" :now="now" :format-duration="formatDuration" />
            </div>
        </template>

        <div class="db-history">
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
                    </span>
                    <span class="db-history-took" :class="{ 'is-unknown': item.missed }">
                        {{ item.missed ? "—" : formatDuration(item.endedAt - item.startedAt) }}
                    </span>
                    <span class="db-history-when">{{ $t("deployBoardAgo", [formatDuration(now - item.endedAt)]) }}</span>
                    <RollbackPanel v-if="item.rollback" :rollback="item.rollback" class="db-history-rollback" />
                </li>
            </ol>
            <p v-if="historyRows.some((item) => item.missed)" class="db-history-note">{{ $t("deployBoardMissedNote") }}</p>
        </div>
    </section>
</template>

<script>
import DeployCard from "./DeployCard.vue";
import RollbackPanel from "./RollbackPanel.vue";

/** States of a deploy still moving: it has a card under "Em andamento". */
const RUNNING_STATES = ["pipeline", "built", "updating", "noProgress"];

/** States and outcomes that are a failure: a card that stays until dismissed. */
const FAILED = ["failed", "stuck"];

/** An ended deploy on screen → the outcome of its line in the history. */
const ENDED_OUTCOMES = { done: "done", cancelled: "cancelled", superseded: "replaced" };

/** A deploy that went live is highlighted at the top of the history this long. */
const FRESH_MS = 15 * 60 * 1000;

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
    },

    data() {
        return { OUTCOME_KEYS, OUTCOME_MARKS, dismissed: dismissedSaved(), clipped: false };
    },

    computed: {
        /** @returns {boolean} True when no deploy source is configured at all */
        noSourceOn() {
            return Object.values(this.board.sources).every((s) => s.state === "unconfigured");
        },

        /** @returns {object[]} Deploys still moving */
        running() {
            return this.board ? this.board.deploys.filter((d) => RUNNING_STATES.includes(d.state)) : [];
        },

        /**
         * Failed and stuck deploys nobody dismissed: the ones on screen with their whole card, and the
         * ones the server already moved to the history with what the history keeps.
         * @returns {object[]} Deploys, as DeployCard takes them
         */
        failures() {
            if (!this.board) {
                return [];
            }
            const live = this.board.deploys.filter((d) => FAILED.includes(d.state));
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
                }));
            return [...live, ...past].filter((d) => !this.dismissed.includes(d.id));
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
        "historyRows.length"() {
            this.$nextTick(this.measure);
        },
    },

    mounted() {
        this.observer = new ResizeObserver(() => this.measure());
        this.observer.observe(this.$el);
        this.measure();
    },

    beforeUnmount() {
        this.observer?.disconnect();
    },

    methods: {
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
         * Take a failure off the screen, in this browser.
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
    gap: 0.8em;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}

.db-section-title {
    margin: 0;
    font-size: 0.8em;
    font-weight: 800;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--db-ink-2);
}

.db-section-count {
    margin-left: 8px;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    color: var(--db-ink-3);
}

.db-empty {
    margin: 0;
    padding: 0.9em 1em;
    border: 1px dashed var(--db-line-2);
    border-radius: 10px;
    color: var(--db-ink-2);
    text-wrap: pretty;
}

.db-cards {
    display: grid;
    flex-shrink: 0;
    gap: 0.6em;
}

/* On a wall screen the history gives way first: cards are never cut, the oldest lines are. */
.db-history {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow: hidden;
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
    font-size: 0.85em;

    // Cut softly, without a scrollbar, when it does not fit.
    &.is-clipped {
        mask-image: linear-gradient(to bottom, #000 calc(100% - 40px), transparent);
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
    font-size: 0.85em;
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
    font-size: 0.78em;
    color: var(--db-ink-3);
}

.db-history-outcome {
    justify-self: center;
    font-weight: 800;
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

.db-muted {
    margin: 0;
    font-size: 0.9em;
    color: var(--db-ink-3);
}
</style>
