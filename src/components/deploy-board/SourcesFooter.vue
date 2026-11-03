<template>
    <footer class="db-sources">
        <span v-for="item in items" :key="item.id" class="db-source" :class="'is-' + item.tone">
            {{ item.name }}
            <b>{{ item.text }}</b>
        </span>
        <!-- The legend of the grid, out of the way: needed once, not every time the eye passes. -->
        <span class="db-legend">
            <span class="db-legend-item is-up">{{ $t("deployBoardStatusUp") }}</span>
            <span class="db-legend-item is-pending">{{ $t("deployBoardStatusPending") }}</span>
            <span class="db-legend-item is-down">{{ $t("deployBoardStatusDown") }}</span>
            <span class="db-legend-item is-maintenance">{{ $t("deployBoardStatusMaintenance") }}</span>
            <span>{{ $t("deployBoardBeatsHint") }}</span>
        </span>
    </footer>
</template>

<script>
/**
 * The dot means the same on every source: green, recent data; amber, connected with no data yet;
 * grey, not configured; red (a triangle), not answering.
 */

/** Sources the server reads, in the order they are shown. Kuma (read by this page) comes first. */
const SERVER_SOURCES = [
    { id: "cluster", nameKey: "deployBoardSourceCluster", webhook: false },
    { id: "bitbucket", nameKey: "deployBoardSourceBitbucket", webhook: true },
    { id: "github", nameKey: "deployBoardSourceGithub", webhook: true },
    { id: "amplify", nameKey: "deployBoardSourceAmplify", webhook: false },
];

export default {
    props: {
        /** `sources` of the board snapshot, or null before the first read */
        sources: {
            type: Object,
            default: null,
        },
        /** Whether the socket to Kuma is up */
        kumaConnected: {
            type: Boolean,
            required: true,
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

    computed: {
        /** @returns {object[]} One entry per source: name, text and tone */
        items() {
            const items = [
                {
                    id: "kuma",
                    name: "Uptime Kuma",
                    text: this.kumaConnected
                        ? this.$t("deployBoardSourceConnected")
                        : this.$t("deployBoardSourceStale"),
                    tone: this.kumaConnected ? "ok" : "bad",
                },
            ];

            for (const source of SERVER_SOURCES) {
                items.push({
                    id: source.id,
                    name: this.$t(source.nameKey),
                    ...this.describe(source, this.sources?.[source.id]),
                });
            }
            return items;
        },
    },

    methods: {
        /**
         * Text and tone of one server source.
         * @param {object} source Entry of SERVER_SOURCES.
         * @param {object|undefined} state Source state from the snapshot.
         * @returns {{text: string, tone: string}} What to show.
         */
        describe(source, state) {
            if (!state) {
                return { text: this.$t("deployBoardReading"), tone: "muted" };
            }
            if (state.state === "unconfigured") {
                return { text: this.$t("deployBoardSourceUnconfigured"), tone: "muted" };
            }
            if (state.state === "stale") {
                const text = state.detail
                    ? `${this.$t("deployBoardSourceStale")} · ${state.detail}`
                    : this.$t("deployBoardSourceStale");
                return { text, tone: "bad" };
            }
            if (!state.lastDataAt) {
                return { text: this.$t("deployBoardSourceWaiting"), tone: "warn" };
            }
            const ago = this.formatDuration(this.now - state.lastDataAt);
            const key = source.webhook ? "deployBoardSourceLastEvent" : "deployBoardSourceRead";
            return { text: this.$t(key, [ago]), tone: "ok" };
        },
    },
};
</script>

<style lang="scss" scoped>
.db-sources {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 20px;
    padding-top: 8px;
    border-top: 1px solid var(--db-line);
    font-size: 12.5px;
    color: var(--db-ink-3);
}

.db-source {
    display: inline-flex;
    align-items: center;
    gap: 8px;

    &::before {
        content: "";
        width: 0.55em;
        height: 0.55em;
        border-radius: 50%;
        background: var(--db-ok);
    }

    b {
        font-weight: 600;
        color: var(--db-ink-2);
    }

    &.is-warn::before {
        background: var(--db-warn);
    }

    &.is-bad::before {
        width: 0.7em;
        border-radius: 0;
        background: var(--db-bad);
        clip-path: polygon(50% 0, 100% 100%, 0 100%);
    }

    &.is-warn b {
        color: var(--db-warn);
    }

    &.is-bad b {
        color: var(--db-bad);
    }

    &.is-muted::before {
        background: var(--db-line-2);
    }
}

.db-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    margin-left: auto;
    font-size: 13.5px;
    color: var(--db-ink-3);
    opacity: 0.85;
}

.db-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;

    &::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 2px;
        background: var(--db-ok);
    }

    &.is-pending::before {
        background: var(--db-warn);
    }

    &.is-down::before {
        width: 10px;
        border-radius: 0;
        background: var(--db-bad);
        clip-path: polygon(50% 0, 100% 100%, 0 100%);
    }

    &.is-maintenance::before {
        background: var(--db-maint);
    }
}
</style>
