process.env.UPTIME_KUMA_HIDE_LOG = ["error_deploy-board", "info_deploy-board", "warn_deploy-board"].join(",");

const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DeployHistoryRepository, TABLE, OBJECT_TABLE } = require("../../../server/deploy-board/history-repository");
const { DeployBoard, HISTORY_RETENTION_MS } = require("../../../server/deploy-board");
const { DeployBoardStore, HISTORY_MS } = require("../../../server/deploy-board/store");
const migration = require("../../../db/knex_migrations/2026-11-02-1500-create-deploy-board-deploy");
const objectMigration = require("../../../db/knex_migrations/2026-11-02-1700-create-deploy-board-object");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

/**
 * @param {string} id Deploy id.
 * @param {number} endedAt End time.
 * @param {object} o Fields to replace.
 * @returns {object} History record, as the store builds it.
 */
function record(id, endedAt, o = {}) {
    return {
        id,
        project: "condominio",
        version: "9ee108f",
        sha: "9ee108fd57e459e093b5503b1de543d66df61c2e",
        outcome: "done",
        startedAt: endedAt - 2 * 60 * 1000,
        endedAt,
        releases: [{ namespace: "condominio", release: "winker-integration" }],
        rollouts: [
            {
                id: "condominio/winker-integration:1",
                namespace: "condominio",
                release: "winker-integration",
                state: "done",
                updated: 2,
                desired: 2,
                cronJobsUpdated: 0,
                atBoot: false,
                startedAt: endedAt - 2 * 60 * 1000,
                endedAt,
                images: ["9ee108fd57e459e093b5503b1de543d66df61c2e"],
            },
        ],
        ...o,
    };
}

describe("Histórico do painel no banco do Kuma", () => {
    let db;

    beforeEach(async () => {
        // The same SQLite driver as the project, and the migration itself, not a copy of the schema.
        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");
        db = require("knex")({ client: Dialect, connection: { filename: ":memory:" }, useNullAsDefault: true });
        await migration.up(db);
        await objectMigration.up(db);
    });

    afterEach(async () => {
        await db.destroy();
    });

    test("grava, regrava o mesmo deploy (upsert) e lê de volta", async () => {
        const repo = new DeployHistoryRepository({ knex: () => db });
        await repo.save(record("condominio:1", NOW - 1000, { outcome: "done" }));
        await repo.save(
            record("condominio:1", NOW, {
                releases: [
                    { namespace: "condominio", release: "winker-integration" },
                    { namespace: "condominio", release: "winker-prod" },
                ],
            })
        );

        assert.strictEqual((await db(TABLE).count({ n: "*" }))[0].n, 1, "um deploy, uma linha");
        const [loaded] = await repo.load(NOW - HISTORY_MS);
        assert.strictEqual(loaded.endedAt, NOW, "ficou a última versão");
        assert.deepStrictEqual(
            loaded.releases.map((r) => r.release),
            ["winker-integration", "winker-prod"]
        );
    });

    test("lê só a janela pedida, os mais recentes primeiro", async () => {
        const repo = new DeployHistoryRepository({ knex: () => db });
        await repo.save(record("a", NOW - 2 * DAY));
        await repo.save(record("b", NOW - 2000));
        await repo.save(record("c", NOW - 1000));
        assert.deepStrictEqual(
            (await repo.load(NOW - HISTORY_MS)).map((r) => r.id),
            ["c", "b"]
        );
    });

    test("a limpeza apaga o que encerrou há mais de 7 dias", async () => {
        const repo = new DeployHistoryRepository({ knex: () => db });
        await repo.save(record("velho", NOW - HISTORY_RETENTION_MS - 1));
        await repo.save(record("recente", NOW - HISTORY_RETENTION_MS + 1));
        assert.strictEqual(await repo.prune(NOW - HISTORY_RETENTION_MS), 1);
        assert.deepStrictEqual(
            (await db(TABLE).select("deploy_id")).map((r) => r.deploy_id),
            ["recente"]
        );
    });

    test("banco que falha não lança: gravar resolve, ler devolve vazio, limpar devolve zero", async () => {
        const broken = () => {
            const q = () => {
                throw new Error("SQLITE_BUSY");
            };
            return q;
        };
        const repo = new DeployHistoryRepository({ knex: broken });
        await assert.doesNotReject(repo.save(record("x", NOW)));
        assert.deepStrictEqual(await repo.load(0), []);
        assert.strictEqual(await repo.prune(NOW), 0);
        // E a fila continua: a gravação seguinte, com o banco de volta, entra.
        repo.knex = () => db;
        await repo.save(record("y", NOW));
        assert.strictEqual((await repo.load(0)).length, 1);
    });

    test("última versão de cada objeto: grava, regrava (upsert) e lê de volta", async () => {
        const repo = new DeployHistoryRepository({ knex: () => db });
        await repo.saveObject("deployments/monitor-infra/uptime-kuma", "40", NOW - 1000);
        await repo.saveObject("deployments/monitor-infra/uptime-kuma", "41", NOW);
        await repo.saveObject("cronjobs/gateway/c0", "1111111aaaa", NOW);
        assert.strictEqual((await db(OBJECT_TABLE).count({ n: "*" }))[0].n, 2);
        assert.deepStrictEqual([...(await repo.loadObjects())].sort(), [
            ["cronjobs/gateway/c0", "1111111aaaa"],
            ["deployments/monitor-infra/uptime-kuma", "41"],
        ]);
    });

    test("sem banco (antes do setup do Kuma) tudo é no-op", async () => {
        const repo = new DeployHistoryRepository({ knex: () => undefined });
        assert.strictEqual(repo.available(), false);
        await repo.save(record("x", NOW));
        assert.deepStrictEqual(await repo.load(0), []);
    });

    test("o cluster recebe as versões gravadas e grava as novas pelo repositório", () => {
        const saved = [];
        const repo = { available: () => true, save: () => Promise.resolve(), saveObject: (...a) => saved.push(a) };
        const board = new DeployBoard({ env: {}, store: new DeployBoardStore({ now: () => NOW }), history: repo });
        board.known = new Map([["deployments/condominio/winker-prod", "6"]]);
        try {
            board.startCluster({
                namespaces: ["condominio"],
                projects: [
                    {
                        name: "condominio",
                        source: null,
                        releases: [{ namespace: "condominio", release: "winker-prod" }],
                    },
                ],
            });
            const tracker = board.clusters[0].tracker;
            assert.strictEqual(tracker.known.get("deployments/condominio/winker-prod"), "6");
            tracker.see("deployments", "condominio/winker-prod", "7");
            assert.deepStrictEqual(saved, [["deployments/condominio/winker-prod", "7", NOW]]);
        } finally {
            board.stop();
        }
    });

    test("boot: o histórico do banco volta à tela antes de ligar o cluster", async () => {
        const repo = new DeployHistoryRepository({ knex: () => db });
        await repo.save(record("condominio:carregado", NOW - 60 * 60 * 1000));
        await repo.saveObject("deployments/condominio/winker-prod", "6", NOW - 60 * 60 * 1000);
        await repo.save(record("condominio:semana-passada", NOW - 8 * DAY));

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-board-boot-"));
        const file = path.join(dir, "config.json");
        fs.writeFileSync(
            file,
            JSON.stringify({
                namespaces: ["condominio"],
                projects: [
                    { name: "condominio", releases: ["condominio/winker-prod", "condominio/winker-integration"] },
                ],
            })
        );
        const store = new DeployBoardStore({ now: () => NOW });
        const board = new DeployBoard({ env: { DEPLOY_BOARD_CONFIG: file }, store, history: repo });
        let historyAtClusterStart = null;
        let knownAtClusterStart = null;
        board.startCluster = () => {
            historyAtClusterStart = store.snapshot().history.map((h) => h.id);
            knownAtClusterStart = [...board.known];
        };
        try {
            board.start(null);
            await board.ready;
            assert.deepStrictEqual(historyAtClusterStart, ["condominio:carregado"], "carregado antes do cluster");
            assert.deepStrictEqual(
                knownAtClusterStart,
                [["deployments/condominio/winker-prod", "6"]],
                "as versões vistas também"
            );
            assert.deepStrictEqual(
                (await db(TABLE).select("deploy_id")).map((r) => r.deploy_id),
                ["condominio:carregado"],
                "a semana passada foi limpa"
            );

            // Um deploy que encerra depois do boot vai para o banco pelo repositório.
            store.setProjects([
                { name: "condominio", source: null, releases: [{ namespace: "condominio", release: "winker-prod" }] },
            ]);
            store.upsertRollout({
                id: "condominio/winker-prod:1",
                namespace: "condominio",
                release: "winker-prod",
                atBoot: false,
                startedAt: NOW,
                endedAt: NOW + 1000,
                state: "done",
                updated: 7,
                desired: 7,
                cronJobsUpdated: 0,
                images: ["9ee108fd57e459e093b5503b1de543d66df61c2e"],
            });
            await repo.queue;
            const ids = (await db(TABLE).select("deploy_id")).map((r) => r.deploy_id);
            assert.deepStrictEqual(
                ids,
                ["condominio:carregado"],
                "o mesmo commit reabriu o registro carregado e o regravou"
            );
            const [row] = await repo.load(0);
            assert.deepStrictEqual(
                row.releases.map((r) => r.release),
                ["winker-integration", "winker-prod"]
            );
        } finally {
            board.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
