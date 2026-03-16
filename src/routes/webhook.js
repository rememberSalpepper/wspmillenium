const express = require('express');
const { log } = require('../logger');
const { getAutomatedReply, limitReplyWords } = require('../botPolicy');
const { FLOW_STATES, isFormCollectionState } = require('../stores/patientFlowStore');

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

function getUnsupportedMessageReply(type) {
  const base =
    'Por ahora solo puedo procesar mensajes de texto. Escríbeme tu consulta en texto.';

  switch (type) {
    case 'audio':
      return 'Por ahora no puedo escuchar audios. Escríbeme tu mensaje en texto.';
    case 'image':
      return 'Por ahora no puedo analizar imágenes. Escríbeme tu consulta en texto.';
    case 'sticker':
      return 'Por ahora no puedo interpretar stickers. Escríbeme tu mensaje en texto.';
    case 'video':
      return 'Por ahora no puedo analizar videos. Escríbeme tu consulta en texto.';
    case 'document':
      return 'Por ahora no puedo leer documentos automáticamente. Escríbeme tu consulta en texto.';
    case 'location':
      return 'Por ahora no puedo procesar ubicaciones automáticamente. Escríbeme la información en texto.';
    case 'contacts':
      return 'Por ahora no puedo procesar contactos compartidos automáticamente. Escríbeme tu consulta en texto.';
    default:
      return base;
  }
}

function truncateText(text, maxChars) {
  const clean = String(text || '').trim();
  if (!clean) return 'No pude generar una respuesta.';
  return clean.length > maxChars ? clean.slice(0, maxChars) : clean;
}

function applyReplyLimits(body, config, options = {}) {
  const { skipWordLimit = false } = options;
  const baseText = skipWordLimit
    ? String(body || '').trim()
    : limitReplyWords(body, config.BOT_MAX_WORDS);

  return truncateText(baseText, config.MAX_REPLY_CHARS);
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

async function deliverReply({
  from,
  msgId,
  body,
  conversationStore,
  whatsappService,
  successEvent,
  errorEvent,
  logData = {},
}) {
  const cleanBody = String(body || '').trim();
  if (!cleanBody) return false;

  try {
    const waResponse = await whatsappService.sendText(from, cleanBody);

    conversationStore.append(from, 'assistant', cleanBody);

    log('info', successEvent, {
      msgId,
      from,
      waMessageId: waResponse?.messages?.[0]?.id || null,
      replyLength: cleanBody.length,
      replyPreview: previewText(cleanBody),
      ...logData,
    });

    return true;
  } catch (waErr) {
    logError(errorEvent, waErr, {
      msgId,
      from,
      ...logData,
    });

    return false;
  }
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
  inboundBufferStore,
  whatsappService,
  geminiService,
  database,
  patientFlowStore,
  formHandler,
  consultationHandler,
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
          void stageInboundMessage(event).catch((err) => {
            const from = event.payload?.message?.from || 'unknown';
            logError('inbound.stage_error', err, { from });
          });
        }
      }
    } catch (err) {
      logError('webhook.processing_error', err);
    }
  });

  async function stageInboundMessage(event) {
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

      const unsupportedReply = getUnsupportedMessageReply(type);
      try {
        await whatsappService.sendText(from, unsupportedReply);

        log('info', 'outbound.unsupported_type_sent', {
          msgId,
          from,
          type,
        });
      } catch (waErr) {
        logError('whatsapp.unsupported_type_send_error', waErr, {
          msgId,
          from,
          type,
        });
      }

      
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

    log('info', 'inbound.buffered', {
      msgId,
      from,
      type,
      timestamp,
      textLength: prompt.length,
      textPreview: previewText(prompt),
    });

    inboundBufferStore.push(
      from,
      {
        msgId,
        from,
        text: prompt,
        timestamp,
        metadata,
      },
      async (batch) => {
        void senderQueue
          .enqueue(from, async () => {
            await handleInboundBatch(batch);
          })
          .catch((err) => {
            logError('queue.processing_error', err, { from });
          });
      }
    );
  }

  async function handleInboundBatch(batch) {
    const from = batch?.senderId || null;
    const msgId = batch?.lastMsgId || null;
    const prompt = String(batch?.combinedText || '').trim();

    if (!from || !msgId || !prompt) {
      log('info', 'batch.ignored_invalid', {
        from,
        msgId,
        hasPrompt: Boolean(prompt),
      });
      return;
    }

    const patient = database.getPatientByPhone(from);
    const flowState = patientFlowStore.getState(from);
    const isFirstInteraction = !conversationStore.hasTurns(from) && !patient;

    log('info', 'batch.accepted', {
      from,
      msgId,
      count: batch.count,
      combinedLength: prompt.length,
      combinedPreview: previewText(prompt, 220),
      batchMsgIds: Array.isArray(batch.items) ? batch.items.map((item) => item.msgId) : [],
    });

    try {
      await whatsappService.markAsReadAndTyping(msgId);

      log('info', 'inbound.read_typing_sent', {
        msgId,
        from,
        batchCount: batch.count,
      });
    } catch (waTypingErr) {
      logError('whatsapp.read_typing_error', waTypingErr, {
        msgId,
        from,
        batchCount: batch.count,
      });
    }

    conversationStore.append(from, 'user', prompt);

    const automatedReply = getAutomatedReply({
      prompt,
      isFirstInteraction,
      config,
    });

    if (automatedReply) {
      const safeAutomatedReply = applyReplyLimits(automatedReply.body, config);

      await deliverReply({
        from,
        msgId,
        body: safeAutomatedReply,
        conversationStore,
        whatsappService,
        successEvent: 'outbound.policy_reply_sent',
        errorEvent: 'whatsapp.policy_reply_send_error',
        logData: {
          policy: automatedReply.kind,
          batchCount: batch.count,
        },
      });

      return;
    }

    if (isFormCollectionState(flowState)) {
      let formReply;

      try {
        formReply = await formHandler.handleMessage({
          phone: from,
          prompt,
          state: flowState,
          patient,
        });
      } catch (formErr) {
        logError('form.handler_error', formErr, {
          msgId,
          from,
          state: flowState,
        });

        const isQuotaError = geminiService.isGeminiQuotaError(formErr);
        const fallbackMessage = isQuotaError
          ? FALLBACK_QUOTA_MESSAGE
          : FALLBACK_TEMPORARY_MESSAGE;

        await deliverReply({
          from,
          msgId,
          body: fallbackMessage,
          conversationStore,
          whatsappService,
          successEvent: 'outbound.form_fallback_sent',
          errorEvent: 'whatsapp.form_fallback_send_error',
          logData: {
            fallbackType: isQuotaError ? 'quota' : 'temporary',
            state: flowState,
          },
        });

        return;
      }

      const safeFormReply = applyReplyLimits(formReply?.body, config, {
        skipWordLimit: Boolean(formReply?.skipWordLimit),
      });

      await deliverReply({
        from,
        msgId,
        body: safeFormReply,
        conversationStore,
        whatsappService,
        successEvent: 'outbound.form_reply_sent',
        errorEvent: 'whatsapp.form_reply_send_error',
        logData: {
          batchCount: batch.count,
          state: flowState,
        },
      });

      return;
    }

    if (flowState === FLOW_STATES.CONSULTATION) {
      let consultationReply;

      try {
        consultationReply = await consultationHandler.handleMessage({
          phone: from,
          prompt,
          patient,
        });
      } catch (consultationErr) {
        logError('consultation.handler_error', consultationErr, {
          msgId,
          from,
          state: flowState,
        });

        const isQuotaError = geminiService.isGeminiQuotaError(consultationErr);
        const fallbackMessage = isQuotaError
          ? FALLBACK_QUOTA_MESSAGE
          : FALLBACK_TEMPORARY_MESSAGE;

        await deliverReply({
          from,
          msgId,
          body: fallbackMessage,
          conversationStore,
          whatsappService,
          successEvent: 'outbound.consultation_fallback_sent',
          errorEvent: 'whatsapp.consultation_fallback_send_error',
          logData: {
            fallbackType: isQuotaError ? 'quota' : 'temporary',
            state: flowState,
          },
        });

        return;
      }

      const safeConsultationReply = applyReplyLimits(consultationReply?.body, config, {
        skipWordLimit: Boolean(consultationReply?.skipWordLimit),
      });

      await deliverReply({
        from,
        msgId,
        body: safeConsultationReply,
        conversationStore,
        whatsappService,
        successEvent: 'outbound.consultation_reply_sent',
        errorEvent: 'whatsapp.consultation_reply_send_error',
        logData: {
          batchCount: batch.count,
          consultationId: consultationReply?.consultationId || null,
        },
      });

      return;
    }

    let reply;

    try {
      const contents = conversationStore.buildContents(from);

      log('info', 'gemini.context_summary', {
        from,
        turns: contents.length,
        lastTurns: contents.slice(-4).map((item) => ({
          role: item.role,
          textPreview: previewText(item?.parts?.[0]?.text || '', 80),
        })),
      });

      reply = await geminiService.generateReply(contents);
    } catch (geminiErr) {
      logError('gemini.error', geminiErr, {
        msgId,
        from,
        batchCount: batch.count,
      });

      const isQuotaError = geminiService.isGeminiQuotaError(geminiErr);
      const fallbackMessage = isQuotaError
        ? FALLBACK_QUOTA_MESSAGE
        : FALLBACK_TEMPORARY_MESSAGE;

      await deliverReply({
        from,
        msgId,
        body: fallbackMessage,
        conversationStore,
        whatsappService,
        successEvent: 'outbound.fallback_sent',
        errorEvent: 'whatsapp.fallback_send_error',
        logData: {
          fallbackType: isQuotaError ? 'quota' : 'temporary',
        },
      });

      return;
    }

    const safeReply = applyReplyLimits(reply, config);

    await deliverReply({
      from,
      msgId,
      body: safeReply,
      conversationStore,
      whatsappService,
      successEvent: 'outbound.reply_sent',
      errorEvent: 'whatsapp.reply_send_error',
      logData: {
        batchCount: batch.count,
      },
    });
  }

  return router;
}

module.exports = { createWebhookRouter };
