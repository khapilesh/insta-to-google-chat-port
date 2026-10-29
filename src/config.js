import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Minimal .env loader so the project stays dependency-free.
 * Values already present in process.env win.
 */
export function loadDotEnv(file = '.env') {
  if (!existsSync(file)) return;
  const raw = readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 8080),

    instagram: {
      appSecret: env.IG_APP_SECRET || '',
      verifyToken: env.IG_VERIFY_TOKEN || '',
      accessToken: env.IG_ACCESS_TOKEN || '',
      igUserId: env.IG_USER_ID || '',
      graphBase: trimTrailingSlash(env.IG_GRAPH_BASE || 'https://graph.facebook.com/v23.0'),
    },

    chat: {
      space: env.GOOGLE_CHAT_SPACE || '',
      projectNumber: env.GOOGLE_CHAT_PROJECT_NUMBER || '',
      serviceAccountFile: env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
      serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
      // Escape hatches for tests / local dry runs.
      apiBase: trimTrailingSlash(env.CHAT_API_BASE || 'https://chat.googleapis.com'),
      accessTokenOverride: env.GOOGLE_ACCESS_TOKEN || '',
      skipJwtVerification: bool(env.SKIP_CHAT_JWT_VERIFICATION, false),
    },

    storePath: env.STORE_PATH || './data/store.json',
    // Meta's standard messaging window, in hours, measured from the last
    // inbound Instagram message.
    windowHours: Number(env.IG_WINDOW_HOURS || 24),
    allowHumanAgentTag: bool(env.ALLOW_HUMAN_AGENT_TAG, false),
    prefixChatSender: bool(env.PREFIX_CHAT_SENDER, true),
  };
}
