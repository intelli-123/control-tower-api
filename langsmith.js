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

/** List all tracing projects ("sessions") for an account. Returns normalized rows. */
async function listProjects({ baseUrl, apiKey }) {
  const f = _fetch || fetch;
  const base = (baseUrl || 'https://api.smith.langchain.com').replace(/\/$/, '');
  const out = [];
  let offset = 0; const limit = 100;
  for (;;) {
    const res = await f(`${base}/api/v1/sessions?limit=${limit}&offset=${offset}`, {
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`.trim());
    }
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.sessions || data.data || []);
    for (const s of items) {
      out.push({
        id:          s.id,
        name:        s.name,
        runCount:    s.run_count ?? null,
        totalTokens: s.total_tokens ?? null,
        errorRate:   s.error_rate ?? null,
        lastRun:     s.last_run_start_time ?? s.end_time ?? s.start_time ?? null,
      });
    }
    if (items.length < limit) break;
    offset += limit;
    if (offset > 1000) break; // safety cap
  }
  return out;
}

module.exports = { listProjects, setFetch };
