const crypto = require("crypto");

/**
 * Check a webhook signature: HMAC-SHA256 of the bytes received, keyed with the source's secret,
 * sent as "sha256=<hex>" (Bitbucket in X-Hub-Signature, GitHub in X-Hub-Signature-256).
 *
 * Over the body as received, never over JSON parsed and serialized again: any change of spacing or
 * key order changes the signature.
 * @param {string} secret Secret of the source.
 * @param {Buffer} body Request body, as received.
 * @param {string|undefined} header Value of the signature header.
 * @returns {boolean} Whether it matches.
 */
function verifySignature(secret, body, header) {
    if (!secret || !Buffer.isBuffer(body) || typeof header !== "string" || !header.startsWith("sha256=")) {
        return false;
    }
    const expected = Buffer.from(`sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`);
    const received = Buffer.from(header);
    // timingSafeEqual throws on different lengths; a different length is simply a mismatch.
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

module.exports = {
    verifySignature,
};
