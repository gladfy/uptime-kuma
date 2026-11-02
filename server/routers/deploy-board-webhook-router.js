const express = require("express");
const { log } = require("../../src/util");
// The package behind Kuma's KumaRateLimiter, which server/rate-limiter.js does not export.
const { RateLimiter } = require("limiter");
const { verifySignature } = require("../deploy-board/signature");

/** Header with the signature, per source. */
const SIGNATURE_HEADERS = {
    bitbucket: "x-hub-signature",
    github: "x-hub-signature-256",
};

/** Header with the event name, per source. */
const EVENT_HEADERS = {
    bitbucket: "x-event-key",
    github: "x-github-event",
};

/** Body limit: a push of a big merge is a few hundred KB. */
const BODY_LIMIT = "1mb";

/**
 * Requests per minute per IP, before the signature is even computed. Generous on purpose: one push to
 * a repository with test matrices sends ~50 deliveries in a minute (a workflow_job per job and state),
 * GitHub does not resend a refused one, and behind a proxy Kuma does not trust every sender may share
 * one address. The ingress already lets only the senders' ranges reach this path.
 */
const PER_IP_PER_MINUTE = 600;

/** The table of limiters is cleared past this many IPs, so a scan cannot grow it without end. */
const MAX_TRACKED_IPS = 1000;

/**
 * @param {any} value Header or payload value.
 * @returns {string} Safe for one log line: no newlines, at most 100 characters.
 */
function forLog(value) {
    return String(value || "-")
        .replace(/[^\w:./@-]/g, "_")
        .slice(0, 100);
}

/**
 * Routes that receive the Bitbucket and GitHub webhooks of the deploy board.
 *
 * Mounted BEFORE the global express.json(): the signature is over the bytes received, so this router
 * reads the raw body itself, on its own path only. Every other request of Kuma goes on untouched.
 * Nothing of the body, of the signature header or of the secret is ever logged.
 * @param {object} options Options.
 * @param {object} options.board DeployBoard: webhookSecret(source) and receiveWebhook(...).
 * @param {Function} options.clientIP (req) → Promise<string>, honouring Kuma's "trust proxy".
 * @returns {express.Router} Router.
 */
function createDeployBoardWebhookRouter({ board, clientIP }) {
    const router = express.Router();
    const limiters = new Map();

    const limit = async (req, res, next) => {
        try {
            const ip = await clientIP(req);
            if (limiters.size > MAX_TRACKED_IPS) {
                limiters.clear();
            }
            if (!limiters.has(ip)) {
                limiters.set(
                    ip,
                    new RateLimiter({ tokensPerInterval: PER_IP_PER_MINUTE, interval: "minute", fireImmediately: true })
                );
            }
            if ((await limiters.get(ip).removeTokens(1)) < 0) {
                res.status(429).json({ ok: false });
                return;
            }
            next();
        } catch (e) {
            next(e);
        }
    };

    router.post(
        "/api/deploy-board/webhook/:source",
        limit,
        express.raw({ type: "application/json", limit: BODY_LIMIT }),
        (req, res) => {
            const source = req.params.source;
            const secret = SIGNATURE_HEADERS[source] ? board.webhookSecret(source) : null;
            if (!secret) {
                // Unknown source, or one not switched on: as if the route did not exist.
                res.status(404).json({ ok: false });
                return;
            }
            if (!Buffer.isBuffer(req.body)) {
                log.info("deploy-board", `Webhook ${source}: refused, content type is not application/json`);
                res.status(415).json({ ok: false, msg: "Content type must be application/json" });
                return;
            }
            if (!verifySignature(secret, req.body, req.get(SIGNATURE_HEADERS[source]))) {
                log.warn("deploy-board", `Webhook ${source}: refused, signature does not match`);
                res.status(401).json({ ok: false });
                return;
            }

            const eventName = req.get(EVENT_HEADERS[source]) || "";
            let payload;
            try {
                payload = JSON.parse(req.body.toString("utf8"));
            } catch (e) {
                log.info("deploy-board", `Webhook ${source} ${forLog(eventName)}: refused, body is not JSON`);
                res.status(400).json({ ok: false });
                return;
            }

            try {
                const { repo, kept } = board.receiveWebhook(source, eventName, payload);
                log.info(
                    "deploy-board",
                    `Webhook ${source} ${forLog(eventName)} ${forLog(repo)}: ${kept ? `${kept} kept` : "discarded"}`
                );
            } catch (e) {
                // Accepted anyway: the sender would resend a body the board cannot read, forever.
                log.error("deploy-board", `Webhook ${source} ${forLog(eventName)}: could not apply: ${e.message}`);
            }
            // 2xx for discarded events too: a feature branch is not an error for the sender.
            res.status(202).json({ ok: true });
        }
    );

    // Errors of this router's own middleware (the body over the limit, mostly), without the body.
    // eslint-disable-next-line no-unused-vars
    router.use("/api/deploy-board/webhook", (err, req, res, next) => {
        const status = err.type === "entity.too.large" ? 413 : err.status || 500;
        log.warn("deploy-board", `Webhook ${forLog(req.params?.source || req.path)}: refused with ${status}`);
        res.status(status).json({ ok: false });
    });

    return router;
}

module.exports = {
    BODY_LIMIT,
    PER_IP_PER_MINUTE,
    createDeployBoardWebhookRouter,
};
