const { log } = require("../../src/util");
const { MESSAGE_MAX, firstLine } = require("./bitbucket-events");

/** The apps and their production branches are looked up again this often. */
const DISCOVER_MS = 30 * 60 * 1000;

/** Jobs are read this often, and more often while one of them runs. */
const IDLE_MS = 60 * 1000;
const BUSY_MS = 15 * 1000;

/** After this many cycles in a row with an error, the board stops vouching for the Amplify. */
const FAILED_CYCLES = 3;

/** Jobs read per branch: the one running and the ones just before it. */
const JOBS_PER_BRANCH = 3;

/** Amplify job and step status → board state. CANCELLING is still running until it ends. */
const STATES = {
    CREATED: "queued",
    PENDING: "queued",
    PROVISIONING: "running",
    RUNNING: "running",
    CANCELLING: "running",
    SUCCEED: "success",
    FAILED: "failed",
    CANCELLED: "stopped",
};

const FINAL_STATES = ["success", "failed", "stopped"];

/** A full commit hash: a job without one (a manual deploy of a zip) has no commit to show. */
const HASH_RE = /^[0-9a-f]{40}$/;

/** Errors of the credential chain: no credential is "not configured", not a failure. */
const CREDENTIAL_ERRORS = ["CredentialsProviderError", "ExpiredTokenException", "UnrecognizedClientException"];

/**
 * The calls the source makes, over the AWS SDK. Only the four read actions of the role.
 * @param {string} region AWS region.
 * @returns {object} listApps, listBranches, listJobs and getJob.
 */
function sdkApi(region) {
    const {
        AmplifyClient,
        ListAppsCommand,
        ListBranchesCommand,
        ListJobsCommand,
        GetJobCommand,
    } = require("@aws-sdk/client-amplify");
    // The default credential chain: in the cluster, the IRSA web identity token of the pod.
    const client = new AmplifyClient({ region });
    return {
        listApps: (nextToken) => client.send(new ListAppsCommand({ nextToken })),
        listBranches: (appId, nextToken) => client.send(new ListBranchesCommand({ appId, nextToken })),
        listJobs: (appId, branchName) =>
            client.send(new ListJobsCommand({ appId, branchName, maxResults: JOBS_PER_BRANCH })),
        getJob: (appId, branchName, jobId) => client.send(new GetJobCommand({ appId, branchName, jobId })),
    };
}

/**
 * @param {Function} page Called with the token of the next page.
 * @param {string} key Field of the answer with the items.
 * @returns {Promise<object[]>} Every item of every page.
 */
async function allPages(page, key) {
    const items = [];
    let token;
    do {
        const answer = await page(token);
        items.push(...(answer[key] || []));
        token = answer.nextToken;
    } while (token);
    return items;
}

/**
 * @param {Date|string|null|undefined} value Time from the SDK.
 * @returns {number|null} Epoch ms.
 */
function timeOf(value) {
    if (!value) {
        return null;
    }
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Jobs of the production branch of each Amplify app, read by polling: the Amplify sends no webhook
 * the board can receive without a rule and a destination on the AWS side.
 *
 * A job is a pipeline run of the app's project and its steps (BUILD, DEPLOY, VERIFY) are its jobs,
 * the same events the GitHub sends, so the store needs nothing of its own. What was already over at
 * the first read of a branch is not shown: it ended while the board was not looking.
 */
class AmplifySource {
    /**
     * @param {object} options Options.
     * @param {string} options.region AWS region of the apps.
     * @param {object} options.store DeployBoardStore.
     * @param {object} options.api Calls to the Amplify (sdkApi by default; a double in tests).
     * @param {Function} options.setTimer setTimeout (injectable for tests).
     * @param {Function} options.clearTimer clearTimeout.
     */
    constructor({ region, store, api = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
        this.region = region;
        this.store = store;
        this.api = api;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.branches = null;
        this.discoveredAt = null;
        this.seen = new Map();
        this.failures = 0;
        this.timer = null;
        this.stopped = false;
    }

    /**
     * Start polling. The source stays "unconfigured" until the first answer, and for good without a
     * credential.
     * @returns {boolean} Whether it started (only with a region).
     */
    start() {
        if (!this.region) {
            return false;
        }
        this.api = this.api || sdkApi(this.region);
        this.schedule(0);
        return true;
    }

    /**
     * @returns {void}
     */
    stop() {
        this.stopped = true;
        this.clearTimer(this.timer);
    }

    /**
     * @param {number} ms Delay.
     * @returns {void}
     */
    schedule(ms) {
        if (this.stopped) {
            return;
        }
        this.timer = this.setTimer(() => this.cycle(), ms);
        this.timer?.unref?.();
    }

    /**
     * One read: the apps when due, then the jobs of every production branch.
     * @returns {Promise<void>} Never rejects.
     */
    async cycle() {
        let busy = false;
        try {
            const now = this.store.now();
            if (this.branches === null || now - this.discoveredAt >= DISCOVER_MS) {
                await this.discover();
            }
            for (const branch of this.branches) {
                busy = (await this.readBranch(branch)) || busy;
            }
            if (this.failures >= FAILED_CYCLES) {
                log.info("deploy-board", "Amplify answering again");
            }
            this.failures = 0;
            this.store.setSource("amplify", "active");
            this.store.markData("amplify");
        } catch (e) {
            if (CREDENTIAL_ERRORS.includes(e?.name)) {
                // Without a credential there is no source: read again only when the apps are due.
                this.branches = null;
                this.store.setSource("amplify", "unconfigured", "no AWS credential");
                log.info("deploy-board", `No AWS credential for the Amplify (${e.name}); the Amplify source is off.`);
                this.schedule(DISCOVER_MS);
                return;
            }
            this.failures += 1;
            if (this.failures === FAILED_CYCLES) {
                this.store.setSource("amplify", "stale", String(e?.name || "error").slice(0, MESSAGE_MAX));
                log.warn("deploy-board", `Amplify not answering for ${FAILED_CYCLES} cycles: ${e?.name}: ${e?.message}`);
            }
        }
        this.schedule(busy ? BUSY_MS : IDLE_MS);
    }

    /**
     * The production branch of each app (stage PRODUCTION; a branch of stage NONE is not a deploy).
     * @returns {Promise<void>} Rejects on an error of the API.
     */
    async discover() {
        const apps = await allPages((token) => this.api.listApps(token), "apps");
        const branches = [];
        for (const app of apps) {
            const list = await allPages((token) => this.api.listBranches(app.appId, token), "branches");
            for (const b of list) {
                if (b.stage === "PRODUCTION") {
                    branches.push({ appId: app.appId, app: app.name, branch: b.branchName });
                }
            }
        }
        const left = this.store.setAmplifyApps([...new Set(branches.map((b) => b.app))]);
        if (left.length) {
            log.warn("deploy-board", `Amplify apps named like a configured project, left out: ${left.join(", ")}`);
        }
        this.branches = branches.filter((b) => !left.includes(b.app));
        this.discoveredAt = this.store.now();
    }

    /**
     * Read the last jobs of a branch and tell the store what changed.
     * @param {{appId: string, app: string, branch: string}} branch Production branch.
     * @returns {Promise<boolean>} Whether a job of it is running.
     */
    async readBranch(branch) {
        const key = `${branch.appId}/${branch.branch}`;
        const first = !this.seen.has(key);
        const seen = this.seen.get(key) || new Map();
        const answer = await this.api.listJobs(branch.appId, branch.branch);
        // Oldest first, so a retry is applied after the job it retries.
        const jobs = [...(answer.jobSummaries || [])].reverse();
        let busy = false;
        const next = new Map();
        for (const job of jobs) {
            const state = STATES[job.status] || "queued";
            const final = FINAL_STATES.includes(state);
            busy = busy || !final;
            const signature = `${job.status}|${timeOf(job.endTime)}`;
            next.set(job.jobId, signature);
            // A job that runs is read every cycle (its steps move while its status does not); an
            // ended one once, when it ends.
            if (!HASH_RE.test(String(job.commitId)) || (final && (first || seen.get(job.jobId) === signature))) {
                continue;
            }
            this.emit(branch, job, state);
            await this.emitSteps(branch, job);
        }
        this.seen.set(key, next);
        return busy;
    }

    /**
     * @param {object} branch Production branch.
     * @param {object} job Job summary.
     * @param {string} state Board state.
     * @returns {void}
     */
    emit(branch, job, state) {
        this.store.pipelineEvent({
            kind: "run",
            source: "amplify",
            project: branch.app,
            sha: job.commitId,
            branchKnown: true,
            runId: `${branch.appId}/${branch.branch}/${job.jobId}`,
            attempt: 1,
            updatedAt: null,
            name: `${branch.branch} #${job.jobId}`,
            message: firstLine(job.commitMessage),
            state,
            url: `https://${this.region}.console.aws.amazon.com/amplify/apps/${branch.appId}/branches/${encodeURIComponent(branch.branch)}/deployments/${job.jobId}`,
            startedAt: timeOf(job.startTime),
            endedAt: FINAL_STATES.includes(state) ? timeOf(job.endTime) : null,
        });
    }

    /**
     * The steps of a job that runs or just changed, as the jobs of its run.
     * @param {object} branch Production branch.
     * @param {object} job Job summary.
     * @returns {Promise<void>} Rejects on an error of the API.
     */
    async emitSteps(branch, job) {
        const answer = await this.api.getJob(branch.appId, branch.branch, job.jobId);
        for (const step of answer.job?.steps || []) {
            const state = STATES[step.status] || "queued";
            this.store.pipelineEvent({
                kind: "job",
                source: "amplify",
                project: branch.app,
                sha: job.commitId,
                runId: `${branch.appId}/${branch.branch}/${job.jobId}`,
                jobId: `${branch.appId}/${branch.branch}/${job.jobId}/${step.stepName}`,
                attempt: 1,
                updatedAt: null,
                name: String(step.stepName || "").toLowerCase().slice(0, MESSAGE_MAX),
                state,
                startedAt: timeOf(step.startTime),
                endedAt: FINAL_STATES.includes(state) ? timeOf(step.endTime) : null,
            });
        }
    }
}

module.exports = {
    DISCOVER_MS,
    IDLE_MS,
    BUSY_MS,
    FAILED_CYCLES,
    STATES,
    AmplifySource,
};
