/**
 * The command to put a release back on its previous images, for someone with access to the cluster
 * to copy and run with their own credential. The board never runs it: it reads the cluster and
 * nothing else.
 *
 * Only the image goes back (`kubectl set image`), not the whole template (`kubectl rollout undo`),
 * which can land on a revision that was only a restart.
 */

/**
 * What a namespace, a Deployment, a container and an image reference may hold. The command goes to
 * someone's terminal: anything else in a value read from the cluster and the release gets no command.
 */
const SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/**
 * @param {object[]} current Deployments of this version: [{name, containers}].
 * @param {object[]} previous Deployments of the previous version, same shape.
 * @returns {object[]} [{name, containers}] with only the containers whose tag differs, and the
 * previous image of each. A container or Deployment the previous version did not have is left out:
 * there is nothing to go back to.
 */
function changedContainers(current, previous) {
    const out = [];
    for (const d of current) {
        const before = previous.find((p) => p.name === d.name);
        if (!before) {
            continue;
        }
        const containers = [];
        for (const c of d.containers) {
            const old = before.containers.find((p) => p.name === c.name);
            if (old && old.tag !== c.tag) {
                containers.push({ name: c.name, repository: old.repository, tag: old.tag });
            }
        }
        if (containers.length) {
            out.push({ name: d.name, containers });
        }
    }
    return out;
}

/**
 * @param {object} before Map of Deployment name → containers, as the tracker records it.
 * @returns {object[]} The same as a Deployment list.
 */
function beforeAsDeployments(before) {
    return Object.entries(before || {}).map(([name, containers]) => ({ name, containers }));
}

/**
 * How to go back one release of a deploy.
 *
 * The previous version is the latest finished deploy of the same release whose images differ from
 * this one (a deploy of the same images again is not a version to go back to). Without one in the
 * history (7 days), it is what was running when this rollout began, when the board saw it begin.
 * A rollout that changed no image (a restart) has nothing to go back.
 * @param {object} rollout Rollout of the release, with `deployments`, `before` and `cronJobsUpdated`.
 * @param {object[]} candidates Earlier finished rollouts of the same release, newest first.
 * @returns {object} { namespace, release, status, previous, setImage, rolloutStatus, cronJobs },
 * status being "known", "unknown", "unchanged" or "cronOnly".
 */
function releaseRollback(rollout, candidates) {
    const current = rollout.deployments || [];
    const plan = {
        namespace: rollout.namespace,
        release: rollout.release,
        status: "unknown",
        previous: null,
        setImage: [],
        rolloutStatus: [],
        cronJobs: rollout.cronJobsUpdated || 0,
    };
    if (current.length === 0) {
        plan.status = "cronOnly";
        return plan;
    }

    const before = beforeAsDeployments(rollout.before);
    if (before.length && changedContainers(current, before).length === 0) {
        plan.status = "unchanged";
        return plan;
    }

    let changed = [];
    for (const candidate of candidates) {
        changed = changedContainers(current, candidate.deployments || []);
        if (changed.length) {
            break;
        }
    }
    if (!changed.length && before.length) {
        changed = changedContainers(current, before);
    }
    if (!changed.length) {
        return plan;
    }

    const ns = rollout.namespace;
    const values = [
        ns,
        ...changed.flatMap((d) => [d.name, ...d.containers.flatMap((c) => [c.name, c.repository, c.tag])]),
    ];
    if (!values.every((v) => SAFE_RE.test(v))) {
        return plan;
    }
    plan.status = "known";
    plan.previous = changed[0].containers[0].tag;
    for (const d of changed) {
        const images = d.containers.map((c) => `${c.name}=${c.repository}:${c.tag}`).join(" ");
        plan.setImage.push(`kubectl -n ${ns} set image deployment/${d.name} ${images}`);
        plan.rolloutStatus.push(`kubectl -n ${ns} rollout status deployment/${d.name}`);
    }
    return plan;
}

module.exports = {
    SAFE_RE,
    changedContainers,
    releaseRollback,
};
