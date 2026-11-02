/**
 * Which sounds a change of the board plays. Pure: it compares two snapshots of the server and says
 * what was seen happening between them. No audio here, so every rule is testable in Node.
 *
 * Kept as .mjs so the backend tests (CommonJS, Node 20) can import it as it is.
 */

/** The sounds, in the order a deploy goes through them. */
export const SOUND_EVENTS = ["started", "built", "rolling", "done", "failed"];

/**
 * @param {object} deploy Deploy of a snapshot.
 * @returns {string} Its releases, sorted: a deploy that takes in one more release is at a new stage.
 */
function stageOf(deploy) {
    return deploy.releases
        .map((r) => `${r.namespace}/${r.release}`)
        .sort()
        .join(",");
}

/**
 * Sounds for what changed from one snapshot to the next.
 *
 * A deploy that shows up rolling plays "started" and then "rolling"; one that comes back from the
 * history (the production of a commit whose integration already ended) plays only "rolling". Reaching
 * "No ar" plays "done", getting stuck plays "failed". "No progress" and "replaced" play nothing.
 * Without a previous snapshot (page load, reconnection, server restart with the history loaded from
 * the database) nothing plays: those are things found, not seen happening.
 *
 * "started" and "built" belong to the pipeline once its source exists (phase 4); until then, the
 * rollout starting is the start of the deploy.
 * @param {object|null} previous Snapshot before.
 * @param {object|null} current Snapshot now.
 * @returns {{deployId: string, event: string, key: string}[]} Sounds, in order; `key` names the
 * event of that deploy at that stage, so the same one is never played twice.
 */
export function soundEvents(previous, current) {
    if (!previous || !current) {
        return [];
    }
    const before = new Map(previous.deploys.map((d) => [d.id, d]));
    const inHistory = new Set((previous.history || []).map((h) => h.id));
    const out = [];

    for (const deploy of current.deploys) {
        const stage = stageOf(deploy);
        const play = (event) => out.push({ deployId: deploy.id, event, key: `${deploy.id}:${event}:${stage}` });
        const old = before.get(deploy.id);

        if (!old) {
            // Found already rolling or rolled while the board was down: its start was not seen.
            if (deploy.missed || deploy.releases.every((r) => r.atBoot)) {
                continue;
            }
            if (!inHistory.has(deploy.id) && !deploy.pipeline) {
                play("started");
            }
            play("rolling");
            if (deploy.state === "done") {
                play("done");
            } else if (deploy.state === "stuck") {
                play("failed");
            }
            continue;
        }

        if (deploy.state === old.state && stage === stageOf(old)) {
            continue;
        }
        if (deploy.state === "done" && old.state !== "done") {
            play("done");
        } else if (deploy.state === "done" && stage !== stageOf(old)) {
            // Another release of the same deploy rolled and ended between two snapshots.
            play("rolling");
            play("done");
        } else if (deploy.state === "stuck" && old.state !== "stuck") {
            play("failed");
        } else if ((deploy.state === "updating" || deploy.state === "noProgress") && old.state === "done") {
            play("rolling");
        }
    }
    return out;
}

/**
 * Keep only the sounds not played yet, and remember them.
 * @param {object[]} events Result of soundEvents().
 * @param {Set<string>} played Keys already played (changed in place).
 * @returns {object[]} The new ones.
 */
export function freshEvents(events, played) {
    const fresh = [];
    for (const e of events) {
        if (!played.has(e.key)) {
            played.add(e.key);
            fresh.push(e);
        }
    }
    return fresh;
}
