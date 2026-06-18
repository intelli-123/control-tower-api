/**
 * insights.js — executive summary rule engine (dependency-free, CommonJS).
 *
 * Pure functions: feed in the same data the API already computes
 * (agents list, cost breakdown, active alerts, escalations, cost trend) and
 * get back structured KPIs, breakdowns, ranked insights+recommendations, and a
 * templated narrative. No I/O, no LLM — the server may optionally replace the
 * narrative with a Claude-generated one, falling back to the one produced here.
 */

const WARN_PCT = 80;    // budget warning threshold
const HIGH_PCT = 100;   // budget breach threshold
const LATENCY_SLOW_MS = 5000;   // an agent slower than this is flagged
const SEV_RANK = { high: 0, medium: 1, low: 2 };

function round(n, d = 2) { const f = Math.pow(10, d); return Math.round((n || 0) * f) / f; }
function fmtUsd(n) { n = n || 0; return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`; }
function isOffline(a) { return a.status === 'offline'; }

/** Build the full executive summary object. All inputs are optional/defensive. */
function buildSummary({ agents = [], cost = {}, alerts = [], esc = {}, trend = [] } = {}) {
  const online  = agents.filter(a => !isOffline(a));
  const offline = agents.filter(a => isOffline(a));

  const activeAlerts = (alerts || []).filter(a => !a.resolved);
  const sev = { high: 0, medium: 0, low: 0 };
  activeAlerts.forEach(a => { sev[a.severity] = (sev[a.severity] || 0) + 1; });

  const latencies = online.map(a => a.avg_latency_ms || 0).filter(Boolean);
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0;

  const pending = (esc.pending || []).length;

  const kpis = {
    cost:    { total: round(cost.total_cost_usd, 4), budget: cost.total_budget ?? null, pct: cost.total_pct ?? null },
    tokens:  cost.total_tokens || 0,
    fleet:   { online: online.length, offline: offline.length, total: agents.length },
    avg_latency_ms: avgLatency,
    alerts:  { high: sev.high, medium: sev.medium, low: sev.low, total: activeAlerts.length },
    approvals_waiting: pending,
  };

  // ── Breakdowns ──────────────────────────────────────────────────────────────
  const byDept = Object.entries(cost.by_department || {})
    .map(([dept, d]) => ({ dept, cost: round(d.cost, 4), tokens: d.tokens || 0, budget: d.budget ?? null, pct: d.pct ?? null }))
    .sort((a, b) => b.cost - a.cost);

  const topAgents = Object.entries(cost.by_agent || {})
    .map(([id, a]) => ({ agent_id: id, name: a.name || id, dept: a.dept || 'Unknown', cost: round(a.cost, 4), tokens: a.tokens || 0 }))
    .filter(a => a.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  const breakdowns = { by_department: byDept, top_agents: topAgents };

  // ── Insights (rule engine) ───────────────────────────────────────────────────
  const insights = [];
  const add = (severity, title, detail, recommendation) => insights.push({ severity, title, detail, recommendation });

  // 1. Org-wide budget
  if (kpis.cost.pct != null) {
    if (kpis.cost.pct >= HIGH_PCT)
      add('high', 'Total spend over budget',
        `Org spend is ${fmtUsd(kpis.cost.total)} — ${kpis.cost.pct}% of the ${fmtUsd(kpis.cost.budget)} budget.`,
        'Pause or rate-limit the top-spending agents and review budgets immediately.');
    else if (kpis.cost.pct >= WARN_PCT)
      add('medium', 'Total spend approaching budget',
        `Org spend is at ${kpis.cost.pct}% of the ${fmtUsd(kpis.cost.budget)} budget.`,
        'Watch the top spenders this week; consider raising the budget or trimming usage.');
  }

  // 2. Per-department budget
  byDept.forEach(d => {
    if (d.pct == null) return;
    if (d.pct >= HIGH_PCT)
      add('high', `${d.dept} over budget`,
        `${d.dept} spent ${fmtUsd(d.cost)} (${d.pct}% of ${fmtUsd(d.budget)}).`,
        `Review ${d.dept}'s agents for runaway token usage or raise its budget.`);
    else if (d.pct >= WARN_PCT)
      add('medium', `${d.dept} nearing budget`,
        `${d.dept} is at ${d.pct}% of its ${fmtUsd(d.budget)} budget.`,
        `Flag ${d.dept} for cost review.`);
  });

  // 3. Offline / silent agents (include the reason when one was reported)
  if (offline.length) {
    const list = offline.slice(0, 5)
      .map(a => a.current_task ? `${a.name || a.agent_id} (${a.current_task})` : (a.name || a.agent_id))
      .join('; ');
    add('high', `${offline.length} agent${offline.length > 1 ? 's' : ''} not active`,
      `${list}${offline.length > 5 ? '…' : ''}.`,
      'Check host processes / SDK connectivity (e.g. TLS proxy, bad API key, server down).');
  }

  // 4. Error-state agents
  const errored = online.filter(a => a.status === 'error');
  if (errored.length)
    add('high', `${errored.length} agent${errored.length > 1 ? 's' : ''} in error state`,
      `Reporting errors: ${errored.slice(0, 5).map(a => a.name || a.agent_id).join(', ')}.`,
      'Inspect recent runs/logs for these agents.');

  // 5. High-severity alerts
  if (sev.high)
    add('high', `${sev.high} high-severity alert${sev.high > 1 ? 's' : ''} active`,
      `${activeAlerts.filter(a => a.severity === 'high').slice(0, 4).map(a => a.title || a.type).join('; ')}.`,
      'Triage these alerts before they impact downstream tools.');
  else if (sev.medium)
    add('medium', `${sev.medium} medium-severity alert${sev.medium > 1 ? 's' : ''} active`,
      'Anomalies detected but not yet critical.',
      'Review during the next operations check-in.');

  // 6. Latency outliers
  const slow = online.filter(a => (a.avg_latency_ms || 0) > LATENCY_SLOW_MS)
    .sort((a, b) => (b.avg_latency_ms || 0) - (a.avg_latency_ms || 0));
  if (slow.length)
    add('medium', `${slow.length} slow agent${slow.length > 1 ? 's' : ''}`,
      `Highest avg latency: ${slow.slice(0, 3).map(a => `${a.name || a.agent_id} (${Math.round(a.avg_latency_ms)}ms)`).join(', ')}.`,
      'Investigate prompt size, tool calls, or model choice for these agents.');

  // 7. Pending approvals
  if (pending)
    add('medium', `${pending} approval${pending > 1 ? 's' : ''} waiting`,
      'Human-in-the-loop decisions are pending and may be blocking agents.',
      'Route these to the right approver to unblock work.');

  // 8. Spend concentration (only meaningful with 2+ spending agents)
  if (topAgents.length >= 2 && kpis.cost.total > 0) {
    const top = topAgents[0];
    const share = Math.round((top.cost / kpis.cost.total) * 100);
    if (share >= 50)
      add('low', 'Spend concentrated in one agent',
        `${top.name} accounts for ${share}% of total spend (${fmtUsd(top.cost)}).`,
        'Confirm this agent\'s usage is expected; a single agent dominating cost is worth a check.');
  }

  // 9. Idle agents
  const idle = online.filter(a => (a.executions_count || 0) === 0 && (a.totals?.tokens || 0) === 0);
  if (idle.length)
    add('low', `${idle.length} idle agent${idle.length > 1 ? 's' : ''}`,
      `Online but no activity: ${idle.slice(0, 5).map(a => a.name || a.agent_id).join(', ')}.`,
      'Decommission or repurpose agents that are connected but unused.');

  if (!insights.length)
    add('low', 'All systems healthy',
      'No agents offline or erroring, budgets within range, and no high-severity alerts.',
      'No action needed — keep monitoring.');

  insights.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);

  // ── Narrative (rule-based; server may override with an LLM version) ───────────
  const narrative = buildNarrative(kpis, breakdowns, insights, trend);

  return { kpis, breakdowns, insights, narrative, engine: 'rules' };
}

/** Plain-English executive paragraph derived from the structured metrics. */
function buildNarrative(kpis, breakdowns, insights, trend) {
  const parts = [];
  parts.push(
    `The fleet has ${kpis.fleet.total} agent${kpis.fleet.total === 1 ? '' : 's'}, ` +
    `${kpis.fleet.online} online and ${kpis.fleet.offline} offline.`);

  if (kpis.cost.budget != null)
    parts.push(`Total spend is ${fmtUsd(kpis.cost.total)} against a ${fmtUsd(kpis.cost.budget)} budget (${kpis.cost.pct}% used).`);
  else
    parts.push(`Total spend is ${fmtUsd(kpis.cost.total)} across ${(kpis.tokens || 0).toLocaleString()} tokens.`);

  const topDept = breakdowns.by_department[0];
  if (topDept) parts.push(`${topDept.dept} is the largest cost center at ${fmtUsd(topDept.cost)}.`);

  if (trend && trend.length >= 2) {
    const first = trend[0].cost || 0, last = trend[trend.length - 1].cost || 0;
    if (first > 0) {
      const delta = Math.round(((last - first) / first) * 100);
      if (Math.abs(delta) >= 5) parts.push(`Spend is ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)}% over the tracked window.`);
    }
  }

  const high = insights.filter(i => i.severity === 'high');
  if (high.length) parts.push(`Top risk${high.length > 1 ? 's' : ''}: ${high.slice(0, 2).map(i => i.title.toLowerCase()).join('; ')}.`);
  else parts.push('No high-severity risks are currently flagged.');

  return parts.join(' ');
}

module.exports = { buildSummary, buildNarrative };
