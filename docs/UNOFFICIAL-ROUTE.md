# The unofficial route: bridging a Google Space to a real Instagram group chat

You asked for the unofficial option, for a **private team/friends group**. This is the
honest assessment: what it actually is, what it would take, what it costs you, and what
I'd do instead.

**Bottom line:** it works today, it is against Instagram's terms, and the thing at risk is
the Instagram account your team actually talks to each other on. For a customer-support
inbox that's a business decision. For a friends-and-team group, it's a bad trade —
you'd be gambling the account itself to save a copy-paste.

---

## 1. Why the official API can't do this

From Meta's own Send Messages documentation:

> **"Group messaging is not supported. An Instagram professional account can only converse
> with one customer per conversation."**

That covers both directions:

| Capability | Official API |
| --- | --- |
| Receive 1:1 DMs via webhook | Yes |
| Send 1:1 replies inside 24h | Yes |
| Read a group thread | **No** — group messages aren't delivered to webhooks at all |
| Send into a group thread | **No** |
| Create a group / add participants | **No** |

It's not an App Review gate that opens later. Group DMs are an app-only surface, and Meta
has never exposed them. Every commercial "Instagram group chat integration" you'll find
is either doing what's described below, or quietly doing 1:1 fan-out.

---

## 2. What the unofficial route actually is

There are two distinct things people call "the Instagram API", and only one of them is
public:

* **The public Graph API** — OAuth tokens, documented endpoints, webhooks. What
  `src/instagram.js` in this repo uses.
* **The private mobile API** — the endpoints the real Instagram app calls. No
  documentation, no OAuth, no approval. Libraries reach it by **logging in with a
  username and password**, generating a plausible Android device fingerprint
  (`device_id`, `android_device_id`, `uuid`, app version, user agent), signing requests
  the way the app does, and persisting the resulting session to a JSON file.

The active libraries as of late 2026:

| Library | Language | Notes |
| --- | --- | --- |
| [`instagrapi`](https://github.com/subzeroid/instagrapi) | Python | Most maintained. Sessions, challenge handling, and experimental realtime over MQTT (Instagram's push channel) |
| [`aiograpi`](https://github.com/subzeroid/aiograpi) | Python (async) | Same author, async mirror |
| `instagram-private-api` | Node | Older; lagged behind recent app changes |

And yes — **group threads are supported by these**, which is the whole reason the option
exists:

```python
cl = Client()
cl.login(USERNAME, PASSWORD)

cl.direct_threads()                       # list threads, group ones included
cl.direct_answer(thread_id, "hello")      # send into a specific thread
cl.direct_send("hi", thread_ids=[tid])    # same, thread-targeted
```

So the technical shape of a bridge is straightforward, and honestly *simpler* than the
official one — no 24-hour window, no per-person fan-out, no scoping rules:

```
Google Chat space  ──► webhook ──► sidecar (instagrapi) ──► direct_answer(thread_id)
        ▲                                    │
        └────── MQTT "message" callback ◄────┘  (a single fixed thread_id)
```

Mapping is one-to-one: **one Chat space ↔ one Instagram thread id**. No conversation
store needed, no window tracking.

**Effort:** roughly 1–3 days to a working prototype, including login persistence, an MQTT
listener, echo suppression (so the bot doesn't repost its own messages), and idle
reconnect logic.

---

## 3. What it costs you

Ordered by how likely it is to actually bite you, for a small private group.

### a) The account can be suspended — this is the real risk

Instagram's anti-bot systems don't care that your intent is harmless. They score
behaviour: a login from a datacenter IP, a device that never existed, request timing no
human produces, and a session that never sleeps.

The evidence is in the libraries' own issue trackers: `challenge_required` on login
(solved only by a human tapping through a checkpoint on a real device), accounts
suspended after ten actions, and the library README itself warning that *"private API
automation is fragile in production because account trust, proxies, device state,
challenges, and rate limits can change independently of the library."*

If that account is where your team coordinates, a suspension isn't an inconvenience —
you lose the group and your contacts in it, and Instagram's appeal path for automation
suspensions is close to nonexistent.

### b) It violates the terms, explicitly

Instagram's Terms of Use prohibit accessing or collecting information in an automated way
"without our express permission, **regardless of whether such automated access is
undertaken while logged-in to an Instagram account**." That sentence is written for
exactly this case: being logged in doesn't make automation allowed. Meta's Platform Terms
separately prohibit requesting or proxying product usernames and passwords.

The consequence available to Meta is termination. There's no "small private use"
exemption, and no arbitration you'd win.

### c) Your password, on a server, forever

OAuth tokens are scoped and revocable. A password is a master key: it also means the
session can read your friends' messages, your business inbox, and anything else the
account can reach. The persisted session file is roughly equivalent to a logged-in
device. A bug in your container, a leaked volume, or a compromised dependency in a
library that sees your `Client()` object is a full account takeover — and 2FA doesn't
help, because the login happens programmatically.

### d) Other people's messages land in your Workspace

This is the part people forget. You'd be copying **private messages written by people who
didn't agree to any of this** into a Google Workspace space — where an admin can read it,
where Vault may retain it, and where it may sit for years.

If any participant is in the EU or UK, you become a controller of their personal data with
no notice and no lawful basis. "It's just our team chat" is not a defence in a
complaint — and these are your friends and colleagues, not abstract users.

### e) It breaks, and you maintain a fork

Every Instagram app release can invalidate the signing scheme. The MQTT push schema
changes without notice. When it breaks, the failure mode is usually *silent* — the
bridge stops delivering and nobody notices for a day. Budget a few hours a month of
maintenance, and expect occasional multi-day outages where no version of the library
works until someone patches it.

### f) It may get permanently killed by encryption

Meta has been migrating DMs to end-to-end encryption. Where E2EE applies, **no** unofficial
client can read the thread, and no amount of community patching fixes it — the server
doesn't have the plaintext either. Treat "Instagram ships E2EE for these conversations" as
a plausible end-of-life event, not a bug report.

### g) Supply chain

You're trusting an unvetted dependency with your deepest credential. Popular libraries are
maintained by volunteers, and forks with backdoored login flows are a known pattern.

---

## 4. Side-by-side

| | Official API (this repo) | Private API library | On-device notification relay | WhatsApp Groups API | Telegram |
| --- | --- | --- | --- | --- | --- |
| Real group chat | **No** | Yes | Read only | Yes (≤8 people) | Yes (large) |
| Credentials on your server | No (OAuth) | **Yes (password)** | No | No | No (bot token) |
| Terms-compliant | Yes | No | Grey | Yes | Yes |
| Ban risk | None | **Real** | Very low | None | None |
| Maintenance | Low | High, unbounded | Low-medium | Low | Low |
| Eligibility | IG Business + App Review | Any account | Any account | Official Business Account | Anyone |
| Effort | Done | 1–3 days + upkeep | 1–2 days | 2–4 days + OBA | Half a day |

**On-device relay**, for context: an Android phone signed into that Instagram account runs
a Notification Listener and forwards notification text to a Google Chat incoming webhook.
No password leaves the phone, nothing logs into Instagram from a server, and there's no
private API to break. But it's **one-way**, it's still automation of the service
(arguably grey rather than clearly forbidden), notifications are truncated and coalesce
when the app is backgrounded, and sending *into* the group would require accessibility-service
UI automation — which is both fragile and much closer to the line. It's the least-bad
version of "not the official API", not a good version.

---

## 5. What I'd actually do for a team/friends group

1. **Telegram** — a bot in a group is ten lines of code, unlimited members, no approval,
   no ban risk, and it has a proper Bot API with webhooks. If the point is "a group chat
   that our Google Space can talk to", this is the whole job done in an evening.
2. **WhatsApp Groups API** — if the group must be on a Meta product. Real group support on
   the Cloud API, but gated: you need an **Official Business Account**, groups cap at **8
   participants**, people join via invite link (you can't add them), and billing is per
   recipient per message.
3. **Keep the official bridge for the 1:1 case** and let the group stay in the app. The
   space handles customer DMs (which is what the API is good at); the team group stays
   where your friends already are. Realistically this is what most small teams do, and it
   costs nothing to maintain.

If you still want the unofficial route after reading the above, the guardrails that
matter most:

* **Never the brand/primary account.** A dedicated account that you're willing to lose.
* **Tell the group.** They're trusting you with their messages; say where they're going.
* **Isolate it.** A separate container, its own secrets store, no shared filesystem with
  the customer-facing bridge.
* **Volume low, human-shaped.** No bulk sends, no scheduled blasts; a chat bridge that
  pushes a few dozen messages a day is the only version that survives.
* **Assume a break.** Alerts on "no traffic in 6 hours", and a documented manual fallback.
* **Don't mix PII.** No customer conversations in a private-API process; that's where a
  ban stops being embarrassing and starts being a breach.

---

## 6. What I can build from here

| Ask | I'll do it |
| --- | --- |
| Telegram group ↔ Google Space bridge | Yes — clean, official, ~half a day |
| WhatsApp Groups API ↔ Space | Yes — needs OBA + a Meta app |
| On-device notification relay (read-only) | Yes, with the caveats above stated in code |
| Private-API (password) sidecar | With the risks above accepted explicitly, as a separate opt-in module — never as the default path in this repo |

I won't quietly fold password-based automation into the existing bridge: it would put the
working, terms-compliant 1:1 path at risk for anyone who deploys this repo later.
