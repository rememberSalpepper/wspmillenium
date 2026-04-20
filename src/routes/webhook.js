const express = require('express');
const { log } = require('../logger');
const { getAutomatedReply, limitReplyWords } = require('../botPolicy');
const { FLOW_STATES, isFormCollectionState } = require('../stores/patientFlowStore');

const RESTART_PATTERNS = [
  /\bformulario\b/,
  /\breinicia/,
  /\brenuev/,
  /\bempezar de nuevo\b/,
  /\bempezar desde cero\b/,
  /\bde nuevo\b/,
  /\bdesde cero\b/,
  /\bnuevo paciente\b/,
  /\bnueva consulta\b/,
  /\botra consulta\b/,
  /\breset\b/,
];

const RESET_COMMAND = /^\s*(?:borrar datos|borrar|reset|limpiar datos|limpiar)\s*$/;

const CONFIRM_IDENTITY_MESSAGE = [
  'Tenemos datos registrados a este número.',
  '',
  'Si eres la misma persona, responde "sí" para continuar.',
  'Si eres otra persona, responde "nuevo" para iniciar desde cero.',
].join('\n');

function normalizeForPatterns(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function wantsRestart(prompt) {
  const normalized = normalizeForPatterns(prompt);
  return RESTART_PATTERNS.some((p) => p.test(normalized));
}

function isResetCommand(prompt) {
  const normalized = normalizeForPatterns(prompt);
  return RESET_COMMAND.test(normalized);
}

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

function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`(.+?)`/g, '$1');
}

function truncateText(text, maxChars) {
  const clean = String(text || '').trim();
  if (!clean) return 'No pude generar una respuesta.';
  return clean.length > maxChars ? clean.slice(0, maxChars) : clean;
}

function applyReplyLimits(body, config, options = {}) {
  const { skipWordLimit = false } = options;
  const stripped = stripMarkdown(body);
  const baseText = skipWordLimit
    ? String(stripped || '').trim()
    : limitReplyWords(stripped, config.BOT_MAX_WORDS);

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
  emailService,
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

    const isNewSession = conversationStore.turnCount(from) <= 1;
    const hasStalePatient = patient?.form_completed && isNewSession && !isFirstInteraction;

    if (hasStalePatient && flowState === FLOW_STATES.COMPLETED) {
      const wantsNew = /\bnuevo\b|\bnueva\b|\botr[oa]\b/.test(normalizeForPatterns(prompt));

      if (wantsNew || wantsRestart(prompt)) {
        log('info', 'flow.stale_patient_reset', { from, oldPatientId: patient.id });

        database.resetPatient(from);
        patientFlowStore.clearState(from);
        conversationStore.clear(from);

        await deliverReply({
          from,
          msgId,
          body: config.BOT_WELCOME_MESSAGE,
          conversationStore,
          whatsappService,
          successEvent: 'outbound.stale_reset_welcome_sent',
          errorEvent: 'whatsapp.stale_reset_welcome_send_error',
        });

        return;
      }

      patientFlowStore.setState(from, FLOW_STATES.CONFIRMING_IDENTITY);

      await deliverReply({
        from,
        msgId,
        body: CONFIRM_IDENTITY_MESSAGE,
        conversationStore,
        whatsappService,
        successEvent: 'outbound.confirm_identity_sent',
        errorEvent: 'whatsapp.confirm_identity_send_error',
      });

      return;
    }

    // Handle response to identity confirmation
    if (flowState === FLOW_STATES.CONFIRMING_IDENTITY) {
      const normalized = normalizeForPatterns(prompt);
      const isSamePatient = /\bsi\b|\bsí\b|\bsi soy\b|\bsoy yo\b|\bmism[oa]\b/.test(normalized);
      const isNewPatient = /\bnuevo\b|\bnueva\b|\botr[oa]\b/.test(normalized);

      if (isSamePatient) {
        log('info', 'flow.identity_confirmed_same', { from });
        conversationStore.clear(from);
        patientFlowStore.setState(from, FLOW_STATES.CONSULTATION);

        await deliverReply({
          from,
          msgId,
          body: 'Bienvenido(a) de vuelta 👋 Cuénteme brevemente sus síntomas y el motivo de su consulta.',
          conversationStore,
          whatsappService,
          successEvent: 'outbound.returning_patient_welcome_sent',
          errorEvent: 'whatsapp.returning_patient_welcome_error',
        });
        return;
      }

      if (isNewPatient || wantsRestart(prompt)) {
        log('info', 'flow.identity_confirmed_new', { from });
        database.resetPatient(from);
        patientFlowStore.clearState(from);
        conversationStore.clear(from);

        await deliverReply({
          from,
          msgId,
          body: config.BOT_WELCOME_MESSAGE,
          conversationStore,
          whatsappService,
          successEvent: 'outbound.new_patient_reset_sent',
          errorEvent: 'whatsapp.new_patient_reset_error',
        });
        return;
      }

      // Unrecognized response, re-ask
      await deliverReply({
        from,
        msgId,
        body: 'Responda "sí" si es la misma persona, o "nuevo" para iniciar desde cero.',
        conversationStore,
        whatsappService,
        successEvent: 'outbound.confirm_identity_resent',
        errorEvent: 'whatsapp.confirm_identity_resend_error',
      });
      return;
    }

    const automatedReply = getAutomatedReply({
      prompt,
      isFirstInteraction,
      config,
    });

    if (automatedReply) {
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

      // For welcome messages: if the user sent substantial data along with
      // the greeting, continue to the form handler instead of discarding it.
      if (automatedReply.kind === 'welcome' && prompt.length > 20) {
        log('info', 'flow.welcome_with_data', { from, promptLength: prompt.length });
        // fall through to form handler below
      } else {
        return;
      }
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
      const trimmed = prompt.trim();

      // Explicit reset / borrar datos → full delete
      if (isResetCommand(prompt)) {
        database.resetPatient(from);
        patientFlowStore.clearState(from);
        conversationStore.clear(from);
        log('info', 'flow.completed_reset', { from });

        await deliverReply({
          from, msgId,
          body: `Datos eliminados ✅\n\n${config.BOT_WELCOME_MESSAGE}`,
          conversationStore, whatsappService,
          successEvent: 'outbound.completed_reset_sent',
          errorEvent: 'whatsapp.completed_reset_error',
        });
        return;
      }

      // "nueva consulta" / "otra consulta" → new consultation, keep patient data
      if (wantsRestart(prompt)) {
        log('info', 'flow.completed_new_consultation', { from });
        conversationStore.clear(from);
        patientFlowStore.setState(from, FLOW_STATES.CONSULTATION);

        await deliverReply({
          from, msgId,
          body: 'Cuénteme brevemente sus síntomas y el motivo de su nueva consulta 🩺',
          conversationStore, whatsappService,
          successEvent: 'outbound.new_consultation_sent',
          errorEvent: 'whatsapp.new_consultation_error',
        });
        return;
      }

      // Menu option "1" → new consultation
      if (trimmed === '1') {
        log('info', 'flow.completed_menu_new_consultation', { from });
        conversationStore.clear(from);
        patientFlowStore.setState(from, FLOW_STATES.CONSULTATION);

        await deliverReply({
          from, msgId,
          body: 'Cuénteme brevemente sus síntomas y el motivo de su nueva consulta 🩺',
          conversationStore, whatsappService,
          successEvent: 'outbound.menu_new_consultation_sent',
          errorEvent: 'whatsapp.menu_new_consultation_error',
        });
        return;
      }

      // Menu option "2" → appointment status
      if (trimmed === '2') {
        const lastConsultation = database.getLastConsultation(from);
        const statusMap = {
          pending: 'pendiente de confirmación',
          confirmed: 'confirmada, nos pondremos en contacto pronto',
          declined: 'no agendada',
        };
        const statusText = statusMap[lastConsultation?.appointment_status] || 'sin información';

        await deliverReply({
          from, msgId,
          body: `Estado de su última cita: ${statusText}.`,
          conversationStore, whatsappService,
          successEvent: 'outbound.appointment_status_sent',
          errorEvent: 'whatsapp.appointment_status_error',
        });
        return;
      }

      // Menu option "3" → cancel or reschedule appointment
      if (trimmed === '3') {
        const scheduled = database.getScheduledAppointmentsByPhone(from);

        if (!scheduled || scheduled.length === 0) {
          await deliverReply({
            from, msgId,
            body: 'No tiene citas agendadas actualmente.',
            conversationStore, whatsappService,
            successEvent: 'outbound.no_appointments_sent',
            errorEvent: 'whatsapp.no_appointments_error',
          });
          return;
        }

        const apt = scheduled[0];
        const [, month, day] = apt.appointment_date.split('-');
        const monthNames = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
          'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
        const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        const dateObj = new Date(apt.appointment_date + 'T00:00:00');
        const dayName = dayNames[dateObj.getDay()];
        const monthNum = parseInt(month, 10);
        const dayNum = parseInt(day, 10);

        const msg = [
          'Su próxima cita:',
          `📅 Fecha: ${dayName} ${dayNum} de ${monthNames[monthNum]}`,
          `🕐 Hora: ${apt.appointment_time}`,
          '',
          '¿Qué desea hacer?',
          '1) Cancelar cita',
          '2) Reagendar cita',
          '3) Volver',
          '',
          'Responda con el número de la opción.',
        ].join('\n');

        patientFlowStore.setStateWithData(from, FLOW_STATES.MANAGING_APPOINTMENT, { appointment: apt });

        await deliverReply({
          from, msgId,
          body: msg,
          conversationStore, whatsappService,
          successEvent: 'outbound.manage_appointment_sent',
          errorEvent: 'whatsapp.manage_appointment_error',
        });
        return;
      }

      // Any other message → show menu
      const menuMessage = [
        'En qué puedo ayudarle?',
        '',
        '1) Nueva consulta médica',
        '2) Consultar estado de mi cita',
        '3) Cancelar o reagendar mi cita',
        '',
        'Escriba el número de la opción.',
      ].join('\n');

      await deliverReply({
        from, msgId,
        body: menuMessage,
        conversationStore, whatsappService,
        successEvent: 'outbound.completed_menu_sent',
        errorEvent: 'whatsapp.completed_menu_error',
      });
      return;
    }

    if (
      flowState === FLOW_STATES.CONSULTATION ||
      flowState === FLOW_STATES.AWAITING_APPOINTMENT ||
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
