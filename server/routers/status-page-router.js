let express = require("express");
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const StatusPage = require("../model/status_page");
const { allowDevAllOrigin, sendHttpError } = require("../util-server");
const { R } = require("redbean-node");
const { badgeConstants, UP } = require("../../src/util");
const { sanitizeHeartbeatMessage } = require("../util/sanitize-heartbeat-message");
const { makeBadge } = require("badge-maker");
const { UptimeCalculator } = require("../uptime-calculator");

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();

router.get("/status/:slug", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status/:slug/rss", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageRSSResponse(response, slug, request);
});

router.get("/status", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status-page", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

// Status page config, incident, monitor list
router.get("/api/status-page/:slug", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Status Page Not Found");
            return null;
        }

        let statusPageData = await StatusPage.getStatusPageData(statusPage);

        // Response
        response.json(statusPageData);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status Page Polling Data
// Can fetch only if published
router.get("/api/status-page/heartbeat/:slug", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let heartbeatList = {};
        let uptimeList = {};

        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        // Include the direct children of group monitors that have "show children" enabled on this page
        const expandedGroupIDs = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`, monitor
            WHERE monitor_group.group_id = \`group\`.id
            AND monitor.id = monitor_group.monitor_id
            AND \`group\`.public = 1
            AND \`group\`.status_page_id = ?
            AND monitor_group.show_children = 1
            AND monitor.type = 'group'
        `,
            [statusPageID]
        );

        for (const groupMonitorID of expandedGroupIDs) {
            const childIDs = await R.getCol("SELECT id FROM monitor WHERE parent = ? AND active = 1", [groupMonitorID]);
            monitorIDList.push(...childIDs);
        }

        // A child may also be listed individually on the same page
        monitorIDList = [...new Set(monitorIDList)];

        for (let monitorID of monitorIDList) {
            let list = await R.getAll(
                `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 100
            `,
                [monitorID]
            );

            list = R.convertToBeans("heartbeat", list);
            heartbeatList[monitorID] = list.reverse().map((row) => row.toPublicJSON());

            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
            uptimeList[`${monitorID}_24`] = uptimeCalculator.get24Hour().uptime;
        }

        response.json({
            heartbeatList,
            uptimeList,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status page's manifest.json
router.get("/api/status-page/:slug/manifest.json", cache("1440 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Response
        response.json({
            name: statusPage.title,
            start_url: "/status/" + statusPage.slug,
            display: "standalone",
            icons: [
                {
                    src: statusPage.icon,
                    sizes: "128x128",
                    type: "image/png",
                },
            ],
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/status-page/:slug/incident-history", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        if (!statusPageID) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        const cursor = request.query.cursor || null;
        const result = await StatusPage.getIncidentHistory(statusPageID, cursor, true);
        response.json({
            ok: true,
            ...result,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// overall status-page status badge
router.get("/api/status-page/:slug/badge", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    const statusPageID = await StatusPage.slugToID(slug);
    const {
        label,
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        partialColor = "#F6BE00",
        maintenanceColor = "#808080",
        style = badgeConstants.defaultStyle,
    } = request.query;

    try {
        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        let hasUp = false;
        let hasDown = false;
        let hasMaintenance = false;

        for (let monitorID of monitorIDList) {
            // retrieve the latest heartbeat
            let beat = await R.getAll(
                `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 1
            `,
                [monitorID]
            );

            // to be sure, when corresponding monitor not found
            if (beat.length === 0) {
                continue;
            }
            // handle status of beat
            if (beat[0].status === 3) {
                hasMaintenance = true;
            } else if (beat[0].status === 2) {
                // ignored
            } else if (beat[0].status === 1) {
                hasUp = true;
            } else {
                hasDown = true;
            }
        }

        const badgeValues = { style };

        if (!hasUp && !hasDown && !hasMaintenance) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            if (hasMaintenance) {
                badgeValues.label = label ? label : "";
                badgeValues.color = maintenanceColor;
                badgeValues.message = "Maintenance";
            } else if (hasUp && !hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = upColor;
                badgeValues.message = "Up";
            } else if (hasUp && hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = partialColor;
                badgeValues.message = "Degraded";
            } else {
                badgeValues.label = label ? label : "";
                badgeValues.color = downColor;
                badgeValues.message = "Down";
            }
        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

/**
 * How many heartbeats the wall panel gets per monitor.
 * The design's highlighted card draws the full history; the list slices the tail of this same set.
 */
const TV_BEAT_LIMIT = 45;

/**
 * Resolve which monitors the wall panel shows for a status page.
 *
 * Starts from the page's own curation (the monitor_group rows of its public sections) and applies
 * the group rule: a group monitor with "show children" enabled is replaced by its children. Keeping
 * both would show the same outage twice — a child going down also takes its parent group down —
 * and would count it twice in the "N of T" headline.
 * @param {number} statusPageID ID of the status page.
 * @returns {Promise<number[]>} Monitor IDs to render, without duplicates.
 */
async function tvMonitorIDList(statusPageID) {
    const listed = await R.getCol(
        `
        SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
        WHERE monitor_group.group_id = \`group\`.id
        AND public = 1
        AND \`group\`.status_page_id = ?
    `,
        [statusPageID]
    );

    const expandedGroupIDs = await R.getCol(
        `
        SELECT monitor_group.monitor_id FROM monitor_group, \`group\`, monitor
        WHERE monitor_group.group_id = \`group\`.id
        AND monitor.id = monitor_group.monitor_id
        AND \`group\`.public = 1
        AND \`group\`.status_page_id = ?
        AND monitor_group.show_children = 1
        AND monitor.type = 'group'
    `,
        [statusPageID]
    );

    const expanded = new Set(expandedGroupIDs.map(Number));
    const result = [];

    for (const groupMonitorID of expandedGroupIDs) {
        const childIDs = await R.getCol("SELECT id FROM monitor WHERE parent = ? AND active = 1", [groupMonitorID]);
        result.push(...childIDs);
    }

    // The expanded group itself drops out: its children already carry the same outage, with detail.
    for (const monitorID of listed) {
        if (!expanded.has(Number(monitorID))) {
            result.push(monitorID);
        }
    }

    return [...new Set(result.map(Number))];
}

// Wall panel (TV) feed.
// One payload on purpose: the monitor list and the heartbeats travel together under the same cache.
// Composing the panel from the two existing endpoints would put a 5-minute cache next to a 1-minute
// one, and a freshly added monitor would have beats but no row — disappearing from the screen with
// no error at all.
router.get("/api/status-page/:slug/tv", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        const slug = request.params.slug.toLowerCase();
        const statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        // This endpoint publishes more than the status page does (the error label), so unpublishing
        // has to close it. Missing and unpublished answer the same way on purpose.
        if (!statusPage || !statusPage.published) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        const monitorIDList = await tvMonitorIDList(statusPage.id);
        const monitors = [];

        for (const monitorID of monitorIDList) {
            const monitor = await R.getRow("SELECT id, name, type FROM monitor WHERE id = ?", [monitorID]);

            if (!monitor) {
                continue;
            }

            // `msg` is read here and never forwarded: only the sanitized label leaves this function.
            const rows = await R.getAll(
                `
                    SELECT status, time, msg FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT ?
            `,
                [monitorID, TV_BEAT_LIMIT]
            );

            const latest = rows[0];
            const status = latest ? Number(latest.status) : null;

            const entry = {
                id: Number(monitor.id),
                name: monitor.name,
                type: monitor.type,
                status,
                beats: rows
                    .slice()
                    .reverse()
                    .map((row) => ({
                        status: Number(row.status),
                        time: row.time,
                    })),
            };

            // A monitor that is fine has nothing to explain, and its success message ("200 - OK")
            // is not something a public payload needs to carry.
            if (latest && status !== UP) {
                entry.errorLabel = sanitizeHeartbeatMessage(latest.msg);
            }

            monitors.push(entry);
        }

        response.json({
            title: statusPage.title,

            // O mesmo "Intervalo de atualização" que o administrador configura na status page. No
            // painel ele rege o RECARREGAMENTO da tela, não a leitura da situação — que tem ritmo
            // próprio e curto. O fallback é o default do app para a coluna (página antiga, gravada
            // antes de ela existir, vem nula).
            refreshInterval: Number(statusPage.autoRefreshInterval) || 300,
            monitors,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

module.exports = router;
