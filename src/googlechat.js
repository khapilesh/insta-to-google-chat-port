import { createPublicKey, verify as cryptoVerify, sign as cryptoSign } from 'node:crypto';

const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';
const CHAT_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com';

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** Accepts either "spaces/AAAA" or a bare space id. */
export function normalizeSpace(space) {
  if (!space) return '';
  return space.startsWith('spaces/') ? space : `spaces/${space}`;
}

/**
 * Service-account access token provider for the Chat API (app auth).
 * Implements the JWT bearer grant directly so the project needs no SDK.
 */
export function createServiceAccountTokenProvider({
  credentials,
  scope = CHAT_SCOPE,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error('Service account credentials need client_email and private_key');
  }
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  let cached = null;

  return {
    async getToken() {
      if (cached && cached.expiresAt - 60_000 > now()) return cached.accessToken;

      const iat = Math.floor(now() / 1000);
      const claims = {
        iss: credentials.client_email,
        scope,
        aud: tokenUri,
        iat,
        exp: iat + 3600,
      };
      const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
        JSON.stringify(claims),
      )}`;
      const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), credentials.private_key);
      const assertion = `${signingInput}.${signature.toString('base64url')}`;

      const res = await fetchImpl(tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          `Google token exchange failed ${res.status}: ${body.error_description || body.error}`,
        );
      }

      cached = {
        accessToken: body.access_token,
        expiresAt: now() + Number(body.expires_in || 3600) * 1000,
      };
      return cached.accessToken;
    },
  };
}

let jwksCache = { fetchedAt: 0, keys: [] };

export function clearJwksCache() {
  jwksCache = { fetchedAt: 0, keys: [] };
}

async function getChatJwks(fetchImpl, nowMs) {
  if (jwksCache.keys.length && nowMs - jwksCache.fetchedAt < 60 * 60 * 1000) return jwksCache.keys;
  const res = await fetchImpl(CHAT_JWKS_URL);
  if (!res.ok) throw new Error(`Could not fetch Chat JWKS: ${res.status}`);
  const body = await res.json();
  jwksCache = { fetchedAt: nowMs, keys: body.keys || [] };
  return jwksCache.keys;
}

/**
 * Google signs every request it makes to a Chat app with a short-lived JWT.
 * Without this check anyone who learns your endpoint URL can impersonate Chat.
 */
export async function verifyChatRequest(
  authorizationHeader,
  { audience, fetchImpl = fetch, now = () => Date.now() } = {},
) {
  if (!audience) return { ok: false, reason: 'no audience configured' };
  const match = /^Bearer (.+)$/.exec(authorizationHeader || '');
  if (!match) return { ok: false, reason: 'missing bearer token' };

  const nowMs = now();
  const parts = match[1].split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed jwt' };
  const [headerSeg, claimsSeg, sigSeg] = parts;

  let header;
  let claims;
  try {
    header = decodeSegment(headerSeg);
    claims = decodeSegment(claimsSeg);
  } catch {
    return { ok: false, reason: 'unreadable jwt' };
  }

  if (header.alg !== 'RS256') return { ok: false, reason: 'unexpected alg' };
  if (claims.aud !== audience) return { ok: false, reason: 'audience mismatch' };
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) {
    return { ok: false, reason: 'unexpected issuer' };
  }
  if (!claims.exp || claims.exp * 1000 < nowMs) return { ok: false, reason: 'expired' };

  const keys = await getChatJwks(fetchImpl, nowMs);
  const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
  if (!jwk) return { ok: false, reason: 'no matching key' };

  let keyObject;
  try {
    keyObject = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return { ok: false, reason: 'bad jwk' };
  }

  const valid = cryptoVerify(
    'RSA-SHA256',
    Buffer.from(`${headerSeg}.${claimsSeg}`),
    keyObject,
    Buffer.from(sigSeg, 'base64url'),
  );

  return valid ? { ok: true, claims } : { ok: false, reason: 'bad signature' };
}

/**
 * Google Chat client. Sends into a space, threaded by `threadKey` so each
 * Instagram conversation gets its own thread.
 */
export function createChatClient({
  apiBase = 'https://chat.googleapis.com',
  getToken,
  fetchImpl = fetch,
  log = console,
}) {
  return {
    async send({ space, threadKey, text }) {
      const target = normalizeSpace(space);
      if (!target) throw new Error('chat.send: missing space');
      if (!text) throw new Error('chat.send: missing text');

      const token = await getToken();
      const url = `${apiBase}/v1/${target}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          text,
          ...(threadKey ? { thread: { threadKey } } : {}),
        }),
      });

      const raw = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }

      if (!res.ok) {
        throw new Error(`Google Chat API ${res.status}: ${parsed?.error?.message || raw}`);
      }

      log.log(`[chat] posted to ${target}${threadKey ? ` (thread ${threadKey})` : ''}`);
      return {
        messageName: parsed.name,
        threadName: parsed.thread?.name || '',
        space: parsed.space?.name || target,
      };
    },
  };
}
