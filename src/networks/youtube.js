'use strict';
/**
 * YouTube network for Socializeit.
 *
 * Real API: YouTube Data API v3 + Google OAuth 2.0.
 *  - OAuth: accounts.google.com/o/oauth2/v2/auth (scopes youtube.upload,
 *    youtube.readonly), access_type=offline so we get a refresh token.
 *  - Upload: resumable upload to googleapis.com/upload/youtube/v3/videos
 *    (create session -> PUT chunks -> video resource). A vertical video
 *    under 60 seconds is automatically a Short.
 *  - Verify: GET /youtube/v3/videos?part=status&id=... — present = live.
 *
 * Needs a Google Cloud project with the YouTube Data API v3 enabled, an
 * OAuth client (Web application), and the client ID + secret in Settings.
 * The redirect URI in Settings must match the one in Google Cloud exactly.
 */
const fs = require('fs');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];
const CHUNK = 8 * 1024 * 1024; // 8 MB upload chunks

function missingKeys(settings) {
  const missing = [];
  if (!settings.youtube_client_id) missing.push('youtube_client_id');
  if (!settings.youtube_client_secret) missing.push('youtube_client_secret');
  return missing;
}

function authUrl(settings, redirectUri, state) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', settings.youtube_client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenRequest(settings, body) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.youtube_client_id,
      client_secret: settings.youtube_client_secret,
      ...body,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data && data.error_description) || data.error || ('Google error ' + res.status));
  }
  return data;
}

async function exchangeCode(settings, redirectUri, code) {
  const data = await tokenRequest(settings, {
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const channel = await getChannel(data.access_token);
  return {
    accountId: channel ? channel.id : 'youtube',
    name: channel ? channel.title : 'YouTube channel',
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    extra: {},
  };
}

async function getChannel(accessToken) {
  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    { headers: { Authorization: 'Bearer ' + accessToken } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.items || !data.items.length) return null;
  return { id: data.items[0].id, title: data.items[0].snippet.title };
}

/** Refresh the access token. Returns the new token (or null). */
async function refreshAccessToken(account, settings) {
  if (!account.refreshToken) return null;
  const data = await tokenRequest(settings, {
    refresh_token: account.refreshToken,
    grant_type: 'refresh_token',
  });
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

/**
 * Run an authenticated call. If the token is expired (401) and we have a
 * refresh token, refresh once and retry. Returns { data, refreshed }.
 */
async function authed(settings, account, url, options, onRefreshed) {
  const doFetch = async (token) => fetch(url, {
    ...(options || {}),
    headers: { ...(options && options.headers ? options.headers : {}), Authorization: 'Bearer ' + token },
  });
  let res = await doFetch(account.accessToken);
  if (res.status === 401 && account.refreshToken) {
    const fresh = await refreshAccessToken(account, settings);
    if (fresh) {
      if (onRefreshed) await onRefreshed(fresh);
      res = await doFetch(fresh.accessToken);
    }
  }
  return res;
}

/** Upload a video (resumable). Returns { remoteId, url }. */
async function postVideo(account, post, mediaPath, settings, onRefreshed) {
  const size = fs.statSync(mediaPath).size;
  const title = (post.titleYt || post.caption || 'Socializeit video').slice(0, 100) || 'Socializeit video';
  const description = post.caption || '';

  // 1. Create the resumable session.
  const createRes = await authed(settings, account,
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({
        snippet: { title, description, categoryId: '22' },
        status: { privacyStatus: 'public' },
      }),
    }, onRefreshed);
  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    throw new Error(
      (err.error && err.error.message) || ('YouTube upload failed (' + createRes.status + ')'));
  }
  const uploadUrl = createRes.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube did not return an upload URL.');

  // 2. PUT the file in 8 MB chunks.
  const fd = fs.openSync(mediaPath, 'r');
  let uploaded = 0;
  let last = null;
  try {
    while (uploaded < size) {
      const end = Math.min(uploaded + CHUNK, size);
      const buf = Buffer.alloc(end - uploaded);
      fs.readSync(fd, buf, 0, buf.length, uploaded);
      const isLast = end === size;
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(buf.length),
          'Content-Range': 'bytes ' + uploaded + '-' + (end - 1) + '/' + size,
        },
        body: buf,
      });
      if (isLast) {
        if (!putRes.ok) {
          const err = await putRes.json().catch(() => ({}));
          throw new Error(
            (err.error && err.error.message) || ('YouTube upload failed (' + putRes.status + ')'));
        }
        last = await putRes.json();
      } else if (putRes.status !== 308) {
        const err = await putRes.json().catch(() => ({}));
        throw new Error(
          (err.error && err.error.message) || ('YouTube upload failed (' + putRes.status + ')'));
      }
      uploaded = end;
    }
  } finally {
    fs.closeSync(fd);
  }
  const videoId = last && last.id;
  if (!videoId) throw new Error('YouTube did not return a video id.');
  return {
    remoteId: videoId,
    url: 'https://www.youtube.com/watch?v=' + videoId,
  };
}

async function post(account, post, mediaPath, settings, onRefreshed) {
  if (post.mediaType !== 'video') {
    // The YouTube Data API has no way to post a photo or a text-only post
    // (Community posts are not in the API). Say so plainly instead of faking it.
    throw new Error(
      'YouTube only takes video here. A photo or text-only post has no YouTube API — post it to Facebook or TikTok instead.');
  }
  return postVideo(account, post, mediaPath, settings, onRefreshed);
}

/** Read the video back. Present in the API response means it is live. */
async function verify(account, remoteId, settings, onRefreshed) {
  const url = 'https://www.googleapis.com/youtube/v3/videos?part=status&id=' +
    encodeURIComponent(remoteId);
  try {
    const res = await authed(settings, account, url, {}, onRefreshed);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.items && data.items.length) {
      return { live: true, url: 'https://www.youtube.com/watch?v=' + remoteId };
    }
    return { live: false, url: null };
  } catch (e) {
    return { live: false, url: null, error: e.message };
  }
}

module.exports = {
  id: 'youtube',
  name: 'YouTube',
  missingKeys,
  authUrl,
  exchangeCode,
  refreshAccessToken,
  post,
  postVideo,
  verify,
  getChannel,
};
