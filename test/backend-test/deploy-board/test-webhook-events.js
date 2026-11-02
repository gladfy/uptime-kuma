const { describe, test } = require("node:test");
const assert = require("node:assert");
const { parseBitbucket } = require("../../../server/deploy-board/bitbucket-events");
const { parseGithub } = require("../../../server/deploy-board/github-events");

const SHA = "c13dc62f43f7a1b2c3d4e5f6a7b8c9d0e1f2a3b4";

/** Projects as the configuration normalizes them. */
const PROJECTS = [
    {
        name: "condominio",
        source: "bitbucket",
        repo: "winker/condominio",
        branch: "master",
        workflow: null,
        releases: [],
    },
    {
        name: "chat",
        source: "github",
        repo: "gladfy/chat",
        branch: "master",
        workflow: ".github/workflows/build-and-deploy-prod.yaml",
        releases: [],
    },
    {
        name: "jambonz-worker",
        source: "github",
        repo: "gladfy/jambonz-worker",
        branch: "main",
        workflow: null,
        releases: [],
    },
    { name: "agua-gas", source: null, repo: null, branch: null, workflow: null, releases: [] },
];

/**
 * @param {string} branch Branch pushed.
 * @param {object} o Fields to replace in the target commit.
 * @returns {object} repo:push payload, shaped like Bitbucket's.
 */
function bitbucketPush(branch, o = {}) {
    return {
        repository: { full_name: "winker/condominio", type: "repository" },
        actor: { display_name: "Erik", account_id: "x" },
        push: {
            changes: [
                {
                    new: {
                        type: "branch",
                        name: branch,
                        target: {
                            type: "commit",
                            hash: SHA,
                            date: "2026-11-02T19:41:00+00:00",
                            message: "Merged develop into master\n\nApproved-by: alguém",
                            author: { raw: "Erik <erik@winker.com.br>" },
                            ...o,
                        },
                    },
                    old: { type: "branch", name: branch, target: { hash: "0".repeat(40) } },
                    commits: [{ hash: SHA, message: "x" }],
                },
            ],
        },
    };
}

/**
 * @param {string} state Bitbucket state.
 * @param {object} o Fields to replace in commit_status.
 * @returns {object} repo:commit_status_* payload, shaped like Bitbucket's.
 */
function bitbucketStatus(state, o = {}) {
    return {
        repository: { full_name: "winker/condominio" },
        commit_status: {
            key: "{a1b2c3d4-pipeline}",
            type: "build",
            state,
            name: "Pipeline #4321 for master",
            refname: "master",
            url: "https://bitbucket.org/winker/condominio/pipelines/results/4321",
            created_on: "2026-11-02T19:41:10+00:00",
            updated_on: "2026-11-02T19:48:30+00:00",
            commit: { hash: SHA, type: "commit" },
            links: { commit: { href: `https://api.bitbucket.org/2.0/repositories/winker/condominio/commit/${SHA}` } },
            ...o,
        },
    };
}

describe("Eventos do Bitbucket", () => {
    test("merge na master: SHA, primeira linha da mensagem e hora", () => {
        const { events } = parseBitbucket("repo:push", bitbucketPush("master"), PROJECTS);
        assert.deepStrictEqual(events, [
            {
                kind: "merge",
                source: "bitbucket",
                project: "condominio",
                sha: SHA,
                message: "Merged develop into master",
                at: Date.parse("2026-11-02T19:41:00+00:00"),
            },
        ]);
        // Do autor e dos commits, nada sai.
        assert.ok(!JSON.stringify(events).includes("erik@winker.com.br"));
    });

    test("mensagem longa é cortada em 120", () => {
        const { events } = parseBitbucket("repo:push", bitbucketPush("master", { message: "x".repeat(300) }), PROJECTS);
        assert.strictEqual(events[0].message.length, 120);
    });

    test("push numa branch de feature, de branch apagada e de repositório fora da configuração: descartados", () => {
        assert.deepStrictEqual(parseBitbucket("repo:push", bitbucketPush("GPW-123"), PROJECTS).events, []);
        const deleted = bitbucketPush("master");
        deleted.push.changes[0].new = null;
        assert.deepStrictEqual(parseBitbucket("repo:push", deleted, PROJECTS).events, []);
        const other = bitbucketPush("master");
        other.repository.full_name = "winker/outro";
        const out = parseBitbucket("repo:push", other, PROJECTS);
        assert.deepStrictEqual(out, { repo: "winker/outro", events: [] });
    });

    test("estado da pipeline: os quatro estados, com o link e as horas", () => {
        const map = { INPROGRESS: "running", SUCCESSFUL: "success", FAILED: "failed", STOPPED: "stopped" };
        for (const [bb, state] of Object.entries(map)) {
            const [e] = parseBitbucket("repo:commit_status_updated", bitbucketStatus(bb), PROJECTS).events;
            assert.strictEqual(e.state, state);
            assert.strictEqual(e.sha, SHA);
            assert.strictEqual(e.url, "https://bitbucket.org/winker/condominio/pipelines/results/4321");
            assert.strictEqual(e.endedAt === null, state === "running");
        }
    });

    test("SHA tirado do link quando não vem em commit.hash; status sem branch passa marcado", () => {
        const [e] = parseBitbucket(
            "repo:commit_status_created",
            bitbucketStatus("INPROGRESS", { commit: undefined, refname: null }),
            PROJECTS
        ).events;
        assert.strictEqual(e.sha, SHA);
        assert.strictEqual(e.branchKnown, false);
    });

    test("status de pull request (outra branch) e estado desconhecido: descartados", () => {
        assert.deepStrictEqual(
            parseBitbucket(
                "repo:commit_status_updated",
                bitbucketStatus("INPROGRESS", { refname: "GPW-123" }),
                PROJECTS
            ).events,
            []
        );
        assert.deepStrictEqual(
            parseBitbucket("repo:commit_status_updated", bitbucketStatus("PAUSED"), PROJECTS).events,
            []
        );
    });

    test("link que não é do Bitbucket não sai", () => {
        const [e] = parseBitbucket(
            "repo:commit_status_updated",
            bitbucketStatus("SUCCESSFUL", { url: "javascript:alert(1)" }),
            PROJECTS
        ).events;
        assert.strictEqual(e.url, null);
    });
});

/**
 * @param {object} o Fields to replace in workflow_run.
 * @returns {object} workflow_run payload, shaped like GitHub's.
 */
function githubRun(o = {}) {
    return {
        action: "completed",
        repository: { full_name: "gladfy/chat" },
        workflow_run: {
            id: 9988776655,
            name: "Build and Push Image",
            path: ".github/workflows/build-and-deploy-prod.yaml",
            head_branch: "master",
            head_sha: SHA,
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/gladfy/chat/actions/runs/9988776655",
            run_started_at: "2026-11-02T19:40:00Z",
            updated_at: "2026-11-02T19:55:00Z",
            head_commit: { author: { email: "erik@winker.com.br" } },
            ...o,
        },
    };
}

describe("Eventos do GitHub", () => {
    test("push na master: merge", () => {
        const payload = {
            ref: "refs/heads/master",
            deleted: false,
            repository: { full_name: "gladfy/chat" },
            head_commit: {
                id: SHA,
                message: "Merge pull request #12 from gladfy/x\n\ncorpo",
                timestamp: "2026-11-02T19:39:00Z",
            },
        };
        const [e] = parseGithub("push", payload, PROJECTS).events;
        assert.deepStrictEqual(e, {
            source: "github",
            project: "chat",
            kind: "merge",
            sha: SHA,
            message: "Merge pull request #12 from gladfy/x",
            at: Date.parse("2026-11-02T19:39:00Z"),
        });
        assert.deepStrictEqual(parseGithub("push", { ...payload, ref: "refs/heads/develop" }, PROJECTS).events, []);
        assert.deepStrictEqual(parseGithub("push", { ...payload, ref: "refs/tags/v1" }, PROJECTS).events, []);
    });

    test("workflow_run: estados da fila à conclusão", () => {
        const cases = [
            [{ status: "queued", conclusion: null }, "queued"],
            [{ status: "in_progress", conclusion: null }, "running"],
            [{ status: "completed", conclusion: "success" }, "success"],
            [{ status: "completed", conclusion: "failure" }, "failed"],
            [{ status: "completed", conclusion: "cancelled" }, "stopped"],
        ];
        for (const [o, state] of cases) {
            const [e] = parseGithub("workflow_run", githubRun(o), PROJECTS).events;
            assert.strictEqual(e.state, state, JSON.stringify(o));
            assert.strictEqual(e.runId, "9988776655");
        }
        // Pulado não é resultado de deploy.
        assert.deepStrictEqual(parseGithub("workflow_run", githubRun({ conclusion: "skipped" }), PROJECTS).events, []);
        // Do autor do commit, nada sai.
        assert.ok(!JSON.stringify(parseGithub("workflow_run", githubRun(), PROJECTS)).includes("erik@winker.com.br"));
    });

    test("só o workflow de deploy configurado conta: testes e CodeQL na mesma master ficam de fora", () => {
        assert.deepStrictEqual(
            parseGithub(
                "workflow_run",
                githubRun({ path: ".github/workflows/run_specs.yml", conclusion: "failure" }),
                PROJECTS
            ).events,
            []
        );
        // Sem workflow configurado (jambonz), todo workflow da branch conta.
        const jambonz = githubRun({ path: ".github/workflows/build-and-deploy.yaml", head_branch: "main" });
        jambonz.repository.full_name = "gladfy/jambonz-worker";
        assert.strictEqual(parseGithub("workflow_run", jambonz, PROJECTS).events.length, 1);
    });

    test("workflow do develop (o que vai para chat-dev) é descartado pela branch", () => {
        assert.deepStrictEqual(parseGithub("workflow_run", githubRun({ head_branch: "develop" }), PROJECTS).events, []);
    });

    test("workflow_job: nome, estado e horas do job", () => {
        const payload = {
            action: "completed",
            repository: { full_name: "gladfy/chat" },
            workflow_job: {
                id: 111,
                run_id: 9988776655,
                name: "deploy",
                status: "completed",
                conclusion: "success",
                started_at: "2026-11-02T19:45:00Z",
                completed_at: "2026-11-02T19:55:00Z",
                head_sha: SHA,
                head_branch: "master",
                runner_name: "runner-x",
            },
        };
        const [e] = parseGithub("workflow_job", payload, PROJECTS).events;
        assert.deepStrictEqual(e, {
            source: "github",
            project: "chat",
            kind: "job",
            sha: SHA,
            runId: "9988776655",
            jobId: "111",
            name: "deploy",
            state: "success",
            startedAt: Date.parse("2026-11-02T19:45:00Z"),
            endedAt: Date.parse("2026-11-02T19:55:00Z"),
        });
    });

    test("projeto sem origem nunca casa, e o ping de criação do webhook não vira evento", () => {
        assert.deepStrictEqual(
            parseGithub("ping", { zen: "x", repository: { full_name: "gladfy/chat" } }, PROJECTS).events,
            []
        );
        const run = githubRun();
        run.repository.full_name = "winker/agua-gas";
        assert.deepStrictEqual(parseGithub("workflow_run", run, PROJECTS).events, []);
    });
});
