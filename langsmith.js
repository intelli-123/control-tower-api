/**
 * langsmith.js — list tracing projects from LangSmith.
 *
 * Uses the LangSmith REST API (GET /api/v1/sessions, header x-api-key). No SDK
 * dependency — just fetch. The fetch impl is injectable for unit tests.
 *   US:  https://api.smith.langchain.com
 *   EU:  https://eu.api.smith.langchain.com
 */
let _fetch = null;
/** Test seam: provide a fetch-like (url, opts) => { ok, status, json(), text() }. */
function setFetch(fn) { _fetch = fn; }

const ENRICH_CAP = 100;   // max projects to fetch per-session stats for

/**
 * List all tracing projects ("sessions") and enrich each with its run/token/cost
 * stats. The list endpoint returns only metadata; stats live on the per-session
 * GET /api/v1/sessions/{id}, so we fetch those (capped, in parallel).
 */
async function listProjects({ baseUrl, apiKey }) {
  const f = _fetch || fetch;
  const base = (baseUrl || 'https://api.smith.langchain.com').replace(/\/$/, '');
  const headers = { 'x-api-key': apiKey, accept: 'application/json' };

  // 1. List sessions (ids + names).
  const sessions = [];
  let offset = 0; const limit = 100;
  for (;;) {
    const res = await f(`${base}/api/v1/sessions?limit=${limit}&offset=${offset}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`.trim());
    }
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.sessions || data.data || []);
    sessions.push(...items);
    if (items.length < limit) break;
    offset += limit;
    if (offset > 1000) break; // safety cap
  }

  // 2. Enrich each (capped) with stats from the single-session endpoint.
  const out = await Promise.all(sessions.slice(0, ENRICH_CAP).map(async (s) => {
    let st = s;
    try {
      const r = await f(`${base}/api/v1/sessions/${encodeURIComponent(s.id)}`, { headers });
      if (r.ok) st = await r.json();
    } catch { /* keep metadata only */ }
    const cost = st.total_cost != null && st.total_cost !== '' ? Number(st.total_cost) : null;
    return {
      id:          s.id,
      name:        s.name || st.name,
      runCount:    st.run_count ?? null,
      totalTokens: st.total_tokens ?? null,
      totalCost:   Number.isFinite(cost) ? cost : null,
      errorRate:   st.error_rate ?? null,
      lastRun:     st.last_run_start_time ?? st.last_run_start_time_live ?? s.start_time ?? null,
    };
  }));
  return out;
}

module.exports = { listProjects, setFetch };
