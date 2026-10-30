/**
 * Server-sent-events hub.
 *
 * One process, a handful of inbox tabs open at once — a plain array of
 * response objects is the right size of machinery. Clients are dropped on
 * write failure so a closed laptop can't leak memory.
 */
export function createEventHub({ heartbeatMs = 25000, now = () => Date.now() } = {}) {
  const clients = new Set();
  let timer = null;

  function write(client, chunk) {
    try {
      client.res.write(chunk);
      return true;
    } catch {
      return false;
    }
  }

  function ensureHeartbeat() {
    if (timer) return;
    timer = setInterval(() => {
      for (const client of clients) {
        if (!write(client, ': ping\n\n')) clients.delete(client);
      }
    }, heartbeatMs);
    timer.unref?.();
  }

  return {
    get size() {
      return clients.size;
    },

    /** Takes over the response and keeps it open. */
    subscribe(req, res, { username = '' } = {}) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');

      const client = { res, username, since: now() };
      clients.add(client);
      ensureHeartbeat();

      const cleanup = () => clients.delete(client);
      req.on('close', cleanup);
      req.on('error', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
    },

    publish(event) {
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) {
        if (!write(client, payload)) clients.delete(client);
      }
    },

    close() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const client of clients) {
        try {
          client.res.end();
        } catch {
          /* already gone */
        }
      }
      clients.clear();
    },
  };
}
