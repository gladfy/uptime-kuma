const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const express = require("express");
const { log } = require("../../../src/util");
const {
    createDeployBoardWebhookRouter,
    PER_IP_PER_MINUTE,
} = require("../../../server/routers/deploy-board-webhook-router");

const SECRET = "segredo-do-bitbucket-de-teste";
const PLANTED = "texto-plantado-no-corpo";

/**
 * @param {string} body Body.
 * @param {string} secret Secret.
 * @returns {string} Signature header value.
 */
function sign(body, secret = SECRET) {
    return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("Roteador dos webhooks", () => {
    let server;
    let base;
    let received;
    let lines;
    let ip;
    let ipCount = 0;
    const original = {};

    before(async () => {
        const board = {
            webhookSecret: (source) => (source === "bitbucket" ? SECRET : null),
            receiveWebhook: (source, eventName, payload) => {
                received.push({ source, eventName, payload });
                return { repo: payload.repository?.full_name || "", kept: payload.keep ? 1 : 0 };
            },
        };
        const app = express();
        app.use(createDeployBoardWebhookRouter({ board, clientIP: async () => ip }));
        app.use(express.json());
        app.post("/api/outra-rota", (req, res) => res.json({ parsed: req.body }));
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
        for (const level of ["info", "warn", "error", "debug"]) {
            original[level] = log[level];
            log[level] = (module, message) => lines.push(`${module} ${message}`);
        }
    });

    after(() => {
        Object.assign(log, original);
        server.close();
    });

    beforeEach(() => {
        received = [];
        lines = [];
        // One address per test: a drawn one could fall on the address the limit test used up.
        ipCount += 1;
        ip = `10.2.${Math.floor(ipCount / 250)}.${(ipCount % 250) + 1}`;
    });

    /**
     * @param {string} source Source in the path.
     * @param {string} body Body.
     * @param {object} headers Headers.
     * @returns {Promise<Response>} Response.
     */
    function post(source, body, headers = {}) {
        return fetch(`${base}/api/deploy-board/webhook/${source}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body,
        });
    }

    test("assinatura certa: 202 e o evento chega ao painel", async () => {
        const body = JSON.stringify({ repository: { full_name: "winker/condominio" }, keep: true, note: PLANTED });
        const res = await post("bitbucket", body, {
            "X-Hub-Signature": sign(body),
            "X-Event-Key": "repo:commit_status_updated",
        });
        assert.strictEqual(res.status, 202);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].eventName, "repo:commit_status_updated");
        assert.deepStrictEqual(lines, [
            "deploy-board Webhook bitbucket repo:commit_status_updated winker/condominio: 1 kept",
        ]);
    });

    test("evento descartado (branch de feature) também é 2xx, para o remetente não reenviar", async () => {
        const body = JSON.stringify({ repository: { full_name: "winker/condominio" } });
        const res = await post("bitbucket", body, { "X-Hub-Signature": sign(body), "X-Event-Key": "repo:push" });
        assert.strictEqual(res.status, 202);
        assert.match(lines[0], /discarded$/);
    });

    test("assinatura errada ou ausente: 401, e nada chega ao painel", async () => {
        const body = JSON.stringify({ repository: { full_name: "winker/condominio" }, keep: true });
        assert.strictEqual((await post("bitbucket", body, { "X-Hub-Signature": sign(body, "outro") })).status, 401);
        assert.strictEqual((await post("bitbucket", body)).status, 401);
        // Assinada sobre o JSON reserializado, e não sobre os bytes enviados.
        const spaced = '{ "repository": { "full_name": "winker/condominio" } }';
        assert.strictEqual(
            (await post("bitbucket", spaced, { "X-Hub-Signature": sign(JSON.stringify(JSON.parse(spaced))) })).status,
            401
        );
        assert.strictEqual(received.length, 0);
    });

    test("fonte sem segredo e fonte desconhecida: 404", async () => {
        const body = "{}";
        assert.strictEqual((await post("github", body, { "X-Hub-Signature-256": sign(body) })).status, 404);
        assert.strictEqual((await post("gitlab", body)).status, 404);
    });

    test("corpo acima de 1 MiB: 413", async () => {
        const body = JSON.stringify({ x: "a".repeat(1024 * 1024 + 10) });
        assert.strictEqual((await post("bitbucket", body, { "X-Hub-Signature": sign(body) })).status, 413);
        assert.strictEqual(received.length, 0);
    });

    test("conteúdo que não é JSON (o padrão de formulário do GitHub): 415, com o motivo", async () => {
        const res = await post("bitbucket", "a=1", {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Hub-Signature": sign("a=1"),
        });
        assert.strictEqual(res.status, 415);
    });

    test("limite por IP: passado o teto, 429 antes de calcular a assinatura", async () => {
        const body = "{}";
        let last;
        for (let i = 0; i <= PER_IP_PER_MINUTE; i++) {
            last = await post("bitbucket", body, { "X-Hub-Signature": "sha256=errada" });
        }
        assert.strictEqual(last.status, 429);
        ip = "10.0.1.1";
        assert.strictEqual(
            (await post("bitbucket", body, { "X-Hub-Signature": "sha256=errada" })).status,
            401,
            "outro IP não é afetado"
        );
    });

    test("outra rota do Kuma continua recebendo o JSON parseado", async () => {
        const res = await fetch(`${base}/api/outra-rota`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ a: 1 }),
        });
        assert.deepStrictEqual(await res.json(), { parsed: { a: 1 } });
    });

    test("o log não traz o corpo, a assinatura nem o segredo", async () => {
        const body = JSON.stringify({ repository: { full_name: "winker/condominio" }, note: PLANTED });
        await post("bitbucket", body, { "X-Hub-Signature": sign(body), "X-Event-Key": "repo:push" });
        await post("bitbucket", body, { "X-Hub-Signature": sign(body, "outro"), "X-Event-Key": "repo:push" });
        await post("bitbucket", "{não é json", {
            "X-Hub-Signature": sign("{não é json"),
            "X-Event-Key": "x <script>forjada</script>",
        });
        const all = lines.join("\n");
        assert.ok(lines.length >= 3, "controle: houve log");
        for (const forbidden of [PLANTED, SECRET, sign(body), "<script>"]) {
            assert.ok(!all.includes(forbidden), `o log contém ${forbidden}`);
        }
        assert.ok(
            lines.every((l) => !l.includes("\n")),
            "uma linha por pedido"
        );
    });
});
