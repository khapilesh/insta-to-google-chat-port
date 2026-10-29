import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';

import {
  clearJwksCache,
  createChatClient,
  createServiceAccountTokenProvider,
  normalizeSpace,
  verifyChatRequest,
} from '../src/googlechat.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeJwt(claims, { kid = 'kid-1', alg = 'RS256' } = {}) {
  const header = base64urlJson({ alg, typ: 'JWT', kid });
  const payload = base64urlJson(claims);
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

function jwksFetch(jwkKey = publicKey) {
  const jwk = jwkKey.export({ format: 'jwk' });
  return async () =>
    new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'kid-1', alg: 'RS256' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

const goodClaims = () => ({
  iss: 'https://accounts.google.com',
  aud: '123456789',
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
});

test('verifies a genuine Google-signed Chat request', async () => {
  clearJwksCache();
  const token = makeJwt(goodClaims());
  const result = await verifyChatRequest(`Bearer ${token}`, {
    audience: '123456789',
    fetchImpl: jwksFetch(),
  });
  assert.equal(result.ok, true, result.reason);
});

test('rejects wrong audience, issuer and expiry', async () => {
  clearJwksCache();
  const fetchImpl = jwksFetch();

  const wrongAud = await verifyChatRequest(`Bearer ${makeJwt(goodClaims())}`, {
    audience: '999',
    fetchImpl,
  });
  assert.equal(wrongAud.ok, false);
  assert.equal(wrongAud.reason, 'audience mismatch');

  const wrongIssuer = await verifyChatRequest(
    `Bearer ${makeJwt({ ...goodClaims(), iss: 'https://evil.example' })}`,
    { audience: '123456789', fetchImpl },
  );
  assert.equal(wrongIssuer.reason, 'unexpected issuer');

  const expired = await verifyChatRequest(
    `Bearer ${makeJwt({ ...goodClaims(), exp: Math.floor(Date.now() / 1000) - 10 })}`,
    { audience: '123456789', fetchImpl },
  );
  assert.equal(expired.reason, 'expired');
});

test('rejects tokens signed by a different key', async () => {
  clearJwksCache();
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const header = base64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
  const payload = base64urlJson(goodClaims());
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const forged = `${header}.${payload}.${signer.sign(otherKey).toString('base64url')}`;

  const result = await verifyChatRequest(`Bearer ${forged}`, {
    audience: '123456789',
    fetchImpl: jwksFetch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad signature');
});

test('fails closed without a header or audience', async () => {
  assert.equal((await verifyChatRequest(undefined, { audience: '1' })).ok, false);
  assert.equal(
    (await verifyChatRequest('Bearer a.b.c', { audience: '' })).reason,
    'no audience configured',
  );
});

test('service account provider signs a JWT assertion and caches the token', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.match(url, /oauth2\.googleapis\.com\/token/);
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims] = params.get('assertion').split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
    assert.equal(
      JSON.parse(Buffer.from(claims, 'base64url')).iss,
      'bridge@project.iam.gserviceaccount.com',
    );
    return new Response(JSON.stringify({ access_token: 'tok-123', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const provider = createServiceAccountTokenProvider({
    credentials: {
      client_email: 'bridge@project.iam.gserviceaccount.com',
      private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      token_uri: 'https://oauth2.googleapis.com/token',
    },
    fetchImpl,
  });

  assert.equal(await provider.getToken(), 'tok-123');
  assert.equal(await provider.getToken(), 'tok-123');
  assert.equal(calls, 1, 'second call should hit the cache');
});

test('chat client threads messages and surfaces API errors', async () => {
  const calls = [];
  const ok = createChatClient({
    getToken: async () => 'tok',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response(JSON.stringify({ name: 'spaces/AAA/messages/1', thread: { name: 'spaces/AAA/threads/1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const res = await ok.send({ space: 'AAAA', threadKey: 'ig-1', text: 'hello' });
  assert.equal(calls[0].url, 'https://chat.googleapis.com/v1/spaces/AAAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  assert.equal(calls[0].headers.authorization, 'Bearer tok');
  assert.deepEqual(calls[0].body.thread, { threadKey: 'ig-1' });
  assert.equal(res.threadName, 'spaces/AAA/threads/1');

  const failing = createChatClient({
    getToken: async () => 'tok',
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { code: 403, message: 'Not a member of space' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
  });
  await assert.rejects(
    () => failing.send({ space: 'spaces/AAA', threadKey: 't', text: 'x' }),
    /Not a member of space/,
  );
});

test('normalizeSpace accepts bare ids and full names', () => {
  assert.equal(normalizeSpace('AAA'), 'spaces/AAA');
  assert.equal(normalizeSpace('spaces/AAA'), 'spaces/AAA');
  assert.equal(normalizeSpace(''), '');
});
