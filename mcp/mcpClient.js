/**
 * mcpClient.js — MonitoredMcpClient
 *
 * Wraps a remote MCP server and reports it to the Control Tower as an agent,
 * WITHOUT the MCP server exposing any health endpoint or reporting tokens:
 *
 *   • Health  — via the MCP protocol `ping` (no custom endpoint needed)
 *   • Tools   — discovered via `tools/list`
 *   • Tokens  — counted locally (tokenCounter) from tool schemas, call args,
 *               and results — provider-independent
 *   • Latency — measured per `tools/call`
 *
 * Transports: supports BOTH Streamable HTTP and SSE. transport='auto' tries
 * Streamable HTTP first and falls back to SSE.
 *
 * Reuses the existing ControlTower SDK as-is for reporting.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ControlTower } from './controlTower.js';
import { countJson, countTokens } from './tokenCounter.js';

export class MonitoredMcpClient {
  constructor({
    name,
    url,                                         // for http/sse transports
    command,                                     // for stdio transport (e.g. 'npx')
    args              = [],                       // e.g. ['-y', '@scope/mcp-server']
    env               = {},                       // extra env vars for the stdio child
    transport         = 'auto',                  // 'auto' | 'http' | 'sse' | 'stdio'
    serverUrl         = 'http://localhost:3090', // Control Tower base URL
    department        = 'MCP',
    tokenizerModel    = 'mcp-llama3',
    healthIntervalMs  = 15000,
  }) {
    if (!name) throw new Error('MonitoredMcpClient: name is required');
    if (!url && !command) {
      throw new Error('MonitoredMcpClient: provide either url (http/sse) or command (stdio, e.g. npx)');
    }

    this.name           = name;
    this.url            = url ? new URL(url) : null;
    this.command        = command;
    this.args           = args;
    this.env            = env;
    // A command implies stdio; otherwise honor the requested network transport.
    this.transportMode  = command ? 'stdio' : transport;
    this.tokenizerModel = tokenizerModel;
    this.healthIntervalMs = healthIntervalMs;

    const label = command ? `stdio:${[command, ...args].join(' ')}`.slice(0, 60) : `mcp:${this.url.host}`;
    this.client = new Client({ name: `control-tower-${name}`, version: '1.0.0' }, { capabilities: {} });
    this.ct     = new ControlTower({ agentId: name, name, department, serverUrl, model: label, framework: 'MCP' });

    this.tools           = [];
    this.schemaTokens    = 0;
    this.activeTransport = null;
    this._connected      = false;
    this._healthTimer    = null;
  }

  // ── Connect (with transport auto-detect) ───────────────────────────────────
  async connect() {
    const tryStdio = async () => {
      // Spawns the MCP as a child process (e.g. `npx -y <pkg>`) and talks stdio.
      await this.client.connect(new StdioClientTransport({
        command: this.command,
        args:    this.args,
        env:     { ...process.env, ...this.env },
      }));
      return 'stdio';
    };
    const tryHttp = async () => {
      await this.client.connect(new StreamableHTTPClientTransport(this.url));
      return 'http';
    };
    const trySse = async () => {
      await this.client.connect(new SSEClientTransport(this.url));
      return 'sse';
    };

    if (this.transportMode === 'stdio')     this.activeTransport = await tryStdio();
    else if (this.transportMode === 'http') this.activeTransport = await tryHttp();
    else if (this.transportMode === 'sse')  this.activeTransport = await trySse();
    else {
      try {
        this.activeTransport = await tryHttp();
      } catch (e) {
        console.warn(`[MCP ${this.name}] Streamable HTTP failed (${e.message}); falling back to SSE`);
        this.activeTransport = await trySse();
      }
    }
    this._connected = true;
    console.log(`[MCP ${this.name}] connected via ${this.activeTransport}`);

    // Discover tools (identity + capabilities) and the schema's token footprint.
    const listed = await this.client.listTools();
    this.tools = (listed.tools || []).map(t => t.name);
    this.schemaTokens = 0;
    for (const t of (listed.tools || [])) {
      this.schemaTokens += await countJson(
        { name: t.name, description: t.description, parameters: t.inputSchema },
        this.tokenizerModel,
      );
    }

    // Report to the Control Tower using the existing SDK.
    this.ct.start({ tools: this.tools, getStatus: () => (this._connected ? 'ready' : 'offline') });
    this.ct._tokensInput += this.schemaTokens; // one-time context cost of exposing this MCP
    await this.ct._post('/api/heartbeat', this.ct._buildPayload({
      event: 'mcp_connected',
      eventDetail: `transport=${this.activeTransport}, ${this.tools.length} tools, schema ~${this.schemaTokens} tok`,
    }));

    this.startHealthLoop();
    return this.activeTransport;
  }

  // ── Health via MCP ping (no agent endpoint required) ───────────────────────
  startHealthLoop() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._healthTimer = setInterval(() => this._pingOnce(), this.healthIntervalMs);
  }

  async _pingOnce() {
    try {
      await this.client.ping();
      this._connected = true;
      this.ct.setStatus('ready');
    } catch (e) {
      this._connected = false;
      this.ct.setStatus('error', `ping failed: ${e.message}`);
    }
  }

  // ── Instrumented tool call (latency + tokens) ──────────────────────────────
  async callTool(name, args = {}) {
    const t0 = Date.now();
    this.ct.taskStart(`callTool:${name}`);
    try {
      const inTok  = await countJson(args, this.tokenizerModel);
      const result = await this.client.callTool({ name, arguments: args });

      const outText = JSON.stringify(result?.content ?? result ?? {});
      const outTok  = await countTokens(outText, this.tokenizerModel);

      // Provider-independent token accounting, reported through the SDK.
      this.ct._tokensInput  += inTok;
      this.ct._tokensOutput += outTok;
      this.ct.toolCall(name, args); // posts a heartbeat carrying these tokens

      this.ct.taskComplete(`${name} ok (${Date.now() - t0}ms, in=${inTok} out=${outTok})`);
      return result;
    } catch (e) {
      this.ct.toolCall(name, args, null, e.message);
      this.ct.setStatus('error', e.message);
      this.ct.taskComplete(`${name} error: ${e.message}`);
      throw e;
    }
  }

  async listTools() { return this.client.listTools(); }

  /**
   * Register a server that FAILED to connect as an offline agent in the tower,
   * carrying the reason — so the dashboard shows "not active" + why, instead of
   * the server silently never appearing.
   */
  async reportConnectFailure(message) {
    const reason = ('Connect failed: ' + (message || 'unknown error')).slice(0, 300);
    this._connected = false;
    this.ct.setStatus('offline', reason);
    // Keep heartbeating as offline so it stays visible with the reason attached.
    this.ct.start({ tools: [], getStatus: () => 'offline' });
    try {
      await this.ct._post('/api/heartbeat', this.ct._buildPayload({
        event: 'mcp_connect_failed', eventDetail: reason,
      }));
    } catch { /* ignore */ }
  }

  async disconnect() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._connected = false;
    this.ct.setStatus('offline');
    this.ct.stop();
    try { await this.client.close(); } catch { /* ignore */ }
  }
}

export default MonitoredMcpClient;
