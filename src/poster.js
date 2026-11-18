'use strict';
/**
 * Poster — posts one scheduled post to its networks, then verifies each one.
 *
 * Duplicate protection (the core promise): every (post, network) has an
 * idempotency key "<postId>:<network>" stored in the deliveries table with
 * a UNIQUE constraint. Before posting to a network, we check the delivery
 * row:
 *   - already "live" or "posted"  -> skip it, mark "duplicate-blocked".
 *   - already "posting" (another worker claimed it) -> skip it.
 *   - otherwise -> post it, then verify it by reading it back.
 *
 * Verification: after a network returns an id, we call its verify()
 * (read the post back from the network). Only a successful read-back
 * marks the delivery "live". A post that went out but cannot be read back
 * is "posted" (needs a human look), not "live".
 *
 * Every step is logged to the events table so the UI can show what happened.
 */
const path = require('path');
const db = require('./db');
const facebook = require('./networks/facebook');
const youtube = require('./networks/youtube');
const tiktok = require('./networks/tiktok');

const NETWORKS = { facebook, youtube, tiktok };

function settingsMap() {
  return {
    facebook_app_id: db.getSetting('facebook_app_id'),
    facebook_app_secret: db.getSetting('facebook_app_secret'),
    youtube_client_id: db.getSetting('youtube_client_id'),
    youtube_client_secret: db.getSetting('youtube_client_secret'),
    tiktok_client_key: db.getSetting('tiktok_client_key'),
    tiktok_client_secret: db.getSetting('tiktok_client_secret'),
  };
}

/**
 * Refresh an account's access token when it is expired, and save the new
 * one. Returns the (possibly refreshed) account object.
 */
async function ensureFreshToken(network, account, settings) {
  const mod = NETWORKS[network];
  if (!mod || !mod.refreshAccessToken) return account;
  if (!account.expiresAt || account.expiresAt > Date.now() + 60000) return account;
  if (!account.refreshToken) return account;
  try {
    const fresh = await mod.refreshAccessToken(account, settings);
    if (fresh && fresh.accessToken) {
      db.upsertAccount(network, account.accountId, {
        accessToken: fresh.accessToken,
        expiresAt: fresh.expiresAt,
      });
      return { ...account, accessToken: fresh.accessToken, expiresAt: fresh.expiresAt };
    }
  } catch (e) {
    db.logEvent(null, network, 'Token refresh failed: ' + e.message);
  }
  return account;
}

/**
 * Post one post to all its networks. Returns a summary.
 * This function is idempotent: running it twice for the same post will
 * never post the same thing twice to one network.
 */
async function processPost(post) {
  const settings = settingsMap();
  const mediaPath = post.mediaPath
    ? path.join(__dirname, '..', post.mediaPath)
    : null;
  const results = [];

  for (const network of post.networks) {
    const mod = NETWORKS[network];
    if (!mod) {
      results.push({ network, status: 'failed', error: 'Unknown network: ' + network });
      continue;
    }
    const key = post.id + ':' + network;
    const delivery = db.getDeliveryByKey(key);
    if (!delivery) {
      results.push({ network, status: 'failed', error: 'No delivery row for ' + network });
      continue;
    }

    // --- duplicate protection -------------------------------------
    // A delivery that is already live stays live — we never touch it
    // again, and we report the skip so the run is honest about it.
    if (delivery.status === 'live') {
      db.logEvent(post.id, network, 'Already live — skipped so it never goes out twice.');
      results.push({ network, status: 'duplicate-blocked' });
      continue;
    }
    // A delivery that went out but could not be read back ("posted"):
    // never post it again — try to read it back instead.
    if (delivery.status === 'posted' && delivery.remote_id) {
      let verified = { live: false };
      try {
        verified = await mod.verify(
          db.getAccount(network), delivery.remote_id, settings);
      } catch (_) { /* leave as posted */ }
      if (verified.live) {
        db.updateDelivery(delivery.id, {
          status: 'live',
          remote_url: verified.url || delivery.remote_url,
        });
        db.logEvent(post.id, network, 'Live and verified on retry.');
        results.push({ network, status: 'live', remoteId: delivery.remote_id, url: verified.url || delivery.remote_url });
      } else {
        db.logEvent(post.id, network, 'Already posted — not sent again. Check it on ' + mod.name + '.');
        results.push({ network, status: 'posted', remoteId: delivery.remote_id, url: delivery.remote_url });
      }
      continue;
    }
    if (delivery.status === 'posting') {
      results.push({ network, status: 'skipped', error: 'Another worker is posting this.' });
      continue;
    }

    db.updateDelivery(delivery.id, {
      status: 'posting',
      attempts: delivery.attempts + 1,
      error: null,
    });

    // --- keys + account -------------------------------------------
    const missing = mod.missingKeys(settings);
    if (missing.length) {
      const msg = 'Add your ' + mod.name + ' keys in Settings first (' + missing.join(', ') + ').';
      db.updateDelivery(delivery.id, { status: 'failed', error: msg });
      db.logEvent(post.id, network, msg);
      results.push({ network, status: 'failed', error: msg });
      continue;
    }
    let account = db.getAccount(network);
    if (!account || !account.accessToken) {
      const msg = 'Connect your ' + mod.name + ' account first (Accounts section).';
      db.updateDelivery(delivery.id, { status: 'failed', error: msg });
      db.logEvent(post.id, network, msg);
      results.push({ network, status: 'failed', error: msg });
      continue;
    }
    account = await ensureFreshToken(network, account, settings);

    // --- post ------------------------------------------------------
    let posted;
    try {
      const onRefreshed = async (fresh) => {
        db.upsertAccount(network, account.accountId, {
          accessToken: fresh.accessToken,
          expiresAt: fresh.expiresAt,
        });
        account = { ...account, accessToken: fresh.accessToken, expiresAt: fresh.expiresAt };
      };
      if (network === 'youtube') {
        posted = await mod.post(account, post, mediaPath, settings, onRefreshed);
      } else {
        posted = await mod.post(account, post, mediaPath, settings);
      }
    } catch (e) {
      const msg = e.message || 'Post failed.';
      db.updateDelivery(delivery.id, { status: 'failed', error: msg });
      db.logEvent(post.id, network, 'Post failed: ' + msg);
      results.push({ network, status: 'failed', error: msg });
      continue;
    }

    // --- verify (read it back) ------------------------------------
    let verified = { live: false, url: posted.url || null };
    try {
      if (network === 'youtube') {
        verified = await mod.verify(account, posted.remoteId, settings);
      } else {
        verified = await mod.verify(account, posted.remoteId, settings);
      }
    } catch (e) {
      verified = { live: false, url: posted.url || null, error: e.message };
    }

    if (verified.live) {
      db.updateDelivery(delivery.id, {
        status: 'live',
        remote_id: posted.remoteId,
        remote_url: verified.url || posted.url,
      });
      db.logEvent(post.id, network, 'Live and verified.');
      results.push({ network, status: 'live', remoteId: posted.remoteId, url: verified.url || posted.url });
    } else {
      // It went out but we could not read it back. Do NOT retry blindly —
      // it may already be live. Mark "posted" for a human to check.
      db.updateDelivery(delivery.id, {
        status: 'posted',
        remote_id: posted.remoteId,
        remote_url: posted.url,
        error: verified.error || 'Posted, but could not read it back yet.',
      });
      db.logEvent(post.id, network, 'Posted, but could not read it back yet.');
      results.push({ network, status: 'posted', remoteId: posted.remoteId, url: posted.url });
    }
  }

  return results;
}

module.exports = { processPost, settingsMap, NETWORKS };
