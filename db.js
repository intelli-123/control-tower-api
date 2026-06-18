/**
 * db.js — 1-day persistence for cumulative data (SQLite via node-sqlite3-wasm).
 *
 * Real SQLite, but WASM-based so it needs no native build toolchain. Stores
 * executions and periodic per-agent cumulative snapshots, pruned to 24h.
 * All calls are wrapped so a DB problem can never crash the API.
 */
const path = require('path');
const fs   = require('fs');

let Database = null;
try { ({ Database } = require('node-sqlite3-wasm')); }
catch { console.warn('[db] node-sqlite3-wasm not installed — persistence disabled'); }

const DAY_MS = 24 * 60 * 60 * 1000;
let db = null;

function openAndMigrate(dbPath) {
  db = new Database(dbPath);
  db.run(`CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY, agent_id TEXT, task TEXT, started_at TEXT, completed_at TEXT,
    latency_ms INTEGER, tokens INTEGER, cost REAL, ts INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_snapshots (
    agent_id TEXT, ts INTEGER, tokens INTEGER, cost REAL, calls INTEGER,
    avg_latency_ms INTEGER, status TEXT)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_exec_agent ON executions(agent_id, ts)');
  db.run('CREATE INDEX IF NOT EXISTS idx_snap_agent ON agent_snapshots(agent_id, ts)');
  // ── Admin / RBAC / BU tables ──────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE, pass_hash TEXT, pass_salt TEXT,
    role TEXT, display_name TEXT, department TEXT, created_at TEXT, last_login TEXT)`);
  try { db.run('ALTER TABLE users ADD COLUMN department TEXT'); } catch { /* already exists */ }
  db.run(`CREATE TABLE IF NOT EXISTS agent_meta (
    agent_id TEXT PRIMARY KEY, name TEXT, framework TEXT, model TEXT,
    department TEXT, owner TEXT, notes TEXT, updated_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS business_units (
    bu_id TEXT PRIMARY KEY, name TEXT, budget REAL, owner TEXT, created_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_bu_map (
    agent_id TEXT, bu_id TEXT, PRIMARY KEY(agent_id, bu_id))`);
  return db;
}

function init(dbPath = path.join(__dirname, 'control-tower.db')) {
  if (!Database) return null;
  try {
    openAndMigrate(dbPath);
    console.log('[db] SQLite (wasm) persistence ready →', dbPath);
    return db;
  } catch (e) {
    // node-sqlite3-wasm locks the DB with a `<db>.lock` *directory*. A hard kill
    // (e.g. closing the launcher window) leaves it behind, which then blocks every
    // future start with "database is locked". Clear a stale lock and retry once.
    // (Assumes one tower per DB — run separate instances with their own CT_DB_PATH.)
    if (/lock/i.test(e.message || '')) {
      try {
        fs.rmSync(dbPath + '.lock', { recursive: true, force: true });
        openAndMigrate(dbPath);
        console.warn('[db] cleared a stale lock from a previous unclean shutdown — persistence ready →', dbPath);
        return db;
      } catch (e2) {
        console.warn('[db] still locked after clearing stale lock (another instance running on this DB?):', e2.message);
        db = null; return null;
      }
    }
    console.warn('[db] init failed, persistence disabled:', e.message); db = null; return null;
  }
}

function recordExecution(e) {
  if (!db) return;
  try {
    db.run(`INSERT OR REPLACE INTO executions
      (id,agent_id,task,started_at,completed_at,latency_ms,tokens,cost,ts)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [e.id, e.agent_id, e.task || null, e.started_at, e.completed_at,
       e.latency_ms | 0, e.tokens | 0, e.cost || 0, Date.parse(e.completed_at) || Date.now()]);
  } catch { /* ignore */ }
}

function snapshotAgents(agents, tsMs) {
  if (!db) return;
  const ts = tsMs || Date.now();
  try {
    for (const a of agents) {
      db.run(`INSERT INTO agent_snapshots(agent_id,ts,tokens,cost,calls,avg_latency_ms,status)
        VALUES (?,?,?,?,?,?,?)`,
        [a.agent_id, ts, a.totals?.tokens || 0, a.totals?.cost || 0,
         a.totals?.calls || 0, a.avg_latency_ms || 0, a.status || 'unknown']);
    }
  } catch { /* ignore */ }
}

function prune(maxAgeMs = DAY_MS, nowMs) {
  if (!db) return;
  const cutoff = (nowMs || Date.now()) - maxAgeMs;
  try {
    db.run('DELETE FROM executions WHERE ts < ?', [cutoff]);
    db.run('DELETE FROM agent_snapshots WHERE ts < ?', [cutoff]);
  } catch { /* ignore */ }
}

/** Executions from the last `maxAgeMs` — used to rehydrate memory on startup. */
function recentExecutions(maxAgeMs = DAY_MS, nowMs) {
  if (!db) return [];
  const cutoff = (nowMs || Date.now()) - maxAgeMs;
  try {
    return db.all('SELECT id,agent_id,task,started_at,completed_at,latency_ms,tokens,cost FROM executions WHERE ts >= ? ORDER BY ts DESC', [cutoff]);
  } catch { return []; }
}

/** Per-agent token/cost totals from persisted executions (last `maxAgeMs`). */
function executionTotals(maxAgeMs = DAY_MS, nowMs) {
  if (!db) return [];
  const cutoff = (nowMs || Date.now()) - maxAgeMs;
  try {
    return db.all('SELECT agent_id, SUM(tokens) AS tokens, SUM(cost) AS cost, COUNT(*) AS n FROM executions WHERE ts >= ? GROUP BY agent_id', [cutoff]);
  } catch { return []; }
}

/** Org-wide cost/token trend across all agents (summed per snapshot time). */
function costTrend(fromTs = 0) {
  if (!db) return [];
  try {
    return db.all('SELECT ts, SUM(tokens) AS tokens, SUM(cost) AS cost FROM agent_snapshots WHERE ts >= ? GROUP BY ts ORDER BY ts', [fromTs]);
  } catch { return []; }
}

/** Per-agent cumulative snapshot history (for charts/export). */
function agentHistory(agentId, fromTs = 0) {
  if (!db) return [];
  try {
    return db.all('SELECT ts,tokens,cost,calls,avg_latency_ms,status FROM agent_snapshots WHERE agent_id=? AND ts>=? ORDER BY ts', [agentId, fromTs]);
  } catch { return []; }
}

// ── Users / stakeholders ──────────────────────────────────────────────────────
function listUsers() { if (!db) return []; try { return db.all('SELECT id,username,role,display_name,department,created_at,last_login FROM users ORDER BY username'); } catch { return []; } }
function getUser(username) { if (!db) return null; try { return db.get('SELECT * FROM users WHERE username=?', [username]); } catch { return null; } }
function countUsers() { if (!db) return 0; try { return (db.get('SELECT COUNT(*) AS n FROM users') || {}).n || 0; } catch { return 0; } }
function upsertUser(u) {
  if (!db) return;
  try {
    db.run(`INSERT INTO users(id,username,pass_hash,pass_salt,role,display_name,department,created_at,last_login)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username, pass_hash=excluded.pass_hash,
        pass_salt=excluded.pass_salt, role=excluded.role, display_name=excluded.display_name,
        department=excluded.department`,
      [u.id, u.username, u.pass_hash, u.pass_salt, u.role, u.display_name || u.username,
       u.department || null, u.created_at || new Date().toISOString(), u.last_login || null]);
  } catch (e) { console.warn('[db] upsertUser:', e.message); }
}
function setUserLastLogin(id, ts) { if (!db) return; try { db.run('UPDATE users SET last_login=? WHERE id=?', [ts, id]); } catch { /* ignore */ } }
function deleteUser(id) { if (!db) return; try { db.run('DELETE FROM users WHERE id=?', [id]); } catch { /* ignore */ } }

// ── Agent metadata overrides (admin-edited) ────────────────────────────────────
function getAgentMeta(agentId) { if (!db) return null; try { return db.get('SELECT * FROM agent_meta WHERE agent_id=?', [agentId]); } catch { return null; } }
function allAgentMeta() { if (!db) return {}; try { const m = {}; db.all('SELECT * FROM agent_meta').forEach(r => m[r.agent_id] = r); return m; } catch { return {}; } }
function setAgentMeta(agentId, meta) {
  if (!db) return;
  try {
    db.run(`INSERT INTO agent_meta(agent_id,name,framework,model,department,owner,notes,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET name=excluded.name, framework=excluded.framework,
        model=excluded.model, department=excluded.department, owner=excluded.owner,
        notes=excluded.notes, updated_at=excluded.updated_at`,
      [agentId, meta.name || null, meta.framework || null, meta.model || null,
       meta.department || null, meta.owner || null, meta.notes || null, new Date().toISOString()]);
  } catch (e) { console.warn('[db] setAgentMeta:', e.message); }
}

// ── Business units + agent↔BU mapping ──────────────────────────────────────────
function listBUs() { if (!db) return []; try { return db.all('SELECT * FROM business_units ORDER BY name'); } catch { return []; } }
function upsertBU(b) {
  if (!db) return;
  try {
    db.run(`INSERT INTO business_units(bu_id,name,budget,owner,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(bu_id) DO UPDATE SET name=excluded.name, budget=excluded.budget, owner=excluded.owner`,
      [b.bu_id, b.name, b.budget != null ? b.budget : null, b.owner || null, b.created_at || new Date().toISOString()]);
  } catch (e) { console.warn('[db] upsertBU:', e.message); }
}
function deleteBU(buId) { if (!db) return; try { db.run('DELETE FROM business_units WHERE bu_id=?', [buId]); db.run('DELETE FROM agent_bu_map WHERE bu_id=?', [buId]); } catch { /* ignore */ } }
function getAgentBUs(agentId) { if (!db) return []; try { return db.all('SELECT bu_id FROM agent_bu_map WHERE agent_id=?', [agentId]).map(r => r.bu_id); } catch { return []; } }
function allAgentBUs() { if (!db) return {}; try { const m = {}; db.all('SELECT agent_id,bu_id FROM agent_bu_map').forEach(r => (m[r.agent_id] = m[r.agent_id] || []).push(r.bu_id)); return m; } catch { return {}; } }
function setAgentBUs(agentId, buIds) {
  if (!db) return;
  try {
    db.run('DELETE FROM agent_bu_map WHERE agent_id=?', [agentId]);
    for (const b of (buIds || [])) db.run('INSERT OR IGNORE INTO agent_bu_map(agent_id,bu_id) VALUES(?,?)', [agentId, b]);
  } catch (e) { console.warn('[db] setAgentBUs:', e.message); }
}

/** Close the DB so node-sqlite3-wasm releases its `<db>.lock` directory. */
function close() { if (db) { try { db.close(); } catch { /* ignore */ } db = null; } }

module.exports = {
  init, close, recordExecution, snapshotAgents, prune, recentExecutions, executionTotals, costTrend, agentHistory,
  listUsers, getUser, countUsers, upsertUser, setUserLastLogin, deleteUser,
  getAgentMeta, allAgentMeta, setAgentMeta,
  listBUs, upsertBU, deleteBU, getAgentBUs, allAgentBUs, setAgentBUs,
  get enabled() { return !!db; },
};
