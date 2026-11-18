'use strict';
/**
 * Socializeit — server.
 *
 * Pure Node, zero dependencies. Serves the web UI from public/ and a small
 * JSON API the UI uses. One command to run it:
 *
 *   node server.js            (port 3000)
 *   PORT=4000 node server.js
 *
 * Open http://localhost:3000 in a browser (or your phone on the same Wi-Fi).
 *
 * Routes:
 *   GET  /                        -> home page (composer, posts, accounts)
 *   GET  /settings                -> settings page (API keys)
 *   GET  /style.css /app.js ...   -> static files
 *   GET  /uploads/<file>          -> uploaded media
 *   GET  /api/status              -> health + counts
 *   GET  /api/accounts            -> connected accounts + what is missing
 *   GET  /api/accounts/:net/connect -> start OAuth (redirects)
 *   GET  /auth/:net/callback      -> OAuth callback
 *   POST /api/accounts/:net/disconnect
 *   POST /api/accounts/facebook/page -> pick which Facebook Page to post to
 *   GET  /api/settings            -> settings (secrets masked)
 *   POST /api/settings            -> save settings
 *   GET  /api/posts               -> list posts with deliveries
 *   GET  /api/posts/:id           -> one post with deliveries + events
 *   POST /api/posts               -> create a post (multipart form)
 *   POST /api/posts/:id/retry     -> retry a failed post
 *   DELETE /api/posts/:id         -> delete a post
 *   POST /api/scheduler/tick      -> run the scheduler now (testing)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const db = require('./src/db');
const scheduler = require('./src/scheduler');
const { parseMultipart } = require('./src/upload');
const facebook = require('./src/networks/facebook');
const youtube = require('./src/networks/youtube');
const tiktok = require('./src/networks/tiktok');

const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(db.DATA_DIR, 'uploads');
const NETWORKS = { facebook, youtube, tiktok };
const NETWORK_NAMES = { facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok' };

// Short-lived OAuth state tokens (CSRF protection). In-memory only.
const oauthStates = new Map();

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

function serveFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 404, 'Not found.');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 1024 * 1024) {
        reject(new Error('Body too big.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new Error('Bad JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function baseUrl(req) {
  const host = req.headers.host || ('localhost:' + PORT);
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return proto + '://' + host;
}

function redirectUri(req, network) {
  return baseUrl(req) + '/auth/' + network + '/callback';
}

/* ------------------------------------------------------------------ */
/* accounts + settings                                                 */
/* ------------------------------------------------------------------ */

function accountSummary() {
  return Object.keys(NETWORKS).map((network) => {
    const mod = NETWORKS[network];
    const settings = {
      facebook_app_id: db.getSetting('facebook_app_id'),
      facebook_app_secret: db.getSetting('facebook_app_secret'),
      youtube_client_id: db.getSetting('youtube_client_id'),
      youtube_client_secret: db.getSetting('youtube_client_secret'),
      tiktok_client_key: db.getSetting('tiktok_client_key'),
      tiktok_client_secret: db.getSetting('tiktok_client_secret'),
    };
    const missing = mod.missingKeys(settings);
    const account = db.getAccount(network);
    return {
      network,
      name: NETWORK_NAMES[network],
      connected: Boolean(account && account.accessToken),
      accountName: account ? account.name : null,
      accountId: account ? account.accountId : null,
      needsKeys: missing,
      extra: account && account.extra ? account.extra : {},
    };
  });
}

function settingsHelp() {
  return {
    facebook: {
      fields: [
        { key: 'facebook_app_id', label: 'App ID', secret: false },
        { key: 'facebook_app_secret', label: 'App Secret', secret: true },
      ],
      where: 'Facebook Developers → My Apps → Create App → Facebook Login. Add the redirect URI below to Facebook Login → Settings → Valid OAuth Redirect URIs. Permissions needed: pages_manage_posts, pages_read_engagement, publish_video. The app must be Live to post to a real Page.',
      links: ['https://developers.facebook.com/apps'],
    },
    youtube: {
      fields: [
        { key: 'youtube_client_id', label: 'Client ID', secret: false },
        { key: 'youtube_client_secret', label: 'Client Secret', secret: true },
      ],
      where: 'Google Cloud Console → create a project → enable YouTube Data API v3 → Credentials → Create OAuth client ID (Web application). Add the redirect URI below as an Authorized redirect URI. Copy the Client ID and Client Secret here.',
      links: ['https://console.cloud.google.com/apis/credentials'],
    },
    tiktok: {
      fields: [
        { key: 'tiktok_client_key', label: 'Client Key', secret: false },
        { key: 'tiktok_client_secret', label: 'Client Secret', secret: true },
      ],
      where: 'TikTok for Developers → My Apps → Create an app → add Login Kit and Content Posting API. Add the redirect URI below. Direct posting needs TikTok to approve the app for the video.upload scope — that review can take days. Until then, connecting works but publishing will fail with a clear message from TikTok.',
      links: ['https://developers.tiktok.com/'],
    },
  };
}

/* ------------------------------------------------------------------ */
/* OAuth                                                               */
/* ------------------------------------------------------------------ */

async function handleConnect(req, res, network) {
  const mod = NETWORKS[network];
  if (!mod) return sendJson(res, 404, { error: 'Unknown network.' });
  const settings = {
    facebook_app_id: db.getSetting('facebook_app_id'),
    facebook_app_secret: db.getSetting('facebook_app_secret'),
    youtube_client_id: db.getSetting('youtube_client_id'),
    youtube_client_secret: db.getSetting('youtube_client_secret'),
    tiktok_client_key: db.getSetting('tiktok_client_key'),
    tiktok_client_secret: db.getSetting('tiktok_client_secret'),
  };
  const missing = mod.missingKeys(settings);
  if (missing.length) {
    return sendJson(res, 400, {
      error: 'Add your ' + mod.name + ' keys in Settings first.',
      needsKeys: missing,
      settingsUrl: '/settings',
    });
  }
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { network, createdAt: Date.now() });
  redirect(res, mod.authUrl(settings, redirectUri(req, network), state));
}

async function handleCallback(req, res, network, query) {
  const mod = NETWORKS[network];
  if (!mod) return sendText(res, 404, 'Unknown network.');
  const state = query.get('state') || '';
  const code = query.get('code') || '';
  const error = query.get('error') || '';
  if (error) return redirect(res, '/?error=' + encodeURIComponent('Connect cancelled: ' + error));
  const saved = oauthStates.get(state);
  oauthStates.delete(state);
  if (!saved || saved.network !== network || Date.now() - saved.createdAt > 10 * 60 * 1000) {
    return redirect(res, '/?error=' + encodeURIComponent('Connect timed out. Try again.'));
  }
  if (!code) return redirect(res, '/?error=' + encodeURIComponent('No code from ' + mod.name + '.'));
  const settings = {
    facebook_app_id: db.getSetting('facebook_app_id'),
    facebook_app_secret: db.getSetting('facebook_app_secret'),
    youtube_client_id: db.getSetting('youtube_client_id'),
    youtube_client_secret: db.getSetting('youtube_client_secret'),
    tiktok_client_key: db.getSetting('tiktok_client_key'),
    tiktok_client_secret: db.getSetting('tiktok_client_secret'),
  };
  try {
    const info = await mod.exchangeCode(settings, redirectUri(req, network), code);
    if (network === 'facebook') {
      // Pick the Page to post to. If there is only one, use it.
      const pages = await facebook.listPages(info.accessToken);
      const extra = { userId: info.accountId, userToken: info.accessToken, pages: [] };
      let accountId = info.accountId;
      let name = info.name;
      let pageToken = info.accessToken;
      if (pages.length) {
        extra.pages = pages.map((p) => ({ id: p.id, name: p.name }));
        const first = pages[0];
        accountId = first.id;
        name = first.name;
        pageToken = first.accessToken;
        extra.pageId = first.id;
        extra.pageToken = first.accessToken;
      }
      db.upsertAccount('facebook', accountId, {
        name, accessToken: pageToken, expiresAt: info.expiresAt, extra,
      });
    } else {
      db.upsertAccount(network, info.accountId, {
        name: info.name,
        accessToken: info.accessToken,
        refreshToken: info.refreshToken,
        expiresAt: info.expiresAt,
        extra: info.extra || {},
      });
    }
    db.logEvent(null, network, mod.name + ' connected.');
    redirect(res, '/?connected=' + network);
  } catch (e) {
    redirect(res, '/?error=' + encodeURIComponent(mod.name + ' connect failed: ' + e.message));
  }
}

/* ------------------------------------------------------------------ */
/* posts                                                               */
/* ------------------------------------------------------------------ */

async function handleCreatePost(req, res) {
  let parsed;
  try {
    parsed = await parseMultipart(req, { destDir: UPLOAD_DIR });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const f = parsed.fields || {};
  const caption = (f.caption || '').trim();
  const networks = [];
  for (const n of ['facebook', 'youtube', 'tiktok']) {
    if (f['net_' + n] === '1' || f['net_' + n] === 'on') networks.push(n);
  }
  if (!networks.length) {
    return sendJson(res, 400, { error: 'Pick at least one network.' });
  }
  const media = (parsed.files || [])[0] || null;
  let mediaType = null;
  let mediaPath = null;
  if (media) {
    mediaType = (media.mime || '').startsWith('video/') ? 'video'
      : (media.mime || '').startsWith('image/') ? 'photo' : null;
    if (!mediaType) {
      try { fs.unlinkSync(media.path); } catch (_) { /* ignore */ }
      return sendJson(res, 400, { error: 'That file is not a video or a photo.' });
    }
    mediaPath = path.relative(path.join(__dirname), media.path);
  }
  if (!caption && !media) {
    return sendJson(res, 400, { error: 'Write something or add a video or photo.' });
  }
  // A video is the normal case. Text-only and photo posts are fine too —
  // the poster skips networks that cannot take them, with a clear reason.
  const when = (f.when || 'now').trim();
  let scheduledAt = Date.now();
  if (when === 'schedule') {
    const t = Date.parse(f.scheduled_at || '');
    if (!t || Number.isNaN(t)) {
      return sendJson(res, 400, { error: 'Pick a date and time to schedule.' });
    }
    if (t < Date.now() - 60000) {
      return sendJson(res, 400, { error: 'That time is in the past.' });
    }
    scheduledAt = t;
  }
  const id = crypto.randomUUID();
  db.createPost({
    id,
    caption,
    mediaPath,
    mediaType,
    titleYt: (f.title_yt || '').trim() || null,
    titleFb: (f.title_fb || '').trim() || null,
    titleTt: (f.title_tt || '').trim() || null,
    networks,
    status: 'scheduled',
    scheduledAt,
  });
  db.logEvent(id, null, when === 'schedule' ? 'Scheduled.' : 'Posted now (queued).');
  sendJson(res, 201, { ok: true, id });
}

function postWithDeliveries(post) {
  const deliveries = db.getDeliveries(post.id);
  const events = db.getEvents(post.id, 10);
  return { ...post, deliveries, events };
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method;

  // --- static -------------------------------------------------------
  if (method === 'GET' && pathname === '/') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (method === 'GET' && pathname === '/settings') return serveFile(res, path.join(PUBLIC_DIR, 'settings.html'));
  if (method === 'GET' && pathname.startsWith('/uploads/')) {
    const name = pathname.slice('/uploads/'.length).replace(/[^A-Za-z0-9._-]/g, '');
    return serveFile(res, path.join(UPLOAD_DIR, name));
  }
  if (method === 'GET' && (pathname === '/style.css' || pathname === '/app.js' || pathname === '/settings.js')) {
    return serveFile(res, path.join(PUBLIC_DIR, pathname.slice(1)));
  }

  // --- status -------------------------------------------------------
  if (method === 'GET' && pathname === '/api/status') {
    const posts = db.listPosts(1000);
    const counts = {};
    for (const p of posts) counts[p.status] = (counts[p.status] || 0) + 1;
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      posts: counts,
      accounts: db.listAccounts().length,
      schedulerTickMs: scheduler.TICK_MS,
    });
  }

  // --- accounts -----------------------------------------------------
  if (method === 'GET' && pathname === '/api/accounts') {
    return sendJson(res, 200, { accounts: accountSummary() });
  }
  let m = pathname.match(/^\/api\/accounts\/([^/]+)\/connect$/);
  if (method === 'GET' && m) return handleConnect(req, res, m[1]);
  m = pathname.match(/^\/auth\/([^/]+)\/callback$/);
  if (method === 'GET' && m) return handleCallback(req, res, m[1], url.searchParams);
  m = pathname.match(/^\/api\/accounts\/([^/]+)\/disconnect$/);
  if (method === 'POST' && m) {
    db.deleteAccount(m[1]);
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && pathname === '/api/accounts/facebook/page') {
    try {
      const body = await readJsonBody(req);
      const account = db.getAccount('facebook');
      if (!account) return sendJson(res, 400, { error: 'Connect Facebook first.' });
      const pages = (account.extra && account.extra.pages) || [];
      const page = pages.find((p) => p.id === body.pageId);
      if (!page) return sendJson(res, 400, { error: 'That Page is not in the list.' });
      // Re-fetch the page token for the chosen page.
      const all = await facebook.listPages(account.extra.userToken);
      const chosen = all.find((p) => p.id === body.pageId);
      if (!chosen) return sendJson(res, 400, { error: 'Could not read that Page.' });
      db.upsertAccount('facebook', chosen.id, {
        name: chosen.name,
        accessToken: chosen.accessToken,
        extra: { ...account.extra, pageId: chosen.id, pageToken: chosen.accessToken },
      });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // --- settings -----------------------------------------------------
  if (method === 'GET' && pathname === '/api/settings') {
    return sendJson(res, 200, {
      settings: db.publicSettings(),
      help: settingsHelp(),
      redirectUris: {
        facebook: baseUrl(req) + '/auth/facebook/callback',
        youtube: baseUrl(req) + '/auth/youtube/callback',
        tiktok: baseUrl(req) + '/auth/tiktok/callback',
      },
    });
  }
  if (method === 'POST' && pathname === '/api/settings') {
    try {
      const body = await readJsonBody(req);
      const secretKeys = new Set([
        'facebook_app_secret', 'youtube_client_secret', 'tiktok_client_secret',
      ]);
      for (const [k, v] of Object.entries(body)) {
        if (typeof v !== 'string') continue;
        if (v === '' || v === '••••••••') continue; // keep the saved value
        db.setSetting(k, v, secretKeys.has(k));
      }
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // --- posts --------------------------------------------------------
  if (method === 'GET' && pathname === '/api/posts') {
    const posts = db.listPosts(50).map(postWithDeliveries);
    return sendJson(res, 200, { posts });
  }
  m = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (method === 'GET' && m) {
    const post = db.getPost(m[1]);
    if (!post) return sendJson(res, 404, { error: 'Post not found.' });
    return sendJson(res, 200, postWithDeliveries(post));
  }
  if (method === 'POST' && pathname === '/api/posts') {
    return handleCreatePost(req, res);
  }
  m = pathname.match(/^\/api\/posts\/([^/]+)\/retry$/);
  if (method === 'POST' && m) {
    const post = db.getPost(m[1]);
    if (!post) return sendJson(res, 404, { error: 'Post not found.' });
    // Reset the failed deliveries so they try again. Live ones stay live —
    // the poster never re-posts them (see poster.js).
    const d = db.getDb();
    d.prepare(
      "UPDATE deliveries SET status = 'pending', error = NULL, next_retry_at = NULL " +
      "WHERE post_id = ? AND status = 'failed'",
    ).run(m[1]);
    db.updatePost(m[1], {
      status: 'scheduled',
      scheduled_at: Date.now(),
      error: null,
      next_retry_at: null,
    });
    db.logEvent(m[1], null, 'Retried by hand.');
    return sendJson(res, 200, { ok: true });
  }
  m = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (method === 'DELETE' && m) {
    const post = db.getPost(m[1]);
    if (post && post.mediaPath) {
      try { fs.unlinkSync(path.join(__dirname, post.mediaPath)); } catch (_) { /* ignore */ }
    }
    db.deletePost(m[1]);
    return sendJson(res, 200, { ok: true });
  }

  // --- scheduler ----------------------------------------------------
  if (method === 'POST' && pathname === '/api/scheduler/tick') {
    const out = await scheduler.tick();
    return sendJson(res, 200, { ok: true, ran: out });
  }

  sendJson(res, 404, { error: 'Not found.' });
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

function recoverStuck() {
  // If the server stopped mid-post, a post can be stuck on "posting" and
  // its deliveries on "posting". Put them back so they run again.
  const d = db.getDb();
  const posts = d.prepare("UPDATE posts SET status = 'scheduled' WHERE status = 'posting'").run();
  const dels = d.prepare("UPDATE deliveries SET status = 'pending' WHERE status = 'posting'").run();
  if (posts.changes || dels.changes) {
    db.logEvent(null, null, 'Recovered ' + posts.changes + ' stuck post(s) after a restart.');
  }
}

function start() {
  db.open();
  recoverStuck();
  scheduler.start();
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: e.message || 'Server error.' });
    });
  });
  server.listen(PORT, HOST, () => {
    console.log('Socializeit ' + VERSION + ' running at http://' + HOST + ':' + PORT);
    console.log('Open it on your phone with this machine\'s address on port ' + PORT + '.');
  });
  return server;
}

if (require.main === module) start();

module.exports = { start, handler };
