/**
 * controlTower.js — Drop-in SDK for Node.js agents
 *
 * Works with LangChain JS, any custom agent, or raw Anthropic SDK.
 *
 * Usage:
 *
 *   const { ControlTower } = require('./controlTower');
 *
 *   const ct = new ControlTower({
 *     agentId:    'finance-agent-01',
 *     name:       'Finance Agent',
 *     department: 'Finance',
 *     serverUrl:  'http://localhost:3000', Control tower url
 *   });
 *
 *   // Auto-discover tools from a registry object or array
 *   ct.start({ tools: toolsRegistry });
 *
 *   // Track an Anthropic/OpenAI response (auto-captures tokens)
 *   const response = await ct.track(client.messages.create({...}));
 *
 *   // Report a tool call
 *   ct.toolCall('query_db', { sql: 'SELECT ...' });
 *
 *   // Create a human escalation and wait for decision
 *   const escId   = await ct.escalate('Should I reject this $48K invoice?');
 *   const decision = await ct.waitForDecision(escId);
 *
 *   // Trigger another agent
 *   const runId = await ct.trigger('hr-agent-01', 'Onboard Alex Chen');
 */

import https from 'https';
import http from 'http';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { join } from 'path';

// Load an optional integration, preferring the HOST app's node_modules (this
// package may be symlinked via `file:` installs, where package-relative
// resolution can't see the app's deps), then falling back to package-relative.
async function loadOptional(spec) {
  try {
    const req = createRequire(join(process.cwd(), 'noop.js'));
    return await import(pathToFileURL(req.resolve(spec)).href);
  } catch { /* try package-relative next */ }
  try { return await import(spec); } catch { return null; }
}

class ControlTower {
  /**
   * Zero-config friendly: serverUrl falls back to CONTROL_TOWER_URL,
   * agentId to CONTROL_TOWER_AGENT_ID.
   * @param {object} opts
   * @param {string} [opts.agentId]         Unique agent id (or env CONTROL_TOWER_AGENT_ID).
   * @param {string} [opts.serverUrl]       Tower URL (or env CONTROL_TOWER_URL; default http://localhost:3090).
   * @param {string} [opts.name] [opts.department] [opts.model] [opts.framework]
   * @param {number} [opts.heartbeatInterval]  Seconds between heartbeats. Default: 30.
   */
  constructor({
    agentId            = process.env.CONTROL_TOWER_AGENT_ID,
    serverUrl          = process.env.CONTROL_TOWER_URL || 'http://localhost:3090',
    name               = process.env.CONTROL_TOWER_NAME || null,
    department         = process.env.CONTROL_TOWER_DEPARTMENT || 'Unknown',
    model              = process.env.CONTROL_TOWER_MODEL || null,
    framework          = process.env.CONTROL_TOWER_FRAMEWORK || null,
    heartbeatInterval  = Number(process.env.CONTROL_TOWER_HEARTBEAT_SEC) || 30,
  } = {}) {
    if (!agentId) throw new Error('ControlTower: agentId is required (pass it or set CONTROL_TOWER_AGENT_ID)');

    this.agentId    = agentId;
    this.serverUrl  = serverUrl.replace(/\/$/, '');
    this.name       = name || agentId;
    this.department = department;
    this.model      = model;
    this.framework  = framework;
    this.interval   = heartbeatInterval * 1000;

    // Rolling metrics (reset each heartbeat)
    this._tokensInput  = 0;
    this._tokensOutput = 0;
    this._callsMade    = 0;
    this._errorCount   = 0;
    this._latencies    = [];
    this._recentTools  = [];

    // State
    this._status      = 'ready';
    this._currentTask = null;
    this._tools       = [];

    this._timer       = null;
    this._getStatusFn = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Start the background heartbeat.
   * @param {object} opts
   * @param {object|Array|Function} [opts.tools]  Tool registry, array, or () => string[]
   * @param {Function} [opts.getStatus]           () => 'ready'|'busy'|'error'
   */
  start({ tools, getStatus } = {}) {
    if (tools) this._tools = this._normalizeTools(tools);
    if (getStatus) this._getStatusFn = getStatus;

    this._timer = setInterval(() => this._heartbeatTick(), this.interval);
    this._heartbeatTick(); // send immediately on start
    console.log(`[ControlTower] Heartbeat started for ${this.agentId} → ${this.serverUrl}`);
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Update agent status. Call at start/end of tasks. */
  setStatus(status, task = null) {
    this._status = status;
    if (task !== null) this._currentTask = task;
  }

  /** Update the tool list dynamically. */
  setTools(tools) {
    this._tools = this._normalizeTools(tools);
  }

  /**
   * Wrap an Anthropic/OpenAI call to auto-capture tokens.
   * Works with Promise-based responses.
   *
   *   const response = await ct.track(client.messages.create({...}));
   */
  async track(promise) {
    const start    = Date.now();
    const response = await promise;
    this._latencies.push(Date.now() - start);
    this._callsMade++;

    try {
      const usage = response?.usage;
      if (usage) {
        // Anthropic SDK
        this._tokensInput  += usage.input_tokens  || 0;
        this._tokensOutput += usage.output_tokens || 0;

        // Fire an immediate audit event
        await this._post('/api/heartbeat', this._buildPayload({
          event:        'llm_response',
          eventDetail:  `Tokens: in=${usage.input_tokens || 0} out=${usage.output_tokens || 0}`,
        }));
      }
    } catch { /* never let tracking crash the agent */ }

    return response;
  }

  /** Report a tool call. */
  toolCall(toolName, params = {}, result = null, error = null) {
    this._recentTools.push(toolName);
    if (this._recentTools.length > 20) this._recentTools = this._recentTools.slice(-20);
    if (error) this._errorCount++;

    const detail = `${toolName}(${JSON.stringify(params).slice(0, 150)})` +
                   (error ? ` → ERROR: ${error}` : '');

    this._post('/api/heartbeat', this._buildPayload({
      event: 'tool_call', eventDetail: detail,
    })).catch(() => {});
  }

  /** Call when your agent starts a new task. */
  taskStart(task) {
    this.setStatus('busy', task);
    this._post('/api/heartbeat', this._buildPayload({
      event: 'task_start', eventDetail: task,
    })).catch(() => {});
  }

  /** Call when your agent finishes a task. */
  taskComplete(result = '') {
    this.setStatus('ready', null);
    this._post('/api/heartbeat', this._buildPayload({
      event: 'task_complete', eventDetail: result,
    })).catch(() => {});
  }

  /**
   * Create a human escalation. Returns escalation_id.
   * @returns {Promise<string>} escalation_id
   */
  async escalate(question, { context = '', urgency = 'normal', options = ['approve', 'reject'] } = {}) {
    const resp = await this._post('/api/escalation', {
      agent_id: this.agentId,
      question,
      context,
      urgency,
      options,
    });
    if (!resp?.escalation_id) throw new Error(`Failed to create escalation: ${JSON.stringify(resp)}`);
    return resp.escalation_id;
  }

  /**
   * Poll until a human decides on an escalation.
   * @returns {Promise<string>} decision: 'approved'|'rejected'|'hold'
   */
  async waitForDecision(escalationId, { pollIntervalMs = 5000, timeoutMs = 3_600_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const resp = await this._get(`/api/escalations/${escalationId}`);
      if (resp?.status === 'resolved' || resp?.status === 'on_hold') {
        return resp.decision;
      }
      await _sleep(pollIntervalMs);
    }
    throw new Error(`Timeout waiting for escalation decision: ${escalationId}`);
  }

  /**
   * Trigger another agent.
   * @returns {Promise<string>} run_id
   */
  async trigger(agentId, task, { priority = 'normal', params = {} } = {}) {
    const resp = await this._post('/api/trigger', {
      agent_id:     agentId,
      task,
      priority,
      triggered_by: this.agentId,
      params,
    });
    if (!resp?.run_id) throw new Error(`Failed to trigger agent: ${JSON.stringify(resp)}`);
    return resp.run_id;
  }

  // ── LangChain JS integration ────────────────────────────────────────────────

  /**
   * Returns a LangChain BaseCallbackHandler that auto-tracks everything.
   *
   *   const agent = await initializeAgentExecutorWithOptions(tools, llm, {
   *     callbacks: [ct.asLangChainCallback()],
   *   });
   */
  async asLangChainCallback() {
    const ct = this;
    const mod = await loadOptional('@langchain/core/callbacks/base');
    const BaseCallbackHandler = mod && mod.BaseCallbackHandler;
    if (!BaseCallbackHandler) { console.warn('[ControlTower] @langchain/core not found — callback unavailable'); return undefined; }
    // Optional dep → async. Use: callbacks: [await ct.asLangChainCallback()]
    return BaseCallbackHandler.fromMethods({
      handleLLMEnd(output) {
        const usage  = output.llmOutput?.tokenUsage || {};
        const inTok  = usage.promptTokens     || 0;
        const outTok = usage.completionTokens || 0;
        ct._tokensInput  += inTok;
        ct._tokensOutput += outTok;
        ct._callsMade++;
        // Attribute tokens to the LLM call itself (emit an llm_response event)
        // rather than letting them ride along on the next tool_call heartbeat.
        ct._post('/api/heartbeat', ct._buildPayload({
          event: 'llm_response', eventDetail: `Tokens: in=${inTok} out=${outTok}`,
        })).catch(() => {});
      },
      handleToolStart(tool, input, _runId, _parentRunId, _tags, _metadata, runName) {
        // The serialized `tool` has no usable .name — LangChain passes the tool's
        // real name as runName (fall back to the serialized class id, then 'tool').
        const name = runName || tool?.name || tool?.id?.[tool.id?.length - 1] || 'tool';
        ct.toolCall(name, { input: String(input).slice(0, 200) });
      },
      handleToolError(err) {
        ct._errorCount++;
      },
      handleAgentAction(action) {
        ct.setStatus('busy', String(action.tool).slice(0, 100));
      },
      handleAgentEnd() {
        ct.setStatus('ready');
      },
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  async _heartbeatTick() {
    try {
      const status = this._getStatusFn ? this._getStatusFn() : this._status;
      await this._post('/api/heartbeat', this._buildPayload({ status }));
      // Reset interval counters
      this._tokensInput  = 0;
      this._tokensOutput = 0;
      this._callsMade    = 0;
      this._errorCount   = 0;
      this._latencies    = [];
      this._recentTools  = [];
    } catch { /* never crash */ }
  }

  _buildPayload({ status, event, eventDetail } = {}) {
    const total  = this._tokensInput + this._tokensOutput;
    const errRate = this._callsMade > 0 ? +(this._errorCount / this._callsMade).toFixed(4) : 0;
    const avgLat  = this._latencies.length
      ? +(this._latencies.reduce((a, b) => a + b, 0) / this._latencies.length).toFixed(1)
      : 0;

    const payload = {
      agent_id:          this.agentId,
      name:              this.name,
      department:        this.department,
      status:            status || this._status,
      current_task:      this._currentTask,
      model:             this.model,
      framework:         this.framework,
      tools:             this._tools,
      recent_tool_calls: this._recentTools.slice(-10),
      metrics: {
        tokens_input:   this._tokensInput,
        tokens_output:  this._tokensOutput,
        tokens_total:   total,
        calls_made:     this._callsMade,
        error_rate:     errRate,
        avg_latency_ms: avgLat,
      },
    };

    if (event) {
      payload.event        = event;
      payload.event_detail = eventDetail || '';
    }

    // Delta reporting: the server SUMS tokens & calls from every heartbeat it
    // receives, but one request can emit several heartbeats (event posts,
    // taskComplete, and the periodic tick). Clear the additive counters once
    // they've been packed into a payload so the same usage isn't counted 2–3×.
    this._tokensInput  = 0;
    this._tokensOutput = 0;
    this._callsMade    = 0;
    this._errorCount   = 0;

    return payload;
  }

  _normalizeTools(tools) {
    if (typeof tools === 'function') return tools();
    if (Array.isArray(tools))
      return tools.map(t => typeof t === 'string' ? t : t?.name || String(t));
    if (typeof tools === 'object')
      return Object.keys(tools);
    return [];
  }

  async _post(path, data) {
    return _request('POST', this.serverUrl + path, data);
  }

  async _get(path) {
    return _request('GET', this.serverUrl + path);
  }
}

// ── HTTP helper (no deps) ─────────────────────────────────────────────────────
function _request(method, urlStr, body = null) {
  return new Promise((resolve) => {
    try {
      const url     = new URL(urlStr);
      const lib     = url.protocol === 'https:' ? https : http;
      const payload = body ? JSON.stringify(body) : null;

      const opts = {
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method,
        headers:  { 'Content-Type': 'application/json', 'Content-Length': payload ? Buffer.byteLength(payload) : 0 },
      };

      const req = lib.request(opts, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
      });

      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      if (payload) req.write(payload);
      req.end();
    } catch { resolve(null); }
  });
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export { ControlTower };
