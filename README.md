# Agent Control Tower — Backend API

A lightweight Node.js API that all your agents report into.
Pairs with the Control Tower dashboard UI.

---

## Quick start

```bash
npm install
node server.js
# → running on http://localhost:3000
```

---

## File overview

| File | What it is |
|---|---|
| `server.js` | The API server (Express) |
| `control_tower.py` | Python SDK — drop into any Python agent |
| `controlTower.js` | Node.js SDK — drop into any Node agent |

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
