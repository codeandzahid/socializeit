'use strict';
/**
 * Token encryption for Socializeit.
 *
 * Access tokens and client secrets are stored encrypted in the database
 * (AES-256-GCM). The encryption key comes from the SOCIALIZEIT_SECRET
 * environment variable, or from a key file created on first run inside
 * data/ (gitignored, never committed). If the key is lost, stored tokens
 * cannot be decrypted and accounts must be reconnected.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let cachedKey = null;

function loadKey(dataDir) {
  if (cachedKey) return cachedKey;
  if (process.env.SOCIALIZEIT_SECRET) {
    cachedKey = crypto.createHash('sha256')
      .update(String(process.env.SOCIALIZEIT_SECRET)).digest();
    return cachedKey;
  }
  const keyFile = path.join(dataDir, 'secret.key');
  try {
    const raw = fs.readFileSync(keyFile);
    if (raw.length === 32) {
      cachedKey = raw;
      return cachedKey;
    }
  } catch (_) { /* no key file yet */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  cachedKey = key;
  return cachedKey;
}

/** Encrypt a string. Returns "iv:ciphertext:tag" (all base64). */
function encrypt(plain, dataDir) {
  if (plain === null || plain === undefined) return null;
  const key = loadKey(dataDir);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    enc.toString('base64'),
    tag.toString('base64'),
  ].join(':');
}

/** Decrypt a value produced by encrypt(). Returns null on failure. */
function decrypt(blob, dataDir) {
  if (!blob) return null;
  try {
    const parts = String(blob).split(':');
    if (parts.length !== 3) return null;
    const key = loadKey(dataDir);
    const iv = Buffer.from(parts[0], 'base64');
    const enc = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

/** Mask a secret for display: show first 4 and last 2 chars only. */
function mask(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '••••••••';
  return s.slice(0, 4) + '••••' + s.slice(-2);
}

module.exports = { encrypt, decrypt, mask, loadKey };
