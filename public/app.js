'use strict';
/* Socializeit home page — composer, posts list, accounts. Plain JS, no build. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const STATUS_LABEL = {
  scheduled: 'Scheduled',
  posting: 'Posting…',
  posted: 'Posted',
  live: 'Live',
  failed: 'Failed',
  'duplicate-blocked': 'Duplicate blocked',
};
const NET_LABEL = { facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok' };

let selectedNets = new Set(['facebook', 'youtube', 'tiktok']);
let whenMode = 'now';
let accounts = [];

function showNotice(text, kind) {
  const el = $('#notice');
  el.innerHTML = text ? '<div class="notice ' + (kind || 'info') + '">' + text + '</div>' : '';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function timeStr(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}

/* ------------------------------------------------------------------ */
/* accounts                                                            */
/* ------------------------------------------------------------------ */

async function loadAccounts() {
  try {
    const data = await api('/api/accounts');
    accounts = data.accounts || [];
  } catch (e) {
    accounts = [];
  }
  const wrap = $('#accounts-list');
  if (!accounts.length) {
    wrap.innerHTML = '<p class="empty">Could not load accounts.</p>';
    return;
  }
  wrap.innerHTML = accounts.map((a) => {
    const connected = a.connected;
    const missing = (a.needsKeys || []).length > 0;
    let sub;
    if (connected) sub = esc(a.accountName || a.accountId || 'Connected');
    else if (missing) sub = 'Add keys in Settings first';
    else sub = 'Not connected';
    const btn = connected
      ? '<button class="btn btn-ghost btn-small" data-disconnect="' + a.network + '">Disconnect</button>'
      : '<button class="btn btn-ghost btn-small" data-connect="' + a.network + '"' + (missing ? ' disabled' : '') + '>Connect</button>';
    let pagePicker = '';
    if (a.network === 'facebook' && connected && a.extra && a.extra.pages && a.extra.pages.length > 1) {
      const current = a.accountId;
      pagePicker = '<div style="margin-top:8px"><label style="margin:0 0 4px">Facebook Page</label>' +
        '<select id="fb-page-select">' +
        a.extra.pages.map((p) => '<option value="' + esc(p.id) + '"' + (p.id === current ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
        '</select></div>';
    }
    return '<div class="account">' +
      '<span class="dot' + (connected ? ' on' : '') + '"></span>' +
      '<div class="info"><div class="name">' + esc(a.name) + '</div>' +
      '<div class="sub">' + sub + '</div>' + pagePicker + '</div>' + btn +
      '</div>';
  }).join('');

  wrap.querySelectorAll('[data-connect]').forEach((b) => {
    b.addEventListener('click', async () => {
      const net = b.getAttribute('data-connect');
      try {
        const res = await fetch('/api/accounts/' + net + '/connect');
        if (res.redirected) { window.location.href = res.url; return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not start connect.');
        if (data.settingsUrl) window.location.href = data.settingsUrl;
      } catch (e) {
        showNotice(esc(e.message), 'err');
      }
    });
  });
  wrap.querySelectorAll('[data-disconnect]').forEach((b) => {
    b.addEventListener('click', async () => {
      const net = b.getAttribute('data-disconnect');
      if (!confirm('Disconnect ' + NET_LABEL[net] + '? You can connect it again any time.')) return;
      try {
        await api('/api/accounts/' + net + '/disconnect', { method: 'POST' });
        showNotice(NET_LABEL[net] + ' disconnected.', 'ok');
        await loadAccounts();
      } catch (e) {
        showNotice(esc(e.message), 'err');
      }
    });
  });
  const sel = $('#fb-page-select');
  if (sel) {
    sel.addEventListener('change', async () => {
      try {
        await api('/api/accounts/facebook/page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageId: sel.value }),
        });
        showNotice('Facebook Page changed.', 'ok');
      } catch (e) {
        showNotice(esc(e.message), 'err');
        await loadAccounts();
      }
    });
  }
  updateNetHint();
}

function updateNetHint() {
  const missing = accounts.filter((a) => selectedNets.has(a.network) && (a.needsKeys || []).length);
  const notConn = accounts.filter((a) => selectedNets.has(a.network) && !(a.needsKeys || []).length && !a.connected);
  const parts = [];
  if (missing.length) parts.push('Keys missing for ' + missing.map((a) => a.name).join(', ') + ' — add them in Settings.');
  if (notConn.length) parts.push('Not connected yet: ' + notConn.map((a) => a.name).join(', ') + '.');
  $('#net-hint').textContent = parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* posts                                                               */
/* ------------------------------------------------------------------ */

async function loadPosts() {
  let posts = [];
  try {
    const data = await api('/api/posts');
    posts = data.posts || [];
  } catch (e) {
    $('#posts-list').innerHTML = '<p class="empty">Could not load posts.</p>';
    return;
  }
  const wrap = $('#posts-list');
  if (!posts.length) {
    wrap.innerHTML = '<p class="empty">No posts yet. Write your first one above.</p>';
    return;
  }
  wrap.innerHTML = posts.map((p) => {
    const dels = (p.deliveries || []).map((d) => {
      const label = d.status === 'live' ? 'Live'
        : d.status === 'posted' ? 'Posted'
        : d.status === 'failed' ? 'Failed'
        : d.status === 'duplicate-blocked' ? 'Blocked'
        : d.status === 'posting' ? 'Posting…'
        : 'Waiting';
      const inner = d.remoteUrl
        ? '<a href="' + esc(d.remoteUrl) + '" target="_blank" rel="noopener">' + esc(NET_LABEL[d.network]) + ' · ' + label + '</a>'
        : esc(NET_LABEL[d.network]) + ' · ' + label;
      const title = d.error ? ' title="' + esc(d.error) + '"' : '';
      return '<span class="badge ' + esc(d.status) + ' delivery"' + title + '>' + inner + '</span>';
    }).join('');
    const media = p.mediaPath
      ? (p.mediaType === 'video'
        ? '<video class="thumb" src="/uploads/' + esc(p.mediaPath.split('/').pop()) + '" controls preload="metadata"></video>'
        : '<img class="thumb" src="/uploads/' + esc(p.mediaPath.split('/').pop()) + '" alt="">')
      : '';
    const err = p.error ? '<p class="small" style="color: var(--red);">' + esc(p.error) + '</p>' : '';
    const retry = p.status === 'failed'
      ? '<button class="btn btn-ghost btn-small" data-retry="' + esc(p.id) + '">Retry</button>' : '';
    const del = '<button class="btn btn-danger btn-small" data-delete="' + esc(p.id) + '">Delete</button>';
    return '<article class="post">' +
      media +
      '<p class="caption">' + esc(p.caption || '(no text)') + '</p>' +
      '<p class="meta">' + timeStr(p.scheduledAt) + ' · ' + esc(p.networks.map((n) => NET_LABEL[n]).join(', ')) + '</p>' +
      '<div class="deliveries"><span class="badge ' + esc(p.status) + '">' + esc(STATUS_LABEL[p.status] || p.status) + '</span>' + dels + '</div>' +
      err +
      '<div class="row">' + retry + del + '</div>' +
      '</article>';
  }).join('');

  wrap.querySelectorAll('[data-retry]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await api('/api/posts/' + b.getAttribute('data-retry') + '/retry', { method: 'POST' });
        showNotice('Retrying now.', 'ok');
        await loadPosts();
      } catch (e) { showNotice(esc(e.message), 'err'); }
    });
  });
  wrap.querySelectorAll('[data-delete]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Delete this post?')) return;
      try {
        await api('/api/posts/' + b.getAttribute('data-delete'), { method: 'DELETE' });
        await loadPosts();
      } catch (e) { showNotice(esc(e.message), 'err'); }
    });
  });
}

/* ------------------------------------------------------------------ */
/* composer                                                            */
/* ------------------------------------------------------------------ */

function setupComposer() {
  $$('#net-row .net-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const net = chip.getAttribute('data-net');
      if (selectedNets.has(net)) {
        if (selectedNets.size === 1) return; // keep at least one
        selectedNets.delete(net);
        chip.classList.remove('on');
      } else {
        selectedNets.add(net);
        chip.classList.add('on');
      }
      $('#yt-title-wrap').style.display = selectedNets.has('youtube') ? '' : 'none';
      updateNetHint();
    });
  });
  $$('[data-when]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('[data-when]').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');
      whenMode = chip.getAttribute('data-when');
      $('#schedule-wrap').style.display = whenMode === 'schedule' ? '' : 'none';
      $('#submit-btn').textContent = whenMode === 'schedule' ? 'Schedule it' : 'Post it';
    });
  });

  const fileInput = $('#media');
  $('#file-box').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    const prev = $('#media-preview');
    prev.innerHTML = '';
    if (!file) {
      $('#file-label').innerHTML = '<strong>Tap to pick a video or photo</strong><br>Video goes to all three as a Reel / Short. Photo goes to Facebook and TikTok.';
      return;
    }
    $('#file-label').innerHTML = '<strong>' + esc(file.name) + '</strong><br>' + (file.size / 1048576).toFixed(1) + ' MB';
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
      prev.innerHTML = '<video src="' + url + '" controls preload="metadata"></video>';
    } else if (file.type.startsWith('image/')) {
      prev.innerHTML = '<img src="' + url + '" alt="">';
    }
  });

  $('#post-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errEl = $('#form-error');
    errEl.textContent = '';
    const btn = $('#submit-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const form = new FormData(ev.target);
      for (const net of ['facebook', 'youtube', 'tiktok']) {
        if (selectedNets.has(net)) form.set('net_' + net, '1');
        else form.delete('net_' + net);
      }
      form.set('when', whenMode);
      const res = await fetch('/api/posts', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save the post.');
      ev.target.reset();
      $('#media-preview').innerHTML = '';
      $('#file-label').innerHTML = '<strong>Tap to pick a video or photo</strong><br>Video goes to all three as a Reel / Short. Photo goes to Facebook and TikTok.';
      selectedNets = new Set(['facebook', 'youtube', 'tiktok']);
      $$('#net-row .net-chip').forEach((c) => c.classList.add('on'));
      showNotice(whenMode === 'schedule' ? 'Scheduled. It will post on time.' : 'Queued. Posting now.', 'ok');
      await loadPosts();
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = whenMode === 'schedule' ? 'Schedule it' : 'Post it';
    }
  });
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

(function init() {
  const params = new URLSearchParams(window.location.search);
  const err = params.get('error');
  const connected = params.get('connected');
  if (err) showNotice(esc(err), 'err');
  else if (connected) showNotice(esc(NET_LABEL[connected] || connected) + ' connected.', 'ok');
  if (err || connected) {
    const u = new URL(window.location.href);
    u.searchParams.delete('error');
    u.searchParams.delete('connected');
    window.history.replaceState({}, '', u.toString());
  }
  setupComposer();
  loadAccounts();
  loadPosts();
  setInterval(loadPosts, 15000);
  setInterval(loadAccounts, 30000);
})();
