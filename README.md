# Socializeit

Write a post once. Post it to Facebook, YouTube and TikTok together.

Socializeit is a small, simple web app for people who post a lot of video.
You write the caption, attach a video (or a photo), pick the networks, and
hit Post now or Schedule. The app posts it, then reads it back on each
network to prove it is actually live. If a post fails, it retries. It never
posts the same thing twice.

It is a cleaner, lighter rebuild of the idea behind Postiz — written from
scratch, in plain Node.js, with no heavy stack and no copied code.

## What is different from Postiz

| Postiz | Socializeit |
|---|---|
| Heavy: Temporal, Elasticsearch, 7+ containers | Light: plain Node.js, SQLite file, one built-in job queue. One command to run. |
| Posts and hopes it went out | Posts, then reads it back on each network. Only a read-back counts as **Live**. |
| Retries can double-post | Every post has an idempotency key per network. A live post is never sent again. |
| Text-first | Video-first: one video becomes a Facebook Reel, a YouTube Short and a TikTok together. |
| Connect is fiddly | One-tap OAuth per network. Your own keys go in a simple Settings page. |
| Desktop-first | Phone-first web UI. Big buttons, simple words. |

## Run it

You need Node.js 22.5 or newer (for the built-in SQLite). No other install.

```sh
node server.js
```

Open http://localhost:3000. On your phone, open this machine's address on
port 3000 (same Wi-Fi). To use another port:

```sh
PORT=4000 node server.js
```

Everything is stored in `data/` (database + uploads + a secret key file).
That folder is gitignored and never committed.

## Connect your accounts

Socializeit posts with **your own** developer apps. Add the keys in
Settings first, then tap Connect on the home page.

### Facebook — App ID + App Secret
1. Go to https://developers.facebook.com/apps → Create App → Facebook Login.
2. In Facebook Login → Settings, add this redirect URI:
   `http://localhost:3000/auth/facebook/callback`
   (use your real address and port if you run it elsewhere).
3. Ask for permissions: `pages_manage_posts`, `pages_read_engagement`,
   `publish_video`.
4. Paste the App ID and App Secret into Settings.
5. The app must be **Live** (not Development) to post to a real Page.
   After connecting, pick which Page to post to in the Accounts section.

### YouTube — Client ID + Client Secret
1. Go to https://console.cloud.google.com/apis/credentials.
2. Create a project, enable **YouTube Data API v3**, then create an
   OAuth client ID (Web application).
3. Add this as an Authorized redirect URI:
   `http://localhost:3000/auth/youtube/callback`
4. Paste the Client ID and Client Secret into Settings.
5. A vertical video under 60 seconds is automatically a Short.

### TikTok — Client Key + Client Secret
1. Go to https://developers.tiktok.com/ → My Apps → create an app.
2. Add **Login Kit** and **Content Posting API**.
3. Add this redirect URI:
   `http://localhost:3000/auth/tiktok/callback`
4. Paste the Client Key and Client Secret into Settings.
5. **Approval needed:** TikTok reviews apps for the `video.upload` scope
   before direct posting works. That review can take days. Until it is
   approved, connecting works but publishing fails with a clear message
   from TikTok.

## Post statuses

- **Scheduled** — waiting for its time.
- **Posting…** — being sent right now.
- **Posted** — sent, but the app could not read it back yet. Check it on
  the network. It will not be sent again.
- **Live** — sent and read back. Verified on the network.
- **Failed** — could not post. The reason is shown. It retries on its
  own up to 3 times (after 1, 5, then 15 minutes), and you can retry it
  by hand with the Retry button.
- **Duplicate blocked** — the app saw this post was already live, so it
  skipped it instead of posting twice.

## What each network takes

| | Video | Photo | Text only |
|---|---|---|---|
| Facebook | Reel | Photo post | Feed post |
| YouTube | Short / video | — (no API for it) | — (no API for it) |
| TikTok | Video | Photo post | — (no API for it) |

A network that cannot take a post type is skipped with a clear reason —
never faked.

## How it is built

- Zero dependencies. Node.js only (`http`, `fs`, `crypto`, built-in
  `node:sqlite`).
- `server.js` — HTTP server, static UI, JSON API, OAuth callbacks.
- `src/db.js` — SQLite storage (settings, accounts, posts, deliveries,
  events). Swap this one file to move to Postgres later.
- `src/scheduler.js` — built-in job queue. Wakes every 15 seconds.
- `src/poster.js` — posts a post, verifies each network, blocks duplicates.
- `src/networks/facebook.js`, `youtube.js`, `tiktok.js` — one file per
  network, real APIs only.
- `src/upload.js` — streaming multipart parser (videos go straight to disk).
- `src/crypto-util.js` — AES-256-GCM encryption for tokens and secrets.
- `public/` — the web UI (plain HTML/CSS/JS, no build step).
- `test/smoke.js` — tests everything that can be tested without keys:
  `node test/smoke.js`.

## Roadmap

- Per-network best time suggestions.
- A "post again" (repost) button that makes a new post from an old one.
- Drafts (save without scheduling).
- More networks (Instagram Reels, X) as new files in `src/networks/`.
- A real phone app (the web UI is phone-first for now).
- Move the database to Postgres for multi-user hosting.

## Notes

- Tokens and secrets are encrypted with a key in `data/secret.key`
  (or the `SOCIALIZEIT_SECRET` environment variable). If that key is
  lost, stored tokens cannot be read — reconnect the accounts.
- This app never posts anything on its own. It only posts what you
  write and schedule here.
