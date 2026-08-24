process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const TestDB = require("../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../server/settings");

const testDb = new TestDB("./data/test-group-expansion");

describe("Status page group expansion (show_children)", () => {
    let statusPage;
    let pageGroup; // section of the status page
    let groupMonitor; // monitor of type "group"
    let childUp;
    let childPaused;
    let childWithUrl;

    before(async () => {
        await testDb.create();

        statusPage = R.dispense("status_page");
        statusPage.slug = "situator";
        statusPage.title = "Situator";
        statusPage.icon = "/icon.svg";
        statusPage.theme = "auto";
        await R.store(statusPage);

        pageGroup = R.dispense("group");
        pageGroup.name = "Services";
        pageGroup.status_page_id = statusPage.id;
        pageGroup.public = true;
        pageGroup.weight = 1;
        await R.store(pageGroup);

        groupMonitor = R.dispense("monitor");
        groupMonitor.name = "Grupo Situator";
        groupMonitor.type = "group";
        groupMonitor.active = true;
        await R.store(groupMonitor);

        childUp = R.dispense("monitor");
        childUp.name = "API";
        childUp.type = "http";
        childUp.url = "https://api.internal.example.com";
        childUp.active = true;
        childUp.parent = groupMonitor.id;
        await R.store(childUp);

        childPaused = R.dispense("monitor");
        childPaused.name = "Worker pausado";
        childPaused.type = "http";
        childPaused.active = false;
        childPaused.parent = groupMonitor.id;
        await R.store(childPaused);

        childWithUrl = R.dispense("monitor");
        childWithUrl.name = "Painel";
        childWithUrl.type = "http";
        childWithUrl.url = "https://painel.secreto.example.com";
        childWithUrl.active = true;
        childWithUrl.parent = groupMonitor.id;
        await R.store(childWithUrl);
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    /**
     * Recreates the monitor_group rows of the section for a scenario
     * @param {boolean} showChildren Value for the group monitor row
     * @param {boolean} withChildOwnRow Also list childWithUrl individually with send_url on
     * @returns {Promise<void>} -
     */
    async function montarPagina(showChildren, withChildOwnRow = false) {
        await R.exec("DELETE FROM monitor_group");

        const row = R.dispense("monitor_group");
        row.group_id = pageGroup.id;
        row.monitor_id = groupMonitor.id;
        row.weight = 1;
        row.show_children = showChildren;
        await R.store(row);

        if (withChildOwnRow) {
            const own = R.dispense("monitor_group");
            own.group_id = pageGroup.id;
            own.monitor_id = childWithUrl.id;
            own.weight = 2;
            own.send_url = true;
            await R.store(own);
        }
    }

    test("grupo expandido lista os filhos ativos, sem os pausados", async () => {
        await montarPagina(true);
        const bean = await R.findOne("group", " id = ? ", [pageGroup.id]);
        const json = await bean.toPublicJSON();

        assert.strictEqual(json.monitorList.length, 1);
        const grupo = json.monitorList[0];
        assert.strictEqual(grupo.showChildren, true);
        assert.ok(Array.isArray(grupo.childrenList), "childrenList deve existir");

        const nomes = grupo.childrenList.map((c) => c.name);
        assert.deepStrictEqual(nomes.sort(), ["API", "Painel"]);
        assert.ok(!nomes.includes("Worker pausado"), "filho pausado nao pode aparecer");
    });

    test("URL do filho nunca vaza — com controle positivo do mecanismo", async () => {
        await montarPagina(true, true);
        const bean = await R.findOne("group", " id = ? ", [pageGroup.id]);
        const json = await bean.toPublicJSON();

        // Controle positivo: o MESMO monitor, com linha propria e send_url ligado, EXPOE a url.
        // Sem isso, "nao contem url" passaria por vacuidade (busca quebrada acha nada).
        const linhaPropria = json.monitorList.find((m) => m.id === childWithUrl.id);
        assert.ok(linhaPropria, "linha propria do filho deve existir no cenario");
        assert.strictEqual(linhaPropria.url, "https://painel.secreto.example.com");

        // A ausencia que importa: dentro de childrenList nao ha url nem customUrl,
        // nem no JSON serializado da lista inteira de filhos.
        const grupo = json.monitorList.find((m) => m.id === groupMonitor.id);
        for (const child of grupo.childrenList) {
            assert.strictEqual("url" in child, false, `filho ${child.name} nao pode ter url`);
            assert.strictEqual("customUrl" in child, false);
            assert.strictEqual("sendUrl" in child, false);
        }
        const serializado = JSON.stringify(grupo.childrenList);
        assert.ok(!serializado.includes("painel.secreto"), "url do filho vazou na childrenList");
    });

    test("flag desligada preserva o formato atual (sem childrenList)", async () => {
        await montarPagina(false);
        const bean = await R.findOne("group", " id = ? ", [pageGroup.id]);
        const json = await bean.toPublicJSON();

        const grupo = json.monitorList[0];
        assert.strictEqual(grupo.showChildren, false);
        assert.strictEqual("childrenList" in grupo, false);
    });

    test("show_children em monitor que nao e grupo nao expande nada", async () => {
        // defensivo: linha adulterada direto no banco
        await R.exec("DELETE FROM monitor_group");
        const row = R.dispense("monitor_group");
        row.group_id = pageGroup.id;
        row.monitor_id = childUp.id;
        row.weight = 1;
        row.show_children = true;
        await R.store(row);

        const bean = await R.findOne("group", " id = ? ", [pageGroup.id]);
        const json = await bean.toPublicJSON();
        assert.strictEqual("childrenList" in json.monitorList[0], false);
    });

    test("migration criou a coluna com default 0", async () => {
        await R.exec("DELETE FROM monitor_group");
        const row = R.dispense("monitor_group");
        row.group_id = pageGroup.id;
        row.monitor_id = groupMonitor.id;
        row.weight = 1;
        // sem setar show_children
        await R.store(row);

        const valor = await R.getCell("SELECT show_children FROM monitor_group WHERE monitor_id = ?", [groupMonitor.id]);
        assert.strictEqual(Number(valor), 0);
    });
});
