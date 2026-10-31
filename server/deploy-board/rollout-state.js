/**
 * Pure functions over Kubernetes objects: what to keep of a Deployment or CronJob, and the rollout
 * state of a Helm release. No I/O and no clock of their own, so every rule is testable with plain
 * objects.
 */

/** Bumped by the Deployment controller when the pod template changes; never by a scale. */
const REVISION_ANNOTATION = "deployment.kubernetes.io/revision";
const RELEASE_ANNOTATION = "meta.helm.sh/release-name";
const INSTANCE_LABEL = "app.kubernetes.io/instance";

/** Rollout states of a release. */
const ROLLOUT_STATES = ["updating", "noProgress", "stuck", "done"];

/** Updating without more updated or available replicas for this long is "no progress". */
const NO_PROGRESS_MS = 2 * 60 * 1000;

/**
 * Helm release of an object: the Helm annotation, then the instance label, then its own name.
 * @param {object} metadata Kubernetes metadata.
 * @returns {string} Release name.
 */
function releaseOf(metadata) {
    return metadata?.annotations?.[RELEASE_ANNOTATION] || metadata?.labels?.[INSTANCE_LABEL] || metadata?.name || "";
}

/**
 * Tag of an image reference: "repo/app:abc123@sha256:..." → "abc123". No tag → "latest", as the
 * runtime reads it.
 * @param {string} image Image reference.
 * @returns {string} Tag.
 */
function imageTag(image) {
    const ref = String(image || "").split("@")[0];
    const slash = ref.lastIndexOf("/");
    const colon = ref.lastIndexOf(":");
    return colon > slash ? ref.slice(colon + 1) : "latest";
}

/**
 * @param {object} podSpec Pod spec of a template.
 * @returns {string[]} Image tags of its containers, without repetition.
 */
function tagsOf(podSpec) {
    const tags = (podSpec?.containers || []).map((c) => imageTag(c.image));
    return [...new Set(tags)];
}

/**
 * @param {any} value Number from the API, possibly absent.
 * @param {number} fallback Value when absent.
 * @returns {number} The number.
 */
function count(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

/**
 * The only fields of a Deployment the board keeps. Built field by field: env, volumes and the rest
 * of the template never leave this function.
 * @param {object} obj Deployment from the API.
 * @returns {object} Kept fields.
 */
function extractDeployment(obj) {
    const metadata = obj?.metadata || {};
    const spec = obj?.spec || {};
    const status = obj?.status || {};
    return {
        namespace: metadata.namespace || "",
        name: metadata.name || "",
        release: releaseOf(metadata),
        revision: String(metadata.annotations?.[REVISION_ANNOTATION] || ""),
        images: tagsOf(spec.template?.spec),
        replicas: count(spec.replicas, 1),
        updated: count(status.updatedReplicas),
        available: count(status.availableReplicas),
        total: count(status.replicas),
        generation: count(metadata.generation),
        observedGeneration: count(status.observedGeneration),
        conditions: (status.conditions || []).map((c) => ({
            type: String(c.type || ""),
            status: String(c.status || ""),
            reason: String(c.reason || ""),
        })),
    };
}

/**
 * The only fields of a CronJob the board keeps. `generation` moves when the spec changes (a new
 * image in the job template), and is how a CronJob joins a rollout.
 * @param {object} obj CronJob from the API.
 * @returns {object} Kept fields.
 */
function extractCronJob(obj) {
    const metadata = obj?.metadata || {};
    return {
        namespace: metadata.namespace || "",
        name: metadata.name || "",
        release: releaseOf(metadata),
        generation: count(metadata.generation),
        images: tagsOf(obj?.spec?.jobTemplate?.spec?.template?.spec),
    };
}

/**
 * @param {object} d Kept Deployment.
 * @returns {boolean} Whether the controller gave up on it (progressDeadlineSeconds passed).
 */
function isStuck(d) {
    return d.conditions.some(
        (c) => c.type === "Progressing" && c.status === "False" && c.reason === "ProgressDeadlineExceeded"
    );
}

/**
 * State of one Deployment, with the criterion of `kubectl rollout status`.
 * @param {object} d Kept Deployment.
 * @returns {string} "updating", "stuck" or "done".
 */
function deploymentState(d) {
    if (d.replicas === 0) {
        return "done";
    }
    if (isStuck(d)) {
        return "stuck";
    }
    const done =
        d.observedGeneration >= d.generation &&
        d.updated >= d.replicas &&
        d.total <= d.updated &&
        d.available >= d.updated;
    return done ? "done" : "updating";
}

/**
 * Whether the old version still has pods: what tells a rollout in progress from a scale-up, where
 * the new pods are already of the current version and only not ready yet.
 * @param {object} d Kept Deployment.
 * @returns {boolean} True while old pods remain.
 */
function oldVersionStillUp(d) {
    return d.replicas > 0 && (d.updated < d.replicas || d.total > d.updated);
}

/**
 * State of a release: the sum of its Deployments. Without a clock, so never "noProgress".
 * @param {object[]} deployments Kept Deployments of the release.
 * @returns {{state: string, updated: number, available: number, desired: number}} Release state.
 */
function releaseStatus(deployments) {
    let updated = 0;
    let available = 0;
    let desired = 0;
    let stuck = false;
    let pending = false;
    for (const d of deployments) {
        updated += Math.min(d.updated, d.replicas);
        available += Math.min(d.available, d.replicas);
        desired += d.replicas;
        const state = deploymentState(d);
        stuck = stuck || state === "stuck";
        pending = pending || state !== "done";
    }
    const state = stuck ? "stuck" : pending ? "updating" : "done";
    return { state, updated, available, desired };
}

/**
 * Apply the "no progress" clock to a release status.
 * @param {object|null} previous Result of the previous call for the same rollout, or null.
 * @param {object} status Result of releaseStatus().
 * @param {number} now Current time, in ms.
 * @returns {object} The status plus `lastProgressAt`, with the state "noProgress" when due.
 */
function withProgressClock(previous, status, now) {
    const progressed =
        !previous || status.updated > previous.updated || status.available > previous.available;
    const lastProgressAt = progressed ? now : previous.lastProgressAt;
    const state = status.state === "updating" && now - lastProgressAt >= NO_PROGRESS_MS ? "noProgress" : status.state;
    return { ...status, state, lastProgressAt };
}

module.exports = {
    REVISION_ANNOTATION,
    ROLLOUT_STATES,
    NO_PROGRESS_MS,
    releaseOf,
    imageTag,
    extractDeployment,
    extractCronJob,
    deploymentState,
    oldVersionStillUp,
    releaseStatus,
    withProgressClock,
};
