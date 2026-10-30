import { timingSafeEqual } from 'node:crypto';

import { fmtDuration } from './bridge.js';
import { parseCookies, serializeCookie } from './auth.js';

const SESSION_COOKIE = 'inbox_session';
const MAX_FORM_BYTES = 64 * 1024;

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape everything that came from Instagram, Chat, or a query string. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        reject(new Error('form too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function timeAgo(ts, now) {
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function stamp(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

const STYLES = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#14161a;--muted:#667085;--line:#e4e7ec;--accent:#2f6feb;
--in:#f1f3f7;--out:#2f6feb;--ok:#0f8a5f;--warn:#b54708;--bad:#b42318;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#e7eaef;--muted:#98a2b3;--line:#252a34;--accent:#5b8def;--in:#21262f;--out:#3b6fd4;--ok:#3ddc97;--warn:#fdb022;--bad:#f97066}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.5}
a{color:var(--accent)}
header.bar{display:flex;align-items:center;gap:14px;padding:12px 18px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
header.bar h1{font-size:15px;margin:0;font-weight:600}
header.bar .spacer{flex:1}
header.bar form{margin:0}
.wrap{max-width:780px;margin:0 auto;padding:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px}
.conv{display:block;padding:13px 16px;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
.conv:last-child{border-bottom:0}
.conv:hover{background:var(--in)}
.conv .top{display:flex;gap:10px;align-items:baseline}
.conv .who{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conv .when{color:var(--muted);font-size:12px}
.conv .preview{color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.badge.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent)}
.badge.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
.badge.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
.thread{padding:16px;display:flex;flex-direction:column;gap:10px;min-height:40vh}
.msg{max-width:78%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;word-break:break-word}
.msg .meta{display:block;font-size:11px;opacity:.7;margin-top:4px}
.msg.in{align-self:flex-start;background:var(--in);border-bottom-left-radius:4px}
.msg.out{align-self:flex-end;background:var(--out);color:#fff;border-bottom-right-radius:4px}
.composer{border-top:1px solid var(--line);padding:12px 16px;display:flex;gap:10px;align-items:flex-end;background:var(--card);border-radius:0 0 12px 12px}
textarea{flex:1;min-height:44px;max-height:180px;resize:vertical;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:inherit;font:inherit}
button{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid transparent;background:var(--accent);color:#fff;cursor:pointer}
button.link{background:none;border:0;color:var(--muted);padding:4px}
button:disabled{opacity:.5;cursor:not-allowed}
.notice{padding:10px 14px;border-radius:10px;font-size:13px;margin:0 0 12px}
.notice.ok{background:color-mix(in srgb,var(--ok) 12%,transparent);color:var(--ok);border:1px solid color-mix(in srgb,var(--ok) 35%,transparent)}
.notice.bad{background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad);border:1px solid color-mix(in srgb,var(--bad) 35%,transparent)}
.notice.warn{background:color-mix(in srgb,var(--warn) 12%,transparent);color:var(--warn);border:1px solid color-mix(in srgb,var(--warn) 35%,transparent)}
.field{margin-bottom:12px}
.field label{display:block;font-size:13px;color:var(--muted);margin-bottom:5px}
.field input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:inherit;font:inherit}
.login{max-width:340px;margin:12vh auto;padding:22px}
.empty{padding:40px 16px;text-align:center;color:var(--muted)}
.muted{color:var(--muted);font-size:13px}
`;

const APP_JS = `
(function () {
  var body = document.body;
  var igsid = body.getAttribute('data-igsid') || '';
  var box = document.querySelector('textarea[name="text"]');
  var key = 'draft:' + (igsid || 'list');

  if (box) {
    var saved = sessionStorage.getItem(key);
    if (saved) { box.value = saved; }
    box.addEventListener('input', function () { sessionStorage.setItem(key, box.value); });
    box.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { box.form.requestSubmit(); }
    });
  }

  function bottom() { window.scrollTo(0, document.body.scrollHeight); }
  bottom();

  if (!window.EventSource) { return; }
  var stream = new EventSource('/events');
  stream.onmessage = function (event) {
    var payload;
    try { payload = JSON.parse(event.data); } catch (e) { return; }
    if (payload.type !== 'message') { return; }
    if (igsid && payload.igsid === igsid) { location.reload(); }
    else if (!igsid) { location.reload(); }
  };
})();
`;

function shell({ title, username, body, extraHead = '' }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>${extraHead}
</head><body>
<header class="bar">
  <h1>Instagram inbox</h1>
  <span class="spacer"></span>
  ${username ? `<span class="muted">${escapeHtml(username)}</span>
  <form method="post" action="/logout"><button class="link" type="submit">Sign out</button></form>` : ''}
</header>
${body}
<script src="/assets/app.js" defer></script>
</body></html>`;
}

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

function sendHtml(res, status, html, extra = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(html);
}

function redirect(res, location, extra = {}) {
  res.writeHead(303, { ...SECURITY_HEADERS, location, ...extra });
  res.end();
}

/**
 * Password-protected web inbox: the same Instagram bridge, with a browser
 * instead of Google Chat as the transport.
 *
 * Returns `null` when no password is configured, so the routes simply don't
 * exist rather than shipping an open inbox.
 */
export function createInboxRoutes({
  auth,
  store,
  bridge,
  events,
  log = console,
  now = () => Date.now(),
}) {
  if (!auth || !auth.enabled) return null;

  function sessionFrom(req) {
    const cookies = parseCookies(req.headers?.cookie);
    return auth.read(cookies[SESSION_COOKIE]);
  }

  function cookieHeaders(session, { clear = false } = {}) {
    return {
      'set-cookie': serializeCookie(
        SESSION_COOKIE,
        clear ? '' : session.value,
        {
          maxAge: clear ? 0 : Math.floor(auth.sessionTtlMs / 1000),
          secure: auth.cookieSecure,
          sameSite: 'Lax',
          httpOnly: true,
          path: '/',
        },
      ),
    };
  }

  function notice(flash) {
    if (!flash) return '';
    const kind = flash.kind || 'warn';
    return `<div class="notice ${escapeHtml(kind)}">${escapeHtml(flash.text)}</div>`;
  }

  function windowBadge(state) {
    if (state.state === 'open') {
      return `<span class="badge ok">replies open · ${fmtDuration(state.remainingMs)} left</span>`;
    }
    if (state.state === 'tagged') {
      return `<span class="badge warn">24h closed · human-agent ${fmtDuration(state.remainingMs)} left</span>`;
    }
    return '<span class="badge bad">window closed</span>';
  }

  function loginPage({ error = '', next = '', username = '' } = {}) {
    const userField = auth.singleUser
      ? `<input type="hidden" name="username" value="${escapeHtml(auth.singleUser)}">`
      : `<div class="field"><label for="username">Username</label>
         <input id="username" name="username" autocomplete="username" required value="${escapeHtml(username)}"></div>`;

    return shell({
      title: 'Sign in · Instagram inbox',
      username: '',
      body: `<div class="login card">
  <h2 style="margin:0 0 16px;font-size:18px">Sign in</h2>
  ${error ? `<div class="notice bad">${escapeHtml(error)}</div>` : ''}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    ${userField}
    <div class="field"><label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    </div>
    <button type="submit" style="width:100%">Sign in</button>
  </form>
</div>`,
    });
  }

  function listPage({ username, conversations, flash }) {
    const rows = conversations
      .map((conv) => {
        const state = bridge.windowState(conv);
        const last = store.lastMessage(conv.igsid);
        const name = conv.displayName || conv.igsid;
        const preview = last
          ? `${last.direction === 'out' ? 'You: ' : ''}${last.text}`
          : 'No messages yet';
        const at = last?.at || conv.lastInboundAt || conv.createdAt;
        return `<a class="conv" href="/inbox/${encodeURIComponent(conv.igsid)}">
  <div class="top">
    <span class="who">${escapeHtml(name)}</span>
    ${windowBadge(state)}
    <span class="when">${escapeHtml(timeAgo(at, now()))}</span>
  </div>
  <div class="preview">${escapeHtml(preview)}</div>
</a>`;
      })
      .join('\n');

    return shell({
      title: 'Inbox · Instagram',
      username,
      body: `<div class="wrap">
  ${notice(flash)}
  <div class="card">${rows || '<div class="empty">No conversations yet.<br>Messages appear here as soon as someone DMs the Instagram account.</div>'}</div>
</div>`,
    });
  }

  function threadPage({ username, csrf, conv, flash }) {
    const state = bridge.windowState(conv);
    const messages = store.messages(conv.igsid);
    const blocked = state.state === 'blocked';

    const bubbles = messages
      .map((m) => {
        const mine = m.direction === 'out';
        const who = mine ? m.author || 'You' : conv.displayName || conv.igsid;
        return `<div class="msg ${mine ? 'out' : 'in'}">${escapeHtml(m.text)}<span class="meta">${escapeHtml(who)} · ${escapeHtml(stamp(m.at))}</span></div>`;
      })
      .join('\n');

    const banner = blocked
      ? `<div class="notice bad">${
          state.reason === 'human agent window closed'
            ? 'The 7-day human-agent window has also closed. You can reply once they message you again.'
            : "Instagram's 24-hour reply window has closed, so the API cannot deliver a reply. Enable ALLOW_HUMAN_AGENT_TAG to allow support replies for up to 7 days."
        }</div>`
      : state.state === 'tagged'
        ? `<div class="notice warn">The 24-hour window has closed. Sends will use Meta's HUMAN_AGENT tag — for human support only, within 7 days.</div>`
        : '';

    return shell({
      title: `${conv.displayName || conv.igsid} · Instagram inbox`,
      username,
      extraHead: '',
      body: `<div class="wrap" data-igsid="${escapeHtml(conv.igsid)}" id="thread">
  <p><a href="/inbox">← All conversations</a></p>
  ${notice(flash)}
  <div class="card">
    <div class="thread">
      ${bubbles || '<div class="empty">No messages stored for this conversation yet.</div>'}
    </div>
    ${blocked ? '' : `<form class="composer" method="post" action="/inbox/${encodeURIComponent(conv.igsid)}/reply">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
      <textarea name="text" placeholder="Reply on Instagram…  (⌘/Ctrl + Enter to send)" required></textarea>
      <button type="submit">Send</button>
    </form>`}
  </div>
  <p class="muted">${windowBadge(state)} · scoped id ${escapeHtml(conv.igsid)}</p>
</div>`,
    });
  }

  return async function handleInboxRequest(req, res, url) {
    const path = url.pathname;

    if (path === '/assets/app.js' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff',
      });
      res.end(APP_JS);
      return true;
    }

    if (path === '/login' && req.method === 'GET') {
      const next = url.searchParams.get('next') || '';
      sendHtml(res, 200, loginPage({ next }));
      return true;
    }

    if (path === '/login' && req.method === 'POST') {
      const form = await readForm(req);
      const ip = req.socket?.remoteAddress || 'unknown';
      const next = String(form.get('next') || '');

      if (auth.throttle.isBlocked(ip)) {
        const mins = Math.ceil(auth.throttle.retryAfterMs(ip) / 60000);
        log.warn(`[inbox] login throttled for ${ip}`);
        sendHtml(res, 429, loginPage({ error: `Too many attempts. Try again in ${mins} minute(s).`, next }));
        return true;
      }

      const username = String(form.get('username') || auth.singleUser || '');
      const password = String(form.get('password') || '');

      if (!(await auth.authenticate(username, password))) {
        auth.throttle.fail(ip);
        log.warn(`[inbox] failed login for "${username}" from ${ip}`);
        sendHtml(res, 401, loginPage({ error: 'Wrong username or password.', next, username }));
        return true;
      }

      auth.throttle.reset(ip);
      const session = auth.issue(username);
      // Only same-site relative paths, never a protocol-relative URL.
      const target = next.startsWith('/') && !next.startsWith('//') ? next : '/inbox';
      log.log(`[inbox] ${username} signed in`);
      redirect(res, target, cookieHeaders(session));
      return true;
    }

    if (path === '/logout' && req.method === 'POST') {
      redirect(res, '/login', cookieHeaders(null, { clear: true }));
      return true;
    }

    // Everything below requires a valid session.
    const session = sessionFrom(req);
    if (!session) {
      if (path.startsWith('/events')) {
        res.writeHead(401, { ...SECURITY_HEADERS, 'content-type': 'text/plain' });
        res.end('unauthorized');
        return true;
      }
      redirect(res, `/login?next=${encodeURIComponent(path)}`);
      return true;
    }

    const csrfOk = (form) => safeEqual(form.get('_csrf'), session.c);

    if (path === '/' && req.method === 'GET') {
      redirect(res, '/inbox');
      return true;
    }

    if (path === '/inbox' && req.method === 'GET') {
      const flash = url.searchParams.get('ok') === '1'
        ? { kind: 'ok', text: 'Message sent to Instagram.' }
        : null;
      sendHtml(res, 200, listPage({ username: session.u, conversations: store.listConversations(), flash }));
      return true;
    }

    const threadMatch = /^\/inbox\/([^/]+)$/.exec(path);
    if (threadMatch && req.method === 'GET') {
      const igsid = decodeURIComponent(threadMatch[1]);
      const conv = store.getConversation(igsid);
      if (!conv) {
        sendHtml(res, 404, shell({ title: 'Not found', username: session.u, body: '<div class="wrap"><p>No such conversation.</p><p><a href="/inbox">Back to inbox</a></p></div>' }));
        return true;
      }
      sendHtml(res, 200, threadPage({ username: session.u, csrf: session.c, conv }));
      return true;
    }

    const replyMatch = /^\/inbox\/([^/]+)\/reply$/.exec(path);
    if (replyMatch && req.method === 'POST') {
      const igsid = decodeURIComponent(replyMatch[1]);
      const form = await readForm(req);

      if (!csrfOk(form)) {
        log.warn('[inbox] rejected reply with bad CSRF token');
        sendHtml(res, 403, shell({ title: 'Forbidden', username: session.u, body: '<div class="wrap"><p>Your session token was rejected. Reload and try again.</p></div>' }));
        return true;
      }

      const conv = store.getConversation(igsid);
      if (!conv) {
        sendHtml(res, 404, shell({ title: 'Not found', username: session.u, body: '<div class="wrap"><p>No such conversation.</p></div>' }));
        return true;
      }

      const result = await bridge.replyFromWeb({
        igsid,
        text: String(form.get('text') || ''),
        author: session.u,
      });

      if (result.sent) {
        redirect(res, `/inbox/${encodeURIComponent(igsid)}?ok=1`);
        return true;
      }

      const reason =
        result.blocked === 'human agent window closed'
          ? 'Not sent: even the 7-day human-agent window has closed. Wait for a new message from them.'
          : result.blocked
            ? 'Not sent: the 24-hour reply window is closed.'
            : `Not sent: ${result.error}`;

      sendHtml(
        res,
        409,
        threadPage({
          username: session.u,
          csrf: session.c,
          conv,
          flash: { kind: 'bad', text: reason },
        }),
      );
      return true;
    }

    if (path === '/events' && req.method === 'GET') {
      events.subscribe(req, res, { username: session.u });
      return true;
    }

    return false;
  };
}
