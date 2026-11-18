'use strict';
/**
 * TikTok network for Socializeit.
 *
 * Real API: TikTok Content Posting API + Login Kit.
 *  - OAuth: tiktok.com/v2/auth/authorize (scopes user.info.basic,
 *    video.upload), then open.tiktokapis.com/v2/oauth/token.
 *  - Video: POST /v2/post/publish/video/init (get publish_id + upload_url),
 *    PUT the file in chunks to upload_url, then check status.
 *  - Photo: POST /v2/post/publish/content/init (same idea, one image).
 *  - Verify: POST /v2/post/publish/status/fetch {publish_id} —
 *    PUBLISH_COMPLETE means it is live.
 *
 * Needs a TikTok developer app (client key + client secret) in Settings.
 * Direct posting needs the app approved for the video.upload scope and
 * the Content Posting API — TikTok reviews apps, which can take days.
 * Until then the connect works but publishing will fail with a clear
 * message from TikTok.
 */
const fs = require('fs');

const SCOPES = ['user.info.basic', 'video.upload'];
const CHUNK = 8 * 1024 * 1024; // 8 MB upload chunks

function missingKeys(settings) {
  const missing = [];
  if (!settings.tiktok_client_key) missing.push('tiktok_client_key');
  if (!settings.tiktok_client_secret) missing.push('tiktok_client_secret');
  return missing;
}

function authUrl(settings, redirectUri, state) {
  const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
  u.searchParams.set('client_key', settings.tiktok_client_key);
  u.searchParams.set('scope', SCOPES.join(','));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenRequest(settings, body) {
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: settings.tiktok_client_key,
      client_secret: settings.tiktok_client_secret,
      ...body,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.error)) {
    throw new Error(
      (data && (data.error_description || data.error)) ||
      ('TikTok error ' + res.status));
  }
  return data;
}

async function exchangeCode(settings, redirectUri, code) {
  const data = await tokenRequest(settings, {
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const info = await getUserInfo(data.access_token);
  return {
    accountId: data.open_id || (info && info.open_id) || 'tiktok',
    name: (info && info.display_name) || 'TikTok account',
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + (data.expires_in || 86400) * 1000,
    extra: { openId: data.open_id },
  };
}

async function getUserInfo(accessToken) {
  const res = await fetch(
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url',
    { headers: { Authorization: 'Bearer ' + accessToken } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.data || !data.data.user) return null;
  return data.data.user;
}

async function refreshAccessToken(account, settings) {
  if (!account.refreshToken) return null;
  const data = await tokenRequest(settings, {
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
  });
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 86400) * 1000,
  };
}

/** PUT a file to an upload URL in chunks. */
async function putChunks(uploadUrl, mediaPath, contentType) {
  const size = fs.statSync(mediaPath).size;
  const fd = fs.openSync(mediaPath, 'r');
  let uploaded = 0;
  try {
    while (uploaded < size) {
      const end = Math.min(uploaded + CHUNK, size);
      const buf = Buffer.alloc(end - uploaded);
      fs.readSync(fd, buf, 0, buf.length, uploaded);
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(buf.length),
          'Content-Range': 'bytes ' + uploaded + '-' + (end - 1) + '/' + size,
        },
        body: buf,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error('TikTok upload failed (' + res.status + ') ' + text.slice(0, 200));
      }
      uploaded = end;
    }
  } finally {
    fs.closeSync(fd);
  }
  return size;
}

async function postVideo(account, post, mediaPath, settings) {
  const size = fs.statSync(mediaPath).size;
  const chunkSize = Math.min(CHUNK, size);
  const totalChunks = Math.ceil(size / chunkSize);
  const title = (post.titleTt || post.caption || '').slice(0, 2200);

  const initRes = await fetch(
    'https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + account.accessToken,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title,
          privacy_level: 'PUBLIC',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: size,
          chunk_size: chunkSize,
          total_chunk_count: totalChunks,
        },
      }),
    });
  const init = await initRes.json().catch(() => ({}));
  if (!initRes.ok || !init.data || !init.data.upload_url) {
    const msg = (init.error && (init.error.message || init.error.code)) ||
      ('TikTok init failed (' + initRes.status + ')');
    throw new Error(msg);
  }
  await putChunks(init.data.upload_url, mediaPath, 'video/mp4');
  return {
    remoteId: init.data.publish_id,
    url: null, // TikTok gives no public URL until it is live; verify() finds it.
  };
}

async function postPhoto(account, post, mediaPath, settings) {
  const size = fs.statSync(mediaPath).size;
  const chunkSize = Math.min(CHUNK, size);
  const initRes = await fetch(
    'https://open.tiktokapis.com/v2/post/publish/content/init/', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + account.accessToken,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title: (post.caption || '').slice(0, 2200),
          privacy_level: 'PUBLIC',
          disable_comment: false,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          photo_cover_index: 0,
          photo_images: [{
            image_size: size,
            chunk_size: chunkSize,
            total_chunk_count: Math.ceil(size / chunkSize),
          }],
        },
      }),
    });
  const init = await initRes.json().catch(() => ({}));
  if (!initRes.ok || !init.data || !init.data.upload_url) {
    const msg = (init.error && (init.error.message || init.error.code)) ||
      ('TikTok photo init failed (' + initRes.status + ')');
    throw new Error(msg);
  }
  await putChunks(init.data.upload_url, mediaPath, 'image/jpeg');
  return { remoteId: init.data.publish_id, url: null };
}

async function post(account, post, mediaPath, settings) {
  if (post.mediaType === 'video') return postVideo(account, post, mediaPath, settings);
  if (post.mediaType === 'photo') return postPhoto(account, post, mediaPath, settings);
  throw new Error('TikTok needs a video or a photo. A text-only post has no TikTok API.');
}

/** Check the publish status. PUBLISH_COMPLETE means it is live. */
async function verify(account, remoteId, settings) {
  try {
    const res = await fetch(
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + account.accessToken,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ publish_id: remoteId }),
      });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { live: false, url: null };
    const status = data && data.data ? data.data.status : null;
    if (status === 'PUBLISH_COMPLETE') {
      return { live: true, url: null };
    }
    if (status === 'FAILED') {
      return {
        live: false,
        url: null,
        error: (data.data && data.data.fail_reason) || 'TikTok publish failed',
      };
    }
    return { live: false, url: null }; // still processing
  } catch (e) {
    return { live: false, url: null, error: e.message };
  }
}

module.exports = {
  id: 'tiktok',
  name: 'TikTok',
  missingKeys,
  authUrl,
  exchangeCode,
  refreshAccessToken,
  post,
  postVideo,
  postPhoto,
  verify,
  getUserInfo,
};
