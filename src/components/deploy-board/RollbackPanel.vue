<template>
    <div class="db-rollback">
        <button
            v-if="toggle"
            type="button"
            class="db-rollback-toggle db-control"
            :aria-expanded="String(rollbackOpen)"
            @click="rollbackOpen = !rollbackOpen"
        >
            {{ $t("deployBoardRollbackButton") }}
        </button>

        <div v-if="rollbackOpen" class="db-rollback-body">
            <template v-if="rollbackText">
                <pre ref="command" class="db-rollback-command"><code>{{ rollbackText }}</code></pre>
                <button type="button" class="db-rollback-copy" @click="copyRollback">
                    {{ $t(copied ? "deployBoardRollbackCopied" : "deployBoardRollbackCopy") }}
                </button>
            </template>

            <ul class="db-rollback-notes">
                <li v-for="r in rollbackGaps" :key="r.namespace + '/' + r.release">
                    {{ $t(GAP_KEYS[r.status], [r.release]) }}
                </li>
                <li v-if="rollbackText">{{ $t("deployBoardRollbackRunYourself") }}</li>
                <li v-if="rollbackCronJobs > 0">{{ $t("deployBoardRollbackCronJobs", [rollbackCronJobs]) }}</li>
                <li v-if="rollbackText">{{ $t("deployBoardRollbackNextDeploy") }}</li>
                <li v-if="rollbackKnown.length > 1">{{ $t("deployBoardRollbackDeleteRelease") }}</li>
            </ul>
        </div>
    </div>
</template>

<script>
/** Why a release has no command → i18n key. */
const GAP_KEYS = {
    unknown: "deployBoardRollbackUnknown",
    unchanged: "deployBoardRollbackUnchanged",
    cronOnly: "deployBoardRollbackCronOnly",
};

/** A tag that is a commit is shown short, as the card shows the version. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** How long "Copied" stays on the button. */
const COPIED_MS = 2000;

/**
 * "Como voltar": the button and the command to go back to the previous image, for the card of a
 * stuck deploy and for the line of one that just went live.
 */
export default {
    props: {
        /** `rollback` of a deploy of the board */
        rollback: {
            type: Object,
            required: true,
        },
        /** False when whoever shows the panel has its own button: then it opens at once */
        toggle: {
            type: Boolean,
            default: true,
        },
    },

    data() {
        return {
            GAP_KEYS,
            rollbackOpen: !this.toggle,
            copied: false,
        };
    },

    computed: {
        /** @returns {object[]} Releases with a command to go back */
        rollbackKnown() {
            return this.rollback.releases.filter((r) => r.status === "known");
        },

        /** @returns {object[]} Releases without one, to say why */
        rollbackGaps() {
            return this.rollback.releases.filter((r) => r.status !== "known");
        },

        /** @returns {number} CronJobs of the deploy that the command leaves on the new version */
        rollbackCronJobs() {
            return this.rollback.releases.reduce((n, r) => n + r.cronJobs, 0);
        },

        /**
         * The text to copy: per release, a comment naming it, the `set image` lines and then the
         * `rollout status` lines. Empty when no release has a previous version.
         * @returns {string} Command.
         */
        rollbackText() {
            return this.rollbackKnown
                .map((r) => {
                    const previous = SHA_RE.test(r.previous) ? r.previous.slice(0, 7) : r.previous;
                    const head = `# ${this.$t("deployBoardRollbackComment", [`${r.namespace}/${r.release}`, previous])}`;
                    return [head, ...r.setImage, ...r.rolloutStatus].join("\n");
                })
                .join("\n\n");
        },
    },

    beforeUnmount() {
        clearTimeout(this.copiedTimer);
    },

    methods: {
        /**
         * Copy the command. Where the browser refuses the clipboard, the text is selected for Ctrl+C.
         * @returns {void}
         */
        copyRollback() {
            const done = () => {
                this.copied = true;
                clearTimeout(this.copiedTimer);
                this.copiedTimer = setTimeout(() => {
                    this.copied = false;
                }, COPIED_MS);
            };
            const select = () => {
                const range = document.createRange();
                range.selectNodeContents(this.$refs.command);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            };
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(this.rollbackText).then(done, select);
            } else {
                select();
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.db-rollback {
    display: grid;
    gap: 8px;
    justify-items: start;
    min-width: 0;
}

.db-rollback-toggle,
.db-rollback-copy {
    padding: 4px 12px;
    border: 1px solid var(--db-line-2);
    border-radius: 999px;
    background: var(--db-panel-2);
    color: var(--db-ink);
    font: inherit;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;

    &:hover {
        border-color: var(--db-brand);
    }

    &:focus-visible {
        outline: 2px solid var(--db-brand);
        outline-offset: 2px;
    }
}

.db-rollback-body {
    display: grid;
    gap: 8px;
    justify-items: start;
    width: 100%;
    min-width: 0;
}

.db-rollback-command {
    width: 100%;
    max-height: 18em;
    margin: 0;
    padding: 8px 12px;
    overflow: auto;
    border: 1px solid var(--db-line);
    border-radius: 8px;
    background: var(--db-bg);
    color: var(--db-ink);
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre;
}

.db-rollback-notes {
    display: grid;
    gap: 4px;
    margin: 0;
    padding-left: 16px;
    font-size: 13.5px;
    color: var(--db-ink-2);
}
</style>
