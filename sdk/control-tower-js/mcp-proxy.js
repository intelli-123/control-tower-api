#!/usr/bin/env node
/**
 * control-tower-mcp-proxy — transparent MCP stdio proxy that meters tool calls.
 *
 * Put it BETWEEN an MCP host (e.g. Claude Desktop) and the real MCP server, so
 * every tools/call passes through the tower and updates tokens/latency LIVE
 * (passive monitoring can't see host→server traffic — a proxy can).
 *
 *   Host config:
 *     "weather": {
 *       "command": "npx",
 *       "args": ["-y","control-tower-mcp-proxy","--","npx","-y","@scope/weather-mcp@latest"],
 *       "env": { "CONTROL_TOWER_URL":"http://localhost:3090",
 *                "CONTROL_TOWER_AGENT_ID":"weather-mcp",
 *                "CONTROL_TOWER_NAME":"Weather MCP",
 *                "CONTROL_TOWER_DEPARTMENT":"Engineering" }
 *     }
 *
 * It spawns the real server, forwards the JSON-RPC stream verbatim in both
 * directions, and reports each tools/call (name, tokens, latency, errors) to the
 * Control Tower. stdout is reserved for the protocol; all logging goes to stderr.
 */

// CRITICAL: stdout is the MCP channel — keep it clean. Route all logging to stderr.
console.log = console.info = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

import { spawn } from 'node:child_process';
import { ControlTower } from './controlTower.js';

// Target command = args after `--`, else all args.
let argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep !== -1) argv = argv.slice(sep + 1);
if (!argv.length) { process.stderr.write('[ct-proxy] usage: control-tower-mcp-proxy [--] <command> [args...]\n'); process.exit(2); }
const [cmd, ...args] = argv;

const target = [cmd, ...args].join(' ');
const agentId = process.env.CONTROL_TOWER_AGENT_ID
  || ('mcp:' + (args[args.length - 1] || cmd).replace(/[^a-zA-Z0-9._@/-]/g, '').slice(-40));

const ct = new ControlTower({
  agentId,
  name:       process.env.CONTROL_TOWER_NAME || agentId,
  department: process.env.CONTROL_TOWER_DEPARTMENT || 'MCP',
  framework:  'MCP',
  model:      process.env.CONTROL_TOWER_MODEL || ('stdio:' + target).slice(0, 60),
  serverUrl:  process.env.CONTROL_TOWER_URL || 'http://localhost:3090',
});
ct.start({ tools: [] });
console.log(`[ct-proxy] proxying "${target}" as "${agentId}" → ${ct.serverUrl}`);

// Rough, dependency-free token estimate (~4 chars/token). The tower computes cost.
const est = v => Math.ceil((typeof v === 'string' ? v : JSON.stringify(v ?? '')).length / 4);

const pendingCalls = new Map();   // jsonrpc id -> { name, args, start }
const pendingLists = new Set();   // ids of tools/list requests

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: process.platform === 'win32' });
child.on('error', e => { process.stderr.write(`[ct-proxy] failed to start target: ${e.message}\n`); process.exit(1); });
child.on('exit', code => { try { ct.setStatus('offline'); ct.stop(); } catch {} process.exit(code == null ? 0 : code); });

// Host (our stdin) → real server (child stdin)
linePump(process.stdin, (line) => {
  let m; try { m = JSON.parse(line); } catch { child.stdin.write(line + '\n'); return; }
  if (m && m.id != null && m.method === 'tools/call') {
    const name = (m.params && m.params.name) || 'tool';
    pendingCalls.set(m.id, { name, args: (m.params && m.params.arguments) || {}, start: Date.now() });
  } else if (m && m.id != null && m.method === 'tools/list') {
    pendingLists.add(m.id);
  }
  child.stdin.write(line + '\n');
});

// Real server (child stdout) → host (our stdout)
linePump(child.stdout, (line) => {
  process.stdout.write(line + '\n');           // forward FIRST — never block the protocol
  let m; try { m = JSON.parse(line); } catch { return; }
  if (!m || m.id == null) return;
  if (pendingCalls.has(m.id)) {
    const p = pendingCalls.get(m.id); pendingCalls.delete(m.id);
    const isErr = m.error != null;
    const out = isErr ? m.error : (m.result != null ? m.result : {});
    const inTok = est(p.args), outTok = est(out);
    try {
      ct.recordCall(p.name, {
        latencyMs: Date.now() - p.start, inputTokens: inTok, outputTokens: outTok,
        error: isErr ? (m.error.message || 'error') : null,
      });
    } catch {}
  } else if (pendingLists.has(m.id)) {
    pendingLists.delete(m.id);
    const tools = ((m.result && m.result.tools) || []).map(t => t.name).filter(Boolean);
    if (tools.length) try { ct.setTools(tools); } catch {}
  }
});

// Split a stream into newline-delimited messages (MCP stdio framing).
function linePump(stream, onLine) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
  stream.on('end', () => { if (buf.trim()) onLine(buf); });
}
