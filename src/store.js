import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SEEN_TTL_MS = 6 * 60 * 60 * 1000;

function emptyState() {
  return { conversations: {}, threads: {}, seen: {} };
}

/**
 * Tiny JSON-file store.
 *
 * Deliberately boring: one bridge instance, one file, atomic rewrite on every
 * mutation. The whole state is a few kilobytes unless you have thousands of
 * conversations. Swap in SQLite/Postgres if you outgrow it — the shape is
 * `conversation -> igsid, chat thread, last inbound timestamp`.
 */
export class Store {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.state = emptyState();
    this.load();
  }

  load() {
    if (!this.file) return;
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      this.state = { ...emptyState(), ...parsed };
    } catch (err) {
      throw new Error(`Could not parse store at ${this.file}: ${err.message}`);
    }
  }

  save() {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  /** Get or create the record for one Instagram conversation. */
  conversation(igsid, defaults = {}) {
    const existing = this.state.conversations[igsid];
    if (existing) return existing;
    const created = {
      igsid,
      threadKey: `ig-${igsid}`,
      space: defaults.space || '',
      threadName: '',
      displayName: defaults.displayName || '',
      lastInboundAt: 0,
      lastOutboundAt: 0,
      createdAt: this.now(),
    };
    this.state.conversations[igsid] = created;
    this.save();
    return created;
  }

  getConversation(igsid) {
    return this.state.conversations[igsid];
  }

  conversationForThread(threadName) {
    if (!threadName) return undefined;
    const igsid = this.state.threads[threadName];
    return igsid ? this.state.conversations[igsid] : undefined;
  }

  /** Remember which Chat thread belongs to which Instagram conversation. */
  linkThread(threadName, igsid) {
    if (!threadName || !igsid) return;
    if (this.state.threads[threadName] === igsid) return;
    this.state.threads[threadName] = igsid;
    const conv = this.state.conversations[igsid];
    if (conv) conv.threadName = threadName;
    this.save();
  }

  markInbound(igsid, at = this.now()) {
    const conv = this.conversation(igsid);
    conv.lastInboundAt = at;
    this.save();
    return conv;
  }

  markOutbound(igsid, at = this.now()) {
    const conv = this.conversation(igsid);
    conv.lastOutboundAt = at;
    this.save();
    return conv;
  }

  /**
   * Both Meta and Google Chat retry webhook deliveries, so every handler has to
   * be idempotent. Returns true when this id was already handled.
   */
  seen(id) {
    if (!id) return false;
    return Boolean(this.state.seen[id]);
  }

  markSeen(id) {
    if (!id) return;
    this.state.seen[id] = this.now();
    this.pruneSeen();
    this.save();
  }

  /** Release a dedupe entry so a retried delivery can be processed. */
  forget(id) {
    if (!id || !this.state.seen[id]) return;
    delete this.state.seen[id];
    this.save();
  }

  pruneSeen() {
    const cutoff = this.now() - SEEN_TTL_MS;
    const ids = Object.keys(this.state.seen);
    if (ids.length <= 5000) {
      for (const id of ids) {
        if (this.state.seen[id] < cutoff) delete this.state.seen[id];
      }
      return;
    }
    const kept = ids
      .sort((a, b) => this.state.seen[b] - this.state.seen[a])
      .slice(0, 5000);
    const next = {};
    for (const id of kept) next[id] = this.state.seen[id];
    this.state.seen = next;
  }
}
