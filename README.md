# Agent Control Tower — Backend API

A lightweight Node.js API that all your agents report into.
Pairs with the Control Tower dashboard UI.

---

## Quick start

**Easiest (Windows):** double-click **`run-control-tower.bat`**. It checks for
Node.js (auto-downloads a portable copy if missing — no admin needed), installs
dependencies on first run, asks for a **port** (and optional admin password /
Anthropic key), then starts the server and opens the dashboard in your browser.
Your answers are remembered for next time.

**Manual:**
```bash
npm install
node server.js
# → running on http://localhost:3000  (set PORT to change)
```

---

## File overview

| File | What it is |
|---|---|
| `server.js` | The API server (Express) |
| `sdk/control-tower-js/` | Node.js SDK — installable npm package (`control-tower-sdk`) |
| `sdk/control-tower-py/` | Python SDK — installable pip package (`control_tower`) |
| `insights.js` | Executive-summary rule engine (KPIs, insights, recommendations) |

---

## Configuration

All settings are optional — see `.env.example`. Notable ones:

| Variable | Purpose |
|---|---|
| `CT_ADMIN_PASSWORD` | Password for the seeded `admin` user (default `admin`). |
| `CT_DB_PATH` | SQLite persistence path (default `./control-tower.db`). |
| `CT_MONITOR_MCP=off` | Disable built-in MCP host discovery on startup. |
| `ANTHROPIC_API_KEY` | **Optional.** If set, the Executive Summary narrative is written by Claude; otherwise a built-in rule engine is used. Failures fall back to rules. |
| `CONTROL_TOWER_SUMMARY_MODEL` | Claude model for the summary (default `claude-sonnet-4-6`). |

The **Executive Summary** (CEO / CTO roles) analyzes captured agent data into KPIs,
ranked insights with recommendations, and a downloadable print-ready report —
working with no API key out of the box.

---

## API endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/heartbeat` | Agent reports status, tools, token metrics |
| `GET` | `/api/agents` | List all agents + current state |
| `GET` | `/api/agents/:id` | Single agent detail + audit trail |
| `POST` | `/api/trigger` | Trigger an agent run from the dashboard |
| `GET` | `/api/runs` | List recent trigger runs |
| `PATCH` | `/api/runs/:id` | Agent updates its run status |
| `GET` | `/api/alerts` | Active anomaly alerts |
| `POST` | `/api/escalation` | Agent creates a human escalation |
| `GET` | `/api/escalations/:id` | Poll for human decision |
| `POST` | `/api/escalations/:id/resolve` | Dashboard resolves an escalation |
| `GET` | `/api/audit` | Audit log (filterable by agent) |
| `GET` | `/api/cost` | Cost attribution per agent + department |
| `GET` | `/api/health` | Health check |
| `POST` | `/v1/traces` | **OTLP receiver** — any OpenTelemetry agent exports GenAI traces here (tokens, cost, latency, tool calls); maps `gen_ai.*`/`llm.*` spans onto the agent model. No SDK required. |
| `POST/GET/DELETE` | `/api/admin/bedrock/accounts` | Connect / list / disconnect AWS accounts (creds stored encrypted) |
| `GET` | `/api/admin/bedrock/agents` | Live inventory of Bedrock agents across connected accounts |
| `POST/GET/DELETE` | `/api/admin/langsmith/accounts` | Connect / list / disconnect LangSmith workspaces (API key encrypted) |
| `GET` | `/api/admin/langsmith/projects` | Live inventory of LangSmith tracing projects (runs/tokens) |

---

## Cloud agents — AWS Bedrock

In **Admin → Cloud agents (AWS Bedrock)**, an admin clicks **Connect AWS account**,
enters credentials (an IAM principal with `bedrock:ListAgents` is enough), and the tower
calls the Bedrock Agent API (`ListAgentsCommand`) to discover that account's agents —
showing how many accounts are connected, how many agents exist, and how many are
`PREPARED`. Credentials are encrypted at rest (AES-256-GCM; key in a gitignored
`.ct-secret`, override with `CT_SECRET_FILE`). Behind a TLS-inspection proxy, the AWS
calls may need `NODE_TLS_REJECT_UNAUTHORIZED=0` / `NODE_EXTRA_CA_CERTS`.

---

## Live MCP usage metering (proxy)

Passive MCP monitoring sees tools + health + the one-time schema tokens, but **not**
the host's actual tool calls (those go host→server directly). To meter real per-call
tokens/latency, put **`control-tower-mcp-proxy`** in the call path — it spawns the real
server, forwards the JSON-RPC stream verbatim, and reports each `tools/call` to the tower:

```json
"weather": {
  "command": "npx",
  "args": ["-y", "control-tower-mcp-proxy", "--", "npx", "-y", "@scope/weather-mcp@latest"],
  "env": { "CONTROL_TOWER_URL": "http://localhost:3090",
           "CONTROL_TOWER_AGENT_ID": "weather-mcp",
           "CONTROL_TOWER_NAME": "Weather MCP",
           "CONTROL_TOWER_DEPARTMENT": "Engineering" }
}
```

Each tool call becomes a self-contained execution (tokens/latency/errors) — robust to
concurrent calls. `stdout` is reserved for the protocol; logging goes to `stderr`.

---

## Two ways an agent reports in

1. **SDK** (`control-tower-sdk`) — heartbeat + tokens/cost/tools, plus control-plane
   features (escalations, triggering). Best when you want the agent interactive.
2. **OpenTelemetry** — point any OTel-instrumented agent at the OTLP receiver:
   ```bash
   node --import control-tower-sdk/otel your-app.js   # telemetry + heartbeat, zero app code
   ```
   OTel gives tokens/cost/latency/tool-calls/lineage; the bundled preload also starts a
   heartbeat (OTel alone can't report liveness when an agent is idle). Use the SDK on top
   only if you also need escalations/triggers.

---

## Python agent — add 3 lines

```python
from control_tower import ControlTower

ct = ControlTower(
    agent_id   = "finance-agent-01",
    name       = "Finance Agent",
    department = "Finance",
    server_url = "http://localhost:3000",
)

# 1. Start heartbeat (auto-discovers tools)
ct.start(tools=agent.tools)           # LangChain / CrewAI: agent.tools
                                       # MCP: pass result of list_tools()
                                       # Raw: pass ["tool_a", "tool_b"]

# 2. Wrap every LLM call (auto-captures tokens)
response = ct.track(client.messages.create(...))

# 3. Optionally report tool calls
ct.tool_call("query_db", params={"sql": "SELECT ..."})

# ── Human escalation ──────────────────────────────────────
esc_id   = ct.escalate("Should I reject this $48K invoice?", context="INV-8841")
decision = ct.wait_for_decision(esc_id)   # blocks until human decides
if decision == "approved":
    reject_invoice()

# ── Trigger another agent ─────────────────────────────────
run_id = ct.trigger("hr-agent-01", task="Onboard Alex Chen")
```

### LangChain — one-liner integration

```python
agent = initialize_agent(
    tools, llm,
    callbacks=[ct.as_langchain_callback()]  # tokens + tools auto-tracked
)
ct.start()
```

### CrewAI — one-liner integration

```python
crew = Crew(agents=[...], tasks=[...], step_callback=ct.as_crewai_callback())
ct.start(tools=[t for a in crew.agents for t in a.tools])
```

---

## Node.js agent — add 3 lines

```javascript
const { ControlTower } = require('./controlTower');

const ct = new ControlTower({
  agentId:    'finance-agent-01',
  name:       'Finance Agent',
  department: 'Finance',
  serverUrl:  'http://localhost:3000',
});

// 1. Start heartbeat
ct.start({ tools: toolsRegistry });   // object keys become tool names
                                       // or pass an array of strings/objects

// 2. Wrap every LLM call
const response = await ct.track(client.messages.create({...}));

// 3. Report tool calls
ct.toolCall('query_db', { sql: 'SELECT ...' });

// ── Human escalation ──────────────────────────────────────
const escId   = await ct.escalate('Should I reject this $48K invoice?');
const decision = await ct.waitForDecision(escId);

// ── Trigger another agent ─────────────────────────────────
const runId = await ct.trigger('hr-agent-01', 'Onboard Alex Chen');
```

### LangChain JS — one-liner

```javascript
const executor = await initializeAgentExecutorWithOptions(tools, llm, {
  callbacks: [ct.asLangChainCallback()],
});
ct.start({ tools });
```

---

## Heartbeat payload (what agents send)

```json
{
  "agent_id":          "finance-agent-01",
  "name":              "Finance Agent",
  "department":        "Finance",
  "status":            "busy",
  "current_task":      "Processing Q2 invoices",
  "model":             "claude-sonnet-4-20250514",
  "tools":             ["query_db", "send_report", "fetch_invoice"],
  "recent_tool_calls": ["query_db", "query_db"],
  "metrics": {
    "tokens_input":   1200,
    "tokens_output":  430,
    "tokens_total":   1630,
    "calls_made":     14,
    "error_rate":     0.02,
    "avg_latency_ms": 840
  },
  "event":        "tool_call",
  "event_detail": "query_db({sql: 'SELECT ...'})"
}
```

---

## Anomaly detection (built-in)

The server auto-detects and raises alerts for:

| Condition | Threshold | Alert severity |
|---|---|---|
| Token spike | >2.5× agent's rolling baseline | High |
| Tool loop | Same tool called ≥5× in one window | High |
| Silent failure | No heartbeat for 60 seconds | High |
| High error rate | >15% of calls erroring | Medium |

---

## Production notes

- **Storage**: Replace in-memory `store` in `server.js` with PostgreSQL / Redis.
- **Auth**: Add an `x-api-key` header check for the `/api/heartbeat` endpoint.
- **Scaling**: Run behind a load balancer; move store to Redis for multi-instance.
- **Dashboard**: Point the Control Tower UI at `http://your-server:3000` to connect.
