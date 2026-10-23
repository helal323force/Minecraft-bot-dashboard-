require("dotenv").config();
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");
const { initDb, db } = require("./store");
const { BotManager } = require("./bot-manager");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const SQLiteStore = SQLiteStoreFactory(session);
const sessionMiddleware = session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 1000 * 60 * 60 * 24 },
});
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false }));

const manager = new BotManager(io, db);
io.engine.use(sessionMiddleware);
io.on("connection", (socket) => {
  if (!socket.request.session?.userId) return socket.disconnect(true);
  socket.emit("snapshot", manager.snapshot());
});

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function auth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: "Please log in." });
  db.get("SELECT id, username, role FROM users WHERE id = ?", [req.session.userId], (err, user) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: "Session expired." });
    req.user = user; next();
  });
}
function admin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin role required." });
  next();
}
function safeProfile(row) {
  if (!row) return row;
  const settings = JSON.parse(row.settings || "{}");
  return { ...row, settings };
}
function validateProfile(body) {
  const edition = body.edition === "bedrock" ? "bedrock" : body.edition === "java" ? "java" : null;
  const host = String(body.host || "").trim();
  const port = Number(body.port);
  const username = String(body.username || "").trim();
  if (!edition) throw new Error("Edition must be Java or Bedrock.");
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) throw new Error("Enter a valid hostname or IP.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1–65535.");
  if (!/^[A-Za-z0-9_ .-]{1,32}$/.test(username)) throw new Error("Username must be 1–32 safe characters.");
  return { name: String(body.name || host).trim().slice(0, 60), edition, host, port, username,
    settings: { autoReconnect: body.autoReconnect !== false, retrySeconds: Math.max(5, Math.min(300, Number(body.retrySeconds) || 15)), autoEat: body.autoEat === true } };
}
function getProfileForUser(id, user, callback) {
  db.get("SELECT * FROM profiles WHERE id = ? AND user_id = ?", [id, user.id], (err, row) => callback(err, row && safeProfile(row)));
}

app.get("/health", (_req, res) => res.json({ ok: true, uptimeSeconds: Math.floor(process.uptime()), bots: manager.count() }));
app.get("/api/me", auth, (req, res) => res.json({ user: req.user, registrationAllowed: process.env.ALLOW_REGISTRATION !== "false" }));
app.post("/api/auth/register", (req, res, next) => {
  if (process.env.ALLOW_REGISTRATION === "false") return res.status(403).json({ error: "Registration is disabled." });
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username) || password.length < 10 || password.length > 128) {
    return res.status(400).json({ error: "Username must be 3–24 characters; password must be 10–128 characters." });
  }
  db.get("SELECT COUNT(*) AS n FROM users", (err, count) => {
    if (err) return next(err);
    const role = count.n === 0 ? "admin" : "viewer";
    bcrypt.hash(password, 12).then(hash => {
      db.run("INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)", [username, hash, role, new Date().toISOString()], function (e) {
        if (e) return res.status(409).json({ error: "Username already exists." });
        req.session.userId = this.lastID;
        res.json({ user: { id: this.lastID, username, role } });
      });
    }).catch(next);
  });
});
app.post("/api/auth/login", (req, res, next) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err) return next(err);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "Invalid username or password." });
    req.session.regenerate((e) => {
      if (e) return next(e);
      req.session.userId = user.id;
      res.json({ user: { id: user.id, username: user.username, role: user.role } });
    });
  });
});
app.post("/api/auth/logout", auth, (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get("/api/profiles", auth, (req, res, next) => {
  db.all("SELECT * FROM profiles WHERE user_id = ? ORDER BY id DESC", [req.user.id], (err, rows) => {
    if (err) return next(err);
    res.json(rows.map(safeProfile).map(p => ({ ...p, runtime: manager.getStatus(p.id) })));
  });
});
app.post("/api/profiles", auth, (req, res, next) => {
  let p; try { p = validateProfile(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  db.run("INSERT INTO profiles(user_id,name,edition,host,port,username,settings,created_at) VALUES(?,?,?,?,?,?,?,?)",
    [req.user.id, p.name, p.edition, p.host, p.port, p.username, JSON.stringify(p.settings), new Date().toISOString()],
    function (err) { if (err) return next(err); res.json({ id: this.lastID, ...p, runtime: { status: "offline" } }); });
});
app.put("/api/profiles/:id", auth, (req, res, next) => {
  let p; try { p = validateProfile(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  getProfileForUser(req.params.id, req.user, (err, old) => {
    if (err) return next(err); if (!old) return res.status(404).json({ error: "Profile not found." });
    manager.stop(old.id, "Profile updated");
    db.run("UPDATE profiles SET name=?,edition=?,host=?,port=?,username=?,settings=? WHERE id=? AND user_id=?",
      [p.name, p.edition, p.host, p.port, p.username, JSON.stringify(p.settings), old.id, req.user.id],
      e => e ? next(e) : res.json({ id: old.id, ...p }));
  });
});
app.delete("/api/profiles/:id", auth, (req, res, next) => {
  getProfileForUser(req.params.id, req.user, (err, p) => {
    if (err) return next(err); if (!p) return res.status(404).json({ error: "Profile not found." });
    manager.stop(p.id, "Profile deleted");
    db.run("DELETE FROM profiles WHERE id=? AND user_id=?", [p.id, req.user.id], e => e ? next(e) : res.json({ ok: true }));
  });
});
app.post("/api/profiles/:id/connect", auth, (req, res, next) => {
  getProfileForUser(req.params.id, req.user, async (err, p) => {
    if (err) return next(err); if (!p) return res.status(404).json({ error: "Profile not found." });
    try { await manager.connect(p, req.user.id); res.json({ ok: true, status: manager.getStatus(p.id) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
});
app.post("/api/profiles/:id/disconnect", auth, (req, res, next) => {
  getProfileForUser(req.params.id, req.user, (err, p) => {
    if (err) return next(err); if (!p) return res.status(404).json({ error: "Profile not found." });
    manager.stop(p.id, "Stopped by dashboard"); res.json({ ok: true });
  });
});
app.post("/api/profiles/:id/chat", auth, (req, res, next) => {
  getProfileForUser(req.params.id, req.user, (err, p) => {
    if (err) return next(err); if (!p) return res.status(404).json({ error: "Profile not found." });
    const message = String(req.body.message || "").trim();
    if (!message || message.length > 256 || /[\r\n]/.test(message)) return res.status(400).json({ error: "Message must be 1–256 characters on one line." });
    if (message.startsWith("/") && req.user.role !== "admin") return res.status(403).json({ error: "Only admins may send slash commands." });
    try { manager.sendChat(p.id, message); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
  });
});
app.get("/api/profiles/:id/players", auth, (req, res, next) => {
  getProfileForUser(req.params.id, req.user, (err, p) => {
    if (err) return next(err); if (!p) return res.status(404).json({ error: "Profile not found." });
    res.json(manager.getPlayers(p.id));
  });
});
app.get("/api/profiles/:id/inventory", auth, (req, res, next) => {
  getProfileForUser(req.params.id, req.user, (err, p) => {
    if (err) return next(err); if (!p) return res.status(404).json({ error: "Profile not found." });
    res.json(manager.getInventory(p.id));
  });
});
app.post("/api/profiles/:id/action", auth, (req, res, next) => {
  getProfileForUser(req.params.id, req.user, (err, p) => {
    if (err) return next(err); if (!p) return res.status(404).json({ error: "Profile not found." });
    const allowed = new Set(["follow", "stop-follow", "pvp", "stop-pvp", "protect", "stop-protect", "eat"]);
    const action = String(req.body.action || "");
    if (!allowed.has(action)) return res.status(400).json({ error: "Unknown action." });
    try { manager.playerAction(p.id, action, String(req.body.player || "")); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
});
app.get("/api/logs", auth, (req, res, next) => {
  db.all("SELECT l.* FROM logs l JOIN profiles p ON p.id=l.profile_id WHERE p.user_id=? ORDER BY l.id DESC LIMIT 500", [req.user.id], (err, rows) => err ? next(err) : res.json(rows.reverse()));
});
app.get("/api/logs/export", auth, (req, res, next) => {
  db.all("SELECT l.* FROM logs l JOIN profiles p ON p.id=l.profile_id WHERE p.user_id=? ORDER BY l.id DESC LIMIT 5000", [req.user.id], (err, rows) => {
    if (err) return next(err);
    res.setHeader("Content-Disposition", 'attachment; filename="minecraft-bot-logs.json"');
    res.json(rows);
  });
});
app.get("/api/backup", auth, (req, res, next) => {
  db.all("SELECT name,edition,host,port,username,settings,created_at FROM profiles WHERE user_id=?", [req.user.id], (err, rows) => {
    if (err) return next(err);
    res.setHeader("Content-Disposition", 'attachment; filename="minecraft-dashboard-backup.json"');
    res.json({ version: 1, exportedAt: new Date().toISOString(), profiles: rows.map(safeProfile) });
  });
});
app.post("/api/maintenance", auth, admin, (req, res) => {
  manager.setMaintenance(Boolean(req.body.enabled));
  res.json({ maintenance: manager.maintenance });
});
app.get("/api/admin/users", auth, admin, (_req, res, next) => db.all("SELECT id,username,role,created_at FROM users ORDER BY id", (e, rows) => e ? next(e) : res.json(rows)));
app.patch("/api/admin/users/:id/role", auth, admin, (req, res, next) => {
  const role = req.body.role;
  if (!["admin", "viewer"].includes(role)) return res.status(400).json({ error: "Role must be admin or viewer." });
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You cannot change your own role." });
  db.run("UPDATE users SET role=? WHERE id=?", [role, req.params.id], function (e) {
    if (e) return next(e); if (!this.changes) return res.status(404).json({ error: "User not found." });
    res.json({ ok: true });
  });
});
app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found." }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

initDb().then(() => {
  server.listen(PORT, "0.0.0.0", () => console.log(`Dashboard listening on port ${PORT}`));
}).catch(err => { console.error("Database init failed", err); process.exit(1); });
