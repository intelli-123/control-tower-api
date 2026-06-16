/**
 * monitor.js — built-in MCP monitoring for the Control Tower.
 *
 * Started automatically by server.js on boot (no separate process). Reads
 * mcp/mcp-config.json (override with CT_MCP_CONFIG), discovers MCP servers
 * from installed hosts and/or an explicit list, and connects a
 * MonitoredMcpClient for each — reporting health/tools/tokens/latency back to
 * this same Control Tower over HTTP.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MonitoredMcpClient } from './mcpClient.js';
import { discoverHosts } from './hosts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig(configPath) {
  const p = configPath || process.env.CT_MCP_CONFIG || join(__dirname, 'mcp-config.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn(`[mcp] no config at ${p} (${e.code || e.message}); defaulting to discoverHosts:'all'`);
    return { discoverHosts: 'all', servers: [] };
  }
}

function importClaudeServers(claudePath) {
  try {
    const raw = JSON.parse(readFileSync(claudePath, 'utf8'));
    return Object.entries(raw.mcpServers || {}).map(([name, def]) => ({
      name, url: def.url, command: def.command, args: def.args || [], env: def.env || {},
      transport: def.url ? (def.type || 'auto') : undefined,
    }));
  } catch (e) {
    console.error(`[mcp] could not import Claude config (${claudePath}): ${e.message}`);
    return [];
  }
}

/**
 * Identity of an MCP server by what it actually connects to — not its name.
 * The same server is frequently configured in several hosts under different
 * names (e.g. an explicit `gitmcp` url and a Claude `mcp-remote <same-url>`),
 * so we key on the resolved endpoint: an explicit url, a url embedded in the
 * launch args (mcp-remote/supergateway style), else the command + args.
 */
function canonicalTarget(s) {
  let url = s.url;
  if (!url && Array.isArray(s.args)) url = s.args.find(a => /^https?:\/\//i.test(a));
  if (url) {
    try { const u = new URL(url); return 'url:' + (u.host + u.pathname).replace(/\/+$/, '').toLowerCase(); }
    catch { return 'url:' + String(url).replace(/\/+$/, '').toLowerCase(); }
  }
  return 'cmd:' + [s.command, ...(s.args || [])].join(' ').trim().toLowerCase();
}

function gatherServers(cfg) {
  const all = [...(cfg.servers || [])];
  if (cfg.claudeConfigPath) all.push(...importClaudeServers(cfg.claudeConfigPath));
  if (cfg.discoverHosts) {
    const { servers, found } = discoverHosts(cfg.discoverHosts);
    found.forEach(f => console.log(`[mcp] found ${f.count} MCP(s) in ${f.host} → ${f.path}`));
    all.push(...servers);
  }
  // Dedupe by name AND by resolved target, so the same server discovered from
  // multiple host configs is monitored once (first occurrence wins).
  const seenName = new Set(), seenTarget = new Set();
  const out = [];
  for (const s of all) {
    if (!s || !s.name || seenName.has(s.name)) continue;
    const tgt = canonicalTarget(s);
    if (seenTarget.has(tgt)) {
      console.log(`[mcp] skipping "${s.name}" — duplicate of an earlier server (same target: ${tgt})`);
      continue;
    }
    seenName.add(s.name); seenTarget.add(tgt); out.push(s);
  }
  return out;
}

let _clients = [];

/** Start monitoring. Returns { stop() }. Never throws — failures are logged. */
export async function startMcpMonitoring({ serverUrl, configPath } = {}) {
  const cfg = loadConfig(configPath);
  const url = serverUrl || cfg.controlTowerUrl || 'http://localhost:3090';
  const healthIntervalMs = cfg.healthIntervalMs || 15000;
  const specs = gatherServers(cfg);

  if (!specs.length) {
    console.log('[mcp] no MCP servers configured/discovered — monitor idle');
    return { stop() {} };
  }
  console.log(`[mcp] monitoring ${specs.length} MCP server(s) → ${url}`);

  for (const s of specs) {
    const mc = new MonitoredMcpClient({
      name: s.name, url: s.url, command: s.command, args: s.args || [], env: s.env || {},
      department: s.department, transport: s.transport || 'auto', serverUrl: url, healthIntervalMs,
    });
    // Fire-and-forget connect so one bad server never blocks the others / the server.
    mc.connect().then(() => _clients.push(mc))
      .catch(e => console.error(`[mcp] connect failed ${s.name} (${s.url || [s.command, ...(s.args || [])].join(' ')}): ${e.message}`));
  }

  return {
    async stop() { await Promise.all(_clients.map(c => c.disconnect())); _clients = []; },
  };
}

export default { startMcpMonitoring };
