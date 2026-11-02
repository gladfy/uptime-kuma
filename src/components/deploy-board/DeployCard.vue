<template>
    <article class="db-card" :class="'is-' + tone">
        <header class="db-card-head">
            <span class="db-card-project">{{ deploy.project }}</span>
            <code v-if="deploy.version" class="db-card-version">{{ deploy.version }}</code>
            <span class="db-card-label">{{ $t(labelKey) }}</span>
        </header>

        <p class="db-card-time">
            <span>{{ timeText }}</span>
            <span v-if="steps" class="db-steps-count">{{ $t("deployBoardStepCount", [stepNumber, steps.length]) }}</span>
        </p>

        <ol v-if="steps" class="db-steps" :style="{ '--db-steps': steps.length }" :aria-label="$t('deployBoardStepsLabel')">
            <li
                v-for="s in steps"
                :key="s.key"
                class="db-step"
                :class="'is-' + s.status"
                :aria-current="s.status === 'current' ? 'step' : null"
            >
                <i aria-hidden="true"></i>
                <span>{{ $t(STEP_KEYS[s.key]) }}</span>
            </li>
        </ol>

        <section v-if="pipeline" class="db-pipeline" :class="'is-' + pipeline.state">
            <div class="db-pipeline-head">
                <span class="db-pipeline-state">{{ $t(PIPELINE_KEYS[pipeline.state] || PIPELINE_KEYS.running) }}</span>
                <a v-if="pipeline.url" class="db-pipeline-link" :href="pipeline.url" target="_blank" rel="noopener noreferrer">
                    {{ $t("deployBoardPipelineOpen") }}
                </a>
            </div>
            <p v-if="pipeline.message" class="db-pipeline-commit">{{ pipeline.message }}</p>
            <p v-for="line in pipelineLines" :key="line" class="db-pipeline-note">{{ line }}</p>
            <ul v-if="pipeline.jobs.length" class="db-jobs">
                <li v-for="job in pipeline.jobs" :key="job.id || job.name" class="db-job" :class="'is-' + job.state">
                    <span class="db-job-name">{{ job.name }}</span>
                    <span class="db-job-state">{{ jobText(job) }}</span>
                </li>
            </ul>
        </section>

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

        <p v-if="!deploy.confirmed && deploy.releases.length" class="db-card-warning">{{ $t("deployBoardUnconfirmed") }}</p>

        <div v-if="deploy.rollback" class="db-rollback">
            <button type="button" class="db-rollback-toggle" :aria-expanded="String(rollbackOpen)" @click="rollbackOpen = !rollbackOpen">
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
    inPipeline: "deployBoardLabelInPipeline",
    built: "deployBoardLabelBuilt",
    failed: "deployBoardLabelFailed",
    noRollout: "deployBoardLabelNoRollout",
    cancelled: "deployBoardLabelCancelled",
};

/** Pipeline state → i18n key. */
const PIPELINE_KEYS = {
    merged: "deployBoardPipelineMerged",
    queued: "deployBoardPipelineQueued",
    running: "deployBoardPipelineRunning",
    success: "deployBoardPipelineSuccess",
    failed: "deployBoardPipelineFailed",
    stopped: "deployBoardPipelineStopped",
};

/** Job state → i18n key. */
const JOB_KEYS = {
    queued: "deployBoardJobQueued",
    running: "deployBoardJobRunning",
    success: "deployBoardJobSuccess",
    failed: "deployBoardJobFailed",
    stopped: "deployBoardJobStopped",
};

/** Step of the deploy → i18n key. */
const STEP_KEYS = {
    merge: "deployBoardStepMerge",
    pipeline: "deployBoardStepPipeline",
    built: "deployBoardStepBuilt",
    rollout: "deployBoardStepRollout",
    live: "deployBoardStepLive",
};

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

/** Deploy state → tone of the card. */
const TONES = {
    updating: "rolling",
    noProgress: "warn",
    stuck: "bad",
    done: "ok",
    pipeline: "rolling",
    built: "rolling",
    failed: "bad",
    cancelled: "warn",
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

    data() {
        return {
            GAP_KEYS,
            PIPELINE_KEYS,
            STEP_KEYS,
            rollbackOpen: false,
            copied: false,
        };
    },

    computed: {
        /** @returns {object[]} Releases with a command to go back */
        rollbackKnown() {
            return this.deploy.rollback.releases.filter((r) => r.status === "known");
        },

        /** @returns {object[]} Releases without one, to say why */
        rollbackGaps() {
            return this.deploy.rollback.releases.filter((r) => r.status !== "known");
        },

        /** @returns {number} CronJobs of the deploy that the command leaves on the new version */
        rollbackCronJobs() {
            return this.deploy.rollback.releases.reduce((n, r) => n + r.cronJobs, 0);
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

        /** @returns {string} i18n key of the label */
        labelKey() {
            return LABEL_KEYS[this.deploy.label] || LABEL_KEYS.rolling;
        },

        /** @returns {string} Tone of the card */
        tone() {
            if (this.deploy.label === "noRollout") {
                return "warn";
            }
            return TONES[this.deploy.state] || "rolling";
        },

        /** @returns {object[]|null} Steps from the merge to "No ar" (older servers do not send them) */
        steps() {
            return this.deploy.steps?.length ? this.deploy.steps : null;
        },

        /** @returns {number} Number of the step it is on, from 1: the last one reached */
        stepNumber() {
            return this.steps.findLastIndex((s) => s.status !== "pending") + 1;
        },

        /** @returns {object|null} Pipeline of the deploy (older servers do not send it) */
        pipeline() {
            return this.deploy.pipeline || null;
        },

        /**
         * Lines under the commit: time since the merge, and what the green pipeline means.
         * @returns {string[]} Lines.
         */
        pipelineLines() {
            const p = this.pipeline;
            const lines = [];
            if (p.mergedAt) {
                lines.push(this.$t("deployBoardPipelineMergedAgo", [this.formatDuration(this.now - p.mergedAt)]));
            }
            if (p.state === "success" && p.endedAt) {
                const ago = this.formatDuration(this.now - p.endedAt);
                if (this.deploy.label === "noRollout") {
                    lines.push(this.$t("deployBoardPipelineNoRollout", [ago]));
                } else if (this.deploy.state !== "done") {
                    // Bitbucket goes green once helm has applied the release; the pods come after.
                    lines.push(this.$t("deployBoardPipelineGreenRolling", [ago]));
                }
            }
            return lines;
        },

        /** @returns {string} How long it has been running, or how long it took */
        timeText() {
            // Its start was not seen: any duration would be made up.
            if (this.deploy.missed) {
                return this.$t("deployBoardMissed");
            }
            if (this.deploy.endedAt) {
                return this.$t("deployBoardTookTime", [this.formatDuration(this.deploy.endedAt - this.deploy.startedAt)]);
            }
            return this.$t("deployBoardStartedAgo", [this.formatDuration(this.now - this.deploy.startedAt)]);
        },
    },

    beforeUnmount() {
        clearTimeout(this.copiedTimer);
    },

    methods: {
        /**
         * @param {object} job Job of the pipeline.
         * @returns {string} Its state, with how long it took or has been running.
         */
        jobText(job) {
            const state = this.$t(JOB_KEYS[job.state] || JOB_KEYS.running);
            if (!job.startedAt) {
                return state;
            }
            const until = job.endedAt || this.now;
            return `${state} · ${this.formatDuration(until - job.startedAt)}`;
        },

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
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.2em 0.8em;
    margin: 0;
    font-size: 0.85em;
    color: var(--db-ink-3);
}

.db-steps-count {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--db-ink-2);
}

.db-steps {
    display: grid;
    grid-template-columns: repeat(var(--db-steps), minmax(0, 1fr));
    gap: 0.3em;
    margin: 0.1em 0 0.15em;
    padding: 0;
    list-style: none;
}

.db-step {
    display: grid;
    gap: 0.3em;
    min-width: 0;
    font-size: 0.72em;
    color: var(--db-ink-3);

    i {
        display: block;
        height: 0.45rem;
        border-radius: 0.2rem;
        background: var(--db-panel-2);
    }

    span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    &.is-done {
        color: var(--db-ink-2);

        i {
            background: var(--db-ok);
        }
    }

    // A step the deploy went past without seeing it: no pipeline for this commit.
    &.is-skipped i {
        background: transparent;
        border: 1px dashed var(--db-line-2);
    }

    &.is-current,
    &.is-warn,
    &.is-failed {
        font-weight: 800;
    }

    &.is-current {
        color: var(--db-brand);

        i {
            background: var(--db-brand);
            animation: db-step-pulse 1.6s ease-in-out infinite;
        }
    }

    &.is-warn {
        color: var(--db-warn);

        i {
            background: var(--db-warn);
        }
    }

    &.is-failed {
        color: var(--db-bad);

        i {
            background: var(--db-bad);
        }
    }
}

@keyframes db-step-pulse {
    50% {
        opacity: 0.45;
    }
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

.db-pipeline {
    display: grid;
    gap: 0.25em;
    padding: 0.5em 0.7em;
    border-radius: 6px;
    background: var(--db-panel-2);
    font-size: 0.88em;
    min-width: 0;
}

.db-pipeline-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.2em 0.8em;
}

.db-pipeline-state {
    font-weight: 700;
    color: var(--db-brand);

    .is-success & {
        color: var(--db-ok);
    }

    .is-failed &,
    .is-stopped & {
        color: var(--db-bad);
    }
}

.db-pipeline-link {
    color: var(--db-ink-2);
    font-size: 0.92em;

    &:hover {
        color: var(--db-brand);
    }
}

.db-pipeline-commit {
    margin: 0;
    color: var(--db-ink);
    overflow-wrap: anywhere;
}

.db-pipeline-note {
    margin: 0;
    color: var(--db-ink-3);
}

.db-jobs {
    display: grid;
    gap: 0.15em;
    margin: 0.2em 0 0;
    padding: 0;
    list-style: none;
}

.db-job {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.6em;
    color: var(--db-ink-2);

    &.is-failed .db-job-state {
        color: var(--db-bad);
    }

    &.is-success .db-job-state {
        color: var(--db-ok);
    }
}

.db-job-name {
    overflow-wrap: anywhere;
}

.db-job-state {
    font-variant-numeric: tabular-nums;
}

.db-rollback {
    display: grid;
    gap: 0.5em;
    justify-items: start;
    min-width: 0;
}

.db-rollback-toggle,
.db-rollback-copy {
    padding: 0.25em 0.7em;
    border: 1px solid var(--db-line-2);
    border-radius: 6px;
    background: var(--db-panel-2);
    color: var(--db-ink);
    font: inherit;
    font-size: 0.85em;
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
    gap: 0.5em;
    justify-items: start;
    width: 100%;
    min-width: 0;
}

.db-rollback-command {
    width: 100%;
    max-height: 18em;
    margin: 0;
    padding: 0.6em 0.8em;
    overflow: auto;
    border: 1px solid var(--db-line);
    border-radius: 6px;
    background: var(--db-bg);
    color: var(--db-ink);
    font-size: 0.8em;
    line-height: 1.5;
    white-space: pre;
}

.db-rollback-notes {
    display: grid;
    gap: 0.2em;
    margin: 0;
    padding-left: 1.1em;
    font-size: 0.85em;
    color: var(--db-ink-2);
}

@media (prefers-reduced-motion: reduce) {
    .db-release-bar i {
        transition: none;
    }

    .db-step.is-current i {
        animation: none;
    }
}
</style>
