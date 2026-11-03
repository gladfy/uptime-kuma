/**
 * Deploys made up for `?mock=deploys&n=N`: the board is drawn with them in place of the server's,
 * to see how the column holds N deploys at once. The integrations, the sounds and the server never
 * see them. Each one has the shape of the server's `publicDeploy`.
 */

const MIN = 60 * 1000;

/** At most this many: one of each case below. */
const MAX = 6;

/**
 * @param {string} key Step.
 * @param {string[]} keys Steps of the deploy, in order.
 * @param {string} status Status of the step it is on.
 * @returns {{key: string, status: string}[]} Steps done before it, pending after.
 */
function steps(key, keys, status = "current") {
    const at = keys.indexOf(key);
    return keys.map((k, i) => ({ key: k, status: i < at ? "done" : i === at ? status : "pending" }));
}

const CLUSTER = ["merge", "pipeline", "built", "rollout", "live"];
const AMPLIFY = ["merge", "pipeline", "live"];

/**
 * @param {number} t0 When the page opened, in ms: the times count from it and keep running.
 * @returns {object[]} The cases, in the order N takes them: with 3, a rollout, a pipeline and a failure.
 */
function cases(t0) {
    const job = (name, state, startedMin = null, endedMin = null) => ({
        id: name,
        name,
        state,
        startedAt: startedMin === null ? null : t0 - startedMin * MIN,
        endedAt: endedMin === null ? null : t0 - endedMin * MIN,
    });
    const pipeline = (source, state, message, jobs, startedMin, endedMin = null) => ({
        source,
        state,
        name: "Pipeline",
        url: null,
        mergedAt: t0 - (startedMin + 1) * MIN,
        message,
        startedAt: t0 - startedMin * MIN,
        endedAt: endedMin === null ? null : t0 - endedMin * MIN,
        jobs,
    });
    const release = (namespace, name, updated, desired) => ({
        namespace,
        release: name,
        state: updated >= desired ? "done" : "updating",
        updated,
        desired,
        cronJobsUpdated: 0,
        atBoot: false,
    });
    return [
        {
            project: "condominio",
            version: "9ee108f",
            state: "updating",
            label: "rolling",
            startedAt: t0 - 15 * MIN,
            releases: [release("condominio", "winker-prod", 4, 7), release("condominio", "winker-integration", 2, 2)],
            pipeline: pipeline("bitbucket", "success", "Merged in feat/creditos-winker-ia (pull request #8262)", [], 14, 9),
            steps: steps("rollout", CLUSTER),
        },
        {
            project: "uptime-kuma",
            version: "b0f02a2",
            state: "pipeline",
            label: "inPipeline",
            startedAt: t0 - 3 * MIN,
            releases: [],
            pipeline: pipeline(
                "github",
                "running",
                "chore(deploy): chart uptimekuma 0.5.2",
                [job("build", "running", 1), job("deploy", "queued"), job("verify", "queued")],
                2
            ),
            steps: steps("pipeline", CLUSTER),
        },
        {
            project: "chat",
            version: "4c1d2e9",
            state: "failed",
            label: "failed",
            startedAt: t0 - 9 * MIN,
            endedAt: t0 - 2 * MIN,
            releases: [],
            pipeline: pipeline(
                "github",
                "failed",
                "fix: fila de mensagens do widget",
                [job("build", "failed", 8, 2), job("deploy", "stopped")],
                8,
                2
            ),
            steps: steps("pipeline", CLUSTER, "failed"),
        },
        {
            project: "api_gateway",
            version: "7a57ebc",
            state: "built",
            label: "built",
            startedAt: t0 - 12 * MIN,
            releases: [],
            pipeline: pipeline("bitbucket", "success", "Merged in fix/limite-de-creditos (pull request #3120)", [], 11, 1),
            steps: steps("built", CLUSTER),
        },
        {
            project: "connector-server",
            version: "e45dd76",
            state: "updating",
            label: "rolling",
            startedAt: t0 - 6 * MIN,
            releases: [release("connector", "connector-access", 1, 3), release("connector", "connector-consumer", 0, 2)],
            pipeline: pipeline("bitbucket", "success", "Merged in feat/fila-por-instalacao (pull request #412)", [], 5, 3),
            steps: steps("rollout", CLUSTER),
        },
        {
            project: "pro",
            version: "1b957c8",
            state: "pipeline",
            label: "inPipeline",
            startedAt: t0 - 4 * MIN,
            releases: [],
            pipeline: pipeline(
                "amplify",
                "running",
                "feat: tela de créditos da Winker IA",
                [job("build", "running", 3), job("deploy", "queued"), job("verify", "queued")],
                3
            ),
            steps: steps("pipeline", AMPLIFY),
        },
    ];
}

/**
 * @param {number} t0 When the page opened, in ms.
 * @returns {object[]} Eight deploys that went live in the last hours, newest first.
 */
function history(t0) {
    const done = [
        ["observer", "3f9a1c0", "observer", "observer-prod", 22, 3],
        ["site", "8b2e4d1", "site-prod", "site-prod", 48, 2],
        ["agua-gas", "c71d0e5", "microservices-prod", "agua-gas", 75, 4],
        ["audit-consumer", "52aa9f3", "audit-platform", "audit-consumer", 110, 2],
        ["mcp-winker", "e09b7c4", "winker-mcp", "winker-mcp", 150, 3],
        ["status", "9d4f2a8", "microservices-prod", "status", 205, 2],
        ["temporal", "1c6e8b2", "temporal", "temporal", 260, 5],
        ["land", "7f3b5d9", "land", "land", 330, 2],
    ];
    return done.map(([project, version, namespace, release, endedMin, tookMin], i) => ({
        id: `mock-history-${i + 1}`,
        project,
        version,
        outcome: "done",
        startedAt: t0 - (endedMin + tookMin) * MIN,
        endedAt: t0 - endedMin * MIN,
        missed: false,
        releases: [{ namespace, release }],
        links: [`${namespace}/${release}`],
    }));
}

/**
 * @param {object} query Query string of the route.
 * @returns {number|null} How many made-up deploys it asks for (0 to MAX, MAX when N is left out),
 * or null when it asks for none.
 */
export function mockCount(query) {
    if (query?.mock !== "deploys") {
        return null;
    }
    const n = Number.parseInt(query.n, 10);
    return Number.isFinite(n) ? Math.min(MAX, Math.max(0, n)) : MAX;
}

/**
 * The board with the made-up deploys in place of the real ones, every source read, and a made-up
 * history too: the real one could hold a failure (another card, and N would not be N) or a later
 * "done" of a project made up here (which takes the made-up failure off the screen).
 * @param {object} board Board snapshot from the server.
 * @param {number} n How many.
 * @param {number} t0 When the page opened, in ms.
 * @returns {object} Snapshot to draw.
 */
export function withMockDeploys(board, n, t0) {
    const deploys = cases(t0)
        .slice(0, n)
        .map((d, i) => ({
            id: `mock-${i + 1}`,
            endedAt: null,
            missed: false,
            confirmed: true,
            rollback: null,
            links: d.pipeline.source === "amplify" ? [`amplify/${d.project}`] : d.releases.map((r) => `${r.namespace}/${r.release}`),
            ...d,
        }));
    // Every source read just now: the made-up deploys came from somewhere, and a "no source" text
    // in the column would take room the real board never gives it.
    const sources = Object.fromEntries(
        Object.keys(board.sources).map((id) => [id, { state: "active", lastDataAt: t0, detail: null }])
    );
    return { ...board, sources, deploys, history: history(t0) };
}
