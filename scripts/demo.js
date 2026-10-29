import process from 'node:process';

import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { parseWebhook } from '../src/instagram.js';
import { Bridge } from '../src/bridge.js';
import { createFakeChat, createFakeInstagram } from '../test/fakes.js';

/**
 * Runs the real bridge code end to end against fake transports.
 *
 *   npm run demo
 *
 * Everything you see below comes from the same Bridge/parseWebhook functions
 * the server uses; only the two network clients are swapped out.
 */

let now = Date.parse('2026-10-29T09:00:00Z');
const clock = () => now;
const advance = (minutes) => {
  now += minutes * 60 * 1000;
};

const quietLog = { log() {}, warn() {}, error() {} };

const config = loadConfig({
  ...process.env,
  STORE_PATH: '',
  IG_WINDOW_HOURS: '24',
  PREFIX_CHAT_SENDER: 'true',
  ALLOW_HUMAN_AGENT_TAG: 'false',
  GOOGLE_CHAT_SPACE: 'spaces/DEMO',
});
config.chat.space = 'spaces/DEMO';

const store = new Store('', { now: clock });
const chat = createFakeChat({ clock });
const instagram = createFakeInstagram();
const bridge = new Bridge({ store, instagram, chat, config, log: quietLog, now: clock });

let step = 0;
function heading(title) {
  step += 1;
  console.log(`\n\x1b[1m${step}. ${title}\x1b[0m`);
}
function show(label, value) {
  console.log(`   ${label}: ${value}`);
}
function quote(text) {
  return text
    .split('\n')
    .map((line) => `      │ ${line}`)
    .join('\n');
}

/** Build a realistic Meta webhook body and run it through parseWebhook. */
async function instagramDm({ igsid, mid, text, attachments }) {
  const payload = {
    object: 'instagram',
    entry: [
      {
        id: config.instagram.igUserId || '17841400000000000',
        time: Math.floor(now / 1000),
        messaging: [
          {
            sender: { id: igsid },
            recipient: { id: config.instagram.igUserId || '17841400000000000' },
            timestamp: now,
            message: {
              mid,
              text,
              ...(attachments ? { attachments } : {}),
            },
          },
        ],
      },
    ],
  };
  const events = parseWebhook(payload);
  const results = [];
  for (const evt of events) results.push(await bridge.handleInstagramEvent(evt));
  return results;
}

console.log('\x1b[1mInstagram → Google Chat → Instagram bridge (dry run)\x1b[0m');
console.log('No network calls are made. Transports are in-memory fakes.');

heading('A customer DMs the Instagram account');
const first = await instagramDm({
  igsid: '17841400000001234',
  mid: 'mid.in.001',
  text: 'Hi! Is the blue hoodie in a medium still available?',
});
show('result', JSON.stringify(first[0]));
console.log('   posted to Google Chat:');
console.log(quote(chat.sent.at(-1).text));

heading('Meta retries the same delivery (very common)');
const dup = await instagramDm({
  igsid: '17841400000001234',
  mid: 'mid.in.001',
  text: 'Hi! Is the blue hoodie in a medium still available?',
});
show('result', JSON.stringify(dup[0]));
show('chat messages total', String(chat.sent.length));

heading('A teammate replies inside that Chat thread');
const threadName = chat.sent.at(-1).threadName;
const chatReply = await bridge.handleChatEvent({
  type: 'MESSAGE',
  space: { name: 'spaces/DEMO' },
  message: {
    name: 'spaces/DEMO/messages/m9001',
    text: 'Yes — medium is in stock. Want me to send a link?',
    thread: { name: threadName },
    sender: { displayName: 'Aisha', email: 'aisha@example.com', type: 'HUMAN' },
  },
});
show('result', JSON.stringify(chatReply));
console.log('   delivered to Instagram:');
console.log(quote(instagram.sent.at(-1).text));
show('message tag', instagram.sent.at(-1).humanAgent ? 'HUMAN_AGENT' : 'RESPONSE');

heading('A reply lands in a Chat thread that has no Instagram conversation');
const stray = await bridge.handleChatEvent({
  type: 'MESSAGE',
  space: { name: 'spaces/DEMO' },
  message: {
    name: 'spaces/DEMO/messages/m9002',
    text: 'unrelated thread chatter',
    thread: { name: 'spaces/DEMO/threads/unrelated' },
    sender: { displayName: 'Aisha', type: 'HUMAN' },
  },
});
show('result', JSON.stringify(stray));
console.log(quote(chat.sent.at(-1).text));

heading('An image-only DM arrives');
await instagramDm({
  igsid: '17841400000009876',
  mid: 'mid.in.002',
  attachments: [{ type: 'image', payload: { url: 'https://cdn.example.com/photo.jpg' } }],
});
console.log(quote(chat.sent.at(-1).text));

heading('27 hours later, someone replies in the old thread');
advance(27 * 60);
const late = await bridge.handleChatEvent({
  type: 'MESSAGE',
  space: { name: 'spaces/DEMO' },
  message: {
    name: 'spaces/DEMO/messages/m9003',
    text: 'Just following up on this!',
    thread: { name: threadName },
    sender: { displayName: 'Aisha', type: 'HUMAN' },
  },
});
show('result', JSON.stringify(late));
show('instagram messages sent', String(instagram.sent.length));
console.log('   what the teammate sees in the thread:');
console.log(quote(chat.sent.at(-1).text));

heading('Same reply with ALLOW_HUMAN_AGENT_TAG=true (still inside 7 days)');
config.allowHumanAgentTag = true;
const tagged = await bridge.handleChatEvent({
  type: 'MESSAGE',
  space: { name: 'spaces/DEMO' },
  message: {
    name: 'spaces/DEMO/messages/m9004',
    text: 'Just following up on this!',
    thread: { name: threadName },
    sender: { displayName: 'Aisha', type: 'HUMAN' },
  },
});
show('result', JSON.stringify(tagged));
show('message tag', instagram.sent.at(-1).humanAgent ? 'HUMAN_AGENT' : 'RESPONSE');

heading('The customer answers, which reopens the 24h window');
await instagramDm({
  igsid: '17841400000001234',
  mid: 'mid.in.003',
  text: 'Yes please send the link',
});
const afterReopen = await bridge.handleChatEvent({
  type: 'MESSAGE',
  space: { name: 'spaces/DEMO' },
  message: {
    name: 'spaces/DEMO/messages/m9005',
    text: 'Here you go: https://shop.example.com/blue-hoodie-m',
    thread: { name: threadName },
    sender: { displayName: 'Aisha', type: 'HUMAN' },
  },
});
show('result', JSON.stringify(afterReopen));
show('message tag', instagram.sent.at(-1).humanAgent ? 'HUMAN_AGENT' : 'RESPONSE');

console.log('\n\x1b[1mSummary\x1b[0m');
console.log(`   Chat messages posted : ${chat.sent.length}`);
console.log(`   Instagram messages   : ${instagram.sent.length}`);
console.log(`   Conversations tracked: ${Object.keys(store.state.conversations).length}`);
console.log('\nNext: fill in .env (see .env.example) and run `npm start` behind a public HTTPS URL.\n');
