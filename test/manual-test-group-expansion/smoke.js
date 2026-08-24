// Smoke E2E: provisiona via socket.io e valida os endpoints publicos da expansao de grupo
const { io } = require("socket.io-client");
const BASE = "http://localhost:3005";
const socket = io(BASE);

function emit(event, ...args) {
    return new Promise((resolve, reject) => {
        socket.emit(event, ...args, (res) => {
            if (res && res.ok === false) {
                reject(new Error(event + " falhou: " + (res.msg?.key || res.msg)));
            } else {
                resolve(res);
            }
        });
    });
}

function assert(cond, msg) {
    if (!cond) {
        throw new Error("ASSERT: " + msg);
    }
    console.log("  OK:", msg);
}

(async () => {
    await new Promise((r) => socket.on("connect", r));
    console.log("1. conectado");

    await emit("setup", "admin", "SmokeTest!2026");
    await emit("login", { username: "admin", password: "SmokeTest!2026", token: "" });
    console.log("2. admin criado e logado");

    const base = { interval: 20, retryInterval: 60, resendInterval: 0, maxretries: 0, timeout: 16, accepted_statuscodes: ["200-299"], conditions: [], notificationIDList: {} };
    const g = await emit("add", { ...base, type: "group", name: "Grupo Situator" });
    const c1 = await emit("add", { ...base, type: "http", name: "API", url: "http://127.0.0.1:9/", parent: g.monitorID });
    const c2 = await emit("add", { ...base, type: "http", name: "Painel", url: "http://painel.secreto.example.com/", parent: g.monitorID });
    const c3 = await emit("add", { ...base, type: "http", name: "Worker pausado", url: "http://127.0.0.1:9/", parent: g.monitorID });
    await emit("pauseMonitor", c3.monitorID);
    console.log("3. grupo", g.monitorID, "+ 3 filhos (1 pausado)");

    await emit("addStatusPage", "Situator", "situator");
    const sp = await emit("getStatusPage", "situator");
    await emit("saveStatusPage", "situator", sp.config, "/icon.svg", [
        { name: "Services", weight: 1, monitorList: [{ id: g.monitorID, showChildren: true }] },
    ]);
    console.log("4. status page salva com showChildren");

    // --- API publica da pagina ---
    const pub = await (await fetch(BASE + "/api/status-page/situator")).json();
    const grupo = pub.publicGroupList[0].monitorList[0];
    assert(grupo.showChildren === true, "showChildren round-tripa no JSON publico");
    assert(Array.isArray(grupo.childrenList), "childrenList presente");
    const nomes = grupo.childrenList.map((c) => c.name).sort();
    assert(JSON.stringify(nomes) === JSON.stringify(["API", "Painel"]), "filhos ativos listados, pausado fora: " + nomes);
    const corpo = JSON.stringify(pub).replace(/\\/g, "");
    assert(!corpo.includes("painel.secreto"), "URL do filho nao vaza no corpo (normalizado)");

    // --- endpoint de heartbeat ---
    const hb = await (await fetch(BASE + "/api/status-page/heartbeat/situator")).json();
    const ids = Object.keys(hb.heartbeatList).map(Number);
    assert(ids.includes(c1.monitorID) && ids.includes(c2.monitorID), "heartbeatList tem os filhos ativos");
    assert(!ids.includes(c3.monitorID), "filho pausado fora do heartbeatList");
    assert(hb.uptimeList[c1.monitorID + "_24"] !== undefined, "uptimeList tem o filho");

    // --- filho novo aparece SEM editar a pagina ---
    const c4 = await emit("add", { ...base, type: "http", name: "Zerado agora", url: "http://127.0.0.1:9/", parent: g.monitorID });
    // o endpoint publico tem cache de 5 min; bust por query para ver o dado fresco
    const pub2 = await (await fetch(BASE + "/api/status-page/situator?bust=1")).json();
    const nomes2 = pub2.publicGroupList[0].monitorList[0].childrenList.map((c) => c.name);
    assert(nomes2.includes("Zerado agora"), "monitor novo no grupo aparece sem editar a pagina (id " + c4.monitorID + ")");

    // --- flag desligada = formato atual ---
    await emit("saveStatusPage", "situator", sp.config, "/icon.svg", [
        { name: "Services", weight: 1, monitorList: [{ id: g.monitorID, showChildren: false }] },
    ]);
    const pub3 = await (await fetch(BASE + "/api/status-page/situator?bust=2")).json();
    const grupo3 = pub3.publicGroupList[0].monitorList[0];
    assert(grupo3.showChildren === false && !("childrenList" in grupo3), "flag desligada volta ao formato atual");

    console.log("\nSMOKE TEST: TUDO PASSOU");
    process.exit(0);
})().catch((e) => {
    console.error("\nSMOKE FALHOU:", e.message);
    process.exit(1);
});
