'use strict';
/**
 * Socializeit storage — SQLite (Node built-in node:sqlite, no dependencies).
 *
 * Tables:
 *   settings   — key/value app settings (API client IDs/secrets, encrypted).
 *   accounts   — one row per connected network account (tokens encrypted).
 *   posts      — one row per post (caption, media, schedule, overall status).
 *   deliveries — one row per (post, network). The UNIQUE idempotency key is
 *                what stops the same post going out twice to one network.
 *   events     — small log of what happened to each post (for the UI).
 *
 * The file lives in data/socializeit.db (gitignored). To move to Postgres
 * later, only this file needs a new backend — every other module talks to
 * these functions, never to SQL directly.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { encrypt, decrypt } = require('./crypto-util');

const DATA_DIR = process.env.SOCIALIZEIT_DATA_DIR ||
  path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'socializeit.db');

let db = null;

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath || DB_PATH), { recursive: true });
  db = new DatabaseSync(dbPath || DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network TEXT NOT NULL,
      account_id TEXT NOT NULL,
      name TEXT,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER,
      extra TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(network, account_id)
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      caption TEXT NOT NULL DEFAULT '',
      media_path TEXT,
      media_type TEXT,
      title_yt TEXT,
      title_fb TEXT,
      title_tt TEXT,
      networks TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'scheduled',
      scheduled_at INTEGER NOT NULL,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      network TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      remote_id TEXT,
      remote_url TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT,
      network TEXT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_posts_due
      ON posts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_deliveries_post
      ON deliveries(post_id);
  `);
  return db;
}

function getDb() {
  if (!db) open();
  return db;
}

function now() {
  return Date.now();
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  const val = row.value;
  // Secrets are stored encrypted with a "enc:" prefix.
  if (val.startsWith('enc:')) return decrypt(val.slice(4), DATA_DIR);
  return val;
}

function setSetting(key, value, secret) {
  const stored = secret ? 'enc:' + encrypt(value, DATA_DIR) : String(value);
  getDb().prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, stored);
}

/** Settings the UI is allowed to read (secrets masked). */
function publicSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    out[r.key] = r.value.startsWith('enc:') ? '••••••••' : r.value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* accounts                                                            */
/* ------------------------------------------------------------------ */

function upsertAccount(network, accountId, fields) {
  const d = getDb();
  const existing = d.prepare(
    'SELECT id FROM accounts WHERE network = ? AND account_id = ?',
  ).get(network, accountId);
  const encAccess = fields.accessToken ? encrypt(fields.accessToken, DATA_DIR) : null;
  const encRefresh = fields.refreshToken ? encrypt(fields.refreshToken, DATA_DIR) : null;
  const extra = fields.extra ? JSON.stringify(fields.extra) : null;
  if (existing) {
    d.prepare(
      'UPDATE accounts SET name = COALESCE(?, name), ' +
      'access_token = COALESCE(?, access_token), ' +
      'refresh_token = COALESCE(?, refresh_token), ' +
      'expires_at = COALESCE(?, expires_at), extra = COALESCE(?, extra), ' +
      'updated_at = ? WHERE id = ?',
    ).run(fields.name || null, encAccess, encRefresh,
      fields.expiresAt || null, extra, now(), existing.id);
    return existing.id;
  }
  const res = d.prepare(
    'INSERT INTO accounts(network, account_id, name, access_token, ' +
    'refresh_token, expires_at, extra, created_at, updated_at) ' +
    'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(network, accountId, fields.name || null, encAccess, encRefresh,
    fields.expiresAt || null, extra, now(), now());
  return Number(res.lastInsertRowid);
}

function getAccount(network) {
  const row = getDb().prepare(
    'SELECT * FROM accounts WHERE network = ? ORDER BY updated_at DESC LIMIT 1',
  ).get(network);
  if (!row) return null;
  return {
    id: row.id,
    network: row.network,
    accountId: row.account_id,
    name: row.name,
    accessToken: row.access_token ? decrypt(row.access_token, DATA_DIR) : null,
    refreshToken: row.refresh_token ? decrypt(row.refresh_token, DATA_DIR) : null,
    expiresAt: row.expires_at,
    extra: row.extra ? JSON.parse(row.extra) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listAccounts() {
  return getDb().prepare(
    'SELECT network, account_id, name, updated_at FROM accounts ORDER BY network',
  ).all().map((r) => ({
    network: r.network,
    accountId: r.account_id,
    name: r.name,
    updatedAt: r.updated_at,
  }));
}

function deleteAccount(network) {
  getDb().prepare('DELETE FROM accounts WHERE network = ?').run(network);
}

/* ------------------------------------------------------------------ */
/* posts                                                               */
/* ------------------------------------------------------------------ */

function createPost(post) {
  const d = getDb();
  const ts = now();
  d.prepare(
    'INSERT INTO posts(id, caption, media_path, media_type, title_yt, ' +
    'title_fb, title_tt, networks, status, scheduled_at, created_at, updated_at) ' +
    'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(post.id, post.caption || '', post.mediaPath || null,
    post.mediaType || null, post.titleYt || null, post.titleFb || null,
    post.titleTt || null, JSON.stringify(post.networks || []),
    post.status || 'scheduled', post.scheduledAt, ts, ts);
  for (const network of post.networks || []) {
    d.prepare(
      'INSERT INTO deliveries(post_id, network, idempotency_key, status, created_at, updated_at) ' +
      'VALUES(?, ?, ?, ?, ?, ?)',
    ).run(post.id, network, post.id + ':' + network, 'pending', ts, ts);
  }
  return post.id;
}

function getPost(id) {
  const row = getDb().prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!row) return null;
  return rowToPost(row);
}

function rowToPost(row) {
  return {
    id: row.id,
    caption: row.caption,
    mediaPath: row.media_path,
    mediaType: row.media_type,
    titleYt: row.title_yt,
    titleFb: row.title_fb,
    titleTt: row.title_tt,
    networks: JSON.parse(row.networks || '[]'),
    status: row.status,
    scheduledAt: row.scheduled_at,
    error: row.error,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listPosts(limit) {
  return getDb().prepare(
    'SELECT * FROM posts ORDER BY created_at DESC LIMIT ?',
  ).all(limit || 50).map(rowToPost);
}

function updatePost(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(k + ' = ?');
    vals.push(v);
  }
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(id);
  getDb().prepare('UPDATE posts SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
}

function deletePost(id) {
  getDb().prepare('DELETE FROM posts WHERE id = ?').run(id);
}

/** Posts that are due: scheduled and time reached, or failed and retry due. */
function duePosts(limit) {
  const rows = getDb().prepare(
    "SELECT * FROM posts WHERE " +
    "(status = 'scheduled' AND scheduled_at <= ?) OR " +
    "(status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ? AND attempts < 3) " +
    'ORDER BY scheduled_at ASC LIMIT ?',
  ).all(now(), now(), limit || 10);
  return rows.map(rowToPost);
}

/* ------------------------------------------------------------------ */
/* deliveries                                                          */
/* ------------------------------------------------------------------ */

function getDeliveries(postId) {
  return getDb().prepare(
    'SELECT * FROM deliveries WHERE post_id = ? ORDER BY network',
  ).all(postId).map((r) => ({
    id: r.id,
    postId: r.post_id,
    network: r.network,
    idempotencyKey: r.idempotency_key,
    status: r.status,
    remoteId: r.remote_id,
    remoteUrl: r.remote_url,
    error: r.error,
    attempts: r.attempts,
    nextRetryAt: r.next_retry_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

function updateDelivery(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(k + ' = ?');
    vals.push(v);
  }
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(id);
  getDb().prepare('UPDATE deliveries SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
}

function getDeliveryByKey(key) {
  const row = getDb().prepare(
    'SELECT * FROM deliveries WHERE idempotency_key = ?',
  ).get(key);
  return row || null;
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function logEvent(postId, network, message) {
  getDb().prepare(
    'INSERT INTO events(post_id, network, message, created_at) VALUES(?, ?, ?, ?)',
  ).run(postId || null, network || null, message, now());
}

function getEvents(postId, limit) {
  return getDb().prepare(
    'SELECT * FROM events WHERE post_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(postId, limit || 20);
}

module.exports = {
  open, getDb, DATA_DIR, DB_PATH,
  getSetting, setSetting, publicSettings,
  upsertAccount, getAccount, listAccounts, deleteAccount,
  createPost, getPost, listPosts, updatePost, deletePost, duePosts,
  getDeliveries, updateDelivery, getDeliveryByKey,
  logEvent, getEvents,
};
