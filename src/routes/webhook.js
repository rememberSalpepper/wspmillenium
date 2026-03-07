const express = require('express');
const { log } = require('../logger');

const FALLBACK_QUOTA_MESSAGE =
  'Se agotó la cuota de la cuenta API de IA. Estamos en pruebas. Intenta nuevamente en un rato.';

const FALLBACK_TEMPORARY_MESSAGE =
  'Tu mensaje llegó, pero hubo un problema temporal al procesarlo. Intenta nuevamente en un rato.';

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function previewText(text, max = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function truncateText(text, maxChars) {
  const clean = String(text || '').trim();
  if (!clean) return 'No pude generar una respuesta.';
  return clean.length > maxChars ? clean.slice(0, maxChars) : clean;
}

function isStaleMessage(timestampSeconds, maxAgeSeconds) {
  if (!timestampSeconds) return false;

  const ts = Number(timestampSeconds);
  if (!Number.isFinite(ts) || ts <= 0) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = nowSeconds - ts;

  return ageSeconds > maxAgeSeconds;
}

function logError(event, err, extra = {}) {
  log('error', event, {
    ...extra,
    message: err?.message || null,
    status: err?.response?.status ?? err?.status ?? null,
    data: err?.response?.data || null,
  });
}

function extractEvents(payload) {
  const events = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change?.value || {};
      const metadata = value?.metadata || null;
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];

      for (const status of statuses) {
        events.push({
          kind: 'status',
          payload: {
            status,
            metadata,
          },
        });
      }

      for (const message of messages) {
        events.push({
          kind: 'message',
          payload: {
            message,
            metadata,
            contacts,
          },
        });
      }
    }
  }

  return events;
}

function createWebhookRouter({
  config,
  dedupStore,
  conversationStore,
  senderQueue,
  whatsappService,
  geminiService,
}) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    log('info', 'webhook.verify', {
      mode,
      hasToken: Boolean(token),
      match: token === config.VERIFY_TOKEN,
    });

    if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  });

  router.post('/', (req, res) => {
    res.sendStatus(200);

    try {
      const events = extractEvents(req.body);

      if (events.length === 0) {
        log('info', 'webhook.ignored_empty_payload');
        return;
      }

      for (const event of events) {
        if (event.kind === 'status') {
          const status = event.payload?.status || {};

          log('info', 'status.received', {
            id: status?.id || null,
            status: status?.status || null,
            recipientId: status?.recipient_id || null,
            timestamp: status?.timestamp || null,
          });

          continue;
        }

        if (event.kind === 'message') {
          const from = event.payload?.message?.from || 'unknown';

          void senderQueue
            .enqueue(from, async () => {
              await handleInboundTextMessage(event);
            })
            .catch((err) => {
              logError('queue.processing_error', err, { from });
            });
        }
      }
    } catch (err) {
      logError('webhook.processing_error', err);
    }
  });

  async function handleInboundTextMessage(event) {
    const message = event?.payload?.message || {};
    const metadata = event?.payload?.metadata || {};

    const msgId = message?.id || null;
    const from = message?.from || null;
    const type = message?.type || null;
    const timestamp = message?.timestamp || null;
    const text = message?.text?.body ?? '';

    if (!msgId || !from) {
      log('info', 'inbound.ignored_missing_fields', {
        msgId,
        from,
        type,
      });
      return;
    }

    if (config.IGNORE_SELF_MESSAGES) {
      const normalizedFrom = normalizeDigits(from);
      const normalizedDisplayPhone = normalizeDigits(metadata?.display_phone_number);

      if (normalizedFrom && normalizedDisplayPhone && normalizedFrom === normalizedDisplayPhone) {
        log('info', 'inbound.ignored_self_message', {
          msgId,
          from,
          displayPhoneNumber: metadata?.display_phone_number || null,
        });
        return;
      }
    }

    if (type !== 'text') {
      log('info', 'inbound.ignored_non_text', {
        msgId,
        from,
        type,
      });
      return;
    }

    const prompt = String(text || '').trim();

    if (!prompt) {
      log('info', 'inbound.ignored_empty_text', {
        msgId,
        from,
      });
      return;
    }

    if (!dedupStore.addIfNew(msgId)) {
      log('info', 'inbound.duplicate_ignored', {
        msgId,
        from,
      });
      return;
    }

    if (isStaleMessage(timestamp, config.MESSAGE_MAX_AGE_SECONDS)) {
      log('info', 'inbound.stale_ignored', {
        msgId,
        from,
        timestamp,
        maxAgeSeconds: config.MESSAGE_MAX_AGE_SECONDS,
      });
      return;
    }

    log('info', 'inbound.accepted', {
      msgId,
      from,
      type,
      timestamp,
      textLength: prompt.length,
      textPreview: previewText(prompt),
    });

    conversationStore.append(from, 'user', prompt);

    let reply;

    try {
      const contents = conversationStore.buildContents(from);
      reply = await geminiService.generateReply(contents);
    } catch (geminiErr) {
      logError('gemini.error', geminiErr, {
        msgId,
        from,
      });

      const fallbackMessage = geminiService.isGeminiQuotaError(geminiErr)
        ? FALLBACK_QUOTA_MESSAGE
        : FALLBACK_TEMPORARY_MESSAGE;

      try {
        const fallbackResponse = await whatsappService.sendText(from, fallbackMessage);

        conversationStore.append(from, 'assistant', fallbackMessage);

        log('info', 'outbound.fallback_sent', {
          msgId,
          from,
          waMessageId: fallbackResponse?.messages?.[0]?.id || null,
          fallbackType: geminiService.isGeminiQuotaError(geminiErr) ? 'quota' : 'temporary',
        });
      } catch (waErr) {
        logError('whatsapp.fallback_send_error', waErr, {
          msgId,
          from,
        });
      }

      return;
    }

    const safeReply = truncateText(reply, config.MAX_REPLY_CHARS);

    try {
      const waResponse = await whatsappService.sendText(from, safeReply);

      conversationStore.append(from, 'assistant', safeReply);

      log('info', 'outbound.reply_sent', {
        msgId,
        from,
        waMessageId: waResponse?.messages?.[0]?.id || null,
        replyLength: safeReply.length,
        replyPreview: previewText(safeReply),
      });
    } catch (waErr) {
      logError('whatsapp.reply_send_error', waErr, {
        msgId,
        from,
      });
    }
  }

  return router;
}

module.exports = { createWebhookRouter };