import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { createApp } from '../src/server.js';
import { createAuthService, hashPassword, verifyPassword } from '../src/auth.js';
import { createEventHub } from '../src/events.js';
import { createInboxRoutes } from '../src/inbox.js';
import { createFakeChat, createFakeInstagram } from './fakes.js';

const quiet = { log() {}, warn() {}, error() {} };
const PASSWORD = 'correct horse battery staple';

async function setup({ allowHumanAgentTag = false, withChat = false } = {}) {
  const config = loadConfig({
    STORE_PATH: '',
    GOOGLE_CHAT_SPACE: withChat ? 'spaces/AAA' : '',
    IG_WINDOW_HOURS: '24',
    INBOX_PASSWORD: PASSWORD,
    SESSION_SECRET: 'test-session-secret-test-session-secret',
    COOKIE_SECURE: 'false',
  });
  config.chat.space = withChat ? 'spaces/AAA' : '';
  config.allowHumanAgentTag = allowHumanAgentTag;

  const store = new Store('');
  const instagram = createFakeInstagram();
  const chat = withChat ? createFakeChat() : null;
  const events = createEventHub();
  const bridge = new Bridge({ store, instagram, chat, config, log: quiet, events });
  const auth = await createAuthService({
    password: PASSWORD,
    sessionSecret: config.inbox.sessionSecret,
    cookieSecure: false,
    log: quiet,
  });
  const inboxRoutes = createInboxRoutes({ auth, store, bridge, events, log: quiet });

  const app = createApp({ config, bridge, instagramClient: instagram, chat, inboxRoutes, log: quiet });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function login() {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'team', password: PASSWORD }),
    });
    const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    // CSRF tokens are bound to the session, so read it back from the cookie.
    const csrf = auth.read(cookie.split('=')[1]).c;
    return { res, cookie, csrf };
  }

  return {
    base,
    store,
    instagram,
    chat,
    events,
    bridge,
    auth,
    inboxRoutes,
    login,
    async close() {
      events.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Seed a conversation with one inbound message. */
function seed(t, { igsid = 'igsid-1', text = 'Hi there', at = Date.now() } = {}) {
  t.store.conversation(igsid, { displayName: 'customer_one' });
  t.store.markInbound(igsid, at);
  t.store.appendMessage({ igsid, direction: 'in', text, at, id: `mid-${igsid}` });
  return t.store.getConversation(igsid);
}

test('password hashing round-trips and rejects bad input', async () => {
  const hash = await hashPassword('s3cret');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyPassword('s3cret', hash), true);
  assert.equal(await verifyPassword('s3cret ', hash), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', ''), false);
  // Same password, different salt => different hash.
  assert.notEqual(hash, await hashPassword('s3cret'));
});

test('inbox routes are not mounted without a password', async () => {
  const auth = await createAuthService({ password: '', log: quiet });
  assert.equal(auth.enabled, false);
  assert.equal(createInboxRoutes({ auth, store: new Store(''), bridge: {}, events: null, log: quiet }), null);
});

test('unauthenticated visitors are redirected to the login page', async () => {
  const t = await setup();
  try {
    const res = await fetch(`${t.base}/inbox`, { redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^\/login\?next=/);
  } finally {
    await t.close();
  }
});

test('wrong password is rejected and never sets a session', async () => {
  const t = await setup();
  try {
    const res = await fetch(`${t.base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'team', password: 'nope' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.match(await res.text(), /Wrong username or password/);
  } finally {
    await t.close();
  }
});

test('correct password issues an HttpOnly session cookie', async () => {
  const t = await setup();
  try {
    const { res, cookie } = await t.login();
    assert.equal(res.status, 303);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.ok(cookie.startsWith('inbox_session='));

    const inbox = await fetch(`${t.base}/inbox`, { headers: { cookie } });
    assert.equal(inbox.status, 200);
    assert.match(await inbox.text(), /Instagram inbox/);
  } finally {
    await t.close();
  }
});

test('login redirect ignores protocol-relative next targets', async () => {
  const t = await setup();
  try {
    const res = await fetch(`${t.base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'team', password: PASSWORD, next: '//evil.example/x' }),
    });
    assert.equal(res.headers.get('location'), '/inbox');
  } finally {
    await t.close();
  }
});

test('repeated failures are throttled', async () => {
  const t = await setup();
  try {
    let last;
    for (let i = 0; i < 9; i += 1) {
      last = await fetch(`${t.base}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'team', password: `wrong-${i}` }),
      });
    }
    assert.equal(last.status, 429);
    // Even the right password is refused while blocked.
    const good = await fetch(`${t.base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'team', password: PASSWORD }),
    });
    assert.equal(good.status, 429);
  } finally {
    await t.close();
  }
});

test('the inbox lists conversations with their window state', async () => {
  const t = await setup();
  try {
    seed(t, { igsid: 'igsid-1', text: 'Is the hoodie in stock?' });
    const { cookie } = await t.login();
    const res = await fetch(`${t.base}/inbox`, { headers: { cookie } });
    const html = await res.text();
    assert.match(html, /customer_one/);
    assert.match(html, /Is the hoodie in stock\?/);
    assert.match(html, /replies open/);
  } finally {
    await t.close();
  }
});

test('a thread renders stored messages and escapes Instagram content', async () => {
  const t = await setup();
  try {
    seed(t, { text: '<script>alert(1)</script> & "quotes"' });
    const { cookie } = await t.login();
    const res = await fetch(`${t.base}/inbox/igsid-1`, { headers: { cookie } });
    const html = await res.text();
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not be rendered');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&amp; &quot;quotes&quot;/);
  } finally {
    await t.close();
  }
});

test('replies require the CSRF token from the session', async () => {
  const t = await setup();
  try {
    seed(t);
    const { cookie } = await t.login();
    const res = await fetch(`${t.base}/inbox/igsid-1/reply`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: 'hi', _csrf: 'wrong' }),
    });
    assert.equal(res.status, 403);
    assert.equal(t.instagram.sent.length, 0);
  } finally {
    await t.close();
  }
});

test('a valid reply is sent to Instagram and stored', async () => {
  const t = await setup();
  try {
    seed(t);
    const { cookie, csrf } = await t.login();

    const res = await fetch(`${t.base}/inbox/igsid-1/reply`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: 'Yes, 3 left!', _csrf: csrf }),
    });

    assert.equal(res.status, 303);
    assert.equal(t.instagram.sent.length, 1);
    assert.equal(t.instagram.sent[0].igsid, 'igsid-1');
    assert.equal(t.instagram.sent[0].text, 'Yes, 3 left!');
    assert.equal(t.instagram.sent[0].humanAgent, false);
    assert.equal(t.store.lastMessage('igsid-1').direction, 'out');
  } finally {
    await t.close();
  }
});

test('replying after the 24h window is refused with an explanation', async () => {
  const t = await setup();
  try {
    seed(t, { at: Date.now() - 30 * 60 * 60 * 1000 });
    const { cookie, csrf } = await t.login();

    const res = await fetch(`${t.base}/inbox/igsid-1/reply`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: 'too late', _csrf: csrf }),
    });

    assert.equal(res.status, 409);
    assert.equal(t.instagram.sent.length, 0);
    assert.match(await res.text(), /24-hour reply window/);
  } finally {
    await t.close();
  }
});

test('HUMAN_AGENT is used from the inbox when enabled', async () => {
  const t = await setup({ allowHumanAgentTag: true });
  try {
    seed(t, { at: Date.now() - 30 * 60 * 60 * 1000 });
    const { cookie, csrf } = await t.login();

    const res = await fetch(`${t.base}/inbox/igsid-1/reply`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: 'support follow-up', _csrf: csrf }),
    });

    assert.equal(res.status, 303);
    assert.equal(t.instagram.sent[0].humanAgent, true);
  } finally {
    await t.close();
  }
});

test('inbound webhooks populate the inbox', async () => {
  const t = await setup();
  try {
    const { createHmac } = await import('node:crypto');
    const config = loadConfig({ IG_APP_SECRET: 'sekret', STORE_PATH: '' });

    // Rebuild the app with a signed webhook so we can drive the whole path.
    const store = new Store('');
    const instagram = createFakeInstagram();
    const events = createEventHub();
    const bridge = new Bridge({ store, instagram, config: { ...t.bridge.config, instagram: config.instagram }, log: quiet, events });
    const auth = t.auth;
    const inboxRoutes = createInboxRoutes({ auth, store, bridge, events, log: quiet });
    const app = createApp({
      config: { ...config, chat: { ...config.chat, space: '' }, windowHours: 24, allowHumanAgentTag: false },
      bridge,
      instagramClient: instagram,
      chat: null,
      inboxRoutes,
      log: quiet,
    });
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const body = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'igsid-42' },
              timestamp: Date.now(),
              message: { mid: 'mid-42', text: 'hello from instagram' },
            },
          ],
        },
      ],
    });

    const res = await fetch(`${base}/webhooks/instagram`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'sekret').update(body).digest('hex')}`,
      },
      body,
    });
    assert.equal(res.status, 200);

    assert.equal(store.messages('igsid-42').length, 1);
    assert.equal(store.messages('igsid-42')[0].text, 'hello from instagram');

    const { cookie } = await t.login();
    const inbox = await fetch(`${base}/inbox`, { headers: { cookie } });
    assert.match(await inbox.text(), /hello from instagram/);

    events.close();
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await t.close();
  }
});

test('the event stream requires a session', async () => {
  const t = await setup();
  try {
    const res = await fetch(`${t.base}/events`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  } finally {
    await t.close();
  }
});
