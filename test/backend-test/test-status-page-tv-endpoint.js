process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const TestDB = require("../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../server/settings");
const { UP, DOWN, MAINTENANCE } = require("../../src/util");

const testDb = new TestDB("./data/test-tv-endpoint");

// A mensagem crua que o monitor grava: o valor que NAO pode chegar ao navegador.
const MSG_SUJA = "connect ECONNREFUSED 10.0.3.14:5432";
const SEGREDOS = ["10.0.3.14", "5432", "ECONNREFUSED"];

/**
 * Fragments found inside a text. Used for the absence assertion and for its positive control.
 * @param {string} text Text to search.
 * @param {string[]} fragments Fragments to look for.
 * @returns {string[]} Fragments actually present.
 */
function fragmentosPresentes(text, fragments) {
    return fragments.filter((fragment) => text.includes(fragment));
}

describe("Endpoint do painel de parede (/api/status-page/:slug/tv)", () => {
    let statusPage;
    let pageGroup;
    let groupMonitor;
    let child;
    let httpMonitor;
    let maintenanceMonitor;

    /**
     * Store a heartbeat for a monitor.
     * @param {object} monitor Monitor bean.
     * @param {number} status Heartbeat status.
     * @param {string} msg Raw message.
     * @param {string} time Timestamp.
     * @returns {Promise<void>} -
     */
    async function bater(monitor, status, msg, time) {
        const beat = R.dispense("heartbeat");
        beat.monitor_id = monitor.id;
        beat.status = status;
        beat.msg = msg;
        beat.time = time;
        beat.important = false;
        beat.duration = 60;
        await R.store(beat);
    }

    before(async () => {
        await testDb.create();

        statusPage = R.dispense("status_page");
        statusPage.slug = "noc";
        statusPage.title = "NOC Winker";
        statusPage.icon = "/icon.svg";
        statusPage.theme = "auto";
        statusPage.published = true;
        statusPage.auto_refresh_interval = 45;
        await R.store(statusPage);

        pageGroup = R.dispense("group");
        pageGroup.name = "Serviços";
        pageGroup.status_page_id = statusPage.id;
        pageGroup.public = true;
        pageGroup.weight = 1;
        await R.store(pageGroup);

        groupMonitor = R.dispense("monitor");
        groupMonitor.name = "Grupo Situator";
        groupMonitor.type = "group";
        groupMonitor.active = true;
        await R.store(groupMonitor);

        child = R.dispense("monitor");
        child.name = "API Situator";
        child.type = "http";
        child.active = true;
        child.parent = groupMonitor.id;
        await R.store(child);

        httpMonitor = R.dispense("monitor");
        httpMonitor.name = "Emissão de boletos";
        httpMonitor.type = "http";
        httpMonitor.active = true;
        await R.store(httpMonitor);

        maintenanceMonitor = R.dispense("monitor");
        maintenanceMonitor.name = "Portaria remota";
        maintenanceMonitor.type = "http";
        maintenanceMonitor.active = true;
        await R.store(maintenanceMonitor);

        // O grupo e o filho caem juntos (é o comportamento do GroupMonitorType).
        await bater(groupMonitor, DOWN, "Child monitors down: API Situator", "2026-08-24 10:00:00");
        await bater(child, DOWN, MSG_SUJA, "2026-08-24 10:00:00");
        await bater(httpMonitor, UP, "200 - OK", "2026-08-24 10:00:00");
        await bater(maintenanceMonitor, MAINTENANCE, "Monitor under maintenance", "2026-08-24 10:00:00");
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    /**
     * Rebuild the monitor_group rows of the page.
     * @param {boolean} showChildren Whether the group monitor expands its children.
     * @returns {Promise<void>} -
     */
    async function montarPagina(showChildren) {
        await R.exec("DELETE FROM monitor_group");

        const linhas = [
            [groupMonitor.id, 1, showChildren],
            [httpMonitor.id, 2, false],
            [maintenanceMonitor.id, 3, false],
        ];

        for (const [monitorID, weight, expand] of linhas) {
            const row = R.dispense("monitor_group");
            row.group_id = pageGroup.id;
            row.monitor_id = monitorID;
            row.weight = weight;
            row.show_children = expand;
            await R.store(row);
        }
    }

    /**
     * Call the route handler the same way express would, capturing the response.
     * @param {string} slug Slug to request.
     * @returns {Promise<{status: number, body: object}>} Captured response.
     */
    async function pedir(slug) {
        // O router é montado no boot do server; aqui exercitamos a mesma lógica pela camada de
        // dados, chamando o handler registrado. Carregar o router puxa o UptimeKumaServer inteiro,
        // então o teste replica a montagem do payload via require do módulo de rota.
        const router = require("../../server/routers/status-page-router");
        const layer = router.stack.find(
            (l) => l.route && l.route.path === "/api/status-page/:slug/tv" && l.route.methods.get
        );
        assert.ok(layer, "a rota do painel precisa estar registrada no router");

        // O último handler da pilha é o nosso; os anteriores são o cache do apicache.
        const handler = layer.route.stack[layer.route.stack.length - 1].handle;

        let statusCode = 200;
        let body = null;

        const response = {
            json(payload) {
                body = payload;
                return this;
            },
            status(code) {
                statusCode = code;
                return this;
            },
            setHeader() {
                return this;
            },
            header() {
                return this;
            },
        };

        await handler({ params: { slug } }, response);
        return {
            status: statusCode,
            body,
        };
    }

    test("payload traz lista, estado e batidas na MESMA resposta", async () => {
        await montarPagina(false);
        const { status, body } = await pedir("noc");

        assert.strictEqual(status, 200);
        assert.strictEqual(body.title, "NOC Winker");
        assert.strictEqual(body.refreshInterval, 45, "o painel recebe o intervalo configurado na página, não um fixo");

        const nomes = body.monitors.map((m) => m.name).sort();
        assert.deepStrictEqual(nomes, ["Emissão de boletos", "Grupo Situator", "Portaria remota"]);

        for (const monitor of body.monitors) {
            assert.ok(Number.isInteger(monitor.id), "monitor precisa de id");
            assert.ok(Array.isArray(monitor.beats), "monitor precisa de batidas");
            assert.ok(monitor.beats.every((b) => "status" in b && "time" in b));
        }
    });

    test("página sem intervalo configurado cai no padrão do app (300 s)", async () => {
        await montarPagina(false);

        const anterior = statusPage.auto_refresh_interval;
        statusPage.auto_refresh_interval = null;
        await R.store(statusPage);

        try {
            const { body } = await pedir("noc");
            assert.strictEqual(body.refreshInterval, 300);
        } finally {
            statusPage.auto_refresh_interval = anterior;
            await R.store(statusPage);
        }
    });

    test("monitor normal não carrega rótulo de erro", async () => {
        await montarPagina(false);
        const { body } = await pedir("noc");

        const ok = body.monitors.find((m) => m.name === "Emissão de boletos");
        assert.strictEqual(ok.status, UP);
        assert.strictEqual("errorLabel" in ok, false, "monitor UP não pode ter rótulo");

        // Controle: quem NÃO está UP tem rótulo. Sem isto, "não tem rótulo" passaria por vacuidade.
        const fora = body.monitors.find((m) => m.name === "Grupo Situator");
        assert.strictEqual(fora.status, DOWN);
        assert.ok(fora.errorLabel, "monitor fora do ar precisa de rótulo");
    });

    test("manutenção é estado próprio, não queda", async () => {
        await montarPagina(false);
        const { body } = await pedir("noc");

        const manut = body.monitors.find((m) => m.name === "Portaria remota");
        assert.strictEqual(manut.status, MAINTENANCE);
        assert.strictEqual(manut.errorLabel, "Em manutenção");
        assert.notStrictEqual(manut.status, DOWN);
    });

    test("grupo expandido some do payload e os filhos o representam", async () => {
        await montarPagina(true);
        const { body } = await pedir("noc");

        const nomes = body.monitors.map((m) => m.name);
        assert.ok(nomes.includes("API Situator"), "o filho precisa aparecer");
        assert.ok(!nomes.includes("Grupo Situator"), "o grupo expandido não pode aparecer junto do filho");

        // A queda é contada UMA vez.
        const fora = body.monitors.filter((m) => m.status === DOWN);
        assert.strictEqual(fora.length, 1);
    });

    test("grupo SEM expansão continua no payload", async () => {
        await montarPagina(false);
        const { body } = await pedir("noc");

        const nomes = body.monitors.map((m) => m.name);
        assert.ok(nomes.includes("Grupo Situator"));
        assert.ok(!nomes.includes("API Situator"), "filho não listado individualmente não deve aparecer");
    });

    test("a mensagem crua não aparece em campo nenhum do corpo", async () => {
        await montarPagina(true);
        const { body } = await pedir("noc");

        const corpo = JSON.stringify(body);

        // Controle positivo do mecanismo: a busca ACHA os segredos quando eles estão presentes.
        const corpoSujo = JSON.stringify({ ...body, vazamento: MSG_SUJA });
        assert.notDeepStrictEqual(
            fragmentosPresentes(corpoSujo, SEGREDOS),
            [],
            "o controle positivo falhou: a busca não acha o segredo nem quando ele está lá"
        );

        // A ausência que importa: no corpo real, nada.
        assert.deepStrictEqual(
            fragmentosPresentes(corpo, SEGREDOS),
            [],
            `mensagem crua vazou no corpo: ${corpo.slice(0, 400)}`
        );

        // E o rótulo do filho é o saneado.
        const filho = body.monitors.find((m) => m.name === "API Situator");
        assert.strictEqual(filho.errorLabel, "Conexão recusada");
    });

    test("as batidas não carregam mensagem", async () => {
        await montarPagina(true);
        const { body } = await pedir("noc");

        for (const monitor of body.monitors) {
            for (const beat of monitor.beats) {
                assert.strictEqual("msg" in beat, false, "batida não pode carregar msg");
            }
        }
    });

    test("status page despublicada devolve 404", async () => {
        await montarPagina(false);
        statusPage.published = false;
        await R.store(statusPage);

        const { status, body } = await pedir("noc");

        assert.strictEqual(status, 404);
        assert.strictEqual(body.status, "fail");

        statusPage.published = true;
        await R.store(statusPage);
    });

    test("slug inexistente devolve 404 indistinguível do despublicado", async () => {
        statusPage.published = false;
        await R.store(statusPage);
        const despublicado = await pedir("noc");

        statusPage.published = true;
        await R.store(statusPage);
        const inexistente = await pedir("nao-existe");

        assert.strictEqual(inexistente.status, 404);
        assert.deepStrictEqual(inexistente.body, despublicado.body);
    });
});
