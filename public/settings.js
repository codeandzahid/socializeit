'use strict';
/* Socializeit settings page — API keys per network. */

const $ = (s) => document.querySelector(s);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showNotice(text, kind) {
  const el = $('#notice');
  el.innerHTML = text ? '<div class="notice ' + (kind || 'info') + '">' + text + '</div>' : '';
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}

const NAMES = { facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok' };

async function load() {
  let data;
  try {
    data = await api('/api/settings');
  } catch (e) {
    $('#settings-list').innerHTML = '<p class="empty">Could not load settings.</p>';
    return;
  }
  const settings = data.settings || {};
  const help = data.help || {};
  const uris = data.redirectUris || {};
  $('#settings-list').innerHTML = Object.keys(help).map((net) => {
    const h = help[net];
    const fields = h.fields.map((f) => {
      const val = settings[f.key] || '';
      const isSecret = f.secret;
      const type = isSecret ? 'password' : 'text';
      const placeholder = val ? 'Saved — leave empty to keep it' : 'Paste it here';
      return '<label for="set-' + f.key + '">' + esc(f.label) + '</label>' +
        '<input type="' + type + '" id="set-' + f.key + '" data-key="' + f.key + '" value="" placeholder="' + esc(placeholder) + '" autocomplete="off">';
    }).join('');
    const links = (h.links || []).map((l) => '<a href="' + esc(l) + '" target="_blank" rel="noopener">' + esc(l) + '</a>').join(' · ');
    return '<section class="card">' +
      '<h2>' + esc(NAMES[net] || net) + '</h2>' +
      '<div class="help">' + esc(h.where) + '</div>' +
      '<p class="small">Redirect URI to register: <code>' + esc(uris[net] || '') + '</code></p>' +
      (links ? '<p class="small">' + links + '</p>' : '') +
      fields +
      '</section>';
  }).join('');
}

$('#save-btn').addEventListener('click', async () => {
  const btn = $('#save-btn');
  const msg = $('#save-msg');
  btn.disabled = true;
  msg.textContent = 'Saving…';
  try {
    const body = {};
    document.querySelectorAll('#settings-list input[data-key]').forEach((input) => {
      body[input.getAttribute('data-key')] = input.value;
    });
    await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    showNotice('Keys saved.', 'ok');
    msg.textContent = '';
    document.querySelectorAll('#settings-list input[data-key]').forEach((input) => {
      input.value = '';
      input.placeholder = 'Saved — leave empty to keep it';
    });
  } catch (e) {
    showNotice(esc(e.message), 'err');
    msg.textContent = '';
  } finally {
    btn.disabled = false;
  }
});

load();
