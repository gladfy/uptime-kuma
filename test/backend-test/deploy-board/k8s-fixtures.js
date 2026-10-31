/**
 * Kubernetes objects shaped like the API returns them, for the deploy board tests.
 */

/**
 * A Deployment as the API returns it, with the fields that matter here.
 * @param {object} o Overrides.
 * @returns {object} Deployment.
 */
function deployment(o = {}) {
    return {
        metadata: {
            namespace: o.namespace || "condominio",
            name: o.name || "winker-prod",
            generation: o.generation ?? 10,
            resourceVersion: String(o.resourceVersion ?? 1),
            annotations: {
                "deployment.kubernetes.io/revision": String(o.revision ?? 7),
                "meta.helm.sh/release-name": o.release ?? "winker-prod",
            },
            labels: {},
        },
        spec: {
            replicas: o.replicas ?? 17,
            template: {
                spec: {
                    containers: [
                        { name: "php-fpm", image: `tiwinker/portal:${o.tag || "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"}` },
                        { name: "nginx", image: "nginx:1.27" },
                    ],
                },
            },
        },
        status: {
            observedGeneration: o.observedGeneration ?? o.generation ?? 10,
            replicas: o.total ?? o.replicas ?? 17,
            updatedReplicas: o.updated ?? o.replicas ?? 17,
            availableReplicas: o.available ?? o.replicas ?? 17,
            conditions: o.conditions || [{ type: "Progressing", status: "True", reason: "NewReplicaSetAvailable" }],
        },
    };
}

/**
 * A CronJob as the API returns it.
 * @param {object} o Overrides.
 * @returns {object} CronJob.
 */
function cronJob(o = {}) {
    return {
        metadata: {
            namespace: o.namespace || "gateway",
            name: o.name || "cron-1",
            generation: o.generation ?? 1,
            resourceVersion: String(o.resourceVersion ?? 1),
            annotations: { "meta.helm.sh/release-name": o.release ?? "gateway-cron" },
        },
        spec: {
            jobTemplate: { spec: { template: { spec: { containers: [{ name: "job", image: `tiwinker/gateway:${o.tag || "1111111aaaa"}` }] } } } },
        },
    };
}

module.exports = {
    deployment,
    cronJob,
};
