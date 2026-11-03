/**
 * When the siren plays: a service seen going down, live. Pure, so every rule is testable in Node.
 *
 * Kept as .mjs so the backend tests (CommonJS, Node 20) can import it as it is.
 */

/**
 * States a service can go down from and the siren play. "unknown" (no beat read yet) and "paused"
 * are not among them: a service found down when its beats arrive, or turned on again already down,
 * was not seen going down.
 */
const WATCHED = ["up", "pending", "maintenance"];

/**
 * @param {Map<number, string>|null} previous State of each monitor at the last look, or null when
 * there is none to compare with (page load, reconnection, new login).
 * @param {{id: number, tone: string}[]} monitors Monitors on screen now, with their state.
 * @returns {{tones: Map<number, string>, down: number[]}} The states to compare with next time, and
 * the monitors seen going down since the last look (one siren for all of them).
 */
export function servicesGoneDown(previous, monitors) {
    const tones = new Map(monitors.map((m) => [m.id, m.tone]));
    if (!previous) {
        return { tones, down: [] };
    }
    const down = monitors.filter((m) => m.tone === "down" && WATCHED.includes(previous.get(m.id))).map((m) => m.id);
    return { tones, down };
}
