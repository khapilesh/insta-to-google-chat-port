import { describeAttachments } from './instagram.js';

const HOUR_MS = 60 * 60 * 1000;
const HUMAN_AGENT_MAX_MS = 7 * 24 * HOUR_MS;

function fmtHours(ms) {
  const hours = ms / HOUR_MS;
  if (hours >= 1) return `${Math.floor(hours)}h`;
  return `${Math.max(0, Math.round(ms / 60000))}m`;
}

function clock(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Routes messages between one Instagram professional account and one Google
 * Chat space, one thread per Instagram conversation.
 *
 * The bridge is transport-agnostic: `instagram`, `chat` and `store` are all
 * injected, which is what lets the demo script run the exact same routing code
 * with in-memory fakes.
 */
export class Bridge {
  constructor({ store, instagram, chat, config, log = console, now = () => Date.now() }) {
    this.store = store;
    this.instagram = instagram;
    this.chat = chat;
    this.config = config;
    this.log = log;
    this.now = now;
  }

  get space() {
    return this.config.chat.space;
  }

  windowMs() {
    return (this.config.windowHours || 24) * HOUR_MS;
  }

  /** Instagram -> Google Chat. */
  async handleInstagramEvent(evt) {
    if (!evt || evt.kind !== 'message') return { ignored: evt?.kind || 'unknown' };
    if (evt.isEcho) return { ignored: 'echo of our own message' };
    if (evt.isDeleted) return { ignored: 'deleted' };
    // parseWebhook already folds attachments into `text`; fall back to reading
    // them directly so the bridge works with any normalizer.
    const body = (evt.text || '').trim() || describeAttachments(evt.attachments);
    if (!body) return { ignored: 'no text content' };
    if (!evt.igsid) return { ignored: 'no sender id' };

    if (this.store.seen(evt.mid)) return { ignored: 'duplicate delivery' };
    this.store.markSeen(evt.mid);

    const conv = this.store.conversation(evt.igsid, {
      space: this.space,
      displayName: evt.displayName,
    });
    if (!conv.space && this.space) conv.space = this.space;
    if (evt.displayName && !conv.displayName) conv.displayName = evt.displayName;

    const receivedAt = evt.timestamp || this.now();
    this.store.markInbound(evt.igsid, receivedAt);

    const deadline = receivedAt + this.windowMs();
    const who = conv.displayName ? `@${conv.displayName}` : evt.igsid;
    const text = [
      `*Instagram DM* from ${who} · ${clock(receivedAt)}`,
      '',
      body,
      '',
      `_Reply in this thread to answer on Instagram — window closes in ${fmtHours(deadline - this.now())}._`,
    ].join('\n');

    let result;
    try {
      result = await this.chat.send({
        space: conv.space || this.space,
        threadKey: conv.threadKey,
        text,
      });
    } catch (err) {
      // Let Meta's retry re-deliver this one.
      this.store.forget(evt.mid);
      throw err;
    }

    if (result?.threadName) this.store.linkThread(result.threadName, evt.igsid);
    return { forwarded: true, threadName: result?.threadName || '', igsid: evt.igsid };
  }

  /** Google Chat -> Instagram. */
  async handleChatEvent(event) {
    const type = event?.type || 'MESSAGE';

    if (type === 'ADDED_TO_SPACE') {
      await this.chat.send({
        space: event.space?.name,
        text:
          'Instagram bridge connected. Each Instagram conversation gets its own thread here — ' +
          'reply inside a thread to answer that person on Instagram.',
      });
      return { welcomed: true };
    }

    if (type !== 'MESSAGE') return { ignored: `event type ${type}` };

    const message = event.message || {};
    const sender = message.sender || event.user || {};
    if (sender.type === 'BOT') return { ignored: 'bot message' };

    const threadName = message.thread?.name || '';
    const space = event.space?.name || this.space;
    const text = (message.text || message.argumentText || '').trim();

    // Chat app mentions arrive as "@Bridge hello"; drop the leading mention.
    const cleanText = text.replace(/^@\S+\s*/, '').trim();
    if (!cleanText) return { ignored: 'empty message' };

    if (!this.store.seen(message.name)) this.store.markSeen(message.name);
    else return { ignored: 'duplicate delivery' };

    const conv = this.store.conversationForThread(threadName);
    if (!conv) {
      await this.chat.send({
        space,
        threadKey: message.thread?.threadKey,
        text:
          'This thread is not linked to an Instagram conversation yet, so there is nobody to ' +
          'send it to. Replies work inside a thread created by an incoming Instagram DM.',
      });
      return { ignored: 'unlinked thread' };
    }

    const age = this.now() - (conv.lastInboundAt || 0);
    const useHumanAgent = age > this.windowMs();

    if (useHumanAgent) {
      if (!this.config.allowHumanAgentTag) {
        await this.chat.send({
          space,
          threadKey: message.thread?.threadKey,
          text:
            `*Not sent.* Instagram's 24-hour reply window closed (last DM ${fmtHours(age)} ago). ` +
            `Until they message you again, the official API cannot deliver this. ` +
            `Set ALLOW_HUMAN_AGENT_TAG=true to use Meta's HUMAN_AGENT tag for up to 7 days.`,
        });
        return { blocked: 'window closed', igsid: conv.igsid };
      }
      if (age > HUMAN_AGENT_MAX_MS) {
        await this.chat.send({
          space,
          threadKey: message.thread?.threadKey,
          text:
            `*Not sent.* Even the HUMAN_AGENT tag only covers 7 days; the last Instagram DM was ` +
            `${fmtHours(age)} ago. Wait for them to message you again.`,
        });
        return { blocked: 'human agent window closed', igsid: conv.igsid };
      }
    }

    const senderName = sender.displayName || sender.email || 'Google Chat';
    const outgoing = this.config.prefixChatSender ? `${senderName} (Google Chat): ${cleanText}` : cleanText;

    try {
      await this.instagram.sendText({ igsid: conv.igsid, text: outgoing, humanAgent: useHumanAgent });
    } catch (err) {
      this.log.error(`[bridge] Instagram send failed: ${err.message}`);
      await this.chat
        .send({
          space,
          threadKey: message.thread?.threadKey,
          text: `*Not sent to Instagram.* ${err.message}`,
        })
        .catch(() => {});
      return { error: err.message, igsid: conv.igsid };
    }

    this.store.markOutbound(conv.igsid);
    return { forwarded: true, igsid: conv.igsid, humanAgent: useHumanAgent };
  }
}
