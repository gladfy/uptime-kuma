const {
    extractDeployment,
    extractCronJob,
    oldVersionStillUp,
    releaseStatus,
    withProgressClock,
} = require("./rollout-state");

/**
 * A change in another object of the same release this soon after the rollout started belongs to
 * the same `helm upgrade`: Helm applies the objects one by one, seconds apart, and a release like
 * gateway-cron (95 CronJobs, no Deployment) would otherwise become 95 rollouts.
 */
const JOIN_MS = 2 * 60 * 1000;

/** Kinds read from the cluster. */
const KINDS = ["deployments", "cronjobs"];

/**
 * Rollouts of the configured Helm releases, from the Deployments and CronJobs the cluster source
 * reads. Holds only the fields of rollout-state.js; the I/O lives in kubernetes-source.js.
 */
class ClusterTracker {
    /**
     * @param {object} options Options.
     * @param {string[]} options.releases Tracked releases, as "<namespace>/<release>".
     * @param {Function} options.onRollout Called with a copy of a rollout whenever it changes.
     * @param {Function} options.now Clock, in ms.
     */
    constructor({ releases, onRollout = () => {}, now = () => Date.now() }) {
        this.tracked = new Set(releases);
        this.onRollout = onRollout;
        this.now = now;
        this.objects = { deployments: new Map(), cronjobs: new Map() };
        this.rollouts = new Map();
        this.sequence = 0;
    }

    /**
     * Replace what is known of one kind in one namespace with a fresh list.
     *
     * The first list of a namespace is the baseline: what is already there is not a rollout, except
     * a Deployment whose old version still has pods (the board came up in the middle of one). A later
     * list (after the watch expired) compares like any change, so an unchanged revision never turns
     * into a rollout.
     * @param {string} namespace Namespace.
     * @param {string} kind "deployments" or "cronjobs".
     * @param {object[]} items Objects from the API.
     * @param {boolean} baseline Whether this is the first list of this namespace and kind.
     * @returns {void}
     */
    replace(namespace, kind, items, baseline) {
        const map = this.mapOf(kind);
        const seen = new Set();
        for (const item of items) {
            const kept = this.keep(kind, item);
            if (!kept) {
                continue;
            }
            seen.add(kept.name);
            this.upsert(kind, kept, baseline);
        }
        for (const [key, kept] of [...map]) {
            if (kept.namespace === namespace && !seen.has(kept.name)) {
                map.delete(key);
                this.recompute(releaseKey(kept), false);
            }
        }
    }

    /**
     * Apply one watch event.
     * @param {string} kind "deployments" or "cronjobs".
     * @param {string} type ADDED, MODIFIED or DELETED.
     * @param {object} item Object from the API.
     * @returns {void}
     */
    apply(kind, type, item) {
        const kept = this.keep(kind, item);
        if (!kept) {
            return;
        }
        if (type === "DELETED") {
            this.mapOf(kind).delete(objectKey(kept));
            this.recompute(releaseKey(kept), false);
        } else if (type === "ADDED" || type === "MODIFIED") {
            this.upsert(kind, kept, false);
        }
    }

    /**
     * Re-evaluate the open rollouts against the clock ("no progress" needs time, not events).
     * @returns {void}
     */
    tick() {
        for (const [key, rollout] of this.rollouts) {
            if (rollout.endedAt === null) {
                this.recompute(key, false);
            }
        }
    }

    /**
     * @param {string} kind Kind.
     * @param {object} item Object from the API.
     * @returns {object|null} Kept fields, or null when its release is not tracked.
     */
    keep(kind, item) {
        const kept = kind === "deployments" ? extractDeployment(item) : extractCronJob(item);
        return this.tracked.has(releaseKey(kept)) ? kept : null;
    }

    /**
     * @param {string} kind Kind.
     * @param {object} kept Kept object.
     * @param {boolean} baseline Whether it comes from the first list.
     * @returns {void}
     */
    upsert(kind, kept, baseline) {
        const map = this.mapOf(kind);
        const key = objectKey(kept);
        const previous = map.get(key);
        map.set(key, kept);
        const release = releaseKey(kept);

        if (baseline) {
            if (kind === "deployments" && oldVersionStillUp(kept)) {
                this.touch(release, kind, kept.name, true);
            }
            this.recompute(release, false);
            return;
        }

        const changed =
            !previous ||
            (kind === "deployments" ? previous.revision !== kept.revision : previous.generation !== kept.generation);
        if (changed) {
            this.touch(release, kind, kept.name, false);
        }
        this.recompute(release, changed);
    }

    /**
     * Record that an object of a release changed: join the open rollout of the release, or start one.
     * @param {string} release "<namespace>/<release>".
     * @param {string} kind Kind of the object.
     * @param {string} name Name of the object.
     * @param {boolean} atBoot Whether the rollout was found already running.
     * @returns {void}
     */
    touch(release, kind, name, atBoot) {
        const now = this.now();
        let rollout = this.rollouts.get(release);
        const joinable =
            rollout && rollout.state !== "superseded" && !rollout.changed[kind].has(name) && now - rollout.startedAt < JOIN_MS;

        if (!joinable) {
            if (rollout && rollout.endedAt === null) {
                // A newer revision while the previous one was still rolling: that one will never end.
                rollout.state = "superseded";
                rollout.endedAt = now;
                this.publish(rollout);
            }
            const [namespace, releaseName] = release.split("/");
            rollout = {
                id: `${release}:${++this.sequence}`,
                namespace,
                release: releaseName,
                atBoot,
                startedAt: now,
                endedAt: null,
                state: "updating",
                updated: 0,
                available: 0,
                desired: 0,
                lastProgressAt: now,
                changed: { deployments: new Set(), cronjobs: new Set() },
            };
            this.rollouts.set(release, rollout);
        }
        rollout.changed[kind].add(name);
    }

    /**
     * Recompute the state of the current rollout of a release and publish it if it moved.
     * @param {string} release "<namespace>/<release>".
     * @param {boolean} changed Whether an object of the release has just changed revision.
     * @returns {void}
     */
    recompute(release, changed) {
        const rollout = this.rollouts.get(release);
        if (!rollout || rollout.state === "superseded") {
            return;
        }
        // A finished rollout stays finished: the HPA scaling afterwards is not part of it.
        if (rollout.endedAt !== null && !changed) {
            return;
        }

        const deployments = [...this.objects.deployments.values()].filter((d) => releaseKey(d) === release);
        const clocked = withProgressClock(
            changed ? null : { updated: rollout.updated, available: rollout.available, lastProgressAt: rollout.lastProgressAt },
            releaseStatus(deployments),
            this.now()
        );
        const before = JSON.stringify(publicRollout(rollout, this.objects));

        rollout.state = clocked.state;
        rollout.updated = clocked.updated;
        rollout.available = clocked.available;
        rollout.desired = clocked.desired;
        rollout.lastProgressAt = clocked.lastProgressAt;
        rollout.endedAt = clocked.state === "done" ? (rollout.endedAt ?? this.now()) : null;

        // A change always publishes: the object that joined has already moved the counts above.
        if (changed || JSON.stringify(publicRollout(rollout, this.objects)) !== before) {
            this.publish(rollout);
        }
    }

    /**
     * @param {object} rollout Internal rollout.
     * @returns {void}
     */
    publish(rollout) {
        this.onRollout(publicRollout(rollout, this.objects));
    }

    /**
     * @param {string} kind Kind.
     * @returns {Map} Objects of that kind.
     * @throws {Error} Unknown kind.
     */
    mapOf(kind) {
        if (!KINDS.includes(kind)) {
            throw new Error(`Unknown kind: ${kind}`);
        }
        return this.objects[kind];
    }
}

/**
 * What leaves the tracker: counts and tags, never the objects.
 * @param {object} rollout Internal rollout.
 * @param {object} objects Kept objects by kind.
 * @returns {object} Rollout for the store.
 */
function publicRollout(rollout, objects) {
    const images = new Set();
    for (const kind of KINDS) {
        for (const name of rollout.changed[kind]) {
            const kept = objects[kind].get(`${rollout.namespace}/${name}`);
            for (const tag of kept?.images || []) {
                images.add(tag);
            }
        }
    }
    return {
        id: rollout.id,
        namespace: rollout.namespace,
        release: rollout.release,
        atBoot: rollout.atBoot,
        startedAt: rollout.startedAt,
        endedAt: rollout.endedAt,
        state: rollout.state,
        updated: rollout.updated,
        desired: rollout.desired,
        cronJobsUpdated: rollout.changed.cronjobs.size,
        // Container order kept: the first is the application, the rest are sidecars (nginx).
        images: [...images],
    };
}

/**
 * @param {object} kept Kept object.
 * @returns {string} "<namespace>/<release>".
 */
function releaseKey(kept) {
    return `${kept.namespace}/${kept.release}`;
}

/**
 * @param {object} kept Kept object.
 * @returns {string} "<namespace>/<name>".
 */
function objectKey(kept) {
    return `${kept.namespace}/${kept.name}`;
}

module.exports = {
    JOIN_MS,
    KINDS,
    ClusterTracker,
};
