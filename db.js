/**
 * db.js — 1-day persistence for cumulative data (SQLite via node-sqlite3-wasm).
 *
 * Real SQLite, but WASM-based so it needs no native build toolchain. Stores
 * executions and periodic per-agent cumulative snapshots, pruned to 24h.
 * All calls are wrapped so a DB problem can never crash the API.
 */
const path = require('path');

let Database = null;
try { ({ Database } = require('node-sqlite3-wasm')); }
catch { console.warn('[db] node-sqlite3-wasm not installed — persistence disabled'); }

const DAY_MS = 24 * 60 * 60 * 1000;
let db = null;

function init(dbPath = path.join(__dirname, 'control-tower.db')) {
  if (!Database) return null;
  try {
    db = new Database(dbPath);
    db.run(`CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY, agent_id TEXT, task TEXT, started_at TEXT, completed_at TEXT,
      latency_ms INTEGER, tokens INTEGER, cost REAL, ts INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS agent_snapshots (
      agent_id TEXT, ts INTEGER, tokens INTEGER, cost REAL, calls INTEGER,
      avg_latency_ms INTEGER, status TEXT)`);
    db.run('CREATE INDEX IF NOT EXISTS idx_exec_agent ON executions(agent_id, ts)');
    db.run('CREATE INDEX IF NOT EXISTS idx_snap_agent ON agent_snapshots(agent_id, ts)');
    console.log('[db] SQLite (wasm) persistence ready →', dbPath);
    return db;
  } catch (e) { console.warn('[db] init failed, persistence disabled:', e.message); db = null; return null; }
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

module.exports = {
  init, recordExecution, snapshotAgents, prune, recentExecutions, executionTotals, costTrend, agentHistory,
  get enabled() { return !!db; },
};
