import { describeAttachments } from './instagram.js';

const HOUR_MS = 60 * 60 * 1000;
const HUMAN_AGENT_MAX_MS = 7 * 24 * HOUR_MS;

export function fmtDuration(ms) {
  const clamped = Math.max(0, ms);
  const hours = clamped / HOUR_MS;
  if (hours >= 1) return `${Math.floor(hours)}h`;
  return `${Math.round(clamped / 60000)}m`;
}

function clock(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Routes messages between one Instagram professional account and one or more
 * destinations: a Google Chat space, a password-protected web inbox, or both.
 *
 * Every transport is injected (`instagram`, `chat`, `store`, `events`), which is
 * what lets the demo run this exact routing code against in-memory fakes.
 */
export class Bridge {
  constructor({ store, instagram, chat = null, config, log = console, now = () => Date.now(), events = null }) {
    this.store = store;
    this.instagram = instagram;
    this.chat = chat;
    this.config = config;
    this.log = log;
    this.now = now;
    this.events = events;
  }

  get space() {
    return this.config?.chat?.space || '';
  }

  get chatEnabled() {
    return Boolean(this.chat && this.space);
  }

  windowMs() {
    return (this.config.windowHours || 24) * HOUR_MS;
  }

  /**
   * Single source of truth for Meta's messaging window.
   * @returns {{state: 'open'|'tagged'|'blocked', ageMs: number, humanAgent: boolean,
   *            remainingMs: number, reason?: string}}
   */
  windowState(conv) {
    const ageMs = this.now() - (conv?.lastInboundAt || 0);
    const limit = this.windowMs();
    if (ageMs <= limit) {
      return { state: 'open', ageMs, humanAgent: false, remainingMs: limit - ageMs };
    }
    if (!this.config.allowHumanAgentTag) {
      return { state: 'blocked', ageMs, humanAgent: false, remainingMs: 0, reason: 'window closed' };
    }
    if (ageMs > HUMAN_AGENT_MAX_MS) {
      return {
        state: 'blocked',
        ageMs,
        humanAgent: false,
        remainingMs: 0,
        reason: 'human agent window closed',
      };
    }
    return {
      state: 'tagged',
      ageMs,
      humanAgent: true,
      remainingMs: HUMAN_AGENT_MAX_MS - ageMs,
    };
  }

  /** Human-readable explanation for a blocked send (used by both transports). */
  blockedNotice(state) {
    if (state.reason === 'human agent window closed') {
      return (
        `*Not sent.* Even the HUMAN_AGENT tag only covers 7 days; the last Instagram DM was ` +
        `${fmtDuration(state.ageMs)} ago. Wait for them to message you again.`
      );
    }
    return (
      `*Not sent.* Instagram's 24-hour reply window closed (last DM ${fmtDuration(state.ageMs)} ago). ` +
      `Until they message you again, the official API cannot deliver this. ` +
      `Set ALLOW_HUMAN_AGENT_TAG=true to use Meta's HUMAN_AGENT tag for up to 7 days.`
    );
  }

  publish(event) {
    try {
      this.events?.publish(event);
    } catch (err) {
      this.log.warn?.(`[bridge] event publish failed: ${err.message}`);
    }
  }

  /** Instagram -> Google Chat and/or the web inbox. */
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

    const message = this.store.appendMessage({
      igsid: evt.igsid,
      direction: 'in',
      text: body,
      at: receivedAt,
      id: evt.mid,
    });

    if (message) {
      this.publish({
        type: 'message',
        direction: 'in',
        igsid: evt.igsid,
        displayName: conv.displayName || '',
        text: body,
        at: receivedAt,
      });
    }

    if (!this.chatEnabled) {
      return { recorded: true, igsid: evt.igsid, chat: false };
    }

    const deadline = receivedAt + this.windowMs();
    const who = conv.displayName ? `@${conv.displayName}` : evt.igsid;
    const text = [
      `*Instagram DM* from ${who} · ${clock(receivedAt)}`,
      '',
      body,
      '',
      `_Reply in this thread to answer on Instagram — window closes in ${fmtDuration(deadline - this.now())}._`,
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

    if (!this.chat) return { ignored: 'no chat transport configured' };

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

    const state = this.windowState(conv);
    if (state.state === 'blocked') {
      await this.chat.send({
        space,
        threadKey: message.thread?.threadKey,
        text: this.blockedNotice(state),
      });
      return { blocked: state.reason, igsid: conv.igsid };
    }

    const senderName = sender.displayName || sender.email || 'Google Chat';
    const outgoing = this.config.prefixChatSender
      ? `${senderName} (Google Chat): ${cleanText}`
      : cleanText;

    try {
      await this.instagram.sendText({
        igsid: conv.igsid,
        text: outgoing,
        humanAgent: state.humanAgent,
      });
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
    this.store.appendMessage({
      igsid: conv.igsid,
      direction: 'out',
      text: cleanText,
      at: this.now(),
      id: `chat-${message.name || this.now()}`,
      author: senderName,
    });
    this.publish({
      type: 'message',
      direction: 'out',
      igsid: conv.igsid,
      text: cleanText,
      author: senderName,
      at: this.now(),
    });

    return { forwarded: true, igsid: conv.igsid, humanAgent: state.humanAgent };
  }

  /** Web inbox -> Instagram. */
  async replyFromWeb({ igsid, text, author = 'web' }) {
    const cleanText = (text || '').trim();
    if (!cleanText) return { error: 'empty message' };
    // Instagram caps message text at 1,000 bytes.
    if (Buffer.byteLength(cleanText, 'utf8') > 1000) {
      return { error: 'message is longer than Instagram allows (1000 bytes)' };
    }

    const conv = this.store.getConversation(igsid);
    if (!conv) return { error: 'unknown conversation' };

    const state = this.windowState(conv);
    if (state.state === 'blocked') {
      return { blocked: state.reason, igsid, ageMs: state.ageMs };
    }

    try {
      await this.instagram.sendText({
        igsid,
        text: cleanText,
        humanAgent: state.humanAgent,
      });
    } catch (err) {
      this.log.error(`[bridge] Instagram send failed: ${err.message}`);
      return { error: err.message, igsid };
    }

    this.store.markOutbound(igsid);
    const record = this.store.appendMessage({
      igsid,
      direction: 'out',
      text: cleanText,
      at: this.now(),
      id: `web-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      author,
    });
    this.publish({
      type: 'message',
      direction: 'out',
      igsid,
      text: cleanText,
      author,
      at: this.now(),
    });

    return { sent: true, igsid, humanAgent: state.humanAgent, message: record };
  }
}
