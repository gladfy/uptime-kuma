const { describe, test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { verifySignature } = require("../../../server/deploy-board/signature");

/**
 * @param {string} secret Secret.
 * @param {Buffer|string} body Body.
 * @returns {string} Header value as the senders compute it.
 */
function sign(secret, body) {
    return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("Assinatura dos webhooks", () => {
    test("o exemplo da documentação do Bitbucket confere", () => {
        const header = "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9";
        assert.strictEqual(verifySignature("It's a Secret to Everybody", Buffer.from("Hello World!"), header), true);
    });

    test("errada, ausente, sem o prefixo e de tamanho diferente: recusada", () => {
        const body = Buffer.from('{"a":1}');
        const good = sign("s3cr3t", body);
        assert.strictEqual(verifySignature("s3cr3t", body, good), true);
        assert.strictEqual(verifySignature("outro", body, good), false);
        assert.strictEqual(verifySignature("s3cr3t", body, undefined), false);
        assert.strictEqual(verifySignature("s3cr3t", body, good.slice("sha256=".length)), false);
        assert.strictEqual(verifySignature("s3cr3t", body, `${good}00`), false);
        assert.strictEqual(verifySignature("s3cr3t", body, "sha1=abc"), false);
        assert.strictEqual(verifySignature("", body, good), false);
    });

    test("calculada sobre o JSON reserializado não serve: vale o corpo recebido", () => {
        const received = Buffer.from('{ "repository": { "full_name": "winker/condominio" } }');
        const reserialized = JSON.stringify(JSON.parse(received.toString()));
        assert.notStrictEqual(reserialized, received.toString());
        assert.strictEqual(verifySignature("s3cr3t", received, sign("s3cr3t", reserialized)), false);
        assert.strictEqual(verifySignature("s3cr3t", received, sign("s3cr3t", received)), true);
    });

    test("corpo que não é Buffer (já parseado por outro middleware) é recusado", () => {
        assert.strictEqual(verifySignature("s3cr3t", { a: 1 }, sign("s3cr3t", '{"a":1}')), false);
    });
});
