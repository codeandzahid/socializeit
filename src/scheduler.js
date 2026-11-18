'use strict';
/**
 * Scheduler — the built-in job queue.
 *
 * No Temporal, no Redis, no extra service. A timer wakes up every
 * TICK_MS, finds posts that are due (scheduled time reached, or a failed
 * post whose retry time arrived), and hands each one to the poster.
 *
 * Rules:
 *  - One post at a time (a simple lock), so two runs never post the same
 *    thing twice.
 *  - A failed post retries up to 3 times, with a growing wait:
 *    1 minute, then 5 minutes, then 15 minutes. After that it stays
 *    "failed" and the user retries it by hand from the UI.
 *  - A post is "live" only when every network is live. If some networks
 *    are live and others failed, the post is "failed" (with the live ones
 *    kept live — the poster never re-posts them, see poster.js).
 *  - The tick never throws: an unexpected error is logged and the
 *    scheduler keeps going.
 */
const db = require('./db');
const { processPost } = require('./poster');

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS || 15000);
const RETRY_DELAYS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]; // 1m, 5m, 15m
const MAX_ATTEMPTS = 3;

let timer = null;
let running = false;

/** Roll a post's overall status from its delivery results. */
function rollupStatus(postId, results) {
  const deliveries = db.getDeliveries(postId);
  const byStatus = {};
  for (const d of deliveries) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  const live = byStatus.live || 0;
  const posted = byStatus.posted || 0;
  const failed = byStatus.failed || 0;
  const blocked = byStatus['duplicate-blocked'] || 0;
  const total = deliveries.length;
  if (live + blocked === total && total > 0) return 'live';
  if (live + posted + blocked === total && live > 0) return 'posted';
  if (failed > 0 && live + posted + blocked === 0) return 'failed';
  if (failed > 0) return 'failed';
  return 'scheduled';
}

async function processOne(post) {
  db.updatePost(post.id, { status: 'posting', attempts: post.attempts + 1 });
  db.logEvent(post.id, null, 'Posting started.');
  let results = [];
  try {
    results = await processPost(post);
  } catch (e) {
    db.logEvent(post.id, null, 'Unexpected error: ' + e.message);
    results = post.networks.map((n) => ({ network: n, status: 'failed', error: e.message }));
  }

  const fresh = db.getPost(post.id);
  const status = rollupStatus(post.id, results);
  const attempts = fresh.attempts;
  const fields = { status, error: null, next_retry_at: null };

  if (status === 'failed') {
    const firstError = (results.find((r) => r.error) || {}).error || 'Post failed.';
    fields.error = firstError;
    if (attempts < MAX_ATTEMPTS) {
      fields.next_retry_at = Date.now() + RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)];
      db.logEvent(post.id, null, 'Failed — will retry. (' + firstError + ')');
    } else {
      db.logEvent(post.id, null, 'Failed — no more automatic retries. (' + firstError + ')');
    }
  } else if (status === 'posted') {
    fields.error = 'Posted, but one or more networks could not be read back yet.';
    db.logEvent(post.id, null, 'Posted. One or more networks still need a read-back check.');
  } else if (status === 'live') {
    db.logEvent(post.id, null, 'Live on all networks.');
  }
  db.updatePost(post.id, fields);
  return { postId: post.id, status, results };
}

async function tick() {
  if (running) return { skipped: true };
  running = true;
  const out = [];
  try {
    const due = db.duePosts(10);
    for (const post of due) {
      // Re-read: another tick may have claimed it already.
      const fresh = db.getPost(post.id);
      if (!fresh || (fresh.status !== 'scheduled' && fresh.status !== 'failed')) continue;
      out.push(await processOne(fresh));
    }
  } catch (e) {
    // Never let the scheduler die.
    try { db.logEvent(null, null, 'Scheduler error: ' + e.message); } catch (_) { /* db down */ }
  } finally {
    running = false;
  }
  return out;
}

function start() {
  if (timer) return timer;
  timer = setInterval(() => {
    tick().catch(() => { /* tick already guards itself */ });
  }, TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick, processOne, rollupStatus, TICK_MS };
