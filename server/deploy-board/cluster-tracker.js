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

/** An image tag that is a commit. */
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

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
     * @param {Map<string, string>} options.known Last signature saved of each object (see signatureOf),
     * to tell at boot what changed while the board was down.
     * @param {Function} options.onSeen Called with (key, signature) when an object shows a new one.
     * @param {string|null} options.cluster Name of the cluster, or null for the one the pod runs in.
     * It prefixes the rollout ids and the object keys, so a release of the same name in another
     * cluster is another release, in the database too.
     */
    constructor({
        releases,
        onRollout = () => {},
        now = () => Date.now(),
        known = new Map(),
        onSeen = () => {},
        cluster = null,
    }) {
        this.cluster = cluster;
        this.prefix = cluster ? `${cluster}:` : "";
        this.tracked = new Set(releases);
        this.onRollout = onRollout;
        this.now = now;
        this.known = new Map(known);
        this.onSeen = onSeen;
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
        if (kind === "deployments") {
            // Helm changes the template first and the controller bumps the revision moments later:
            // the images of a revision are the ones it had when it was first seen.
            kept.revisionContainers =
                previous && previous.revision === kept.revision ? previous.revisionContainers : kept.containers;
        }
        map.set(key, kept);
        const release = releaseKey(kept);

        const signature = signatureOf(kind, kept);
        const saved = this.known.get(`${this.prefix}${kind}/${key}`);
        this.see(kind, key, signature);

        if (baseline) {
            let touched = false;
            if (kind === "deployments" && oldVersionStillUp(kept)) {
                this.touch(release, kind, kept.name, true);
                touched = true;
            } else if (saved !== undefined && changedSince(kind, saved, signature)) {
                // Rolled while the board was down (its own deploy is always one: Recreate).
                this.touch(release, kind, kept.name, true, true);
                touched = true;
            }
            // Touched means changed: a rollout that already ended must still take the object in.
            this.recompute(release, touched);
            return;
        }

        const changed = !previous || (kind === "deployments" ? revisionChanged(previous, kept) : imagesChanged(previous, kept));
        if (changed) {
            this.touch(release, kind, kept.name, false);
            const rollout = this.rollouts.get(release);
            if (kind === "deployments" && previous && !rollout.beforeUnknown.has(kept.name)) {
                // What was running when this rollout began: the version to go back to.
                rollout.before[kept.name] ??= previous.revisionContainers;
            }
        }
        this.recompute(release, changed);
    }

    /**
     * Report a signature the database does not have yet.
     * @param {string} kind Kind.
     * @param {string} key "<namespace>/<name>".
     * @param {string} signature Signature of the object now.
     * @returns {void}
     */
    see(kind, key, signature) {
        const objectKey = `${this.prefix}${kind}/${key}`;
        if (this.known.get(objectKey) === signature) {
            return;
        }
        this.known.set(objectKey, signature);
        try {
            this.onSeen(objectKey, signature);
        } catch (e) {
            // Saving is best effort: the board goes on without it.
        }
    }

    /**
     * Record that an object of a release changed: join the open rollout of the release, or start one.
     * @param {string} release "<namespace>/<release>".
     * @param {string} kind Kind of the object.
     * @param {string} name Name of the object.
     * @param {boolean} atBoot Whether the rollout was found already running.
     * @param {boolean} missed Whether it rolled while the board was down (its start was not seen).
     * @returns {void}
     */
    touch(release, kind, name, atBoot, missed = false) {
        const now = this.now();
        let rollout = this.rollouts.get(release);
        const joinable =
            rollout && rollout.state !== "superseded" && !rollout.changed[kind].has(name) && now - rollout.startedAt < JOIN_MS;

        if (!joinable) {
            // A stuck rollout is left as published: its card stays until a later deploy of the
            // project finishes, and that is the store's call, not the tracker's.
            if (rollout && rollout.endedAt === null && rollout.state !== "stuck") {
                // A newer revision while the previous one was still rolling: that one will never end.
                rollout.state = "superseded";
                rollout.endedAt = now;
                this.publish(rollout);
            }
            // A rollout that never finished (replaced, stuck, still rolling) is no version to go
            // back to: the new one keeps what was running before it, and does not take the
            // half-rolled images of the Deployments it touched as "before".
            const unfinished = rollout && rollout.state !== "done" ? rollout : null;
            const before = unfinished ? { ...unfinished.before } : {};
            const beforeUnknown = new Set(unfinished ? unfinished.beforeUnknown : []);
            for (const d of unfinished ? unfinished.changed.deployments : []) {
                if (!(d in before)) {
                    beforeUnknown.add(d);
                }
            }
            const [namespace, releaseName] = release.split("/");
            rollout = {
                id: `${this.prefix}${release}:${++this.sequence}`,
                cluster: this.cluster,
                namespace,
                release: releaseName,
                atBoot,
                missed,
                startedAt: now,
                endedAt: null,
                state: "updating",
                updated: 0,
                available: 0,
                desired: 0,
                lastProgressAt: now,
                changed: { deployments: new Set(), cronjobs: new Set() },
                before,
                beforeUnknown,
            };
            this.rollouts.set(release, rollout);
        } else {
            // Seen live by any of its objects: then its start was seen too.
            rollout.missed = rollout.missed && missed;
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
     * The commit each object of a release runs now, by its image tag.
     * @param {string} release "<namespace>/<release>".
     * @returns {string[]|null} One commit per object whose tag is one, or null when no object of the
     * release was seen.
     */
    commitsOf(release) {
        const all = KINDS.flatMap((kind) => [...this.objects[kind].values()]);
        const objects = all.filter((o) => releaseKey(o) === release);
        if (!objects.length) {
            return null;
        }
        return objects.map((o) => o.images.find((tag) => COMMIT_RE.test(tag))).filter(Boolean);
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
 * What leaves the tracker: counts, tags and container images, never the objects.
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
    const deployments = [...objects.deployments.values()]
        .filter((d) => d.namespace === rollout.namespace && d.release === rollout.release)
        .map((d) => ({ name: d.name, containers: d.containers }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return {
        id: rollout.id,
        cluster: rollout.cluster,
        namespace: rollout.namespace,
        release: rollout.release,
        atBoot: rollout.atBoot,
        missed: rollout.missed,
        startedAt: rollout.startedAt,
        endedAt: rollout.endedAt,
        state: rollout.state,
        updated: rollout.updated,
        desired: rollout.desired,
        cronJobsUpdated: rollout.changed.cronjobs.size,
        // Container order kept, as in the template; it is not always the application first (nginx
        // comes first in the condominio and gateway pods).
        images: [...images],
        // The version of each Deployment, and the one before it when the start was seen: what the
        // command to go back is built from. Name, repository and tag only.
        deployments,
        before: { ...rollout.before },
    };
}

/**
 * A new Deployment is created without the revision annotation and gets "1" moments later: that is
 * the same rollout, not a second one.
 * @param {object} previous Kept Deployment before the event.
 * @param {object} kept Kept Deployment after it.
 * @returns {boolean} Whether the revision changed.
 */
function revisionChanged(previous, kept) {
    return previous.revision !== "" && previous.revision !== kept.revision;
}

/**
 * A CronJob joins a rollout when its image changes. Not by `generation`: suspending it or changing
 * its schedule by hand also bumps the generation, and is not a deploy.
 * @param {object} previous Kept CronJob before the event.
 * @param {object} kept Kept CronJob after it.
 * @returns {boolean} Whether the image tags changed.
 */
function imagesChanged(previous, kept) {
    return previous.images.join(",") !== kept.images.join(",");
}

/**
 * What tells one version of an object from the next: the revision of a Deployment, the image tags
 * of a CronJob (the same rules as the live detection above).
 * @param {string} kind Kind.
 * @param {object} kept Kept object.
 * @returns {string} Signature.
 */
function signatureOf(kind, kept) {
    return kind === "deployments" ? kept.revision : kept.images.join(",");
}

/**
 * @param {string} kind Kind.
 * @param {string} saved Signature saved before the board went down.
 * @param {string} now Signature at boot.
 * @returns {boolean} Whether it is another version. A Deployment saved without revision was being
 * created, and getting "1" is not a deploy.
 */
function changedSince(kind, saved, now) {
    if (kind === "deployments" && saved === "") {
        return false;
    }
    return saved !== now;
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
