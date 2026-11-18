'use strict';
/**
 * Facebook network for Socializeit.
 *
 * Real API: Facebook Graph API (v19.0).
 *  - OAuth: facebook.com/dialog/oauth, then graph.facebook.com/oauth/access_token.
 *  - Pages: /me/accounts gives the Pages the user manages (with page tokens).
 *  - Video (Reel): resumable upload to graph-video.facebook.com
 *    (start -> transfer -> finish with video_state=PUBLISHED).
 *  - Photo: POST /{page-id}/photos. Text: POST /{page-id}/feed.
 *  - Verify: GET /{video-id}?fields=id,permalink_url — a 200 means it is live.
 *
 * Needs a Facebook developer app (App ID + App Secret) entered in Settings,
 * with the product "Facebook Login" and permissions pages_manage_posts,
 * pages_read_engagement, publish_video. The app must be in Live mode to
 * post to a real Page.
 */
const fs = require('fs');

const GRAPH = 'https://graph.facebook.com/v19.0';
const GRAPH_VIDEO = 'https://graph-video.facebook.com/v19.0';
const SCOPES = ['pages_manage_posts', 'pages_read_engagement', 'publish_video'];

function missingKeys(settings) {
  const missing = [];
  if (!settings.facebook_app_id) missing.push('facebook_app_id');
  if (!settings.facebook_app_secret) missing.push('facebook_app_secret');
  return missing;
}

function authUrl(settings, redirectUri, state) {
  const u = new URL('https://www.facebook.com/v19.0/dialog/oauth');
  u.searchParams.set('client_id', settings.facebook_app_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', SCOPES.join(','));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  return u.toString();
}

async function fbFetch(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* not JSON */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) ||
      ('Facebook error ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.code = data && data.error ? data.error.code : undefined;
    throw err;
  }
  return data;
}

/** Exchange the OAuth code for a long-lived user token. */
async function exchangeCode(settings, redirectUri, code) {
  const u = new URL(GRAPH + '/oauth/access_token');
  u.searchParams.set('client_id', settings.facebook_app_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('client_secret', settings.facebook_app_secret);
  u.searchParams.set('code', code);
  const short = await fbFetch(u.toString());
  // Swap the short-lived token (hours) for a long-lived one (about 60 days).
  const u2 = new URL(GRAPH + '/oauth/access_token');
  u2.searchParams.set('grant_type', 'fb_exchange_token');
  u2.searchParams.set('client_id', settings.facebook_app_id);
  u2.searchParams.set('client_secret', settings.facebook_app_secret);
  u2.searchParams.set('fb_exchange_token', short.access_token);
  const long = await fbFetch(u2.toString());
  const me = await fbFetch(
    GRAPH + '/me?fields=id,name&access_token=' + encodeURIComponent(long.access_token));
  return {
    accountId: me.id,
    name: me.name,
    accessToken: long.access_token,
    refreshToken: null,
    expiresAt: Date.now() + (long.expires_in || 5184000) * 1000,
    extra: {},
  };
}

/** List the Pages this user manages (each with its own page token). */
async function listPages(userAccessToken) {
  const u = new URL(GRAPH + '/me/accounts');
  u.searchParams.set('fields', 'id,name,access_token');
  u.searchParams.set('access_token', userAccessToken);
  u.searchParams.set('limit', '50');
  const data = await fbFetch(u.toString());
  return (data.data || []).map((p) => ({
    id: p.id,
    name: p.name,
    accessToken: p.access_token,
  }));
}

function pageToken(account) {
  // account.extra holds { pageId, pageToken } after the user picks a Page.
  // If only one page was found at connect time it is stored as the account.
  return account.extra && account.extra.pageToken
    ? account.extra.pageToken
    : account.accessToken;
}

function pageId(account) {
  return account.extra && account.extra.pageId
    ? account.extra.pageId
    : account.accountId;
}

/** Upload a video as a Facebook Reel (resumable upload, then publish). */
async function postVideo(account, post, mediaPath) {
  const token = pageToken(account);
  const page = pageId(account);
  const file = fs.readFileSync(mediaPath);
  const caption = post.titleFb || post.caption || '';

  // 1. Start: ask Facebook for an upload session.
  const startUrl = new URL(GRAPH_VIDEO + '/' + page + '/video_reels');
  startUrl.searchParams.set('upload_phase', 'start');
  startUrl.searchParams.set('access_token', token);
  const start = await fbFetch(startUrl.toString(), { method: 'POST' });
  const videoId = start.video_id;
  const uploadUrl = start.upload_url;
  if (!videoId || !uploadUrl) throw new Error('Facebook did not start the upload.');

  // 2. Transfer: send the whole file in one chunk.
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: 'OAuth ' + token,
      file_offset: '0',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.length),
    },
    body: file,
  });
  const upText = await up.text();
  if (!up.ok) {
    let msg = 'Facebook upload failed (' + up.status + ')';
    try { msg = JSON.parse(upText).error.message; } catch (_) { /* keep default */ }
    throw new Error(msg);
  }

  // 3. Finish: publish the Reel.
  const finishUrl = new URL(GRAPH_VIDEO + '/' + page + '/video_reels');
  finishUrl.searchParams.set('upload_phase', 'finish');
  finishUrl.searchParams.set('video_id', videoId);
  finishUrl.searchParams.set('video_state', 'PUBLISHED');
  finishUrl.searchParams.set('description', caption);
  finishUrl.searchParams.set('access_token', token);
  await fbFetch(finishUrl.toString(), { method: 'POST' });

  return {
    remoteId: videoId,
    url: 'https://www.facebook.com/reel/' + videoId + '/',
 // permalink may differ; verify() corrects it
  };
}

/** Post a photo to the Page. */
async function postPhoto(account, post, mediaPath) {
  const token = pageToken(account);
  const page = pageId(account);
  const file = fs.readFileSync(mediaPath);
  const form = new FormData();
  form.append('caption', post.caption || '');
  form.append('published', 'true');
  form.append('source', new Blob([file], { type: 'image/jpeg' }), 'photo.jpg');
  const url = GRAPH + '/' + page + '/photos?access_token=' + encodeURIComponent(token);
  const data = await fbFetch(url, { method: 'POST', body: form });
  return {
    remoteId: data.id,
    url: data.post_id ? 'https://www.facebook.com/' + data.post_id : null,
  };
}

/** Post text only to the Page. */
async function postText(account, post) {
  const token = pageToken(account);
  const page = pageId(account);
  const url = GRAPH + '/' + page + '/feed?access_token=' + encodeURIComponent(token);
  const form = new FormData();
  form.append('message', post.caption || '');
  const data = await fbFetch(url, { method: 'POST', body: form });
  return {
    remoteId: data.id,
    url: 'https://www.facebook.com/' + data.id,
  };
}

async function post(account, post, mediaPath) {
  if (post.mediaType === 'video') return postVideo(account, post, mediaPath);
  if (post.mediaType === 'photo') return postPhoto(account, post, mediaPath);
  return postText(account, post);
}

/** Read the post back. A 200 with the same id means it is live. */
async function verify(account, remoteId) {
  const token = pageToken(account);
  const url = GRAPH + '/' + remoteId +
    '?fields=id,permalink_url&access_token=' + encodeURIComponent(token);
  try {
    const data = await fbFetch(url);
    if (data && data.id) {
      return { live: true, url: data.permalink_url || null };
    }
    return { live: false, url: null };
  } catch (e) {
    // A 404/permission error here means "not live (yet)".
    return { live: false, url: null, error: e.message };
  }
}

module.exports = {
  id: 'facebook',
  name: 'Facebook',
  missingKeys,
  authUrl,
  exchangeCode,
  listPages,
  post,
  postVideo,
  postPhoto,
  postText,
  verify,
  pageId,
};
