/**
 * In-memory stand-ins for the two transports, so the routing logic can be
 * exercised (and demoed) without any Meta or Google credentials.
 * They mirror the real return shapes closely enough to catch wiring mistakes.
 */
export function createFakeChat({ space = 'spaces/DEMO', clock = () => Date.now() } = {}) {
  const sent = [];
  const threads = new Map();
  let seq = 0;

  function threadNameFor(threadKey) {
    if (!threadKey) return '';
    if (!threads.has(threadKey)) {
      seq += 1;
      threads.set(threadKey, `spaces/DEMO/threads/${threadKey}-${seq}`);
    }
    return threads.get(threadKey);
  }

  return {
    sent,
    async send({ space: target = space, threadKey, text }) {
      seq += 1;
      const record = {
        at: clock(),
        space: target,
        threadKey: threadKey || '',
        threadName: threadNameFor(threadKey),
        text,
      };
      sent.push(record);
      return {
        messageName: `${target}/messages/m${seq}`,
        threadName: record.threadName,
        space: target,
      };
    },
  };
}

export function createFakeInstagram() {
  const sent = [];
  return {
    sent,
    configured: true,
    async sendText({ igsid, text, humanAgent = false }) {
      if (!igsid) throw new Error('missing igsid');
      sent.push({ igsid, text, humanAgent });
      return { recipient_id: igsid, message_id: `mid.out.${sent.length}` };
    },
  };
}
