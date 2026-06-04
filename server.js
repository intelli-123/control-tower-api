/**
 * Agent Control Tower — Backend API
 * 
 * Endpoints:
 *   POST /api/heartbeat          — agents report status, tools, metrics
 *   GET  /api/agents             — list all agents + last known state
 *   GET  /api/agents/:id         — single agent detail
 *   POST /api/trigger            — trigger an agent run
 *   GET  /api/alerts             — active anomaly alerts
 *   GET  /api/audit              — audit log (filterable)
 *   GET  /api/cost               — cost attribution summary
 *   POST /api/escalation/:id/resolve — approve/reject/hold an escalation
 *   GET  /api/health             — API health check
 */

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const { v4: uuidv4 } = require('uuid');
const dbStore = require('./db');

const app  = express();
const PORT = process.env.PORT || 3090;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// ─── In-memory store (replace with DB in production) ─────────────────────────
const store = {
  agents:      {},   // { [agent_id]: AgentState }
  auditLog:    [],   // AuditEntry[]
  alerts:      [],   // Alert[]
  escalations: {},   // { [escalation_id]: Escalation }
  runs:        [],   // TriggerRun[]
  executions:  [],   // Execution[] — one per completed request (task_start→task_complete)
  openExec:    {},   // { [agent_id]: { started_at, task, tokens, cost } } in-flight requests
};

// ─── Persistence (SQLite/wasm, 1-day retention) ──────────────────────────────
dbStore.init(process.env.CT_DB_PATH);   // CT_DB_PATH overrides the default DB file
store.carryover = {};   // per-agent totals rehydrated from persisted executions
try {
  const rows = dbStore.recentExecutions();   // rehydrate last 24h on startup
  if (rows.length) { store.executions = rows; console.log(`[db] rehydrated ${rows.length} executions`); }
  // Seed cumulative totals so the cards/table match the (persisted) detail view after a restart.
  for (const r of dbStore.executionTotals()) {
    store.carryover[r.agent_id] = { tokens: r.tokens || 0, cost: r.cost || 0, calls: r.n || 0 };
  }
} catch { /* ignore */ }
// Periodic cumulative snapshot + prune to 24h
setInterval(() => {
  dbStore.snapshotAgents(Object.values(store.agents));
  dbStore.prune();
}, 60_000);

// ─── Constants ────────────────────────────────────────────────────────────────
const OFFLINE_THRESHOLD_MS  = 60_000;  // mark offline after 60s no heartbeat
const TOKEN_SPIKE_MULTIPLIER = 2.5;    // flag if tokens > 2.5× agent baseline
const LOOP_DETECTION_WINDOW  = 5;      // flag if same tool called >5× in 10s

// Cost per 1K tokens by model (input / output) — editable in cost-config.json.
// Falls back to a built-in default if the file is missing or malformed.
let COST_TABLE = { default: { input: 0.003, output: 0.015 } };
let BUDGETS = { total: 0, by_department: {}, by_agent: {} };
try {
  const cfg = require('./cost-config.json');
  COST_TABLE = cfg.models   || COST_TABLE;
  BUDGETS    = cfg.budgets  || BUDGETS;
  console.log(`[cost] Loaded ${Object.keys(COST_TABLE).length} model rates and budgets from cost-config.json`);
} catch (e) {
  console.warn('[cost] cost-config.json not loaded, using built-in default:', e.message);
}
const pct = (spent, budget) => (budget > 0 ? +((spent / budget) * 100).toFixed(1) : null);

// Shared dashboard password (same for all stakeholders). Override via env CT_PASSWORD.
const AUTH_PASSWORD = process.env.CT_PASSWORD || 'control-tower';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function now() { return new Date().toISOString(); }

function estimateCost(model, inputTokens = 0, outputTokens = 0) {
  const rates = COST_TABLE[model] || COST_TABLE.default;
  return (inputTokens / 1000) * rates.input +
         (outputTokens / 1000) * rates.output;
}

// Best-effort framework detection when an agent doesn't report one.
function inferFramework(body = {}) {
  if (body.framework) return body.framework;
  const m = String(body.model || '').toLowerCase();
  if (m.startsWith('mcp:') || m.startsWith('mcp ')) return 'MCP';
  return 'unknown';
}

function addAudit(agentId, label, detail, tokens = null, meta = {}) {
  store.auditLog.unshift({
    id:        uuidv4(),
    timestamp: now(),
    agent_id:  agentId,
    label,
    detail,
    tokens,
    ...meta,
  });
  // Keep last 1000 entries
  if (store.auditLog.length > 1000) store.auditLog.pop();
}

function addAlert(agentId, severity, type, title, description) {
  // Deduplicate: don't re-add same alert type for same agent if still active
  const exists = store.alerts.find(
    a => a.agent_id === agentId && a.type === type && a.resolved === false
  );
  if (exists) return;

  store.alerts.unshift({
    id:          uuidv4(),
    agent_id:    agentId,
    severity,    // 'high' | 'medium' | 'low'
    type,        // 'token_spike' | 'silent_failure' | 'loop' | 'error_rate'
    title,
    description,
    timestamp:   now(),
    resolved:    false,
  });
}

function checkAnomalies(agentId, payload) {
  const agent   = store.agents[agentId];
  const metrics = payload.metrics || {};

  // 1. Token spike
  if (agent.baseline_tokens && metrics.tokens_total) {
    if (metrics.tokens_total > agent.baseline_tokens * TOKEN_SPIKE_MULTIPLIER) {
      addAlert(
        agentId, 'high', 'token_spike',
        `${agentId} — token spike detected`,
        `Consumed ${metrics.tokens_total.toLocaleString()} tokens vs baseline ` +
        `${agent.baseline_tokens.toLocaleString()}. ` +
        `${(metrics.tokens_total / agent.baseline_tokens).toFixed(1)}× above normal.`
      );
    }
  }

  // 2. Tool loop detection (same tool called repeatedly in short window)
  if (payload.recent_tool_calls) {
    const counts = {};
    payload.recent_tool_calls.forEach(t => {
      counts[t] = (counts[t] || 0) + 1;
    });
    for (const [tool, count] of Object.entries(counts)) {
      if (count >= LOOP_DETECTION_WINDOW) {
        addAlert(
          agentId, 'high', 'loop',
          `${agentId} — possible tool loop`,
          `Tool "${tool}" called ${count} times in last report window. Possible infinite loop.`
        );
      }
    }
  }

  // 3. High error rate
  if (metrics.error_rate && metrics.error_rate > 0.15) {
    addAlert(
      agentId, 'medium', 'error_rate',
      `${agentId} — high error rate`,
      `Error rate ${(metrics.error_rate * 100).toFixed(1)}% (threshold: 15%).`
    );
  }
}

function markOfflineAgents() {
  const threshold = Date.now() - OFFLINE_THRESHOLD_MS;
  for (const [id, agent] of Object.entries(store.agents)) {
    if (agent.status !== 'offline' && new Date(agent.last_heartbeat).getTime() < threshold) {
      agent.status = 'offline';
      addAudit(id, 'Agent went offline', 'No heartbeat received for 60s', null, { severity: 'warning' });
      addAlert(id, 'high', 'silent_failure', `${id} — silent failure`, `No heartbeat for over 60 seconds. Last seen: ${agent.last_heartbeat}`);
    }
  }
}

// Run offline check every 30 seconds
setInterval(markOfflineAgents, 30_000);

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: now(),
    agents:    Object.keys(store.agents).length,
    uptime_s:  Math.floor(process.uptime()),
  });
});

/**
 * POST /api/login  { password }
 * Shared password for all stakeholders (CT_PASSWORD env, default 'control-tower').
 * Returns a session token on success; 401 otherwise.
 */
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password && password === AUTH_PASSWORD) {
    return res.json({ ok: true, token: uuidv4() });
  }
  return res.status(401).json({ ok: false, error: 'Invalid password' });
});

/**
 * POST /api/heartbeat
 * 
 * Body (all fields optional except agent_id):
 * {
 *   agent_id:           "finance-agent-01",     // required
 *   name:               "Finance Agent",
 *   department:         "Finance",
 *   status:             "ready" | "busy" | "error",
 *   tools:              ["query_db", "send_report"],   // auto-discovered
 *   current_task:       "Processing Q2 invoices",
 *   model:              "claude-sonnet-4-20250514",
 *   metrics: {
 *     tokens_input:     1200,
 *     tokens_output:    430,
 *     tokens_total:     1630,
 *     cost_usd:         0.0102,      // optional — we calculate if not given
 *     calls_made:       14,
 *     avg_latency_ms:   840,
 *     error_rate:       0.02
 *   },
 *   recent_tool_calls:  ["query_db", "query_db", "query_db"],  // for loop detection
 *   event:              "tool_call" | "llm_response" | "task_complete" | "error",
 *   event_detail:       "Called query_db with params {...}",
 * }
 */
app.post('/api/heartbeat', (req, res) => {
  const body = req.body;

  if (!body.agent_id) {
    return res.status(400).json({ error: 'agent_id is required' });
  }

  const agentId = body.agent_id;
  const metrics = body.metrics || {};
  const existing = store.agents[agentId] || {};

  // Calculate cost if not provided
  if (!metrics.cost_usd && metrics.tokens_input !== undefined) {
    metrics.cost_usd = estimateCost(body.model, metrics.tokens_input, metrics.tokens_output);
  }

  // Accumulate totals. On the agent's first heartbeat after a restart, start
  // from the totals rehydrated from persisted executions (so the cards/table
  // match the detail view) instead of zero.
  const prev = existing.totals || store.carryover[agentId] || { tokens: 0, cost: 0, calls: 0 };
  const newTotals = {
    tokens: prev.tokens + (metrics.tokens_total || 0),
    cost:   prev.cost   + (metrics.cost_usd    || 0),
    calls:  prev.calls  + (metrics.calls_made  || 0),
  };

  // Establish baseline on first heartbeat (use as rolling average)
  let baseline = existing.baseline_tokens;
  if (!baseline && metrics.tokens_total) {
    baseline = metrics.tokens_total;
  } else if (baseline && metrics.tokens_total) {
    baseline = Math.round(baseline * 0.9 + metrics.tokens_total * 0.1); // EMA
  }

  // Upsert agent state
  store.agents[agentId] = {
    ...existing,
    agent_id:        agentId,
    name:            body.name            || existing.name            || agentId,
    department:      body.department      || existing.department      || 'Unknown',
    status:          body.status          || existing.status          || 'ready',
    current_task:    body.current_task    || existing.current_task    || null,
    model:           body.model           || existing.model           || 'unknown',
    framework:       body.framework       || existing.framework       || inferFramework(body),
    depends_on:      body.depends_on       || existing.depends_on       || [],
    tools:           body.tools           || existing.tools           || [],
    last_heartbeat:  now(),
    first_seen:      existing.first_seen  || now(),
    metrics:         { ...existing.metrics, ...metrics },
    totals:          newTotals,
    baseline_tokens: baseline,
  };

  // Anomaly detection
  checkAnomalies(agentId, body);

  // Add to audit log if this heartbeat carries an event
  if (body.event) {
    addAudit(
      agentId,
      body.event,
      body.event_detail || '',
      metrics.tokens_total ? `${metrics.tokens_total.toLocaleString()} tokens` : null,
      { model: body.model }
    );
  }

  // ── Per-request execution tracking ──────────────────────────────────────────
  // Open on task_start, accumulate tokens/cost across the request's heartbeats,
  // close on task_complete recording wall-clock latency.
  const ev = body.event;
  if (ev === 'task_start') {
    store.openExec[agentId] = {
      started_at: now(),
      task:       body.event_detail || body.current_task || null,
      tokens:     0,
      cost:       0,
    };
  }
  const open = store.openExec[agentId];
  if (open) {
    open.tokens += metrics.tokens_total || 0;
    open.cost   += metrics.cost_usd     || 0;
  }
  if (ev === 'task_complete' && open) {
    const exec = {
      id:           uuidv4(),
      agent_id:     agentId,
      task:         open.task,
      started_at:   open.started_at,
      completed_at: now(),
      latency_ms:   Date.now() - new Date(open.started_at).getTime(),
      tokens:       open.tokens,
      cost:         +open.cost.toFixed(6),
    };
    store.executions.unshift(exec);
    dbStore.recordExecution(exec);            // persist (1-day retention)
    if (store.executions.length > 2000) store.executions.pop();
    delete store.openExec[agentId];
  }

  // Resolve silent_failure alert if agent is back
  store.alerts
    .filter(a => a.agent_id === agentId && a.type === 'silent_failure' && !a.resolved)
    .forEach(a => { a.resolved = true; a.resolved_at = now(); });

  res.json({
    ok:          true,
    agent_id:    agentId,
    received_at: now(),
    status:      store.agents[agentId].status,
    alerts:      store.alerts.filter(a => a.agent_id === agentId && !a.resolved).length,
  });
});

/**
 * GET /api/agents
 * Returns all agents with their current state
 */
app.get('/api/agents', (req, res) => {
  markOfflineAgents();
  const agents = Object.values(store.agents).map(a => {
    const execs = store.executions.filter(e => e.agent_id === a.agent_id);
    const avgLat = execs.length
      ? Math.round(execs.reduce((s, e) => s + e.latency_ms, 0) / execs.length)
      : 0;
    return {
      ...a,
      seconds_since_heartbeat: a.last_heartbeat
        ? Math.floor((Date.now() - new Date(a.last_heartbeat).getTime()) / 1000)
        : null,
      active_alerts:      store.alerts.filter(al => al.agent_id === a.agent_id && !al.resolved).length,
      executions_count:   execs.length,
      avg_latency_ms:     avgLat,   // wall-clock request latency
    };
  });
  // Overall request latency across all executions (for the dashboard latency card)
  const allExec = store.executions;
  const overallAvgLatency = allExec.length
    ? Math.round(allExec.reduce((s, e) => s + e.latency_ms, 0) / allExec.length)
    : 0;
  res.json({ agents, total: agents.length, avg_latency_ms: overallAvgLatency, timestamp: now() });
});

/**
 * GET /api/agents/:id/executions
 * Per-request executions for one agent.
 * Query: ?from=<ISO date>  (filter completed_at >= from)
 *        ?sort=latency | latency_asc | recent (default)
 */
app.get('/api/agents/:id/executions', (req, res) => {
  const { from, sort } = req.query;
  let execs = store.executions.filter(e => e.agent_id === req.params.id);

  if (from) {
    const fromTs = new Date(from).getTime();
    if (!isNaN(fromTs)) execs = execs.filter(e => new Date(e.completed_at).getTime() >= fromTs);
  }

  if (sort === 'latency')          execs = [...execs].sort((a, b) => b.latency_ms - a.latency_ms);
  else if (sort === 'latency_asc') execs = [...execs].sort((a, b) => a.latency_ms - b.latency_ms);
  // default: newest first (store.executions is unshifted, already newest-first)

  const count  = execs.length;
  const tokens = execs.reduce((s, e) => s + (e.tokens || 0), 0);
  const cost   = +execs.reduce((s, e) => s + (e.cost || 0), 0).toFixed(6);
  const avgLat = count ? Math.round(execs.reduce((s, e) => s + e.latency_ms, 0) / count) : 0;

  res.json({
    agent_id:       req.params.id,
    count, tokens, cost,
    avg_latency_ms: avgLat,
    executions:     execs.slice(0, 500),
  });
});

/**
 * GET /api/agents/:id
 */
app.get('/api/agents/:id', (req, res) => {
  const agent = store.agents[req.params.id];
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({
    ...agent,
    audit:        store.auditLog.filter(e => e.agent_id === req.params.id).slice(0, 50),
    alerts:       store.alerts.filter(a => a.agent_id === req.params.id),
    escalations:  Object.values(store.escalations).filter(e => e.agent_id === req.params.id),
  });
});

/**
 * POST /api/trigger
 * 
 * Body:
 * {
 *   agent_id:    "finance-agent-01",   // required
 *   task:        "Process Q2 invoices",
 *   priority:    "normal" | "high" | "critical",
 *   triggered_by: "dashboard",
 *   params:      { any: "extra params" }
 * }
 * 
 * NOTE: This endpoint records the trigger request and returns a run_id.
 * Your agent should poll GET /api/runs/:run_id or receive the run_id
 * via its own startup mechanism (e.g. env var, queue, webhook).
 */
app.post('/api/trigger', (req, res) => {
  const { agent_id, task, priority = 'normal', triggered_by = 'api', params = {} } = req.body;

  if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
  if (!task)     return res.status(400).json({ error: 'task is required' });

  const run = {
    run_id:       uuidv4(),
    agent_id,
    task,
    priority,
    triggered_by,
    params,
    status:       'queued',
    created_at:   now(),
    started_at:   null,
    completed_at: null,
  };

  store.runs.unshift(run);
  if (store.runs.length > 500) store.runs.pop();

  addAudit(agent_id, 'Run triggered', `Task: "${task}" (priority: ${priority})`, null, {
    run_id: run.run_id, triggered_by,
  });

  res.status(201).json({
    ok:         true,
    run_id:     run.run_id,
    agent_id,
    status:     'queued',
    message:    `Run queued for ${agent_id}. Your agent should poll /api/runs/${run.run_id} for status.`,
    created_at: run.created_at,
  });
});

/**
 * GET /api/runs
 * List recent trigger runs
 */
app.get('/api/runs', (req, res) => {
  const { agent_id, limit = 20 } = req.query;
  let runs = store.runs;
  if (agent_id) runs = runs.filter(r => r.agent_id === agent_id);
  res.json({ runs: runs.slice(0, parseInt(limit)), total: runs.length });
});

/**
 * GET /api/runs/:run_id
 */
app.get('/api/runs/:run_id', (req, res) => {
  const run = store.runs.find(r => r.run_id === req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

/**
 * PATCH /api/runs/:run_id
 * Agents call this to update run status
 * Body: { status: "running"|"completed"|"failed", result: {...} }
 */
app.patch('/api/runs/:run_id', (req, res) => {
  const run = store.runs.find(r => r.run_id === req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const { status, result, error } = req.body;
  if (status) run.status = status;
  if (result) run.result = result;
  if (error)  run.error  = error;
  if (status === 'running')   run.started_at   = now();
  if (status === 'completed' || status === 'failed') run.completed_at = now();

  addAudit(run.agent_id, `Run ${status}`, error || JSON.stringify(result || {}).slice(0, 120), null, { run_id: run.run_id });

  res.json({ ok: true, run });
});

/**
 * GET /api/alerts
 * Query params: ?resolved=false&agent_id=x&severity=high
 */
app.get('/api/alerts', (req, res) => {
  let alerts = store.alerts;
  if (req.query.resolved !== undefined)
    alerts = alerts.filter(a => String(a.resolved) === req.query.resolved);
  if (req.query.agent_id)
    alerts = alerts.filter(a => a.agent_id === req.query.agent_id);
  if (req.query.severity)
    alerts = alerts.filter(a => a.severity === req.query.severity);
  res.json({ alerts, total: alerts.length });
});

/**
 * PATCH /api/alerts/:id/resolve
 */
app.patch('/api/alerts/:id/resolve', (req, res) => {
  const alert = store.alerts.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.resolved    = true;
  alert.resolved_at = now();
  alert.resolved_by = req.body.resolved_by || 'human';
  res.json({ ok: true, alert });
});

/**
 * POST /api/escalation
 * Agents create an escalation when they need human approval
 * Body: { agent_id, question, context, urgency: "normal"|"urgent", options: ["approve","reject"] }
 */
app.post('/api/escalation', (req, res) => {
  const { agent_id, question, context, urgency = 'normal', options = ['approve', 'reject'] } = req.body;
  if (!agent_id || !question) return res.status(400).json({ error: 'agent_id and question required' });

  const id = uuidv4();
  store.escalations[id] = {
    id,
    agent_id,
    question,
    context,
    urgency,
    options,
    status:     'pending',
    created_at: now(),
    resolved_at: null,
    decision:   null,
    decided_by: null,
  };

  addAudit(agent_id, 'Escalation created', question.slice(0, 100), null, { escalation_id: id, urgency });

  res.status(201).json({ ok: true, escalation_id: id, message: 'Awaiting human decision' });
});

/**
 * GET /api/escalations
 */
app.get('/api/escalations', (req, res) => {
  const list = Object.values(store.escalations);
  const pending = list.filter(e => e.status === 'pending');
  const resolved = list.filter(e => e.status !== 'pending');
  res.json({ pending, resolved, total: list.length });
});

/**
 * GET /api/escalations/:id
 * Agents poll this to check if a decision has been made
 */
app.get('/api/escalations/:id', (req, res) => {
  const esc = store.escalations[req.params.id];
  if (!esc) return res.status(404).json({ error: 'Escalation not found' });
  res.json(esc);
});

/**
 * POST /api/escalations/:id/resolve
 * Dashboard calls this when human makes a decision
 * Body: { decision: "approved"|"rejected"|"hold", decided_by: "john@co.com", note: "..." }
 */
app.post('/api/escalations/:id/resolve', (req, res) => {
  const esc = store.escalations[req.params.id];
  if (!esc) return res.status(404).json({ error: 'Escalation not found' });

  const { decision, decided_by = 'human', note = '' } = req.body;
  if (!decision) return res.status(400).json({ error: 'decision is required' });

  esc.status      = decision === 'hold' ? 'on_hold' : 'resolved';
  esc.decision    = decision;
  esc.decided_by  = decided_by;
  esc.note        = note;
  esc.resolved_at = now();

  addAudit(esc.agent_id, `Escalation ${decision}`, note || `Decision: ${decision}`, null, {
    escalation_id: esc.id, decided_by,
  });

  res.json({ ok: true, escalation: esc });
});

/**
 * GET /api/audit
 * Query: ?agent_id=x&limit=50&event=tool_call
 */
app.get('/api/audit', (req, res) => {
  let log = store.auditLog;
  if (req.query.agent_id) log = log.filter(e => e.agent_id === req.query.agent_id);
  if (req.query.event)    log = log.filter(e => e.label === req.query.event);
  const limit = parseInt(req.query.limit) || 100;
  res.json({ log: log.slice(0, limit), total: store.auditLog.length });
});

/**
 * GET /api/cost
 * Returns cost breakdown per agent, per department, and totals
 */
app.get('/api/cost', (req, res) => {
  const byAgent = {};
  const byDept  = {};

  for (const agent of Object.values(store.agents)) {
    const cost   = agent.totals?.cost   || 0;
    const tokens = agent.totals?.tokens || 0;
    const dept   = agent.department     || 'Unknown';

    byAgent[agent.agent_id] = {
      name:   agent.name,
      dept,
      cost:   parseFloat(cost.toFixed(4)),
      tokens,
      calls:  agent.totals?.calls || 0,
      budget: BUDGETS.by_agent?.[agent.agent_id] ?? null,
      pct:    pct(cost, BUDGETS.by_agent?.[agent.agent_id]),
    };

    byDept[dept] = {
      cost:   parseFloat(((byDept[dept]?.cost || 0) + cost).toFixed(4)),
      tokens: (byDept[dept]?.tokens || 0) + tokens,
    };
  }

  // Attach department budgets + % used
  for (const [dept, d] of Object.entries(byDept)) {
    d.budget = BUDGETS.by_department?.[dept] ?? null;
    d.pct    = pct(d.cost, d.budget);
  }

  const totalCost   = Object.values(byAgent).reduce((s, a) => s + a.cost, 0);
  const totalTokens = Object.values(byAgent).reduce((s, a) => s + a.tokens, 0);

  res.json({
    total_cost_usd:    parseFloat(totalCost.toFixed(4)),
    total_tokens:      totalTokens,
    total_budget:      BUDGETS.total || null,
    total_pct:         pct(totalCost, BUDGETS.total),
    budgets:           BUDGETS,
    by_agent:          byAgent,
    by_department:     byDept,
    timestamp:         now(),
  });
});

/**
 * GET /api/cost/trend?from=<ISO>
 * Time-series of total tokens/cost across all agents (from persisted snapshots).
 */
app.get('/api/cost/trend', (req, res) => {
  const fromTs = req.query.from ? new Date(req.query.from).getTime() : Date.now() - 24 * 3600 * 1000;
  res.json({ from: fromTs, points: dbStore.costTrend(fromTs || 0), persisted: dbStore.enabled });
});

// ─── CSV export (Excel-openable, no dependencies) ───────────────────────────
function toCsv(rows, cols) {
  const esc = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = cols.map(c => esc(c.label)).join(',');
  const body = rows.map(r => cols.map(c => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}
function agentExecAgg(agentId) {
  const ex = store.executions.filter(e => e.agent_id === agentId);
  const avg = ex.length ? Math.round(ex.reduce((s, e) => s + e.latency_ms, 0) / ex.length) : 0;
  return { count: ex.length, avg };
}

// All agents (covers the online/offline/tokens/cost/latency cards)
app.get('/api/export/agents.csv', (req, res) => {
  const rows = Object.values(store.agents).map(a => {
    const agg = agentExecAgg(a.agent_id);
    return { ...a, tokens: a.totals?.tokens || 0, cost: a.totals?.cost || 0, calls: a.totals?.calls || 0,
             executions: agg.count, avg_latency_ms: agg.avg };
  });
  sendCsv(res, 'agents.csv', toCsv(rows, [
    { key: 'agent_id', label: 'Agent ID' }, { key: 'name', label: 'Name' },
    { key: 'department', label: 'Department' }, { key: 'framework', label: 'Framework' },
    { key: 'model', label: 'Model' }, { key: 'status', label: 'Status' },
    { key: 'tokens', label: 'Tokens' }, { get: r => (r.cost || 0).toFixed(6), label: 'Cost USD' },
    { key: 'calls', label: 'Calls' }, { key: 'executions', label: 'Executions' },
    { key: 'avg_latency_ms', label: 'Avg latency ms' },
  ]));
});

// Per-agent executions (latency/tokens/cost per request)
app.get('/api/agents/:id/executions.csv', (req, res) => {
  const rows = store.executions.filter(e => e.agent_id === req.params.id);
  sendCsv(res, `${req.params.id}-executions.csv`, toCsv(rows, [
    { key: 'started_at', label: 'Started' }, { key: 'completed_at', label: 'Completed' },
    { key: 'task', label: 'Task' }, { key: 'latency_ms', label: 'Latency ms' },
    { key: 'tokens', label: 'Tokens' }, { get: r => (r.cost || 0).toFixed(6), label: 'Cost USD' },
  ]));
});

// Alerts card
app.get('/api/export/alerts.csv', (req, res) => {
  sendCsv(res, 'alerts.csv', toCsv(store.alerts, [
    { key: 'agent_id', label: 'Agent' }, { key: 'severity', label: 'Severity' },
    { key: 'type', label: 'Type' }, { key: 'title', label: 'Title' },
    { key: 'timestamp', label: 'When' }, { get: r => r.resolved ? 'resolved' : 'active', label: 'State' },
  ]));
});

// Per-agent cumulative history (persisted snapshots, last 24h)
app.get('/api/agents/:id/history', (req, res) => {
  const fromTs = req.query.from ? new Date(req.query.from).getTime() : Date.now() - 24 * 3600 * 1000;
  res.json({ agent_id: req.params.id, history: dbStore.agentHistory(req.params.id, fromTs || 0), persisted: dbStore.enabled });
});

// ─── Lineage (agent → agent interdependency) ─────────────────────────────────
app.get('/api/lineage', (req, res) => {
  const ids = new Set(Object.keys(store.agents));
  const edges = [], seen = new Set();
  const add = (from, to, kind) => {
    if (from && to && from !== to && ids.has(from) && ids.has(to)) {
      const k = `${from}->${to}`; if (!seen.has(k)) { seen.add(k); edges.push({ from, to, kind }); }
    }
  };
  for (const r of store.runs) add(r.triggered_by, r.agent_id, 'trigger');     // who triggered whom
  for (const a of Object.values(store.agents)) (a.depends_on || []).forEach(d => add(a.agent_id, d, 'depends'));
  res.json({
    nodes: Object.values(store.agents).map(a => ({ agent_id: a.agent_id, name: a.name, status: a.status, framework: a.framework })),
    edges,
  });
});

// ─── Dashboard UI ─────────────────────────────────────────────────────────────
const path = require('path');
// Don't let browsers cache the dashboard HTML — always serve the latest build,
// so UI fixes show up on a normal refresh (no hard-refresh needed).
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🗼  Agent Control Tower API running on http://localhost:${PORT}\n`);
  console.log('  POST /api/heartbeat        — agents report in');
  console.log('  GET  /api/agents           — list all agents');
  console.log('  POST /api/trigger          — trigger an agent run');
  console.log('  GET  /api/alerts           — active anomaly alerts');
  console.log('  GET  /api/audit            — decision audit log');
  console.log('  GET  /api/cost             — cost attribution');
  console.log('  POST /api/escalation       — create escalation');
  console.log('  GET  /api/escalations/:id  — poll for decision\n');
});

module.exports = app;
