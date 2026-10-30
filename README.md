# insta-to-google-chat-port

A two-way bridge between Instagram DMs and a destination your team can actually reply
from. Two destinations ship in this repo — run either or both:

* **Google Chat** — each Instagram conversation becomes its own thread in a space.
* **Password-protected web inbox** — a self-hosted inbox at `/login`, no Google
  Workspace account needed, works from any browser or phone.

Short answer to "is this possible?" — **yes, both directions, but only through the
official APIs, which means two things must be true before you write a line of code:**

1. **The Instagram account must be Business or Creator**, linked to a Facebook Page,
   with `instagram_business_manage_messages` approved through Meta App Review.
2. **Pick a destination.** The web inbox needs nothing but a password, so it works with
   a free Google account — or no Google account at all. The Google Chat destination
   additionally requires a **Google Workspace** account, because Chat apps cannot be
   built or tested on `@gmail.com`
   ([Google's docs](https://developers.google.com/workspace/chat/quickstart/apps-script-app)).

Both directions also share one hard law: **you can only reply within 24 hours of the
person's last DM.** No amount of code gets around that. See [Limits](#limits).

---

## How it works

```
   Instagram user
        │ DM
        ▼
  Meta webhooks ──► POST /webhooks/instagram ──► Bridge ──► Chat API
                  (HMAC-verified)                  │        (one thread per
                                                   │         IG conversation)
                                                   ▼
                         POST /webhooks/google-chat ◄── teammate replies in thread
                         (Google-signed JWT)      │
                                                  │
                         POST /inbox/:id/reply ◄── or replies in the web inbox
                         (session + CSRF)         │
                                                  ▼
                                        Instagram Send API
```

* Every Instagram conversation gets its own Google Chat **thread**, keyed by the
  Instagram-scoped user id (`igsid`).
* Replies are only accepted **inside** a bridged thread, so unrelated chatter in the
  space can never be posted to a customer's Instagram.
* Duplicate webhook deliveries (both platforms retry aggressively) are deduped by
  message id, so nothing is posted twice.

## What's in the box

| File | Job |
| --- | --- |
| `src/server.js` | HTTP server, webhook routes, signature verification |
| `src/bridge.js` | All routing logic and the 24-hour window rules |
| `src/instagram.js` | `parseWebhook`, HMAC signature check, Send API client |
| `src/googlechat.js` | Chat API client, service-account JWT flow, request verification |
| `src/auth.js` | scrypt password hashing, signed HttpOnly sessions, CSRF tokens, login throttle |
| `src/inbox.js` | Password-protected web inbox: server-rendered pages, reply handling, SSE |
| `src/events.js` | Server-sent-events hub so open tabs update live |
| `src/store.js` | JSON-file state: conversation ↔ thread mapping, message history, last-inbound time |
| `scripts/demo.js` | Runs the whole flow offline against fake transports |
| `test/` | 44 tests: routing, windows, signatures, JWT verification, auth, inbox |
| `docs/UNOFFICIAL-ROUTE.md` | Why Instagram group chats are impossible officially, and what the workarounds really cost |

No runtime dependencies — Node 18+ standard library only.

## Try it without any credentials

```bash
npm run demo     # full conversation played out offline
npm test         # 44 tests
```

The demo exercises the real `Bridge` and `parseWebhook` code; only the two network
clients are swapped for in-memory fakes. It shows the happy path, duplicate
deliveries, attachment DMs, an unlinked thread, and what happens when the 24-hour
window has closed.

---

## Setup

### 1. Instagram side

1. Convert the Instagram account to **Business** or **Creator** and link it to a
   Facebook Page.
2. Create an app at [developers.facebook.com](https://developers.facebook.com), add the
   **Instagram** product.
3. Request these permissions: `instagram_business_manage_messages`,
   `instagram_business_basic`, `pages_manage_metadata` (webhook subscriptions).
   You can develop against up to 25 test users before App Review; real traffic needs
   **Advanced Access**, which takes days to weeks.
4. Generate a long-lived access token and note the Instagram professional account id.
5. In **Webhooks**, subscribe to the `messages` field with callback URL
   `https://your-host/webhooks/instagram` and your `IG_VERIFY_TOKEN`.

Both Meta onboarding paths work — "Instagram API with Facebook Login"
(`graph.facebook.com`) or "Instagram API with Instagram Login"
(`graph.instagram.com`). Point `IG_GRAPH_BASE` at whichever you used.

### 2. Google Chat side

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and
   enable the **Google Chat API**.
2. Under **Chat API → Configuration**: clear *"Build this Chat app as a Workspace
   add-on"*, set the app name, and add an **HTTP endpoint URL** of
   `https://your-host/webhooks/google-chat`.
3. Create a **service account**, download its JSON key, and note the **project
   number** (used to verify Google's signed requests).
4. Add the bot to the target space, and add the service account as a member so it can
   post (`chat.bot` scope).

### 3. Run the bridge

```bash
cp .env.example .env      # fill in the values
npm start
```

The process needs a **public HTTPS URL** — Meta will not deliver webhooks to
`localhost`. For local work, `cloudflared tunnel --url http://localhost:8080` or
`ngrok http 8080` are the usual choices; in production, any container host
(Cloud Run, Fly, Render, a VPS) works. It's a single stateless-ish process with one
writable file, so scale it by running **one** instance or moving the store to a
database.

Check it's alive:

```bash
curl https://your-host/healthz
# {"ok":true,"instagramConfigured":true,"chatSpace":"spaces/AAAA","windowHours":24}
```

---

## Option B: the password-protected web inbox

If you'd rather not put customer DMs into a Google Space — or you're on a free Google
account — point the bridge at its own inbox instead. Set one variable:

```bash
INBOX_PASSWORD='a long random passphrase'
SESSION_SECRET="$(openssl rand -base64 32)"
COOKIE_SECURE=true          # false only for plain-http local testing
npm start
```

Then open `https://your-host/login`. That's the whole setup — no Workspace account, no
Google Cloud project, no service account, no Chat app configuration.

What you get:

* **Conversation list** — every Instagram conversation, newest first, with its reply-window
  state and a preview of the last message.
* **Thread view** — full history, with the 24-hour countdown shown as a badge that turns
  amber (human-agent) or red (closed).
* **Reply box** — sends through the same Instagram Send API path as the Chat bridge, with
  identical window enforcement and the same `HUMAN_AGENT` fallback. When a send is
  refused, the reason appears in the thread rather than being silently dropped.
* **Live updates** — an SSE stream reloads open tabs when a new DM arrives.
* **Progressive enhancement** — it's a plain HTML form; no JavaScript is required to read
  or send, and the composer restores an unsent draft after a reload.

Run both destinations at once if you like: inbound DMs are recorded in the inbox *and*
posted to Google Chat, and a reply from either side goes out once.

### How the password protection works

Not a `.htpasswd` afterthought — every item below is covered by a test:

| Concern | Implementation |
| --- | --- |
| Password storage | `scrypt` (N=16384) with a per-account random salt; plain `INBOX_PASSWORD` is hashed in memory at boot and never stored |
| Session | Stateless HMAC-SHA256 token in an **HttpOnly**, **SameSite=Lax**, **Secure** cookie with an expiry; tampering or expiry → signed out |
| CSRF | Per-session token embedded in every form and compared in constant time |
| Brute force | Per-IP fixed-window throttle on `/login` (8 attempts / 15 min), then `429` |
| XSS | Every Instagram- or user-supplied value is escaped; strict CSP (`default-src 'none'`, no inline script, no framing) |
| Clickjacking | `frame-ancestors 'none'` plus `X-Frame-Options: DENY` |
| Open redirects | `next` accepts relative paths only — `//evil.example` is ignored |
| Unauthenticated access | All inbox routes redirect to `/login`; nothing is served without a session |
| Empty config | With no password set, the inbox routes are **not mounted at all** — there is no accidentally-open inbox |

Login is intentionally single-factor. If you need per-person accounts, set
`INBOX_USERS="alice:pass,bob:pass"` and each session records who sent what. For anything
beyond a small team, put it behind Cloudflare Access, Tailscale, or your VPN — that's the
cheapest way to add SSO, MFA, and IP rules without writing them.

### Operational reality

The JSON store now holds **customer message history in plaintext**. That changes your
obligations:

* Back up `data/store.json` like a database, and encrypt the disk (`LUKS`, EBS
  encryption, whatever your host offers).
* `chmod 600` the file and don't commit it — it's already in `.gitignore`.
* For more than one instance, move the store to SQLite/Postgres; a single JSON file is
  not safe for concurrent writers.
* Add a retention policy. Old conversations don't need to live forever, and deleting them
  reduces what a leak exposes.
* You are now the controller of that data. If you have EU/UK customers, the privacy notice
  on your site needs to mention that DMs are stored and who can read them.

---

## Limits

These are platform rules, not implementation gaps.

| Limit | Effect |
| --- | --- |
| **24-hour messaging window** | After the person's last DM you have 24h to reply freely. Past that the Send API rejects the call. The bridge detects this up front and posts a "not sent" notice in the thread instead of failing silently. |
| **HUMAN_AGENT tag** | Extends to 7 days, but only for genuine human support, and Meta audits it — misuse can get the tag revoked. Off by default; enable with `ALLOW_HUMAN_AGENT_TAG=true`. |
| **No cold outreach** | You cannot message someone who has never DMed you. There is no "send to any Instagram user" endpoint. |
| **Business/Creator only** | Personal Instagram accounts have no messaging API at all. |
| **App Review** | Weeks of review for production access. 25 test users until then. |
| **Rate limits** | Meta publishes per-second ceilings (100 msg/s text, 10 msg/s media). Practical DM throughput is far lower; queue anything bursty. |
| **Workspace requirement** | Free Gmail accounts cannot install Chat apps. |
| **Media** | Instagram CDN URLs are signed and expire; the bridge posts the URL as text. Re-uploading media to Chat needs a download-and-upload step. |
| **No typing/read receipts** | Only `messages` are bridged; read and reaction events are parsed but ignored. |
| **No group chats** | Meta: *"Group messaging is not supported. An Instagram professional account can only converse with one customer per conversation."* Group threads can't be read or written by any official API — see [docs/UNOFFICIAL-ROUTE.md](docs/UNOFFICIAL-ROUTE.md) for what that leaves you. |

### What *not* to do

Unofficial libraries that log in with the account's username and password
(`instagram-private-api` and friends) break the platform terms, get accounts banned,
and would break the moment Meta changes an internal endpoint. They also violate
Google Chat's terms by scraping. The official webhook path above is the only
sanctioned way, and it is enough for a support-inbox workflow.

If the Workspace requirement is the blocker, use the **web inbox** above — same bridge,
no Google account needed. The same pattern also works with **Slack** (free tier is fine)
or **Telegram**: swap `src/googlechat.js` for another transport; the routing in
`src/bridge.js` doesn't change.

Wanting a **group chat** rather than a per-person inbox? The official API cannot do it at
all. [docs/UNOFFICIAL-ROUTE.md](docs/UNOFFICIAL-ROUTE.md) compares the four ways people
try anyway (private-API libraries, an on-device notification relay, WhatsApp Groups API,
Telegram), with the ban, credential and privacy costs spelled out.

---

## Design notes

* **Webhooks return 200 fast.** Meta retries anything non-2xx and gives you ~20
  seconds. A Chat API failure releases the dedupe entry and returns 500 so the retry
  can succeed.
* **Thread, not channel.** Each `igsid` maps to a fixed `threadKey`, and the returned
  `thread.name` is stored so incoming Chat events can be traced back to the right
  Instagram conversation.
* **Idempotent by default.** Both platforms redeliver; `store.seen()` covers a 6-hour
  window per message id.
* **Fail closed.** No `IG_APP_SECRET` → webhooks rejected. No
  `GOOGLE_CHAT_PROJECT_NUMBER` → Chat requests rejected. No `INBOX_PASSWORD` → inbox
  routes don't exist. None of them silently accept unauthenticated traffic.
* **One window, three transports.** `Bridge.windowState()` is the only place the 24-hour
  rule lives, so Chat replies, inbox replies, and the UI badge can't drift apart.

## Next steps worth doing

1. Profile lookup so threads show `@handle` instead of the numeric scoped id.
2. Media relay: download the CDN asset and upload it to Chat via the attachments API.
3. Swap the JSON store for SQLite/Postgres before running more than one instance.
4. Per-thread ownership so the "not sent, window closed" notice can @-mention whoever
   was handling it.
