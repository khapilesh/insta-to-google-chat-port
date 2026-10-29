import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { createFakeChat, createFakeInstagram } from './fakes.js';

const quiet = { log() {}, warn() {}, error() {} };
const HOUR = 60 * 60 * 1000;

function setup(overrides = {}) {
  let now = Date.parse('2026-10-29T09:00:00Z');
  const clock = () => now;
  const advance = (ms) => {
    now += ms;
  };

  const env = {
    GOOGLE_CHAT_SPACE: 'spaces/AAA',
    STORE_PATH: '',
    ...overrides.env,
  };
  const config = loadConfig(env);
  config.chat.space = 'spaces/AAA';
  if (overrides.allowHumanAgentTag !== undefined) {
    config.allowHumanAgentTag = overrides.allowHumanAgentTag;
  }

  const store = new Store('', { now: clock });
  const chat = createFakeChat({ clock });
  const instagram = createFakeInstagram();
  const bridge = new Bridge({ store, instagram, chat, config, log: quiet, now: clock });

  const igMessage = (over = {}) => ({
    kind: 'message',
    igsid: 'igsid-1',
    mid: `mid-${Math.random()}`,
    text: 'hello',
    timestamp: now,
    isEcho: false,
    isDeleted: false,
    ...over,
  });

  const chatMessage = (over = {}) => {
    const threadName = over.threadName ?? chat.sent.at(-1)?.threadName ?? 'spaces/AAA/threads/none';
    const { threadName: _ignored, ...rest } = over;
    return {
      type: 'MESSAGE',
      space: { name: 'spaces/AAA' },
      message: {
        name: `spaces/AAA/messages/${Math.random()}`,
        text: 'reply from chat',
        thread: { name: threadName },
        sender: { displayName: 'Aisha', email: 'aisha@example.com', type: 'HUMAN' },
        ...rest,
      },
    };
  };

  return { bridge, chat, instagram, store, config, clock, advance, igMessage, chatMessage };
}

test('forwards an inbound Instagram DM into a per-conversation Chat thread', async () => {
  const t = setup();
  const result = await t.bridge.handleInstagramEvent(
    t.igMessage({ igsid: 'igsid-1', text: 'do you ship to Maldives?' }),
  );

  assert.equal(result.forwarded, true);
  assert.equal(t.chat.sent.length, 1);

  const posted = t.chat.sent[0];
  assert.equal(posted.space, 'spaces/AAA');
  assert.equal(posted.threadKey, 'ig-igsid-1');
  assert.match(posted.text, /do you ship to Maldives\?/);
  assert.match(posted.text, /window closes in 24h/);

  // A second DM from the same person lands in the same thread.
  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-1', text: 'second' }));
  assert.equal(t.chat.sent[1].threadKey, 'ig-igsid-1');

  // A different person gets a different thread.
  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-2', text: 'hi' }));
  assert.equal(t.chat.sent[2].threadKey, 'ig-igsid-2');
});

test('ignores duplicate and echo deliveries from Meta', async () => {
  const t = setup();
  const msg = t.igMessage({ mid: 'mid-fixed' });

  assert.equal((await t.bridge.handleInstagramEvent(msg)).forwarded, true);
  assert.deepEqual(await t.bridge.handleInstagramEvent(msg), { ignored: 'duplicate delivery' });
  assert.equal(t.chat.sent.length, 1);

  const echo = t.igMessage({ mid: 'mid-echo', isEcho: true });
  assert.deepEqual(await t.bridge.handleInstagramEvent(echo), {
    ignored: 'echo of our own message',
  });
});

test('renders attachment-only DMs instead of dropping them', async () => {
  const t = setup();
  await t.bridge.handleInstagramEvent(
    t.igMessage({ text: '', attachments: [{ type: 'image', payload: { url: 'https://x/y.jpg' } }] }),
  );
  assert.match(t.chat.sent[0].text, /\[image: https:\/\/x\/y\.jpg\]/);
});

test('routes a threaded Chat reply back to Instagram', async () => {
  const t = setup();
  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-1' }));

  const result = await t.bridge.handleChatEvent(
    t.chatMessage({ text: 'Yes, 3-5 days. Want a link?' }),
  );

  assert.equal(result.forwarded, true);
  assert.equal(t.instagram.sent.length, 1);
  assert.equal(t.instagram.sent[0].igsid, 'igsid-1');
  assert.equal(t.instagram.sent[0].humanAgent, false);
  assert.match(t.instagram.sent[0].text, /^Aisha \(Google Chat\): Yes, 3-5 days/);
});

test('does not leak into Instagram from unlinked threads', async () => {
  const t = setup();
  const result = await t.bridge.handleChatEvent(
    t.chatMessage({ threadName: 'spaces/AAA/threads/random', text: 'water cooler chat' }),
  );
  assert.equal(result.ignored, 'unlinked thread');
  assert.equal(t.instagram.sent.length, 0);
  assert.match(t.chat.sent.at(-1).text, /not linked to an Instagram conversation/);
});

test('ignores bot messages so the bridge cannot loop', async () => {
  const t = setup();
  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-1' }));
  const result = await t.bridge.handleChatEvent(
    t.chatMessage({ sender: { type: 'BOT', displayName: 'Bridge' } }),
  );
  assert.deepEqual(result, { ignored: 'bot message' });
  assert.equal(t.instagram.sent.length, 0);
});

test('strips the @mention prefix Chat adds when the app is named', async () => {
  const t = setup();
  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-1' }));
  await t.bridge.handleChatEvent(t.chatMessage({ text: '@Bridge hi there' }));
  assert.match(t.instagram.sent[0].text, /hi there$/);
  assert.ok(!t.instagram.sent[0].text.includes('@Bridge'));
});

test('refuses to send after the 24h window closes', async () => {
  const t = setup();
  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-1' }));
  t.advance(25 * HOUR);

  const result = await t.bridge.handleChatEvent(t.chatMessage({ text: 'late reply' }));

  assert.equal(result.blocked, 'window closed');
  assert.equal(t.instagram.sent.length, 0);
  assert.match(t.chat.sent.at(-1).text, /24-hour reply window closed/);
});

test('uses the HUMAN_AGENT tag when allowed and inside 7 days', async () => {
  const t = setup({ allowHumanAgentTag: true });
  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-1' }));
  t.advance(48 * HOUR);

  const result = await t.bridge.handleChatEvent(t.chatMessage({ text: 'support follow-up' }));

  assert.equal(result.humanAgent, true);
  assert.equal(t.instagram.sent[0].humanAgent, true);
});

test('gives up after 7 days even with the HUMAN_AGENT tag', async () => {
  const t = setup({ allowHumanAgentTag: true });
  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-1' }));
  t.advance(8 * 24 * HOUR);

  const result = await t.bridge.handleChatEvent(t.chatMessage({ text: 'too late' }));

  assert.equal(result.blocked, 'human agent window closed');
  assert.equal(t.instagram.sent.length, 0);
});

test('a new inbound DM reopens the window', async () => {
  const t = setup();
  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-1' }));
  t.advance(30 * HOUR);
  assert.equal((await t.bridge.handleChatEvent(t.chatMessage())).blocked, 'window closed');

  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-1', text: 'still there?' }));
  const result = await t.bridge.handleChatEvent(t.chatMessage({ text: 'yes!' }));
  assert.equal(result.forwarded, true);
});

test('reports Instagram API failures back into the thread', async () => {
  const t = setup();
  await t.bridge.handleInstagramEvent(t.igMessage({ igsid: 'igsid-1' }));
  t.instagram.sendText = async () => {
    throw new Error('Instagram Send API 400: window closed');
  };

  const result = await t.bridge.handleChatEvent(t.chatMessage({ text: 'oops' }));

  assert.match(result.error, /window closed/);
  assert.match(t.chat.sent.at(-1).text, /\*Not sent to Instagram\.\*/);
});

test('greets the space on ADDED_TO_SPACE', async () => {
  const t = setup();
  const result = await t.bridge.handleChatEvent({
    type: 'ADDED_TO_SPACE',
    space: { name: 'spaces/AAA' },
  });
  assert.equal(result.welcomed, true);
  assert.match(t.chat.sent[0].text, /Instagram bridge connected/);
});
