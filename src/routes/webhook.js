const express = require('express');
const { log } = require('../logger');
const { getAutomatedReply, limitReplyWords } = require('../botPolicy');
const { FLOW_STATES, isFormCollectionState } = require('../stores/patientFlowStore');
const { verifyWebhookSignature } = require('../utils/signature');
const { normalizeForPatterns, isResetCommand } = require('../utils/intent');
const {
  normalizeDigits,
  previewText,
  stripMarkdown,
  truncateText,
  isStaleMessage,
  getUnsupportedMessageReply,
} = require('../utils/text');
const { buildMemorySystemSuffix } = require('../botPrompt');

// First name (capitalized) from a stored full name, or '' if unavailable.
function getFirstName(fullName) {
  const first = String(fullName || '')
    .trim()
    .split(/\s+/)[0] || '';
  if (!first) return '';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// Render the returning-patient greeting, substituting {nombre} and tidying the
// spacing when the name is unknown.
function renderReturningGreeting(template, firstName) {
  return String(template || '')
    .replace('{nombre}', firstName)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// True when the last stored turn is older than the gap (or there is none),
// meaning the patient is opening a fresh session and should be welcomed back.
function isReturningGap(lastTurnAt, gapMs) {
  if (!lastTurnAt) return true;
  const parsed = Date.parse(String(lastTurnAt).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(parsed)) return true;
  return Date.now() - parsed > gapMs;
}

const FALLBACK_QUOTA_MESSAGE =
  'Se agotó la cuota de la cuenta API de IA. Estamos en pruebas. Intenta nuevamente en un rato.';

const FALLBACK_TEMPORARY_MESSAGE =
  'Tu mensaje llegó, pero hubo un problema temporal al procesarlo. Intenta nuevamente en un rato.';

function applyReplyLimits(body, config, options = {}) {
  const { skipWordLimit = false } = options;
  const stripped = stripMarkdown(body);
  const baseText = skipWordLimit
    ? String(stripped || '').trim()
    : limitReplyWords(stripped, config.BOT_MAX_WORDS);

  return truncateText(baseText, config.MAX_REPLY_CHARS);
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
  interactive = null,
  interactiveEnabled = false,
}) {
  const cleanBody = String(body || '').trim();
  if (!cleanBody) return false;

  try {
    let waResponse;

    if (interactive && interactiveEnabled) {
      try {
        if (interactive.type === 'buttons') {
          waResponse = await whatsappService.sendInteractiveButtons(from, cleanBody, interactive.buttons, {
            header: interactive.header,
            footer: interactive.footer,
          });
        } else if (interactive.type === 'list') {
          waResponse = await whatsappService.sendInteractiveList(
            from,
            cleanBody,
            interactive.button,
            interactive.rows,
            {
              header: interactive.header,
              footer: interactive.footer,
              sections: interactive.sections,
            }
          );
        } else {
          waResponse = await whatsappService.sendText(from, cleanBody);
        }
      } catch (interactiveErr) {
        // Fallback to plain text so the bot never goes silent on interactive errors.
        logError('whatsapp.interactive_send_error', interactiveErr, { msgId, from });
        waResponse = await whatsappService.sendText(from, cleanBody);
      }
    } else {
      waResponse = await whatsappService.sendText(from, cleanBody);
    }

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
  menuHandler,
  memoryService,
  emailService,
}) {
  const router = express.Router();

  let warnedSignatureDisabled = false;

  function checkSignature(req) {
    if (!config.APP_SECRET) {
      if (!warnedSignatureDisabled) {
        log('warn', 'webhook.signature_disabled', {
          message: 'APP_SECRET no configurado; verificación de firma del webhook deshabilitada.',
        });
        warnedSignatureDisabled = true;
      }
      return true;
    }

    return verifyWebhookSignature(
      req.rawBody,
      req.get('x-hub-signature-256'),
      config.APP_SECRET
    );
  }

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
    if (!checkSignature(req)) {
      log('warn', 'webhook.invalid_signature', {
        hasHeader: Boolean(req.get('x-hub-signature-256')),
      });
      return res.sendStatus(401);
    }

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
    let text = message?.text?.body ?? '';

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

    // Dedup and stale checks up-front so heavy work (audio transcription) is not repeated.
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

    // Interactive replies (buttons/lists): treat the reply id as the user's text
    // so the existing numeric/keyword flow logic keeps working unchanged.
    if (type === 'interactive') {
      const interactive = message.interactive || {};
      const reply = interactive.button_reply || interactive.list_reply || null;
      text = String(reply?.id || '').trim();

      if (!text) {
        log('info', 'inbound.ignored_empty_interactive', { msgId, from });
        return;
      }

      log('info', 'inbound.interactive_reply', { msgId, from, replyId: text });
    }

    // Voice notes / audio: transcribe with Gemini, then treat the transcription as text.
    if (type === 'audio') {
      try {
        await whatsappService.markAsReadAndTyping(msgId);
      } catch (_) {}

      if (!config.WHATSAPP_AUDIO_TRANSCRIPTION) {
        try {
          await whatsappService.sendText(from, getUnsupportedMessageReply('audio'));
        } catch (_) {}
        return;
      }

      let transcription = '';
      try {
        const mediaId = message.audio?.id;
        if (mediaId) {
          const { buffer, mimeType } = await whatsappService.downloadMedia(mediaId);
          transcription = await geminiService.transcribeAudio({
            data: buffer.toString('base64'),
            mimeType,
          });
        }
      } catch (audioErr) {
        logError('inbound.audio_transcription_error', audioErr, { msgId, from });
      }

      transcription = String(transcription || '').trim();
      if (!transcription || transcription === 'No pude generar una respuesta.') {
        try {
          await whatsappService.sendText(from, getUnsupportedMessageReply('audio'));
        } catch (_) {}
        return;
      }

      log('info', 'inbound.audio_transcribed', { msgId, from, length: transcription.length });
      text = transcription;
    }

    // Any other non-text type is unsupported.
    if (type !== 'text' && type !== 'interactive' && type !== 'audio') {
      log('info', 'inbound.ignored_non_text', {
        msgId,
        from,
        type,
      });

      try {
        await whatsappService.markAsReadAndTyping(msgId);
      } catch (_) {}

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

    // A known patient (form completed, flow done) who comes back after a period
    // of inactivity is treated as a returning session: we greet them by name and
    // show the menu, no identity confirmation. Computed before we append the
    // current turn so the inactivity gap is measured against their last visit.
    const isReturningSession =
      Boolean(patient?.form_completed) &&
      flowState === FLOW_STATES.COMPLETED &&
      !isFirstInteraction &&
      isReturningGap(database.getLastConversationTurnAt(from), config.RETURNING_SESSION_GAP_MS);

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

    if (isResetCommand(prompt)) {
      const deleted = database.resetPatient(from);
      patientFlowStore.clearState(from);
      conversationStore.clear(from);

      log('info', 'flow.reset', { from, deletedPatients: deleted });

      const resetReply = `Datos eliminados ✅\n\n${config.BOT_WELCOME_MESSAGE}`;

      try {
        await whatsappService.sendText(from, resetReply);
        log('info', 'outbound.reset_sent', { from, msgId });
      } catch (waErr) {
        log('error', 'whatsapp.reset_send_error', { from, message: waErr?.message });
      }

      return;
    }

    // Emergency / human-handoff detection runs before the returning greeting so
    // an urgent message from a known patient is never masked by the menu.
    const automatedReply = getAutomatedReply({
      prompt,
      isFirstInteraction,
      config,
    });

    if (automatedReply) {
      // If user sent data along with the first message, skip welcome and go
      // straight to form handler so the data isn't lost / double-messaged.
      if (automatedReply.kind === 'welcome' && prompt.length > 20) {
        log('info', 'flow.welcome_with_data', { from, promptLength: prompt.length });
        // fall through to form handler below
      } else {
        const safeAutomatedReply = applyReplyLimits(automatedReply.body, config, {
          skipWordLimit: true,
        });

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

        // Send emergency email notification
        if (automatedReply.kind === 'emergency' && emailService) {
          emailService.sendEmergencyNotification({ phone: from, message: prompt })
            .catch((err) => log('error', 'email.emergency_trigger_failed', { from, error: err?.message }));
        }

        return;
      }
    }

    // Returning patient: greet them by name and show the menu directly (no
    // identity confirmation). If they explicitly ask to start over, reset first.
    if (isReturningSession) {
      const wantsNew = /\bnuevo\b|\bnueva\b|\botr[oa] persona\b/.test(normalizeForPatterns(prompt));

      if (wantsNew) {
        log('info', 'flow.returning_patient_reset', { from, oldPatientId: patient.id });

        database.resetPatient(from);
        patientFlowStore.clearState(from);
        conversationStore.clear(from);

        await deliverReply({
          from,
          msgId,
          body: config.BOT_WELCOME_MESSAGE,
          conversationStore,
          whatsappService,
          successEvent: 'outbound.returning_reset_welcome_sent',
          errorEvent: 'whatsapp.returning_reset_welcome_send_error',
        });

        return;
      }

      log('info', 'flow.returning_patient_welcome', { from });

      const greeting = renderReturningGreeting(
        config.BOT_RETURNING_MESSAGE,
        getFirstName(patient?.nombre)
      );
      const menuReply = menuHandler.getMenuReply();

      await deliverReply({
        from,
        msgId,
        body: `${greeting}\n\n${menuReply.body}`,
        conversationStore,
        whatsappService,
        successEvent: 'outbound.returning_welcome_sent',
        errorEvent: 'whatsapp.returning_welcome_error',
        interactiveEnabled: config.WHATSAPP_INTERACTIVE,
        interactive: menuReply.interactive,
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

    if (flowState === FLOW_STATES.COMPLETED) {
      const menuReply = menuHandler.handleMessage({ phone: from, prompt });

      await deliverReply({
        from, msgId,
        body: menuReply.body,
        conversationStore, whatsappService,
        successEvent: menuReply.successEvent || 'outbound.completed_menu_sent',
        errorEvent: menuReply.errorEvent || 'whatsapp.completed_menu_error',
        interactiveEnabled: config.WHATSAPP_INTERACTIVE,
        interactive: menuReply.interactive || null,
      });
      return;
    }

    if (
      flowState === FLOW_STATES.CONSULTATION ||
      flowState === FLOW_STATES.AWAITING_APPOINTMENT ||
      flowState === FLOW_STATES.SELECTING_DAY ||
      flowState === FLOW_STATES.SELECTING_APPOINTMENT ||
      flowState === FLOW_STATES.CONFIRMING_APPOINTMENT ||
      flowState === FLOW_STATES.MANAGING_APPOINTMENT ||
      flowState === FLOW_STATES.RESCHEDULING_APPOINTMENT ||
      flowState === FLOW_STATES.COMPLETED
    ) {
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
        interactiveEnabled: config.WHATSAPP_INTERACTIVE,
        interactive: consultationReply?.interactive || null,
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

      // Long-term memory (Fase 5): inject the patient summary into the system
      // prompt so the bot keeps context across sessions.
      const memorySummary = memoryService?.getSummary(from) || '';
      const memorySuffix = memorySummary ? buildMemorySystemSuffix(memorySummary) : '';
      const systemInstruction = memorySuffix
        ? `${config.BOT_SYSTEM_INSTRUCTION}\n\n${memorySuffix}`
        : undefined;

      log('info', 'gemini.context_summary', {
        from,
        turns: contents.length,
        hasMemory: Boolean(memorySummary),
        lastTurns: contents.slice(-4).map((item) => ({
          role: item.role,
          textPreview: previewText(item?.parts?.[0]?.text || '', 80),
        })),
      });

      reply = await geminiService.generateReply(contents, systemInstruction);
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

    // Refresh the long-term memory summary in the background once enough new
    // turns have accumulated (Fase 5).
    if (memoryService) {
      memoryService.noteTurn(from, conversationStore);
    }
  }

  return router;
}

module.exports = { createWebhookRouter };
