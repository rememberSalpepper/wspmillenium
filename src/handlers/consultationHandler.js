const {
  buildConsultationExtractionInstruction,
  buildConsultationExtractionPrompt,
  buildConsultationOrientationInstruction,
  buildConsultationOrientationPrompt,
} = require('../botPrompt');
const { FLOW_STATES } = require('../stores/patientFlowStore');
const { log } = require('../logger');

const CONSULTATION_PROMPT =
  '¿Cómo se siente? Cuénteme brevemente sus síntomas y el motivo de su consulta 🩺';

const APPOINTMENT_CONFIRM_MESSAGE =
  'Perfecto, su hora con el doctor quedó pendiente de confirmación. Nos pondremos en contacto para confirmar fecha y horario 📅';

const APPOINTMENT_DECLINE_MESSAGE =
  'Entendido 👍 Si más adelante desea agendar una hora con el doctor, no dude en escribirnos. ¡Que se mejore! 🙏';

const GREETING_PATTERNS = [
  'hola',
  'buenas',
  'buenos dias',
  'buenas tardes',
  'buenas noches',
  'gracias',
  'ok',
  'oki',
];

const AFFIRMATIVE_PATTERNS = [
  /\bsi\b/,
  /\bsí\b/,
  /\bcorrecto\b/,
  /\bquiero\b/,
  /\bdale\b/,
  /\bok\b/,
  /\bya\b/,
  /\bbueno\b/,
  /\bpor favor\b/,
  /\bporfavor\b/,
  /\bagendar\b/,
  /\bhora\b/,
  /\bde acuerdo\b/,
];

const NEGATIVE_PATTERNS = [
  /\bno\b/,
  /\bnada\b/,
  /\bno gracias\b/,
  /\bno quiero\b/,
  /\bno por ahora\b/,
  /\bdespues\b/,
  /\bdespués\b/,
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonResponse(text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return null;

  try {
    return JSON.parse(cleanText);
  } catch (err) {
    const match = cleanText.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch (nestedErr) {
      return null;
    }
  }
}

function clipText(value, maxLength) {
  const cleanValue = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleanValue) return '';
  return cleanValue.length > maxLength ? `${cleanValue.slice(0, maxLength - 3).trim()}...` : cleanValue;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function looksLikeGreeting(text) {
  const normalized = normalizeText(text);
  return GREETING_PATTERNS.includes(normalized);
}

function isAffirmative(text) {
  const normalized = normalizeText(text);
  return AFFIRMATIVE_PATTERNS.some((p) => p.test(normalized));
}

function isNegative(text) {
  const normalized = normalizeText(text);
  return NEGATIVE_PATTERNS.some((p) => p.test(normalized));
}

function formatDiagnostics(rawResponse) {
  const parsed = parseJsonResponse(rawResponse);

  if (Array.isArray(parsed) && parsed.length > 0) {
    const items = parsed.filter((d) => d?.diagnostico);
    if (items.length > 0) {
      const list = items
        .map((d, i) => {
          const name = cleanText(d.diagnostico);
          const cause = cleanText(d.causa || d.explicacion || '');
          return cause ? `${i + 1}) ${name} (${cause})` : `${i + 1}) ${name}`;
        })
        .join('\n');
      return `🩺 Podria tratarse de:\n\n${list}`;
    }
  }

  const fallback = cleanText(rawResponse);
  return fallback ? `🩺 Orientacion: ${fallback}` : 'Pendiente de evaluacion medica.';
}

function buildConsultationSummary({ patient, diagnosticsText }) {
  return [
    diagnosticsText,
    '',
    '⚠️ Un medico debe evaluar su caso para confirmar.',
    '',
    '📅 ¿Desea agendar una hora con el doctor?',
  ].join('\n');
}

const MONTH_NAMES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Full, human-readable day label, e.g. "Miercoles 18 junio 2026".
// Accepts any object with `date` (YYYY-MM-DD) and `dayLabel`.
function formatSlotDateFull(slot) {
  const [year, month, day] = slot.date.split('-');
  return `${slot.dayLabel} ${parseInt(day, 10)} ${MONTH_NAMES[parseInt(month, 10)]} ${year}`;
}

// Short, list-row-friendly day label, e.g. "Miercoles 18 septiembre".
// Kept under WhatsApp's 24-char row-title limit even for the longest month.
function formatDayShort(day) {
  const [, month, dayNum] = day.date.split('-');
  return `${day.dayLabel} ${parseInt(dayNum, 10)} ${MONTH_NAMES[parseInt(month, 10)]}`;
}

// --- Day selection (step 1) ---

// Reply that asks the patient which day they want, as an interactive dropdown list.
function daysReply(days, { footer } = {}) {
  const lines = ['📅 ¿Qué día prefiere su atención?', ''];
  days.forEach((day, i) => {
    lines.push(`${i + 1}) ${formatDayShort(day)}`);
  });
  lines.push('');
  lines.push('Toque "Ver días" y elija una opción 👇');

  const rows = days.map((day, i) => ({
    id: String(i + 1),
    title: formatDayShort(day),
    description: day.slotCount === 1 ? '1 horario disponible' : `${day.slotCount} horarios disponibles`,
  }));

  return {
    body: lines.join('\n'),
    skipWordLimit: true,
    interactive: {
      type: 'list',
      header: '🗓️ Agendar hora médica',
      footer: footer || undefined,
      button: 'Ver días',
      rows,
    },
  };
}

// --- Time selection (step 2) ---

// Reply that shows the available times for one day as an interactive dropdown list.
// Caps at 9 times so a "choose another day" row fits within WhatsApp's 10-row limit.
function timesReply(times, dayLabelFull, { footer } = {}) {
  const shown = times.slice(0, 9);

  const lines = [`📅 ${dayLabelFull}`, '', 'Horarios disponibles:', ''];
  shown.forEach((slot, i) => {
    lines.push(`${i + 1}) 🕐 ${slot.time}`);
  });
  lines.push('');
  lines.push('Toque "Ver horarios" y elija una opción 👇');

  const rows = shown.map((slot, i) => ({
    id: String(i + 1),
    title: `🕐 ${slot.time} hrs`,
  }));
  rows.push({ id: 'otro_dia', title: '⬅️ Elegir otro día' });

  return {
    body: lines.join('\n'),
    skipWordLimit: true,
    interactive: {
      type: 'list',
      header: '🕐 Elegir horario',
      footer: footer || undefined,
      button: 'Ver horarios',
      rows,
    },
  };
}

function getTodayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

function createConsultationHandler({ database, patientFlowStore, geminiService, emailService, config }) {
  async function extractConsultationDetails(prompt) {
    const rawResponse = await geminiService.generateText({
      prompt: buildConsultationExtractionPrompt(prompt),
      systemInstruction: buildConsultationExtractionInstruction(),
    });

    const parsed = parseJsonResponse(rawResponse);

    if (!parsed || !parsed.valid) {
      log('warn', 'consultation.extraction_failed', {
        promptPreview: String(prompt || '').slice(0, 200),
        rawResponsePreview: String(rawResponse || '').slice(0, 300),
        parsed,
      });
    } else {
      log('info', 'consultation.extraction_ok', {
        sintomasCount: Array.isArray(parsed.sintomas) ? parsed.sintomas.length : 0,
        hasMotivoConsulta: Boolean(parsed.motivoConsulta),
      });
    }

    return parsed;
  }

  async function buildDiagnostics({ symptoms, reason }) {
    const rawResponse = await geminiService.generateText({
      prompt: buildConsultationOrientationPrompt({ symptoms, reason }),
      systemInstruction: buildConsultationOrientationInstruction(),
    });

    return {
      formatted: formatDiagnostics(rawResponse),
      raw: cleanText(rawResponse),
    };
  }

  const footer = (config && config.CLINIC_NAME) || undefined;

  const AGENDAR_BUTTONS = {
    type: 'buttons',
    header: '📅 Agendar hora médica',
    footer,
    buttons: [
      { id: 'si', title: 'Sí, agendar' },
      { id: 'no', title: 'No por ahora' },
    ],
  };

  const CONFIRM_SLOT_BUTTONS = {
    type: 'buttons',
    header: '✅ Confirmar hora',
    footer,
    buttons: [
      { id: 'si', title: 'Sí, confirmar' },
      { id: 'no', title: 'Ver otras horas' },
    ],
  };

  const MANAGE_APPOINTMENT_BUTTONS = {
    type: 'buttons',
    header: '🗂️ Gestionar mi cita',
    footer,
    buttons: [
      { id: '1', title: 'Cancelar cita' },
      { id: '2', title: 'Reagendar' },
      { id: '3', title: 'Volver' },
    ],
  };

  function slotDuration() {
    return (config && config.APPOINTMENT_SLOT_DURATION) || 30;
  }

  // Step 1: show the available days as a dropdown list.
  // `mode` is 'new' (default) or 'reschedule' (carries appointmentId).
  function showDaySelection(phone, extra = {}) {
    const lookahead = (config && config.APPOINTMENT_LOOKAHEAD_DAYS) || 14;
    const days = database.getAvailableDays(getTodayStr(), 9, slotDuration(), lookahead);

    if (!days || days.length === 0) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      return {
        body: 'No hay días disponibles en las próximas semanas. Nos pondremos en contacto.',
      };
    }

    patientFlowStore.setStateWithData(phone, FLOW_STATES.SELECTING_DAY, { days, ...extra });
    return daysReply(days, { footer });
  }

  // Step 2: show the available times for a chosen day as a dropdown list.
  function showTimeSelection(phone, selectedDate, dayLabelFull, stateData) {
    const times = database.getSlotsForDate(selectedDate, slotDuration());

    if (!times || times.length === 0) {
      // The day filled up while the patient was choosing; go back to day list.
      return showDaySelection(phone, {
        mode: stateData?.mode,
        appointmentId: stateData?.appointmentId,
      });
    }

    patientFlowStore.setStateWithData(phone, FLOW_STATES.SELECTING_APPOINTMENT, {
      ...stateData,
      slots: times,
      selectedDate,
      dayLabelFull,
    });
    return timesReply(times, dayLabelFull, { footer });
  }

  function handleAppointmentResponse({ phone, prompt }) {
    if (isAffirmative(prompt)) {
      return showDaySelection(phone, { mode: 'new' });
    }

    if (isNegative(prompt)) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      database.updateAppointmentStatus(phone, 'declined');
      return { body: APPOINTMENT_DECLINE_MESSAGE };
    }

    return {
      body: 'Responda "sí" si desea agendar una hora con el doctor, o "no" si prefiere no agendar por ahora.',
      interactive: AGENDAR_BUTTONS,
    };
  }

  function handleSelectingDay({ phone, prompt }) {
    const stateData = patientFlowStore.getStateData(phone) || {};
    const days = stateData.days || [];

    if (days.length === 0) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      return { body: 'Ocurrió un error. Nos pondremos en contacto para agendar su hora.' };
    }

    const trimmed = String(prompt || '').trim();
    const num = parseInt(trimmed, 10);

    if (Number.isNaN(num) || num < 1 || num > days.length) {
      return daysReply(days, { footer });
    }

    const selectedDay = days[num - 1];
    return showTimeSelection(phone, selectedDay.date, formatSlotDateFull(selectedDay), stateData);
  }

  function handleSelectingAppointment({ phone, prompt }) {
    const stateData = patientFlowStore.getStateData(phone) || {};
    const slots = stateData.slots || [];
    const trimmed = String(prompt || '').trim();
    const normalized = normalizeText(trimmed);

    // Allow the patient to go back to the day list.
    if (trimmed === 'otro_dia' || /\botro dia\b|\bvolver\b/.test(normalized)) {
      return showDaySelection(phone, {
        mode: stateData.mode,
        appointmentId: stateData.appointmentId,
      });
    }

    if (slots.length === 0) {
      return showDaySelection(phone, {
        mode: stateData.mode,
        appointmentId: stateData.appointmentId,
      });
    }

    const num = parseInt(trimmed, 10);
    const shownCount = Math.min(slots.length, 9);

    if (Number.isNaN(num) || num < 1 || num > shownCount) {
      return timesReply(slots, stateData.dayLabelFull, { footer });
    }

    const selectedSlot = slots[num - 1];

    patientFlowStore.setStateWithData(phone, FLOW_STATES.CONFIRMING_APPOINTMENT, {
      ...stateData,
      selectedSlot,
    });

    const confirmMsg = [
      '¿Confirma su hora?',
      '',
      `📅 ${formatSlotDateFull(selectedSlot)}`,
      `🕐 ${selectedSlot.time} hrs`,
    ].join('\n');

    return { body: confirmMsg, skipWordLimit: true, interactive: CONFIRM_SLOT_BUTTONS };
  }

  function bookAppointment(phone, stateData, selectedSlot) {
    const patient = database.getPatientByPhone(phone);
    const consultation = database.getLastConsultation(phone);

    const result = database.createAppointment({
      consultationId: consultation?.id || null,
      patientId: patient?.id || null,
      phone,
      date: selectedSlot.date,
      time: selectedSlot.time,
      duration: slotDuration(),
    });

    if (result.conflict) {
      // Slot was taken between selection and confirmation; show the day's
      // remaining times again (or fall back to the day list).
      log('info', 'appointment.conflict', { phone, slot: selectedSlot });
      const reply = showTimeSelection(phone, selectedSlot.date, stateData.dayLabelFull, stateData);
      return {
        ...reply,
        body: `Lo sentimos, ese horario ya no está disponible. Elija otro 👇\n\n${reply.body}`,
      };
    }

    patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
    if (consultation) {
      database.updateAppointmentStatus(phone, 'confirmed');
    }

    // Fire-and-forget email notification
    if (emailService) {
      const symptoms = consultation ? database.getSymptomsByConsultation(consultation.id) : [];

      emailService.sendAppointmentNotification({
          patient, consultation, symptoms,
          appointmentDate: selectedSlot.date,
          appointmentTime: selectedSlot.time,
        })
        .then((sent) => {
          if (sent && consultation) database.markEmailNotified(consultation.id);
        })
        .catch((err) => log('error', 'email.appointment_trigger_failed', { phone, error: err?.message }));
    }

    return {
      body: [
        '✅ Su hora quedó agendada:',
        '',
        `📅 Fecha: ${formatSlotDateFull(selectedSlot)}`,
        `🕐 Hora: ${selectedSlot.time} hrs`,
        '',
        'Si necesita cancelar o reagendar, escríbanos 😊',
      ].join('\n'),
      skipWordLimit: true,
    };
  }

  function rebookAppointment(phone, stateData, selectedSlot) {
    const appointmentId = stateData.appointmentId;
    const oldAppointment = database.getAppointmentById(appointmentId);

    database.rescheduleAppointment(appointmentId, selectedSlot.date, selectedSlot.time);
    patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);

    // Notify doctor via email
    if (emailService && oldAppointment) {
      const patient = database.getPatientByPhone(phone);
      emailService.sendRescheduleNotification({
        patient,
        oldAppointment,
        newDate: selectedSlot.date,
        newTime: selectedSlot.time,
      }).catch((err) => log('error', 'email.reschedule_trigger_failed', { phone, error: err?.message }));
    }

    return {
      body: [
        '✅ Su cita ha sido reagendada:',
        '',
        `📅 Fecha: ${formatSlotDateFull(selectedSlot)}`,
        `🕐 Hora: ${selectedSlot.time} hrs`,
        '',
        'Si necesita cancelar o reagendar, escríbanos 😊',
      ].join('\n'),
      skipWordLimit: true,
    };
  }

  function handleConfirmingAppointment({ phone, prompt }) {
    const stateData = patientFlowStore.getStateData(phone) || {};
    const selectedSlot = stateData.selectedSlot;

    if (!selectedSlot) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      return { body: 'Ocurrió un error. Nos pondremos en contacto para agendar su hora.' };
    }

    const normalized = normalizeText(prompt);
    const wantsOther = /\botra\b|\botra hora\b|\bcambiar\b/.test(normalized);

    if (isNegative(prompt) || wantsOther) {
      // Show the same day's times again so the patient can pick another.
      return showTimeSelection(phone, selectedSlot.date, stateData.dayLabelFull, stateData);
    }

    if (isAffirmative(prompt)) {
      if (stateData.mode === 'reschedule' && stateData.appointmentId) {
        return rebookAppointment(phone, stateData, selectedSlot);
      }
      return bookAppointment(phone, stateData, selectedSlot);
    }

    return {
      body: 'Responda "sí" para confirmar la hora, o "no" para ver otras opciones.',
      interactive: CONFIRM_SLOT_BUTTONS,
    };
  }

  function handleManagingAppointment({ phone, prompt }) {
    const stateData = patientFlowStore.getStateData(phone);
    const appointment = stateData?.appointment;

    if (!appointment) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      return { body: 'Ocurrió un error. Intente nuevamente.' };
    }

    const trimmed = String(prompt || '').trim();
    const normalized = normalizeText(prompt);

    if (trimmed === '1' || /\bcancelar\b|\bcancela\b|\banular\b/.test(normalized)) {
      database.updateAppointment(appointment.id, 'cancelled', null);
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);

      // Notify doctor via email
      if (emailService) {
        const patient = database.getPatientByPhone(phone);
        emailService.sendCancellationNotification({ patient, appointment })
          .catch((err) => log('error', 'email.cancellation_trigger_failed', { phone, error: err?.message }));
      }

      const [, month, day] = appointment.appointment_date.split('-');
      const monthNum = parseInt(month, 10);
      const dayNum = parseInt(day, 10);

      return {
        body: `Su cita del ${dayNum} de ${MONTH_NAMES[monthNum]} a las ${appointment.appointment_time} ha sido cancelada.\n\nSi desea agendar una nueva hora, escriba "1" para iniciar una nueva consulta.`,
        skipWordLimit: true,
      };
    }

    if (trimmed === '2' || /\breagendar\b|\bcambiar hora\b|\botra hora\b/.test(normalized)) {
      return showDaySelection(phone, { mode: 'reschedule', appointmentId: appointment.id });
    }

    if (trimmed === '3' || /\bvolver\b/.test(normalized) || isNegative(prompt)) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      return { body: 'De acuerdo. Si necesita algo más, escríbanos.' };
    }

    return {
      body: 'Responda con el número de la opción:\n1) Cancelar cita\n2) Reagendar cita\n3) Volver',
      interactive: MANAGE_APPOINTMENT_BUTTONS,
    };
  }

  async function handleMessage({ phone, prompt, patient }) {
    const activePatient = patient || database.getPatientByPhone(phone);
    const currentState = patientFlowStore.getState(phone);

    if (currentState === FLOW_STATES.MANAGING_APPOINTMENT) {
      return handleManagingAppointment({ phone, prompt });
    }

    if (currentState === FLOW_STATES.CONFIRMING_APPOINTMENT) {
      return handleConfirmingAppointment({ phone, prompt });
    }

    if (currentState === FLOW_STATES.SELECTING_APPOINTMENT) {
      return handleSelectingAppointment({ phone, prompt });
    }

    if (currentState === FLOW_STATES.SELECTING_DAY) {
      return handleSelectingDay({ phone, prompt });
    }

    if (currentState === FLOW_STATES.AWAITING_APPOINTMENT) {
      return handleAppointmentResponse({ phone, prompt });
    }

    if (!activePatient?.form_completed) {
      patientFlowStore.syncState(phone, activePatient);
      return { body: CONSULTATION_PROMPT };
    }

    if (looksLikeGreeting(prompt)) {
      patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION);
      return { body: CONSULTATION_PROMPT };
    }

    const extracted = await extractConsultationDetails(prompt);

    if (!extracted?.valid) {
      patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION);
      return { body: CONSULTATION_PROMPT };
    }

    const symptomsArray = Array.isArray(extracted.sintomas)
      ? extracted.sintomas.filter((s) => String(s || '').trim())
      : [];

    const symptomsText = clipText(
      extracted.sintomasTexto || symptomsArray.join(', ') || prompt,
      500
    );
    const reason = clipText(extracted.motivoConsulta || prompt, 500);
    const diagnostics = await buildDiagnostics({ symptoms: symptomsText, reason });

    patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION_SUMMARY);

    const summary = buildConsultationSummary({
      patient: activePatient,
      diagnosticsText: diagnostics.formatted,
    });

    const consultationId = database.createConsultation({
      phone,
      patientId: activePatient.id,
      sintomas: symptomsText,
      motivo: reason,
      orientacion: diagnostics.formatted,
      resumen: summary,
    });

    if (symptomsArray.length > 0) {
      database.addSymptoms(consultationId, symptomsArray);
    }

    patientFlowStore.setState(phone, FLOW_STATES.AWAITING_APPOINTMENT);

    return {
      body: summary,
      consultationId,
      skipWordLimit: true,
      interactive: AGENDAR_BUTTONS,
    };
  }

  return {
    handleMessage,
    buildConsultationSummary,
    CONSULTATION_PROMPT,
  };
}

module.exports = {
  createConsultationHandler,
  CONSULTATION_PROMPT,
};
