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
                <li v-for="item in board.history" :key="item.id" class="db-history-item" :class="'is-' + item.outcome">
                    <span class="db-history-project">{{ item.project }}</span>
                    <code v-if="item.version" class="db-history-version">{{ item.version }}</code>
                    <span class="db-history-outcome">{{ $t(OUTCOME_KEYS[item.outcome]) }}</span>
                    <span class="db-history-when">
                        {{ $t("deployBoardTookTime", [formatDuration(item.endedAt - item.startedAt)]) }} ·
                        {{ $t("deployBoardAgo", [formatDuration(now - item.endedAt)]) }}
                    </span>
                </li>
            </ol>
        </div>
    </section>
</template>

<script>
import DeployCard from "./DeployCard.vue";

/** Outcome of a finished deploy → i18n key. */
const OUTCOME_KEYS = {
    done: "deployBoardOutcomeDone",
    stuck: "deployBoardOutcomeStuck",
    replaced: "deployBoardOutcomeReplaced",
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
        return { OUTCOME_KEYS };
    },

    computed: {
        /** @returns {boolean} True when no deploy source is configured at all */
        noSourceOn() {
            return Object.values(this.board.sources).every((s) => s.state === "unconfigured");
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

.db-history-item {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.1em 0.5em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--db-line);
}

.db-history-project {
    font-weight: 700;
}

.db-history-version {
    color: var(--db-ink-2);
}

.db-history-outcome {
    font-weight: 700;
    color: var(--db-ok);

    .is-stuck & {
        color: var(--db-bad);
    }

    .is-replaced & {
        color: var(--db-ink-3);
    }
}

.db-history-when {
    margin-left: auto;
    color: var(--db-ink-3);
}

.db-muted {
    margin: 0;
    font-size: 0.9em;
    color: var(--db-ink-3);
}
</style>
