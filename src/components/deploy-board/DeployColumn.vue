<template>
    <section class="db-deploys" :aria-label="$t('deployBoardDeploys')">
        <h2 class="db-section-title">{{ $t("deployBoardDeploys") }}</h2>

        <p v-if="!board" class="db-empty">{{ $t("deployBoardReading") }}</p>
        <p v-else-if="noSourceOn" class="db-empty">{{ $t("deployBoardNoSources") }}</p>
        <p v-else-if="board.deploys.length === 0" class="db-empty">{{ $t("deployBoardNoActiveDeploys") }}</p>

        <div v-if="board && board.deploys.length" class="db-cards">
            <DeployCard
                v-for="deploy in board.deploys"
                :key="deploy.id"
                :deploy="deploy"
                :now="now"
                :format-duration="formatDuration"
            />
        </div>

        <div class="db-history">
            <h3 class="db-subtitle">{{ $t("deployBoardHistory") }}</h3>
            <p v-if="!board || board.history.length === 0" class="db-muted">{{ $t("deployBoardHistoryEmpty") }}</p>
            <ol v-else class="db-history-list">
                <li v-for="item in board.history" :key="item.id" class="db-history-item" :class="'is-' + outcomeClass(item.outcome)">
                    <span class="db-history-outcome" role="img" :aria-label="$t(OUTCOME_KEYS[item.outcome])" :title="$t(OUTCOME_KEYS[item.outcome])">
                        {{ OUTCOME_MARKS[item.outcome] || "·" }}
                    </span>
                    <span class="db-history-name">
                        <span class="db-history-project">{{ item.project }}</span>
                        <code v-if="item.version" class="db-history-version">{{ item.version }}</code>
                    </span>
                    <span class="db-history-when">
                        <template v-if="item.missed">{{ $t("deployBoardMissed") }} ·</template>
                        <template v-else>{{ $t("deployBoardTookTime", [formatDuration(item.endedAt - item.startedAt)]) }} ·</template>
                        {{ $t("deployBoardAgo", [formatDuration(now - item.endedAt)]) }}
                    </span>
                </li>
            </ol>
        </div>
    </section>
</template>

<script>
import DeployCard from "./DeployCard.vue";

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
        return { OUTCOME_KEYS, OUTCOME_MARKS };
    },

    computed: {
        /** @returns {boolean} True when no deploy source is configured at all */
        noSourceOn() {
            return Object.values(this.board.sources).every((s) => s.state === "unconfigured");
        },
    },

    methods: {
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

.db-subtitle {
    margin: 0;
    font-size: 0.72em;
    font-weight: 700;
    letter-spacing: 0.11em;
    text-transform: uppercase;
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

/* On a wall screen the history gives way first: cards are never cut, the oldest entries are. */
.db-history {
    display: flex;
    flex-direction: column;
    gap: 0.4em;
    margin-top: auto;
    min-height: 0;
    overflow: hidden;
}

.db-history-list {
    display: grid;
    gap: 0.3em;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.85em;
}

/* Mark, name and times: the times line up in one column on the right. */
.db-history-item {
    display: grid;
    grid-template-columns: 1.1em minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 0.5em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--db-line);
}

.db-history-name {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 0.5em;
    min-width: 0;
}

.db-history-project {
    font-weight: 700;
    overflow-wrap: anywhere;
}

.db-history-version {
    color: var(--db-ink-2);
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

.db-history-when {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: var(--db-ink-3);
}

.db-muted {
    margin: 0;
    font-size: 0.9em;
    color: var(--db-ink-3);
}
</style>
