/**
 * secrets.js — encrypt/decrypt at rest (AES-256-GCM) for stored cloud credentials.
 *
 * Key is a random 32 bytes persisted to a gitignored .ct-secret file (or
 * CT_SECRET_FILE), generated once. Never store provider secrets in plaintext.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_FILE = process.env.CT_SECRET_FILE || path.join(__dirname, '.ct-secret');
let _key = null;

function getKey() {
  if (_key) return _key;
  try { if (fs.existsSync(KEY_FILE)) _key = fs.readFileSync(KEY_FILE); } catch { /* ignore */ }
  if (!_key || _key.length !== 32) {
    _key = crypto.randomBytes(32);
    try { fs.writeFileSync(KEY_FILE, _key, { mode: 0o600 }); } catch (e) { console.warn('[secrets] could not persist key:', e.message); }
  }
  return _key;
}

function encrypt(text) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(b64) {
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; }
}

module.exports = { encrypt, decrypt };
