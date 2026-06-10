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
