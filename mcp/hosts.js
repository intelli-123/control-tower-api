/**
 * hosts.js — discover MCP servers from known MCP-host config files.
 *
 * Different apps (Claude Desktop, Cursor, VS Code, Windsurf, Cline, Claude Code)
 * store their MCP servers in different files, with slightly different schemas, on
 * macOS vs Windows. This module knows those locations and returns a normalized
 * list of server specs the monitor can connect to.
 */
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

const HOME    = os.homedir();
const APPDATA = process.env.APPDATA || join(HOME, 'AppData', 'Roaming');           // Windows
const MACSUP  = join(HOME, 'Library', 'Application Support');                       // macOS
const XDG     = process.env.XDG_CONFIG_HOME || join(HOME, '.config');              // Linux
const PLAT    = process.platform;  // 'win32' | 'darwin' | 'linux'

// key = JSON key holding the servers map (supports dot-path, e.g. "mcp.servers")
const HOSTS = [
  { id: 'claude',      label: 'Claude Desktop', key: 'mcpServers', paths: {
      win32:  [join(APPDATA, 'Claude', 'claude_desktop_config.json')],
      darwin: [join(MACSUP,  'Claude', 'claude_desktop_config.json')],
      linux:  [join(XDG,     'Claude', 'claude_desktop_config.json')] } },

  { id: 'cursor',      label: 'Cursor', key: 'mcpServers', paths: {
      all: [join(HOME, '.cursor', 'mcp.json'), join(process.cwd(), '.cursor', 'mcp.json')] } },

  { id: 'windsurf',    label: 'Windsurf', key: 'mcpServers', paths: {
      all: [join(HOME, '.codeium', 'windsurf', 'mcp_config.json')] } },

  { id: 'vscode',      label: 'VS Code', key: 'servers', paths: {       // .vscode/mcp.json uses "servers"
      win32:  [join(APPDATA, 'Code', 'User', 'mcp.json')],
      darwin: [join(MACSUP,  'Code', 'User', 'mcp.json')],
      linux:  [join(XDG,     'Code', 'User', 'mcp.json')],
      all:    [join(process.cwd(), '.vscode', 'mcp.json')] } },

  { id: 'vscode-settings', label: 'VS Code (settings)', key: 'mcp.servers', paths: {
      win32:  [join(APPDATA, 'Code', 'User', 'settings.json')],
      darwin: [join(MACSUP,  'Code', 'User', 'settings.json')],
      linux:  [join(XDG,     'Code', 'User', 'settings.json')] } },

  { id: 'cline',       label: 'Cline', key: 'mcpServers', paths: {
      win32:  [join(APPDATA, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')],
      darwin: [join(MACSUP,  'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')] } },

  { id: 'claude-code', label: 'Claude Code', key: 'mcpServers', paths: {
      all: [join(HOME, '.claude.json'), join(process.cwd(), '.mcp.json')] } },
];

function getByPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function pathsFor(host) {
  return [...(host.paths[PLAT] || []), ...(host.paths.all || [])];
}

function mapEntry(host, name, def) {
  const isRemote = !!def.url;
  const transport = isRemote ? (def.type === 'http' || def.type === 'streamable-http' ? 'http'
                              : def.type === 'sse' ? 'sse' : 'auto') : undefined;
  return {
    name:       `${host.id}:${name}`,   // unique across hosts
    department: host.label,             // group by host in the dashboard
    url:        def.url,
    command:    def.command,
    args:       def.args || [],
    env:        def.env || {},
    transport,
  };
}

/**
 * @param {'all'|string[]} which  host ids to scan ('all' = every known host)
 * @returns {{servers:Array, found:Array<{host:string,path:string,count:number}>}}
 */
export function discoverHosts(which = 'all') {
  const wanted = which === 'all' ? HOSTS.map(h => h.id) : (Array.isArray(which) ? which : [which]);
  const servers = [], found = [];
  for (const host of HOSTS) {
    if (!wanted.includes(host.id)) continue;
    for (const p of pathsFor(host)) {
      if (!existsSync(p)) continue;
      try {
        const json = JSON.parse(readFileSync(p, 'utf8'));
        const map  = getByPath(json, host.key) || {};
        const entries = Object.entries(map);
        entries.forEach(([name, def]) => servers.push(mapEntry(host, name, def)));
        if (entries.length) found.push({ host: host.label, path: p, count: entries.length });
      } catch (e) {
        console.error(`[mcp-monitor] Could not read ${host.label} config (${p}): ${e.message}`);
      }
    }
  }
  return { servers, found };
}

export default { discoverHosts };
