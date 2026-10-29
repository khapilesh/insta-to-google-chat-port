# insta-to-google-chat-port

A two-way bridge: Instagram DMs land in a Google Chat space, and replying in that
Chat thread sends the message back as an Instagram DM.

Short answer to "is this possible?" — **yes, both directions, but only through the
official APIs, which means two things must be true before you write a line of code:**

1. **The Instagram account must be Business or Creator**, linked to a Facebook Page,
   with `instagram_business_manage_messages` approved through Meta App Review.
2. **The Google Chat side must be a Google Workspace account.** Chat apps cannot be
   built or tested with a free `@gmail.com` account
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
| `src/store.js` | JSON-file state: conversation ↔ thread mapping, last-inbound time |
| `scripts/demo.js` | Runs the whole flow offline against fake transports |
| `test/` | 29 tests: routing, windows, signatures, JWT verification |

No runtime dependencies — Node 18+ standard library only.

## Try it without any credentials

```bash
npm run demo     # full conversation played out offline
npm test         # 29 tests
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

### What *not* to do

Unofficial libraries that log in with the account's username and password
(`instagram-private-api` and friends) break the platform terms, get accounts banned,
and would break the moment Meta changes an internal endpoint. They also violate
Google Chat's terms by scraping. The official webhook path above is the only
sanctioned way, and it is enough for a support-inbox workflow.

If the Workspace requirement is the blocker, the same bridge pattern works with
**Slack** (free tier is fine) or **Telegram** — swap `src/googlechat.js` for another
transport; the routing in `src/bridge.js` doesn't change.

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
  `GOOGLE_CHAT_PROJECT_NUMBER` → Chat requests rejected. Neither silently accepts
  unauthenticated traffic.

## Next steps worth doing

1. Profile lookup so threads show `@handle` instead of the numeric scoped id.
2. Media relay: download the CDN asset and upload it to Chat via the attachments API.
3. Swap the JSON store for SQLite/Postgres before running more than one instance.
4. Per-thread ownership so the "not sent, window closed" notice can @-mention whoever
   was handling it.
