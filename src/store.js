const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new sqlite3.Database(path.join(dataDir, "app.sqlite"));
function run(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); }));
}
function initDb() {
  return new Promise((resolve, reject) => db.serialize(() => {
    db.run("PRAGMA journal_mode=WAL");
    db.run(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', created_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS profiles(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, edition TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
    db.run(`CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_logs_profile ON logs(profile_id)");
    db.get("SELECT 1", err => err ? reject(err) : resolve());
  }));
}
module.exports = { db, initDb, run };
