import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Meta's X-Hub-Signature-256 header against the raw request body.
 * Must run on the raw bytes, before any JSON parsing.
 */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return false;
  if (!header || typeof header !== 'string') return false;
  const [scheme, provided] = header.split('=');
  if (scheme !== 'sha256' || !provided) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function describeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  return attachments
    .map((att) => {
      const kind = att.type || 'attachment';
      const url = att.payload?.url;
      return url ? `[${kind}: ${url}]` : `[${kind}]`;
    })
    .join(' ');
}

/**
 * Flatten a Meta webhook body into the handful of events we care about.
 * Handles both `object: "instagram"` and `object: "page"` payloads.
 */
export function parseWebhook(payload) {
  const events = [];
  if (!payload || !Array.isArray(payload.entry)) return events;

  for (const entry of payload.entry) {
    const messaging = Array.isArray(entry.messaging)
      ? entry.messaging
      : Array.isArray(entry.standby)
        ? []
        : [];

    for (const event of messaging) {
      const message = event.message;
      if (!message) {
        events.push({
          kind: event.read ? 'read' : event.reaction ? 'reaction' : 'other',
          igsid: event.sender?.id,
        });
        continue;
      }

      const text = message.text || '';
      const attachmentText = describeAttachments(message.attachments);
      events.push({
        kind: 'message',
        igsid: event.sender?.id,
        recipientId: event.recipient?.id,
        mid: message.mid,
        text: [text, attachmentText].filter(Boolean).join(' ').trim(),
        isEcho: Boolean(message.is_echo),
        isDeleted: Boolean(message.is_deleted),
        timestamp: Number(event.timestamp || entry.time || Date.now()),
        attachments: message.attachments || [],
      });
    }
  }

  return events;
}

/**
 * Instagram Send API client.
 * @see https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/messaging-api
 */
export function createInstagramClient({
  graphBase,
  igUserId,
  accessToken,
  fetchImpl = fetch,
  log = console,
}) {
  return {
    configured: Boolean(graphBase && igUserId && accessToken),

    async sendText({ igsid, text, humanAgent = false }) {
      if (!igsid) throw new Error('sendText: missing igsid');
      if (!this.configured) {
        throw new Error(
          'Instagram is not configured (IG_GRAPH_BASE / IG_USER_ID / IG_ACCESS_TOKEN)',
        );
      }

      const body = {
        recipient: { id: igsid },
        message: { text },
      };

      // Outside the standard 24h window the only legal move is the HUMAN_AGENT
      // message tag, which Meta audits and allows for up to 7 days.
      if (humanAgent) {
        body.messaging_type = 'MESSAGE_TAG';
        body.tag = 'HUMAN_AGENT';
      } else {
        body.messaging_type = 'RESPONSE';
      }

      const url = `${graphBase}/${igUserId}/messages?access_token=${encodeURIComponent(accessToken)}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      const raw = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }

      if (!res.ok) {
        const detail = parsed?.error?.message || raw;
        throw new Error(`Instagram Send API ${res.status}: ${detail}`);
      }

      log.log(`[instagram] sent to ${igsid} (${body.messaging_type})`);
      return parsed;
    },
  };
}
