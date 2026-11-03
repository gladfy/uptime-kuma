<template>
    <!-- One markup for the three levels (full, medium, compact): the level only hides parts, in CSS. -->
    <article class="db-card" :class="'is-' + tone" :data-level="level">
        <header class="db-card-head">
            <span class="db-card-project">{{ deploy.project }}</span>
            <code v-if="deploy.version" class="db-card-version">{{ deploy.version }}</code>
            <span class="db-card-label">
                <font-awesome-icon v-if="tone === 'bad'" icon="exclamation-triangle" class="db-card-label-icon" />
                {{ $t(labelKey) }}
            </span>
            <!-- In compact, where the line "started N ago" is gone. -->
            <span class="db-card-elapsed">{{ elapsedText }}</span>
            <button
                v-if="dismissible"
                type="button"
                class="db-dismiss db-control"
                :title="$t('deployBoardDismiss')"
                :aria-label="$t('deployBoardDismiss')"
                @click="$emit('dismiss', deploy.id)"
            >
                ✕
            </button>
        </header>

        <p class="db-card-time">
            <span>
                {{ timeText }}
                <!-- Where the deploy came from, not a state: grey, in the subtitle. -->
                <template v-if="noPipeline">
                    · <span :title="$t('deployBoardNoPipelineHint')">{{ $t("deployBoardNoPipelineLinked") }}</span>
                </template>
            </span>
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

        <!-- Medium and compact: one line instead of the pipeline box and the replica bars. -->
        <p v-if="detail.length" class="db-card-detail">
            <template v-for="(part, i) in detail" :key="i">
                <b v-if="part.name">{{ part.text }}</b>
                <template v-else>{{ part.text }}</template>
            </template>
        </p>

        <section v-if="pipeline" class="db-pipeline" :class="'is-' + pipeline.state">
            <div class="db-pipeline-head">
                <span class="db-pipeline-state">{{ $t(PIPELINE_KEYS[pipeline.state] || PIPELINE_KEYS.running) }}</span>
                <a v-if="pipeline.url" class="db-pipeline-link db-control" :href="pipeline.url" target="_blank" rel="noopener noreferrer">
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
            <li v-for="r in deploy.releases" :key="r.namespace + '/' + r.release" class="db-release" :class="['is-' + stateClass(r.state), { 'is-complete': r.desired > 0 && r.updated >= r.desired }]">
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
            </li>
        </ul>

        <!-- Once per card, whatever the number of workloads found mid-rollout at boot. -->
        <p v-if="deploy.releases.some((r) => r.atBoot)" class="db-card-note">ⓘ {{ $t("deployBoardFoundAtBootNote") }}</p>

        <p v-if="!deploy.confirmed && (deploy.links || deploy.releases).length" class="db-card-warning">
            {{ $t(pipeline?.source === "amplify" ? "deployBoardUnconfirmedAmplify" : "deployBoardUnconfirmed") }}
        </p>

        <RollbackPanel v-if="deploy.rollback" :rollback="deploy.rollback" class="db-card-rollback" />
    </article>
</template>

<script>
import RollbackPanel from "./RollbackPanel.vue";

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

/** Deploy state → label, for a deploy whose label is "no pipeline": the card says the state. */
const STATE_LABELS = {
    updating: "rolling",
    noProgress: "noProgress",
    stuck: "stuck",
    done: "live",
    pipeline: "inPipeline",
    built: "built",
    failed: "failed",
    cancelled: "cancelled",
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

/** Deploy states of a rollout in the cluster: their one line is the replicas of each workload. */
const ROLLOUT_STATES = ["updating", "noProgress", "stuck"];

/** Stands for the name in a translated text, to split it around the name. */
const NAME_MARK = "\u0000";

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
    components: {
        RollbackPanel,
    },

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
        /** A failure stays on screen until someone dismisses it: the card offers the button */
        dismissible: {
            type: Boolean,
            default: false,
        },
        /** How much of the card shows: "full", "medium" or "compact" (the column picks it by measuring) */
        level: {
            type: String,
            default: "full",
        },
    },

    emits: ["dismiss"],

    data() {
        return {
            PIPELINE_KEYS,
            STEP_KEYS,
        };
    },

    computed: {
        /**
         * "No pipeline" is a fact about where the deploy came from, not a state: it goes beside the
         * label, in neutral, and the label keeps saying how the rollout is going.
         * @returns {boolean} Whether the deploy has no pipeline matched
         */
        noPipeline() {
            return this.deploy.label === "noPipeline";
        },

        /** @returns {string} i18n key of the label */
        labelKey() {
            const label = this.noPipeline ? STATE_LABELS[this.deploy.state] : this.deploy.label;
            return LABEL_KEYS[label] || LABEL_KEYS.rolling;
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

        /**
         * The one line of the medium and compact levels, as parts; the names of workloads and jobs
         * are the bold ones.
         * @returns {{text: string, name: boolean}[]} Parts, none when there is nothing to say.
         */
        detail() {
            const d = this.deploy;
            const jobs = this.pipeline?.jobs || [];
            if (ROLLOUT_STATES.includes(d.state) && d.releases.length) {
                return d.releases.flatMap((r, i) => [
                    ...(i ? [{ text: ", " }] : []),
                    { text: r.release, name: true },
                    ...(r.desired > 0 ? [{ text: ` ${r.updated}/${r.desired}` }] : []),
                ]);
            }
            if (d.state === "failed") {
                const job = jobs.find((j) => j.state === "failed");
                const end = job?.endedAt || this.pipeline?.endedAt || d.endedAt;
                const name = job ? job.name : this.$t(STEP_KEYS.pipeline);
                return end ? this.named("deployBoardDetailJobFailed", name, this.formatDuration(this.now - end)) : [{ text: name, name: true }];
            }
            if (d.state === "pipeline" && jobs.length) {
                const running = jobs.find((j) => j.state === "running");
                const queued = jobs.filter((j) => j.state === "queued");
                if (running) {
                    const since = running.startedAt ? this.formatDuration(this.now - running.startedAt) : "";
                    const parts = since ? this.named("deployBoardDetailJobRunning", running.name, since) : [{ text: running.name, name: true }];
                    return queued.length ? [...parts, ...this.thenJobs(queued)] : parts;
                }
                if (queued.length) {
                    return [...this.named("deployBoardDetailJobQueued", queued[0].name), ...this.thenJobs(queued.slice(1))];
                }
            }
            const message = this.pipeline?.message;
            return message ? [{ text: message }] : [];
        },

        /** @returns {string} Time running, or how long it took, alone: "15 min" */
        elapsedText() {
            if (this.deploy.missed) {
                return "—";
            }
            return this.formatDuration((this.deploy.endedAt || this.now) - this.deploy.startedAt);
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

    methods: {
        /**
         * A translated text whose {0} is a name, in parts, so the name can be bold.
         * @param {string} key i18n key, with the name as {0}.
         * @param {string} name Name of the job or workload.
         * @param {...string} rest The other values, from {1} on.
         * @returns {{text: string, name: boolean}[]} Parts.
         */
        named(key, name, ...rest) {
            const [before, after = ""] = this.$t(key, [NAME_MARK, ...rest]).split(NAME_MARK);
            return [{ text: before }, { text: name, name: true }, { text: after }].filter((p) => p.text);
        },

        /**
         * ", then deploy and verify", with the names bold.
         * @param {object[]} jobs Jobs that come next.
         * @returns {{text: string, name: boolean}[]} Parts, none without jobs.
         */
        thenJobs(jobs) {
            if (!jobs.length) {
                return [];
            }
            const list = new Intl.ListFormat(this.$i18n.locale, { type: "conjunction" })
                .formatToParts(jobs.map((j) => j.name))
                .map((p) => ({ text: p.value, name: p.type === "element" }));
            const [before, after = ""] = this.$t("deployBoardDetailThen", [NAME_MARK]).split(NAME_MARK);
            return [{ text: before }, ...list, { text: after }].filter((p) => p.text);
        },

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
    gap: 8px;
    padding: 12px 16px;
    border-radius: 14px;
    background: var(--db-panel);
    border: 1px solid var(--db-line);
    border-left: 4px solid var(--db-deploy);
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

/* One line at every level: the column measures the cards, and a header that wraps would make it guess. */
.db-card-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    white-space: nowrap;
}

.db-card-project {
    flex-shrink: 0;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 17px;
    font-weight: 700;
}

// The hash gives way first, then the label.
.db-card-version {
    flex-shrink: 10;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13.5px;
    color: var(--db-ink-2);
}

.db-card-elapsed {
    display: none;
    flex-shrink: 0;
    font-size: 13.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--db-ink-2);
}

.db-card-detail {
    display: none;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13.5px;
    color: var(--db-ink-3);

    b {
        font-weight: 700;
        color: var(--db-ink);
    }
}

/* Medium: header, the time line, the track with its labels and one line of detail. */
.db-card[data-level="medium"] {
    gap: 6px;

    .db-steps {
        margin: 0;
    }
}

.db-card[data-level="medium"],
.db-card[data-level="compact"] {
    .db-pipeline,
    .db-card-releases,
    .db-card-note,
    .db-card-warning,
    .db-card-rollback {
        display: none;
    }

    .db-card-detail {
        display: block;
    }
}

/* Compact (about 70 px): header with the elapsed time, the track without labels, one line. */
.db-card[data-level="compact"] {
    gap: 5px;
    padding-block: 6px;

    .db-card-time,
    .db-step span {
        display: none;
    }

    .db-card-elapsed {
        display: inline;
    }

    .db-steps {
        margin: 0;
    }
}

.db-card-label {
    min-width: 0;
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--db-deploy);

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

.db-card-label-icon {
    margin-right: 4px;
}

.db-card-time {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 4px 12px;
    margin: 0;
    font-size: 13.5px;
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
    gap: 4px;
    margin: 4px 0 4px;
    padding: 0;
    list-style: none;
}

.db-step {
    display: grid;
    gap: 4px;
    min-width: 0;
    font-size: 12.5px;
    color: var(--db-ink-3);

    i {
        display: block;
        height: 0.45rem;
        border-radius: 2px;
        background: var(--db-panel-2);
    }

    span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    // The track is the deploy's own colour: steps done solid, the current one pulsing, the rest grey.
    &.is-done {
        color: var(--db-ink-2);

        i {
            background: var(--db-deploy);
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
        font-weight: 700;
    }

    &.is-current {
        color: var(--db-deploy);

        i {
            background: var(--db-deploy);
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
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
}

.db-release {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 4px 8px;
    font-size: 13.5px;
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
    height: 4px;
    border-radius: 2px;
    background: var(--db-panel-2);
    overflow: hidden;

    i {
        display: block;
        height: 100%;
        background: var(--db-deploy);
        transition: width 0.6s ease;
    }

    .is-done & i,
    .is-complete & i {
        background: var(--db-ok);
    }

    .is-stuck & i {
        background: var(--db-bad);
    }

    .is-no-progress & i {
        background: var(--db-warn);
    }
}

.db-release-cron {
    grid-column: 1 / -1;
    font-size: 13.5px;
    color: var(--db-ink-3);
}

.db-card-warning {
    margin: 0;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--db-warn);
}

.db-pipeline {
    display: grid;
    gap: 4px;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--db-panel-2);
    font-size: 13.5px;
    min-width: 0;
}

.db-pipeline-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 4px 12px;
}

.db-pipeline-state {
    font-weight: 700;
    color: var(--db-deploy);

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
    font-size: 13.5px;

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
    gap: 4px;
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
}

.db-job {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
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

.db-card-note {
    margin: 0;
    font-size: 13.5px;
    color: var(--db-ink-3);
}

.db-dismiss {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--db-line-2);
    border-radius: 999px;
    background: var(--db-panel);
    color: var(--db-ink-2);
    font: inherit;
    font-size: 12.5px;
    line-height: 1;
    cursor: pointer;

    &:focus-visible {
        outline: 2px solid var(--db-deploy);
        outline-offset: 2px;
    }
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
