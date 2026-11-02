<template>
    <div class="db-alert" role="alert">
        <span class="db-alert-icon" aria-hidden="true">▲</span>
        <div class="db-alert-text">
            <p class="db-alert-title">
                {{ $t("deployBoardAlertDown", [shownNames]) }}
                <span v-if="rest > 0" class="db-alert-more">+{{ rest }}</span>
            </p>
            <p class="db-alert-context">{{ context }}</p>
        </div>
        <span v-if="first.since" class="db-alert-timer" :title="$t('deployBoardAlertTimerHint')">{{ timer }}</span>
    </div>
</template>

<script>
/** Names written out in the band; the others are a count. */
const SHOWN = 3;

export default {
    props: {
        /** Monitors that are down, the longest down first: { id, name, since, downChecks, deployLine } */
        monitors: {
            type: Array,
            required: true,
        },
        /** Current time, in ms */
        now: {
            type: Number,
            required: true,
        },
    },

    computed: {
        /** @returns {object} The monitor down the longest: the band's context and clock are its own */
        first() {
            return this.monitors[0];
        },

        /** @returns {string} Up to SHOWN names */
        shownNames() {
            return this.monitors
                .slice(0, SHOWN)
                .map((m) => m.name)
                .join(", ");
        },

        /** @returns {number} Monitors down beyond the ones named */
        rest() {
            return Math.max(0, this.monitors.length - SHOWN);
        },

        /** @returns {string} Failed checks in a row and the deploy line, of the first one */
        context() {
            const checks = this.$t("deployBoardAlertChecks", this.first.downChecks);
            return this.first.deployLine ? `${checks}. ${this.first.deployLine}` : checks;
        },

        /** @returns {string} "mm:ss" down, or "h:mm:ss" past an hour */
        timer() {
            const total = Math.max(0, Math.floor((this.now - this.first.since) / 1000));
            const h = Math.floor(total / 3600);
            const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
            const s = String(total % 60).padStart(2, "0");
            return h ? `${h}:${m}:${s}` : `${m}:${s}`;
        },
    },
};
</script>

<style lang="scss" scoped>
.db-alert {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px;
    border: 1px solid color-mix(in srgb, var(--db-bad) 35%, var(--db-line));
    border-radius: 14px;
    background: var(--db-bad-soft);
}

.db-alert-icon {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--db-bad-solid);
    color: var(--db-on-bad);
    font-size: 15px;
    line-height: 1;
    animation: db-alert-pulse 2s ease-in-out infinite;
}

.db-alert-text {
    flex: 1 1 auto;
    min-width: 0;
}

.db-alert-title {
    margin: 0;
    font-size: 17px;
    font-weight: 700;
    color: var(--db-bad);
    overflow-wrap: anywhere;
}

.db-alert-more {
    margin-left: 4px;
    font-weight: 600;
}

.db-alert-context {
    margin: 0;
    font-size: 13.5px;
    color: var(--db-ink-2);
}

.db-alert-timer {
    flex-shrink: 0;
    font-size: 21px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--db-bad);
}

// A soft pulse by opacity: no shadow, in either theme.
@keyframes db-alert-pulse {
    50% {
        opacity: 0.55;
    }
}

@media (prefers-reduced-motion: reduce) {
    .db-alert-icon {
        animation: none;
    }
}
</style>
