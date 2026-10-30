import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

import { loadConfig, loadDotEnv } from './config.js';
import { Store } from './store.js';
import { createInstagramClient, parseWebhook, verifySignature } from './instagram.js';
import {
  createChatClient,
  createServiceAccountTokenProvider,
  verifyChatRequest,
} from './googlechat.js';
import { Bridge } from './bridge.js';
import { createAuthService } from './auth.js';
import { createEventHub } from './events.js';
import { createInboxRoutes } from './inbox.js';

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

export function loadServiceAccount(config) {
  if (config.chat.serviceAccountJson) return JSON.parse(config.chat.serviceAccountJson);
  const file = config.chat.serviceAccountFile;
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  return null;
}

/**
 * Builds the HTTP app. Kept separate from `main()` so tests can mount it with
 * fake transports.
 */
export function createApp({
  config,
  bridge,
  instagramClient,
  chat,
  inboxRoutes = null,
  log = console,
  verifyChatJwt = verifyChatRequest,
  fetchImpl = fetch,
}) {
  return async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /healthz') {
        return sendJson(res, 200, {
          ok: true,
          instagramConfigured: Boolean(instagramClient?.configured),
          chatSpace: config.chat.space || null,
          webInbox: Boolean(inboxRoutes),
          windowHours: config.windowHours,
        });
      }

      if (route === 'GET /webhooks/instagram') {
        const mode = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token');
        const challenge = url.searchParams.get('hub.challenge');
        if (mode === 'subscribe' && token && token === config.instagram.verifyToken) {
          log.log('[webhook] Instagram verification challenge accepted');
          return sendText(res, 200, challenge || '');
        }
        log.warn('[webhook] Instagram verification rejected');
        return sendText(res, 403, 'forbidden');
      }

      if (route === 'POST /webhooks/instagram') {
        const raw = await readBody(req);
        const signature = req.headers['x-hub-signature-256'];
        if (!verifySignature(raw, signature, config.instagram.appSecret)) {
          log.warn('[webhook] bad Instagram signature — check IG_APP_SECRET');
          return sendJson(res, 401, { error: 'invalid signature' });
        }

        let payload;
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendJson(res, 400, { error: 'invalid json' });
        }

        const events = parseWebhook(payload);
        const results = [];
        for (const event of events) {
          try {
            results.push(await bridge.handleInstagramEvent(event));
          } catch (err) {
            log.error(`[webhook] Instagram event failed: ${err.message}`);
            // 500 so Meta retries; the dedupe entry was released.
            return sendJson(res, 500, { error: err.message });
          }
        }
        return sendJson(res, 200, { handled: results.length });
      }

      if (route === 'POST /webhooks/google-chat') {
        const raw = await readBody(req);

        if (!config.chat.skipJwtVerification) {
          const check = await verifyChatJwt(req.headers.authorization, {
            audience: config.chat.projectNumber,
            fetchImpl,
          });
          if (!check.ok) {
            log.warn(`[webhook] rejected Google Chat request: ${check.reason}`);
            return sendJson(res, 401, { error: 'unauthorized' });
          }
        }

        let event;
        try {
          event = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendJson(res, 400, { error: 'invalid json' });
        }

        const result = await bridge.handleChatEvent(event);
        log.log(`[webhook] chat event: ${JSON.stringify(result)}`);
        // Empty body = "no synchronous reply"; we deliver through the API.
        return sendJson(res, 200, {});
      }

      // Password-protected web inbox (only mounted when a password is set).
      if (inboxRoutes && (await inboxRoutes(req, res, url))) return;

      if (url.pathname === '/') {
        return sendText(res, 200, 'Instagram bridge. See /healthz.\n');
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      log.error(`[server] ${req.method} ${url.pathname} failed: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
  };
}

export async function startServer(config, { log = console } = {}) {
  const store = new Store(config.storePath);

  const instagramClient = createInstagramClient({
    graphBase: config.instagram.graphBase,
    igUserId: config.instagram.igUserId,
    accessToken: config.instagram.accessToken,
    log,
  });

  let getToken;
  if (config.chat.accessTokenOverride) {
    getToken = async () => config.chat.accessTokenOverride;
  } else {
    const credentials = loadServiceAccount(config);
    if (credentials) {
      getToken = createServiceAccountTokenProvider({ credentials }).getToken;
    } else {
      log.warn('[chat] no service account configured — outbound Chat sends will fail');
      getToken = async () => {
        throw new Error('No Google service account configured (GOOGLE_SERVICE_ACCOUNT_FILE)');
      };
    }
  }

  const chat = createChatClient({ apiBase: config.chat.apiBase, getToken, log });
  const events = createEventHub();
  const bridge = new Bridge({ store, instagram: instagramClient, chat, config, log, events });

  const auth = await createAuthService({
    password: config.inbox.password,
    passwordHash: config.inbox.passwordHash,
    users: config.inbox.users,
    sessionSecret: config.inbox.sessionSecret,
    sessionTtlMs: config.inbox.sessionTtlMs,
    cookieSecure: config.inbox.cookieSecure,
    log,
  });

  const inboxRoutes = createInboxRoutes({ auth, store, bridge, events, log });

  const server = createServer(
    createApp({ config, bridge, instagramClient, chat, inboxRoutes, log }),
  );
  return { server, store, bridge, chat, instagramClient, events, auth, inboxRoutes };
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const { server, events, inboxRoutes } = await startServer(config);

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] listening on http://0.0.0.0:${config.port}`);
    console.log(`[server] Instagram webhook: /webhooks/instagram`);
    if (inboxRoutes) console.log('[server] web inbox: /login');
    if (config.chat.space) console.log('[server] Google Chat webhook: /webhooks/google-chat');
    if (!config.instagram.appSecret) console.warn('[server] IG_APP_SECRET is empty — webhooks will be rejected');
    if (!config.chat.space && !inboxRoutes) console.warn('[server] nothing to deliver to — set GOOGLE_CHAT_SPACE or INBOX_PASSWORD');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n[server] ${signal} received, shutting down`);
      events.close();
      server.close(() => process.exit(0));
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
