/**
 * tokenCounter.js — provider-independent token counting layer.
 *
 * Counts tokens locally from text using an open-source tokenizer, so token
 * accounting NEVER depends on the model/provider returning `usage`. This is
 * what lets us measure tokens for things that report nothing on their own
 * (e.g. a remote MCP's tool schemas, args, and results).
 *
 * Tokenizer is chosen by model family and loaded lazily. Falls back to a
 * ~4-chars/token heuristic if the tokenizer package isn't installed, so the
 * layer always returns a number.
 */

let _llama3 = null; // null = not tried, false = unavailable, object = loaded

async function getLlama3() {
  if (_llama3 === null) {
    try {
      const mod = await import('llama3-tokenizer-js');
      _llama3 = mod.default || mod;
    } catch {
      _llama3 = false;
      console.warn('[tokenCounter] llama3-tokenizer-js not installed — using heuristic counts');
    }
  }
  return _llama3;
}

// ~4 characters per token — rough but always available.
function heuristic(text) {
  return Math.ceil((text || '').length / 4);
}

// Map a model name to a tokenizer family. Extend as more families are added.
function familyOf(model = '') {
  const m = String(model).toLowerCase();
  if (m.includes('llama') || m.includes('nemotron') || m.includes('mcp')) return 'llama3';
  return 'llama3'; // sensible default for now
}

/** Count tokens in a string for the given model. */
export async function countTokens(text, model) {
  if (!text) return 0;
  const str = String(text);
  if (familyOf(model) === 'llama3') {
    const tk = await getLlama3();
    if (tk && typeof tk.encode === 'function') {
      try { return tk.encode(str, { bos: false, eos: false }).length; } catch { /* fall through */ }
    }
  }
  return heuristic(str);
}

/** Count an arbitrary object/string (e.g. a tool schema or call args). */
export async function countJson(obj, model) {
  return countTokens(typeof obj === 'string' ? obj : JSON.stringify(obj ?? {}), model);
}

/** Count a list of chat messages (role + content) with per-message overhead. */
export async function countMessages(messages = [], model) {
  let total = 0;
  for (const m of messages) {
    const content = typeof m?.content === 'string'
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map(b => (b?.text ?? '')).join(' ')
        : JSON.stringify(m?.content ?? '');
    total += await countTokens(content, model);
    total += await countTokens(m?.role || '', model);
    total += 4; // approx chat-formatting overhead per message
  }
  return total;
}

export default { countTokens, countJson, countMessages };
