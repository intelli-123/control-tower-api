/**
 * control-tower-sdk/otel — zero-code OpenTelemetry bootstrap + heartbeat.
 *
 * Preload this BEFORE your app so OTel can instrument your LLM/agent libraries:
 *
 *     node --import control-tower-sdk/otel your-app.js
 *     # or:  NODE_OPTIONS="--import control-tower-sdk/otel" node your-app.js
 *
 * It does two things from your existing .env — no code changes in the agent:
 *   1. Telemetry  — exports GenAI traces (tokens, cost, latency, tool calls,
 *      lineage) to the Control Tower's OTLP receiver at <CONTROL_TOWER_URL>/v1/traces.
 *   2. Liveness   — starts a lightweight heartbeat so the tower shows the agent
 *      online/offline even when it is idle (OTel only emits on activity).
 *
 * Env (same as the SDK):
 *   CONTROL_TOWER_URL          default http://localhost:3090
 *   CONTROL_TOWER_AGENT_ID     service.name for traces + heartbeat id
 *   CONTROL_TOWER_NAME / _DEPARTMENT / _HEARTBEAT_SEC
 *
 * GenAI capture: install an instrumentation for your framework, e.g.
 *   npm i @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
 *   npm i @arizeai/openinference-instrumentation-langchain   # for LangChain JS
 *   # or one-line OpenLLMetry:  npm i @traceloop/node-server-sdk
 * If none are present, the heartbeat still works; only token/tool spans are skipped.
 */

const base    = (process.env.CONTROL_TOWER_URL || 'http://localhost:3090').replace(/\/$/, '');
const agentId = process.env.CONTROL_TOWER_AGENT_ID || process.env.OTEL_SERVICE_NAME || 'otel-agent';
const name    = process.env.CONTROL_TOWER_NAME || agentId;
const dept    = process.env.CONTROL_TOWER_DEPARTMENT || 'Unknown';
const tracesUrl = `${base}/v1/traces`;

// NodeSDK reads these for the resource + exporter target (version-robust: avoids
// the churn in the Resource/resourceFromAttributes API across OTel releases).
process.env.OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME || agentId;
process.env.OTEL_RESOURCE_ATTRIBUTES =
  [`service.namespace=${dept}`, process.env.OTEL_RESOURCE_ATTRIBUTES].filter(Boolean).join(',');
process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || tracesUrl;

const log = (...a) => console.log('[control-tower/otel]', ...a);

// ── 1. OpenTelemetry tracing (best-effort; never blocks the agent) ───────────
(async () => {
  try {
    // One-line OpenLLMetry if present — broadest GenAI coverage.
    try {
      const tl = await import('@traceloop/node-server-sdk');
      tl.initialize({ appName: agentId, baseUrl: base, disableBatch: true });
      log('OpenLLMetry (Traceloop) initialized → ' + tracesUrl);
      return;
    } catch { /* not installed — fall back to plain NodeSDK */ }

    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');

    const instrumentations = [];
    // Pull in whatever GenAI/framework instrumentations the agent installed.
    const tryInstr = async (pkg, make) => {
      try { const m = await import(pkg); instrumentations.push(make(m)); log('instrumentation:', pkg); }
      catch { /* not installed */ }
    };
    await tryInstr('@arizeai/openinference-instrumentation-langchain', m => new m.LangChainInstrumentation());
    await tryInstr('@arizeai/openinference-instrumentation-openai',    m => new m.OpenAIInstrumentation());
    await tryInstr('@opentelemetry/auto-instrumentations-node',        m => m.getNodeAutoInstrumentations());

    const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter({ url: tracesUrl }), instrumentations: instrumentations.flat() });
    sdk.start();
    log('OpenTelemetry started → ' + tracesUrl + (instrumentations.length ? '' : ' (no GenAI instrumentation installed — token/tool spans will be limited)'));
    process.once('SIGTERM', () => sdk.shutdown().catch(() => {}));
  } catch (e) {
    log('OTel not available (' + e.message + ') — telemetry disabled; heartbeat still runs.');
    log('Install: npm i @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http');
  }
})();

// ── 2. Liveness heartbeat (so idle agents still show online) ─────────────────
(async () => {
  try {
    const { ControlTower } = await import('./controlTower.js');
    // model:null/framework:'OTel' so the heartbeat doesn't clobber the model OTel reports.
    const ct = new ControlTower({ agentId, name, department: dept, serverUrl: base, framework: 'OTel', model: null });
    ct.start();   // heartbeat-only: we never call track()/toolCall(), so no token double-count
    log('heartbeat started for ' + agentId + ' → ' + base);
  } catch (e) {
    log('heartbeat failed to start: ' + e.message);
  }
})();
