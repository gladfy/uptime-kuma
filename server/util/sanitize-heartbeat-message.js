/**
 * Sanitizer for heartbeat messages that are about to be published.
 *
 * A heartbeat message is written by the monitor loop straight from the underlying error
 * (`bean.msg = error.message`, server/model/monitor.js), so it routinely carries internal
 * hostnames, IP addresses, ports, database queries and stack fragments. The TV panel needs the
 * error line, so this module turns a message into a label that is safe to publish.
 *
 * The rule is allowlist + render, never passthrough: a recognised pattern produces a label
 * written here, and anything unrecognised produces the generic label. A message never reaches the
 * output, not even partially, so a monitor type we have never seen fails closed instead of
 * leaking whatever it happens to put in `msg`.
 */

/** Label used whenever the message is not recognised (default deny) */
const GENERIC_ERROR_LABEL = "Sem resposta";

/**
 * Canonical texts for the HTTP status codes monitors actually produce.
 * Deliberately local: the `statusText` of the response is written by the remote server, so it is
 * third-party controlled text and must never be echoed back into a public payload.
 */
const HTTP_STATUS_TEXT = {
    400: "Bad Request",
    401: "Unauthorized",
    402: "Payment Required",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    407: "Proxy Authentication Required",
    408: "Request Timeout",
    409: "Conflict",
    410: "Gone",
    413: "Payload Too Large",
    414: "URI Too Long",
    421: "Misdirected Request",
    426: "Upgrade Required",
    429: "Too Many Requests",
    431: "Request Header Fields Too Large",
    451: "Unavailable For Legal Reasons",
    500: "Internal Server Error",
    501: "Not Implemented",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
    505: "HTTP Version Not Supported",
    507: "Insufficient Storage",
    508: "Loop Detected",
    511: "Network Authentication Required",
};

/** Every label this module can emit that is not derived from an HTTP status code */
const STATIC_ERROR_LABELS = [
    GENERIC_ERROR_LABEL,
    "Conexão recusada",
    "Host não encontrado",
    "Sem resposta a tempo",
    "Certificado inválido",
    "Em manutenção",
    "Serviços do grupo fora do ar",
    "Palavra-chave não encontrada",
];

/** Shape of the labels derived from an HTTP status code */
const HTTP_ERROR_LABEL_PATTERN = /^HTTP \d{3}(?: · [A-Za-z- ]+)?$/;

/** Shape of the label derived from the monitor's own abort timeout */
const TIMEOUT_ERROR_LABEL_PATTERN = /^timeout \d+s$/;

/** Every shape of label derived from a captured number, as opposed to the static ones */
const DERIVED_ERROR_LABEL_PATTERNS = [HTTP_ERROR_LABEL_PATTERN, TIMEOUT_ERROR_LABEL_PATTERN];

/**
 * Ordered allowlist. The first entry whose `match` hits decides the label, so the specific
 * patterns come before the substring ones.
 * @type {{match: RegExp, label: string | ((m: RegExpMatchArray) => string)}[]}
 */
const RULES = [
    // Axios rejects the response when the status code is not in the monitor's accepted list.
    {
        match: /Request failed with status code (\d{3})/,
        label: (m) => {
            const code = m[1];
            const text = HTTP_STATUS_TEXT[Number(code)];
            return text ? `HTTP ${code} · ${text}` : `HTTP ${code}`;
        },
    },
    // Written by the monitor loop itself when its own abort signal fires.
    {
        match: /timeout by AbortSignal \((\d+)s\)/,
        label: (m) => `timeout ${m[1]}s`,
    },
    { match: /ECONNREFUSED/, label: "Conexão recusada" },
    { match: /ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/, label: "Host não encontrado" },
    { match: /ETIMEDOUT|ESOCKETTIMEDOUT|timeout of \d+ms exceeded/, label: "Sem resposta a tempo" },
    {
        match: /CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|certificate/i,
        label: "Certificado inválido",
    },
    { match: /Monitor under maintenance/, label: "Em manutenção" },
    // Group monitors enumerate the affected children by name. A group can sit on a status page
    // whose children are not published, so the names must not travel.
    { match: /Child monitors down|Pending child monitors|Group empty/, label: "Serviços do grupo fora do ar" },
    { match: /keyword .* not found|should not be present in|not found in \[/i, label: "Palavra-chave não encontrada" },
];

/**
 * Turn a raw heartbeat message into a label that is safe to publish.
 * @param {string | null | undefined} message The raw `heartbeat.msg` value.
 * @returns {string} A label from the closed set this module declares. Never the input.
 */
function sanitizeHeartbeatMessage(message) {
    if (typeof message !== "string" || message.trim() === "") {
        return GENERIC_ERROR_LABEL;
    }

    for (const rule of RULES) {
        const found = message.match(rule.match);
        if (found) {
            return typeof rule.label === "function" ? rule.label(found) : rule.label;
        }
    }

    return GENERIC_ERROR_LABEL;
}

/**
 * Is this string one of the labels this module is allowed to emit?
 * Used by the tests to assert the output set stays closed.
 * @param {string} label The label to check.
 * @returns {boolean} True when the label belongs to the declared set.
 */
function isKnownErrorLabel(label) {
    if (STATIC_ERROR_LABELS.includes(label)) {
        return true;
    }
    return DERIVED_ERROR_LABEL_PATTERNS.some((pattern) => pattern.test(label));
}

module.exports = {
    sanitizeHeartbeatMessage,
    isKnownErrorLabel,
    GENERIC_ERROR_LABEL,
    STATIC_ERROR_LABELS,
    HTTP_ERROR_LABEL_PATTERN,
    TIMEOUT_ERROR_LABEL_PATTERN,
    DERIVED_ERROR_LABEL_PATTERNS,
};
