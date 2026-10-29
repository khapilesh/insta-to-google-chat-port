import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { createApp } from '../src/server.js';
import { parseWebhook, verifySignature } from '../src/instagram.js';
import { createFakeChat, createFakeInstagram } from './fakes.js';

const quiet = { log() {}, warn() {}, error() {} };
const SECRET = 'app-secret';

function sign(body, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function instagramPayload({ igsid = 'igsid-9', mid = 'mid-1', text = 'hi' } = {}) {
  return {
    object: 'instagram',
    entry: [
      {
        id: '17841400000000000',
        time: Math.floor(Date.now() / 1000),
        messaging: [
          {
            sender: { id: igsid },
            recipient: { id: '17841400000000000' },
            timestamp: Date.now(),
            message: { mid, text },
          },
        ],
      },
    ],
  };
}

async function withServer(envOverrides, fn) {
  const config = loadConfig({
    IG_APP_SECRET: SECRET,
    IG_VERIFY_TOKEN: 'verify-me',
    GOOGLE_CHAT_SPACE: 'spaces/AAA',
    STORE_PATH: '',
    SKIP_CHAT_JWT_VERIFICATION: 'true',
    ...envOverrides,
  });
  config.chat.space = 'spaces/AAA';

  const store = new Store('');
  const chat = createFakeChat();
  const instagramClient = createFakeInstagram();
  const bridge = new Bridge({ store, instagram: instagramClient, chat, config, log: quiet });
  const app = createApp({ config, bridge, instagramClient, chat, log: quiet });

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, chat, instagramClient, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('verifySignature accepts a correct signature and rejects tampering', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(body, sign(body), SECRET), true);
  assert.equal(verifySignature(Buffer.from('{"a":2}'), sign(body), SECRET), false);
  assert.equal(verifySignature(body, sign(body, 'wrong'), SECRET), false);
  assert.equal(verifySignature(body, undefined, SECRET), false);
  assert.equal(verifySignature(body, sign(body), ''), false);
});

test('parseWebhook flattens messages, attachments and echoes', () => {
  const events = parseWebhook({
    object: 'instagram',
    entry: [
      {
        messaging: [
          {
            sender: { id: 'u1' },
            timestamp: 1700000000000,
            message: { mid: 'm1', text: 'hello', is_echo: false },
          },
          {
            sender: { id: 'u2' },
            timestamp: 1700000001000,
            message: {
              mid: 'm2',
              attachments: [{ type: 'audio', payload: { url: 'https://cdn/a.mp3' } }],
            },
          },
        ],
      },
    ],
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].text, 'hello');
  assert.equal(events[0].igsid, 'u1');
  assert.equal(events[1].text, '[audio: https://cdn/a.mp3]');
});

test('completes the Meta verification handshake', async () => {
  await withServer({}, async ({ base }) => {
    const ok = await fetch(
      `${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123`,
    );
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'abc123');

    const bad = await fetch(
      `${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc123`,
    );
    assert.equal(bad.status, 403);
  });
});

test('rejects unsigned Instagram webhook deliveries', async () => {
  await withServer({}, async ({ base, chat }) => {
    const res = await fetch(`${base}/webhooks/instagram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(instagramPayload()),
    });
    assert.equal(res.status, 401);
    assert.equal(chat.sent.length, 0);
  });
});

test('accepts a signed delivery and forwards it to Chat', async () => {
  await withServer({}, async ({ base, chat }) => {
    const body = JSON.stringify(instagramPayload({ text: 'signed hello' }));
    const res = await fetch(`${base}/webhooks/instagram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { handled: 1 });
    assert.equal(chat.sent.length, 1);
    assert.match(chat.sent[0].text, /signed hello/);
  });
});

test('replays of the same delivery do not duplicate into Chat', async () => {
  await withServer({}, async ({ base, chat }) => {
    const payload = instagramPayload({ mid: 'mid-stable' });
    const body = JSON.stringify(payload);
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${base}/webhooks/instagram`, {
        method: 'POST',
        headers: { 'x-hub-signature-256': sign(body) },
        body,
      });
      assert.equal(res.status, 200);
    }
    assert.equal(chat.sent.length, 1);
  });
});

test('serves health checks', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.chatSpace, 'spaces/AAA');
  });
});

test('Google Chat endpoint rejects unauthenticated calls once verification is on', async () => {
  await withServer({ SKIP_CHAT_JWT_VERIFICATION: 'false', GOOGLE_CHAT_PROJECT_NUMBER: '123' }, async ({
    base,
  }) => {
    const res = await fetch(`${base}/webhooks/google-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'MESSAGE', message: { text: 'hi' } }),
    });
    assert.equal(res.status, 401);
  });
});

test('Google Chat endpoint rejects calls when no project number is configured', async () => {
  // Fails closed: an unset audience must never mean "accept anything".
  await withServer({ SKIP_CHAT_JWT_VERIFICATION: 'false' }, async ({ base }) => {
    const res = await fetch(`${base}/webhooks/google-chat`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'MESSAGE', message: { text: 'hi' } }),
    });
    assert.equal(res.status, 401);
  });
});
