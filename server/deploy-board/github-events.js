/**
 * GitHub webhook payloads → the few facts the board keeps. Pure: no I/O, no clock.
 *
 * Only the fields of the spec leave: SHA, branch, the first line of the commit message, and the
 * state, name, times and link of a workflow run and of its jobs.
 */
const { MESSAGE_MAX, firstLine, timeOf } = require("./bitbucket-events");

/** A full commit hash. */
const HASH_RE = /^[0-9a-f]{40}$/;

/**
 * State of a run or a job, from its status and conclusion.
 * @param {string} status "queued", "in_progress", "completed", "waiting", "requested", "pending".
 * @param {string|null} conclusion Of a completed one.
 * @returns {string|null} Board state, or null for what is not a result (skipped, neutral).
 */
function stateOf(status, conclusion) {
    if (status !== "completed") {
        return status === "in_progress" ? "running" : "queued";
    }
    if (conclusion === "success") {
        return "success";
    }
    if (conclusion === "cancelled") {
        return "stopped";
    }
    if (["failure", "timed_out", "startup_failure", "action_required"].includes(conclusion)) {
        return "failed";
    }
    return null;
}

/**
 * @param {string} url Link from the payload.
 * @returns {string|null} The link, when it points to GitHub; anything else is not shown.
 */
function githubLink(url) {
    return typeof url === "string" && url.startsWith("https://github.com/") ? url : null;
}

/**
 * Read a GitHub webhook.
 * @param {string} eventName X-GitHub-Event header ("push", "workflow_run", "workflow_job", "ping").
 * @param {object} payload Parsed body.
 * @param {object[]} projects Normalized projects of the configuration.
 * @returns {{repo: string, events: object[]}} The repository (for the log) and what the board
 * keeps; no events when the repository, the branch or the workflow is not the configured one.
 */
function parseGithub(eventName, payload, projects) {
    const repo = String(payload?.repository?.full_name || "");
    const project = projects.find((p) => p.source === "github" && p.repo.toLowerCase() === repo.toLowerCase());
    if (!project) {
        return { repo, events: [] };
    }
    const base = { source: "github", project: project.name };
    const events = [];

    if (eventName === "push") {
        const commit = payload.head_commit;
        if (
            payload.ref === `refs/heads/${project.branch}` &&
            !payload.deleted &&
            commit &&
            HASH_RE.test(String(commit.id))
        ) {
            events.push({
                ...base,
                kind: "merge",
                sha: commit.id,
                message: firstLine(commit.message),
                at: timeOf(commit.timestamp),
            });
        }
    } else if (eventName === "workflow_run") {
        const run = payload.workflow_run || {};
        const state = stateOf(run.status, run.conclusion);
        const workflowOk = !project.workflow || run.path === project.workflow;
        if (state && workflowOk && run.head_branch === project.branch && HASH_RE.test(String(run.head_sha))) {
            events.push({
                ...base,
                kind: "run",
                sha: run.head_sha,
                branchKnown: true,
                runId: String(run.id),
                name: String(run.name || "").slice(0, MESSAGE_MAX),
                state,
                url: githubLink(run.html_url),
                startedAt: timeOf(run.run_started_at),
                endedAt: run.status === "completed" ? timeOf(run.updated_at) : null,
            });
        }
    } else if (eventName === "workflow_job") {
        const job = payload.workflow_job || {};
        const state = stateOf(job.status, job.conclusion);
        // The workflow of a job is checked by the run it belongs to: the payload has no path.
        if (state && job.head_branch === project.branch && HASH_RE.test(String(job.head_sha))) {
            events.push({
                ...base,
                kind: "job",
                sha: job.head_sha,
                runId: String(job.run_id),
                jobId: String(job.id),
                name: String(job.name || "").slice(0, MESSAGE_MAX),
                state,
                startedAt: timeOf(job.started_at),
                endedAt: job.status === "completed" ? timeOf(job.completed_at) : null,
            });
        }
    }
    return { repo, events };
}

module.exports = {
    parseGithub,
    stateOf,
};
