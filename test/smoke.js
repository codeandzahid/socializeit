'use strict';
/**
 * Socializeit smoke test — everything that can be tested without real
 * API keys or developer apps.
 *
 * Run:  node test/smoke.js
 *
 * It starts the server on a test port with a throwaway data folder, then
 * checks: the UI loads, settings save (masked), a post can be created,
 * the scheduler picks it up and fails cleanly (no account connected),
 * duplicate protection blocks a re-post, retry works, and delete works.
 * Nothing is posted to any real network.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Test data dir + port, set BEFORE requiring the app.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socializeit-test-'));
process.env.SOCIALIZEIT_DATA_DIR = tmpDir;
process.env.PORT = '3456';
process.env.SCHEDULER_TICK_MS = '600000'; // do not auto-fire during the test
process.env.SOCIALIZEIT_SECRET = 'test-secret-for-smoke-only';

const BASE = 'http://127.0.0.1:3456';
let failures = 0;

function check(name, ok, extra) {
  if (ok) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
}

async function main() {
  const { start } = require('../server.js');
  const db = require('../src/db');
  const { processPost } = require('../src/poster');
  const server = start();
  await new Promise((r) => server.on('listening', r));

  const get = async (p) => fetch(BASE + p);
  const getJson = async (p) => {
    const r = await get(p);
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  console.log('UI loads');
  let r = await get('/');
  check('home page returns HTML', r.status === 200 && (await r.text()).includes('Socializeit'));
  r = await get('/settings');
  check('settings page returns HTML', r.status === 200 && (await r.text()).includes('Settings'));
  r = await get('/style.css');
  check('stylesheet loads', r.status === 200);
  r = await get('/app.js');
  check('home script loads', r.status === 200);
  r = await get('/settings.js');
  check('settings script loads', r.status === 200);

  console.log('API status + accounts');
  let j = await getJson('/api/status');
  check('status endpoint ok', j.status === 200 && j.data.ok === true);
  j = await getJson('/api/accounts');
  check('three networks listed', j.status === 200 && (j.data.accounts || []).length === 3);
  check('all need keys at first', (j.data.accounts || []).every((a) => (a.needsKeys || []).length > 0));

  console.log('Settings save (masked)');
  r = await fetch(BASE + '/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ facebook_app_id: '12345', facebook_app_secret: 'shh-secret' }),
  });
  check('settings save ok', r.status === 200);
  j = await getJson('/api/settings');
  check('secret is masked on read', j.data.settings.facebook_app_secret === '••••••••');
  check('plain id is readable', j.data.settings.facebook_app_id === '12345');

  console.log('Create a text post');
  const form = new FormData();
  form.append('caption', 'Smoke test post');
  form.append('net_facebook', '1');
  form.append('net_youtube', '1');
  form.append('net_tiktok', '1');
  form.append('when', 'now');
  r = await fetch(BASE + '/api/posts', { method: 'POST', body: form });
  const created = await r.json().catch(() => ({}));
  check('post created (201)', r.status === 201 && Boolean(created.id));
  const postId = created.id;
  j = await getJson('/api/posts');
  const post = (j.data.posts || []).find((p) => p.id === postId);
  check('post listed with 3 deliveries', Boolean(post) && (post.deliveries || []).length === 3);
  check('post starts as scheduled', post && post.status === 'scheduled');

  console.log('Scheduler runs it and fails cleanly (no account)');
  r = await fetch(BASE + '/api/scheduler/tick', { method: 'POST' });
  check('manual tick ok', r.status === 200);
  j = await getJson('/api/posts/' + postId);
  check('post is failed after tick', j.data.status === 'failed');
  check('failure message is clear', typeof j.data.error === 'string' && j.data.error.length > 5);
  check('attempts counted', j.data.attempts === 1);
  check('retry time set', typeof j.data.nextRetryAt === 'number' && j.data.nextRetryAt > Date.now());
  check('deliveries failed with reasons',
    (j.data.deliveries || []).every((d) => d.status === 'failed' && d.error));

  console.log('Duplicate protection');
  // Mark the Facebook delivery as already live, then run the poster again.
  // It must NOT try to post to Facebook again.
  const d = db.getDb();
  d.prepare(
    "UPDATE deliveries SET status = 'live', remote_id = 'fake-123', remote_url = 'https://example.invalid/fake-123' " +
    "WHERE post_id = ? AND network = 'facebook'",
  ).run(postId);
  const results = await processPost(db.getPost(postId));
  const fb = results.find((x) => x.network === 'facebook');
  check('live delivery is not re-posted', fb && fb.status === 'duplicate-blocked');
  const stillLive = d.prepare(
    "SELECT status FROM deliveries WHERE post_id = ? AND network = 'facebook'",
  ).get(postId);
  check('live delivery stays live', stillLive && stillLive.status === 'live');

  console.log('Retry + delete');
  r = await fetch(BASE + '/api/posts/' + postId + '/retry', { method: 'POST' });
  check('retry endpoint ok', r.status === 200);
  j = await getJson('/api/posts/' + postId);
  check('post is scheduled again', j.data.status === 'scheduled');
  check('failed deliveries reset to pending',
    (j.data.deliveries || []).filter((x) => x.network !== 'facebook')
      .every((x) => x.status === 'pending'));
  r = await fetch(BASE + '/api/posts/' + postId, { method: 'DELETE' });
  check('delete ok', r.status === 200);
  j = await getJson('/api/posts/' + postId);
  check('post is gone', j.status === 404);

  console.log('Video upload (multipart, small fake file)');
  const fakeVideo = new Blob([Buffer.alloc(1024, 0)], { type: 'video/mp4' });
  const form2 = new FormData();
  form2.append('caption', 'Video smoke test');
  form2.append('net_facebook', '1');
  form2.append('when', 'now');
  form2.append('media', fakeVideo, 'clip.mp4');
  r = await fetch(BASE + '/api/posts', { method: 'POST', body: form2 });
  const created2 = await r.json().catch(() => ({}));
  check('video post created (201)', r.status === 201 && Boolean(created2.id));
  j = await getJson('/api/posts/' + created2.id);
  check('media detected as video', j.data.mediaType === 'video');
  check('media file is on disk', Boolean(j.data.mediaPath) && fs.existsSync(path.join(__dirname, '..', j.data.mediaPath)));

  server.close();
  const { stop } = require('../src/scheduler');
  stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(failures === 0 ? '\nAll smoke tests passed.' : '\n' + failures + ' test(s) failed.');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
