const mineflayer = require("mineflayer");
const bedrock = require("bedrock-protocol");
const active = new Map();

class BotManager {
  constructor(io, db) { this.io = io; this.db = db; this.maintenance = false; }
  count() { return active.size; }
  snapshot() { return [...active.entries()].map(([id, s]) => ({ profileId: Number(id), ...this.publicState(s) })); }
  publicState(s) { return { status: s.status, startedAt: s.startedAt, connectedAt: s.connectedAt, reconnects: s.reconnects, lastError: s.lastError, edition: s.profile.edition, players: s.players || [] }; }
  getStatus(id) { const s = active.get(String(id)); return s ? this.publicState(s) : { status: "offline", reconnects: 0 }; }
  emitState(id) { this.io.emit("bot-state", { profileId: Number(id), ...this.getStatus(id) }); }
  log(id, level, message) {
    const safe = String(message).slice(0, 500);
    this.db.run("INSERT INTO logs(profile_id,level,message,created_at) VALUES(?,?,?,?)", [id, level, safe, new Date().toISOString()], () => {});
    this.io.emit("bot-log", { profileId: Number(id), level, message: safe, createdAt: new Date().toISOString() });
  }
  async connect(profile, userId) {
    if (this.maintenance) throw new Error("Dashboard maintenance mode is enabled.");
    const id = String(profile.id);
    this.stop(id, "Replacing connection", false);
    const state = { profile, userId, status: "connecting", startedAt: new Date().toISOString(), connectedAt: null, reconnects: 0, lastError: null, bot: null, players: [], timer: null, followTarget: null, pvpTarget: null, protectTarget: null, autoEat: profile.settings?.autoEat === true, stopping: false };
    active.set(id, state); this.emitState(id);
    this.log(id, "info", `Connecting ${profile.edition} bot to ${profile.host}:${profile.port}`);
    this.openConnection(id, state);
  }
  openConnection(id, s) {
    if (!active.has(id) || s.stopping || this.maintenance) return;
    try {
      if (s.profile.edition === "java") {
        const bot = mineflayer.createBot({
          host: s.profile.host, port: Number(s.profile.port), username: s.profile.username,
          auth: "offline",
          hideErrors: false,
          checkTimeoutInterval: 30_000,
        });
        s.bot = bot;
        bot.once("login", () => { s.status = "online"; s.connectedAt = new Date().toISOString(); s.lastError = null; this.log(id, "info", "Java bot logged in."); this.emitState(id); });
        bot.on("spawn", () => { s.status = "online"; this.log(id, "info", "Bot spawned in world."); this.emitState(id); });
        bot.on("end", reason => this.disconnected(id, s, String(reason || "Connection ended")));
        bot.on("kicked", reason => { s.lastError = typeof reason === "string" ? reason : JSON.stringify(reason); this.log(id, "warn", `Kicked: ${s.lastError}`); });
        bot.on("error", err => { s.lastError = err.message; this.log(id, "error", err.message); });
        bot.on("message", jsonMsg => this.log(id, "chat", jsonMsg.toString().slice(0, 450)));
        bot.on("playerJoined", player => { this.refreshPlayers(s); this.log(id, "info", `${player.username} joined`); });
        bot.on("playerLeft", player => { this.refreshPlayers(s); this.log(id, "info", `${player.username} left`); });
        bot.on("health", () => { if (s.autoEat) this.tryEat(id, s); });
        bot.on("physicsTick", () => this.tickActions(id, s));
        bot.on("windowOpen", win => this.log(id, "info", `Inventory/window opened: ${win.title || "unknown"}`));
      } else {
        // Basic Bedrock protocol connection. Online-mode/device-code auth may require additional setup.
        const client = bedrock.createClient({ host: s.profile.host, port: Number(s.profile.port), username: s.profile.username, offline: true, version: "1.21.60", skipPing: false });
        s.bot = client;
        client.on("join", () => { s.status = "online"; s.connectedAt = new Date().toISOString(); this.log(id, "info", "Bedrock protocol connected."); this.emitState(id); });
        client.on("spawn", () => { s.status = "online"; this.emitState(id); });
        client.on("disconnect", packet => this.disconnected(id, s, `Bedrock disconnected: ${JSON.stringify(packet).slice(0,200)}`));
        client.on("close", () => this.disconnected(id, s, "Bedrock connection closed"));
        client.on("error", err => { s.lastError = err.message; this.log(id, "error", err.message); });
        this.log(id, "warn", "Bedrock adapter is connection/status only; player controls and inventory are not implemented.");
      }
    } catch (err) { this.disconnected(id, s, err.message); }
  }
  disconnected(id, s, reason) {
    if (!active.has(id) || s.stopping) return;
    s.status = "offline"; s.lastError = reason; s.bot = null;
    this.log(id, "warn", `Disconnected: ${reason}`); this.emitState(id);
    if (s.profile.settings?.autoReconnect !== false && !this.maintenance) {
      const delay = Math.max(5, Math.min(300, Number(s.profile.settings?.retrySeconds) || 15));
      s.reconnects++;
      s.timer = setTimeout(() => { if (active.get(id) === s && !s.stopping && !this.maintenance) { this.log(id, "info", "Attempting reconnect…"); this.openConnection(id, s); } }, delay * 1000);
    }
  }
  stop(id, reason = "Stopped", remove = true) {
    id = String(id); const s = active.get(id); if (!s) return;
    s.stopping = true; if (s.timer) clearTimeout(s.timer);
    try { if (s.bot?.quit) s.bot.quit(reason); else if (s.bot?.close) s.bot.close(); else if (s.bot?.end) s.bot.end(); } catch {}
    s.status = "offline"; s.bot = null;
    if (remove) active.delete(id);
    this.log(id, "info", reason); this.emitState(id);
  }
  sendChat(id, message) {
    const s = active.get(String(id));
    if (!s || s.status !== "online" || !s.bot) throw new Error("Bot is not online.");
    if (s.profile.edition !== "java") throw new Error("Chat/commands are not implemented for Bedrock in this starter.");
    s.bot.chat(message);
    this.log(id, "command", `Sent chat: ${message}`);
  }
  refreshPlayers(s) {
    if (!s.bot?.players) return;
    s.players = Object.values(s.bot.players).map(p => ({ username: p.username, ping: p.ping ?? null, gamemode: p.gamemode ?? null })).filter(p => p.username);
  }
  getPlayers(id) {
    const s = active.get(String(id));
    if (!s) return { supported: false, players: [], message: "Bot is offline." };
    if (s.profile.edition !== "java") return { supported: false, players: [], message: "Player listing is not implemented for Bedrock in this starter." };
    this.refreshPlayers(s);
    return { supported: true, players: s.players, count: s.players.length };
  }
  getInventory(id) {
    const s = active.get(String(id));
    if (!s || s.profile.edition !== "java" || !s.bot?.inventory) return { supported: false, items: [], message: "Java bot must be online." };
    const items = s.bot.inventory.items().map(i => ({ name: i.name, displayName: i.displayName, count: i.count, slot: i.slot }));
    return { supported: true, health: s.bot.health, food: s.bot.food, items };
  }
  playerAction(id, action, player) {
    const s = active.get(String(id));
    if (!s || s.status !== "online" || s.profile.edition !== "java" || !s.bot) throw new Error("This action requires an online Java bot.");
    if (["follow", "pvp", "protect"].includes(action) && !/^[A-Za-z0-9_]{1,16}$/.test(player)) throw new Error("Select a valid player username.");
    if (action === "follow") { s.followTarget = player; this.log(id, "action", `Following ${player}`); }
    if (action === "stop-follow") { s.followTarget = null; s.bot.clearControlStates(); this.log(id, "action", "Stopped following"); }
    if (action === "pvp") { s.pvpTarget = player; this.log(id, "action", `PvP target set to ${player} (basic attack loop)`); }
    if (action === "stop-pvp") { s.pvpTarget = null; s.bot.clearControlStates(); this.log(id, "action", "Stopped PvP"); }
    if (action === "protect") { s.protectTarget = player; this.log(id, "action", `Protect target set to ${player}`); }
    if (action === "stop-protect") { s.protectTarget = null; s.pvpTarget = null; s.bot.clearControlStates(); this.log(id, "action", "Stopped protect mode"); }
    if (action === "eat") this.tryEat(id, s, true);
  }
  tickActions(id, s) {
    if (!s.bot || s.status !== "online") return;
    const targetName = s.followTarget || s.protectTarget;
    if (targetName) {
      const p = s.bot.players?.[targetName]?.entity;
      if (p) {
        const d = s.bot.entity.position.distanceTo(p.position);
        if (d > 3) { try { s.bot.lookAt(p.position.offset(0, 1, 0), true); s.bot.setControlState("forward", true); } catch {} }
        else s.bot.setControlState("forward", false);
      }
    }
    if (s.pvpTarget || s.protectTarget) {
      const target = s.pvpTarget || s.protectTarget;
      const p = s.bot.players?.[target]?.entity;
      if (p && s.bot.entity.position.distanceTo(p.position) < 4) {
        try { s.bot.lookAt(p.position.offset(0, 1, 0), true); s.bot.attack(p); } catch {}
      }
    }
  }
  tryEat(id, s, manual = false) {
    const bot = s.bot;
    if (!bot || s.profile.edition !== "java" || bot.food >= 20) return;
    const food = bot.inventory.items().find(i => /bread|cooked|apple|carrot|potato|beef|porkchop|chicken|mutton|rabbit|salmon|cod|melon_slice|cookie|baked_potato/.test(i.name));
    if (!food) { if (manual) this.log(id, "warn", "No supported food found in inventory."); return; }
    bot.equip(food, "hand").then(() => bot.consume()).then(() => this.log(id, "action", `Ate ${food.name}`)).catch(e => this.log(id, "warn", `Eat failed: ${e.message}`));
  }
  setMaintenance(enabled) {
    this.maintenance = enabled;
    if (enabled) for (const id of [...active.keys()]) this.stop(id, "Dashboard maintenance mode", true);
    this.io.emit("maintenance", { enabled });
  }
}
module.exports = { BotManager };
