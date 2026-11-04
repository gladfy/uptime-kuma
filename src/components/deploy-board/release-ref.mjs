/**
 * How the page writes a release and finds the source that reads it. The server has the same rules in
 * server/deploy-board/config.js (releaseRef, parseReleaseRef); a backend test keeps the two equal.
 *
 * Kept as .mjs so the backend tests (CommonJS, Node 20) can import it as it is.
 */

/**
 * @param {{cluster?: string|null, namespace: string, release: string}} r Release.
 * @returns {string} "<namespace>/<release>", or "<cluster>:<namespace>/<release>" outside the pod's
 * own cluster: the value of the Kuma tag "deploy" that points to it.
 */
export function releaseRef(r) {
    return `${r.cluster ? `${r.cluster}:` : ""}${r.namespace}/${r.release}`;
}

/**
 * @param {string|null|undefined} cluster Cluster name, or null for the pod's own.
 * @returns {string} The board source that reads it.
 */
export function clusterSourceId(cluster) {
    return cluster ? `cluster:${cluster}` : "cluster";
}

/**
 * @param {string} tag Value of a "deploy" tag: a release ref, or "amplify/<app>".
 * @returns {string} The board source that reads what it points to.
 */
export function sourceOfTag(tag) {
    if (tag.startsWith("amplify/")) {
        return "amplify";
    }
    const cluster = /^([^:/]+):/.exec(tag);
    return clusterSourceId(cluster ? cluster[1] : null);
}

/**
 * @param {string} id Source id of the board.
 * @returns {boolean} Whether it reads a cluster (the pod's own, or another of the configuration).
 */
export function isClusterSource(id) {
    return id === "cluster" || id.startsWith("cluster:");
}

/**
 * @param {{clusterLabel?: string|null, release: string}} r Release, as the server publishes it.
 * @returns {string} Its name for a person, with the cluster in front outside the pod's own.
 */
export function releaseName(r) {
    return r.clusterLabel ? `${r.clusterLabel} · ${r.release}` : r.release;
}
