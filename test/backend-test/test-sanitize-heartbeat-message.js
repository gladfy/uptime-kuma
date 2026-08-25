const { describe, test } = require("node:test");
const assert = require("node:assert");
const {
    sanitizeHeartbeatMessage,
    isKnownErrorLabel,
    GENERIC_ERROR_LABEL,
    STATIC_ERROR_LABELS,
} = require("../../server/util/sanitize-heartbeat-message");

/**
 * Does the text contain any of the given fragments?
 * Used both to assert absence in the sanitized output and, with a string that does contain them,
 * to prove the search itself works — an absence assertion with a broken search passes forever.
 * @param {string} text Text to search in.
 * @param {string[]} fragments Fragments to look for.
 * @returns {string[]} The fragments that were found.
 */
function fragmentosPresentes(text, fragments) {
    return fragments.filter((fragment) => text.toLowerCase().includes(fragment.toLowerCase()));
}

describe("sanitizeHeartbeatMessage", () => {
    describe("a tabela da allowlist", () => {
        const casos = [
            ["Request failed with status code 502", "HTTP 502 · Bad Gateway"],
            ["Request failed with status code 500", "HTTP 500 · Internal Server Error"],
            ["Request failed with status code 429", "HTTP 429 · Too Many Requests"],
            ["Request failed with status code 404", "HTTP 404 · Not Found"],
            ["Request failed with status code 504", "HTTP 504 · Gateway Timeout"],
            ["timeout by AbortSignal (30s)", "timeout 30s"],
            ["timeout by AbortSignal (5s)", "timeout 5s"],
            ["connect ECONNREFUSED 10.0.3.14:5432", "Conexão recusada"],
            ["getaddrinfo ENOTFOUND api-interna.winker.local", "Host não encontrado"],
            ["getaddrinfo EAI_AGAIN db.interno.example.com", "Host não encontrado"],
            ["connect ETIMEDOUT 192.168.1.50:443", "Sem resposta a tempo"],
            ["timeout of 48000ms exceeded", "Sem resposta a tempo"],
            ["certificate has expired", "Certificado inválido"],
            ["Monitor under maintenance", "Em manutenção"],
        ];

        for (const [entrada, esperado] of casos) {
            test(`${JSON.stringify(entrada)} -> ${JSON.stringify(esperado)}`, () => {
                assert.strictEqual(sanitizeHeartbeatMessage(entrada), esperado);
            });
        }
    });

    test("status HTTP fora do mapa ainda vira rótulo, só sem o texto", () => {
        // O código sai de uma captura \d{3}, então não pode carregar nada além de dígitos.
        assert.strictEqual(sanitizeHeartbeatMessage("Request failed with status code 599"), "HTTP 599");
    });

    test("grupo não leva o nome dos filhos", () => {
        const saida = sanitizeHeartbeatMessage("Child monitors down: Banco interno, Fila de jobs");

        assert.strictEqual(saida, "Serviços do grupo fora do ar");
        assert.deepStrictEqual(fragmentosPresentes(saida, ["Banco interno", "Fila de jobs"]), []);
    });

    test("grupo pendente e grupo vazio caem no mesmo rótulo", () => {
        assert.strictEqual(
            sanitizeHeartbeatMessage("Pending child monitors: Câmera 12, Portaria"),
            "Serviços do grupo fora do ar"
        );
        assert.strictEqual(sanitizeHeartbeatMessage("Group empty"), "Serviços do grupo fora do ar");
    });

    describe("default deny", () => {
        const desconhecidas = [
            "coisa que nenhum padrão reconhece",
            "Error: something exploded at /app/server/model/monitor.js:918:31",
            "ER_ACCESS_DENIED_ERROR: Access denied for user 'kuma'@'10.0.0.9'",
            "socket hang up",
        ];

        for (const entrada of desconhecidas) {
            test(`${JSON.stringify(entrada.slice(0, 40))}… -> genérico`, () => {
                assert.strictEqual(sanitizeHeartbeatMessage(entrada), GENERIC_ERROR_LABEL);
            });
        }
    });

    describe("entrada ausente ou inválida", () => {
        const vazias = [["string vazia", ""], ["só espaços", "   "], ["null", null], ["undefined", undefined], ["número", 500], ["objeto", { msg: "x" }]];

        for (const [nome, entrada] of vazias) {
            test(`${nome} -> genérico, sem lançar`, () => {
                assert.strictEqual(sanitizeHeartbeatMessage(entrada), GENERIC_ERROR_LABEL);
            });
        }
    });

    test("a saída pertence sempre ao conjunto fechado", () => {
        const corpus = [
            "Request failed with status code 502",
            "Request failed with status code 599",
            "timeout by AbortSignal (30s)",
            "connect ECONNREFUSED 10.0.3.14:5432",
            "getaddrinfo ENOTFOUND api-interna.winker.local",
            "connect ETIMEDOUT 192.168.1.50:443",
            "certificate has expired",
            "Monitor under maintenance",
            "Child monitors down: Banco interno",
            "keyword [senha-de-producao] not found",
            "",
            null,
            undefined,
            42,
            "qualquer outra coisa",
            "Error: ER_PARSE_ERROR near 'SELECT * FROM usuario WHERE token='abc''",
        ];

        for (const entrada of corpus) {
            const saida = sanitizeHeartbeatMessage(entrada);
            assert.ok(
                isKnownErrorLabel(saida),
                `saída ${JSON.stringify(saida)} não pertence ao conjunto declarado (entrada: ${JSON.stringify(entrada)})`
            );
        }
    });

    test("nenhum identificador de infraestrutura sobrevive ao saneamento", () => {
        const segredos = [
            "10.0.3.14",
            "5432",
            "api-interna.winker.local",
            "db.interno.example.com",
            "kuma",
            "senha-de-producao",
            "usuario",
            "abc",
        ];

        const sujas = [
            "connect ECONNREFUSED 10.0.3.14:5432",
            "getaddrinfo ENOTFOUND api-interna.winker.local",
            "connect ETIMEDOUT db.interno.example.com:5432",
            "ER_ACCESS_DENIED_ERROR: Access denied for user 'kuma'@'10.0.3.14'",
            "Request failed with status code 401 for https://kuma:senha-de-producao@api-interna.winker.local/x",
            "keyword [senha-de-producao] not found",
            "Error: ER_PARSE_ERROR near 'SELECT * FROM usuario WHERE token='abc''",
        ];

        // Controle positivo: a busca ACHA os fragmentos quando eles estão presentes.
        // Sem isto, um `fragmentosPresentes` quebrado deixaria o teste verde para sempre.
        for (const suja of sujas) {
            assert.notDeepStrictEqual(
                fragmentosPresentes(suja, segredos),
                [],
                `o controle positivo falhou: nenhum fragmento encontrado em ${JSON.stringify(suja)}`
            );
        }

        // A ausência que importa.
        for (const suja of sujas) {
            const saida = sanitizeHeartbeatMessage(suja);
            assert.deepStrictEqual(
                fragmentosPresentes(saida, segredos),
                [],
                `vazou em ${JSON.stringify(saida)} (entrada: ${JSON.stringify(suja)})`
            );
        }
    });

    test("o conjunto declarado não tem duplicata nem vazio", () => {
        assert.strictEqual(new Set(STATIC_ERROR_LABELS).size, STATIC_ERROR_LABELS.length);
        for (const label of STATIC_ERROR_LABELS) {
            assert.ok(typeof label === "string" && label.trim() !== "", `rótulo inválido: ${JSON.stringify(label)}`);
        }
    });
});
