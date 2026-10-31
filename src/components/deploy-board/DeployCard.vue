<template>
    <article class="db-card" :class="'is-' + tone">
        <header class="db-card-head">
            <span class="db-card-project">{{ deploy.project }}</span>
            <code v-if="deploy.version" class="db-card-version">{{ deploy.version }}</code>
            <span class="db-card-label">{{ $t(labelKey) }}</span>
        </header>

        <p class="db-card-time">{{ timeText }}</p>

        <ul class="db-card-releases">
            <li v-for="r in deploy.releases" :key="r.namespace + '/' + r.release" class="db-release" :class="'is-' + stateClass(r.state)">
                <span class="db-release-name">{{ r.release }}</span>
                <template v-if="r.desired > 0">
                    <span class="db-release-count">{{ $t("deployBoardReleaseProgress", [r.updated, r.desired]) }}</span>
                    <span class="db-release-bar" aria-hidden="true">
                        <i :style="{ width: percent(r) + '%' }"></i>
                    </span>
                </template>
                <span v-if="r.cronJobsUpdated > 0" class="db-release-cron">
                    {{ $t("deployBoardReleaseCronJobs", [r.cronJobsUpdated]) }}
                </span>
                <span v-if="r.atBoot" class="db-release-note">{{ $t("deployBoardFoundAtBoot") }}</span>
            </li>
        </ul>

        <p v-if="!deploy.confirmed" class="db-card-warning">{{ $t("deployBoardUnconfirmed") }}</p>
    </article>
</template>

<script>
/** Card label → i18n key. */
const LABEL_KEYS = {
    rolling: "deployBoardLabelRolling",
    noProgress: "deployBoardLabelNoProgress",
    stuck: "deployBoardLabelStuck",
    live: "deployBoardLabelLive",
    noPipeline: "deployBoardLabelNoPipeline",
};

/** Deploy state → tone of the card. */
const TONES = {
    updating: "rolling",
    noProgress: "warn",
    stuck: "bad",
    done: "ok",
};

export default {
    props: {
        /** Deploy from the board snapshot */
        deploy: {
            type: Object,
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
        /** @returns {string} i18n key of the label */
        labelKey() {
            return LABEL_KEYS[this.deploy.label] || LABEL_KEYS.rolling;
        },

        /** @returns {string} Tone of the card */
        tone() {
            return TONES[this.deploy.state] || "rolling";
        },

        /** @returns {string} How long it has been running, or how long it took */
        timeText() {
            if (this.deploy.endedAt) {
                return this.$t("deployBoardTookTime", [this.formatDuration(this.deploy.endedAt - this.deploy.startedAt)]);
            }
            return this.$t("deployBoardStartedAgo", [this.formatDuration(this.now - this.deploy.startedAt)]);
        },
    },

    methods: {
        /**
         * @param {string} state Release state.
         * @returns {string} Kebab-case class suffix.
         */
        stateClass(state) {
            return state === "noProgress" ? "no-progress" : state;
        },

        /**
         * @param {object} release Release line.
         * @returns {number} Share of replicas on the new version, 0–100.
         */
        percent(release) {
            return Math.round((100 * release.updated) / release.desired);
        },
    },
};
</script>

<style lang="scss" scoped>
.db-card {
    display: grid;
    gap: 0.45em;
    padding: 0.8em 1em;
    border-radius: 10px;
    background: var(--db-panel);
    border: 1px solid var(--db-line);
    border-left: 4px solid var(--db-brand);
    min-width: 0;

    &.is-ok {
        border-left-color: var(--db-ok);
    }

    &.is-warn {
        border-left-color: var(--db-warn);
        background: var(--db-warn-soft);
    }

    &.is-bad {
        border-left-color: var(--db-bad);
        background: var(--db-bad-soft);
    }
}

.db-card-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.2em 0.6em;
}

.db-card-project {
    font-size: 1.15em;
    font-weight: 800;
    overflow-wrap: anywhere;
}

.db-card-version {
    font-size: 0.85em;
    color: var(--db-ink-2);
}

.db-card-label {
    margin-left: auto;
    font-size: 0.8em;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--db-brand);

    .is-ok & {
        color: var(--db-ok);
    }

    .is-warn & {
        color: var(--db-warn);
    }

    .is-bad & {
        color: var(--db-bad);
    }
}

.db-card-time {
    margin: 0;
    font-size: 0.85em;
    color: var(--db-ink-3);
}

.db-card-releases {
    display: grid;
    gap: 0.35em;
    margin: 0;
    padding: 0;
    list-style: none;
}

.db-release {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.15em 0.6em;
    font-size: 0.9em;
}

.db-release-name {
    font-weight: 600;
    overflow-wrap: anywhere;
}

.db-release-count {
    font-variant-numeric: tabular-nums;
    color: var(--db-ink-2);
}

.db-release-bar {
    grid-column: 1 / -1;
    height: 0.4em;
    border-radius: 0.2em;
    background: var(--db-panel-2);
    overflow: hidden;

    i {
        display: block;
        height: 100%;
        background: var(--db-brand);
        transition: width 0.6s ease;
    }

    .is-done & i {
        background: var(--db-ok);
    }

    .is-stuck & i {
        background: var(--db-bad);
    }

    .is-no-progress & i {
        background: var(--db-warn);
    }
}

.db-release-cron,
.db-release-note {
    grid-column: 1 / -1;
    font-size: 0.9em;
    color: var(--db-ink-3);
}

.db-card-warning {
    margin: 0;
    font-size: 0.85em;
    font-weight: 600;
    color: var(--db-warn);
}

@media (prefers-reduced-motion: reduce) {
    .db-release-bar i {
        transition: none;
    }
}
</style>
