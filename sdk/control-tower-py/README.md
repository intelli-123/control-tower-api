# control-tower-sdk (Python)

Report your agent's status, tokens, cost and tool calls to the Agent Control Tower.

## Install
```bash
pip install control-tower-sdk            # once published
pip install ./sdk/control-tower-py       # from this repo
pip install "git+https://your.git/control-tower-api.git#subdirectory=sdk/control-tower-py"
```

## Use (zero-config via env)
```bash
export CONTROL_TOWER_URL=http://your-tower:3090
export CONTROL_TOWER_AGENT_ID=finance-agent
```
```python
from control_tower import ControlTower

ct = ControlTower(name="Finance Agent", framework="LangChain", model="claude-sonnet-4")
ct.start(tools=my_agent.tools)            # heartbeats → agent auto-registers in the tower

resp = ct.track(client.messages.create(...))   # capture token usage
ct.task_start("Process Q2 invoices")
ct.tool_call("query_db", {"sql": "SELECT ..."})
ct.task_complete(result="done")

# optional human-in-the-loop
eid = ct.escalate("Reject this $48K invoice?")
decision = ct.wait_for_decision(eid)

# optional LangChain / CrewAI callbacks (need langchain-core)
agent = initialize_agent(..., callbacks=[ct.as_langchain_callback()])
```
`agent_id`/`server_url` fall back to `CONTROL_TOWER_AGENT_ID`/`CONTROL_TOWER_URL`.
No required dependencies — `httpx` and `langchain-core` are optional. `AsyncControlTower` is included for asyncio apps.
