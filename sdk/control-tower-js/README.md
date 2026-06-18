# control-tower-sdk (Node.js)

Report your agent's status, tokens, cost and tool calls to the Agent Control Tower.

## Install
```bash
# from a published registry (once published)
npm install control-tower-sdk
# or directly from git / a local tarball
npm install git+https://your.git/control-tower-api.git#path:sdk/control-tower-js
npm install ./control-tower-sdk-1.0.0.tgz     # after `npm pack`
```

## Use (zero-config via env)
```bash
export CONTROL_TOWER_URL=http://your-tower:3090
export CONTROL_TOWER_AGENT_ID=weather-agent
```
```js
import { ControlTower } from 'control-tower-sdk';

const ct = new ControlTower({ name: 'Weather Agent', framework: 'LangChain', model: 'gpt-4o' });
ct.start({ tools });                       // begins heartbeats → agent auto-registers in the tower

// capture an LLM call's tokens
const res = await ct.track(client.messages.create({ /* ... */ }));

// task lifecycle + tool calls
ct.taskStart('Weather in Tokyo');
ct.toolCall('get_weather', { city: 'Tokyo' });
ct.taskComplete('Sunny, 24°C');

// optional LangChain integration (needs @langchain/core)
const cb = await ct.asLangChainCallback();
```
`serverUrl`/`agentId` come from `CONTROL_TOWER_URL`/`CONTROL_TOWER_AGENT_ID` if not passed.
The admin can then enrich the agent's metadata and map it to a Business Unit from the tower UI.

Core SDK has **no required dependencies** (`@langchain/core`, `llama3-tokenizer-js` are optional).

## OpenTelemetry mode (zero-code telemetry + heartbeat)

Prefer auto-instrumentation over wrapping calls? Launch your agent with the bundled
OTel preload — **no code changes**, works with any framework:

```bash
# 1. install OTel + an instrumentation for your framework
npm i @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
npm i @arizeai/openinference-instrumentation-langchain   # LangChain JS
# (or one line:  npm i @traceloop/node-server-sdk  — auto-covers OpenAI/Anthropic/LangChain)

# 2. run with the preload (must load BEFORE your app)
node --import control-tower-sdk/otel your-app.js
```

Reads the same env (`CONTROL_TOWER_URL`, `CONTROL_TOWER_AGENT_ID`, `CONTROL_TOWER_NAME`,
`CONTROL_TOWER_DEPARTMENT`). It:
- exports GenAI traces (tokens, cost, latency, tool calls, lineage) to `<CONTROL_TOWER_URL>/v1/traces`, and
- starts a **heartbeat** so the agent shows online/offline even when idle.

In OTel mode, **don't also call `ct.track()`/`asLangChainCallback()`** — OTel captures the
tokens, and doing both double-counts. Keep explicit SDK calls only for escalations/triggers.
If the OTel packages aren't installed, telemetry is skipped but the heartbeat still runs.
