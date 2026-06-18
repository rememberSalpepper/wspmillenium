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

function formatSlotDate(slot) {
  const dayAbbrev = {
    Domingo: 'Dom',
    Lunes: 'Lun',
    Martes: 'Mar',
    Miercoles: 'Mie',
    Jueves: 'Jue',
    Viernes: 'Vie',
    Sabado: 'Sab',
  };
  const [, month, day] = slot.date.split('-');
  const monthNames = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const abbrev = dayAbbrev[slot.dayLabel] || slot.dayLabel;
  const monthNum = parseInt(month, 10);
  const dayNum = parseInt(day, 10);
  return `${abbrev} ${dayNum} ${monthNames[monthNum]} - ${slot.time}`;
}

function formatSlotDateFull(slot) {
  const [, month, day] = slot.date.split('-');
  const monthNames = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const monthNum = parseInt(month, 10);
  const dayNum = parseInt(day, 10);
  const [year] = slot.date.split('-');
  return `${slot.dayLabel} ${dayNum} ${monthNames[monthNum]} ${year}`;
}

function buildSlotsMessage(slots) {
  const lines = ['📅 Horarios disponibles:', ''];
  slots.forEach((slot, i) => {
    lines.push(`${i + 1}) 🕐 ${formatSlotDate(slot)}`);
  });
  lines.push('');
  lines.push('Responda con el numero de la opcion.');
  return lines.join('\n');
}

// --- Interactive (buttons / lists) helpers ---

function slotsListInteractive(slots) {
  return {
    type: 'list',
    button: 'Ver horarios',
    rows: slots.map((slot, i) => ({ id: String(i + 1), title: formatSlotDate(slot) })),
  };
}

// Reply that shows the available slots as both text (fallback) and an interactive list.
function slotsReply(slots) {
  return {
    body: buildSlotsMessage(slots),
    skipWordLimit: true,
    interactive: slotsListInteractive(slots),
  };
}

const AGENDAR_BUTTONS = {
  type: 'buttons',
  buttons: [
    { id: 'si', title: 'Sí, agendar' },
    { id: 'no', title: 'No por ahora' },
  ],
};

const CONFIRM_SLOT_BUTTONS = {
  type: 'buttons',
  buttons: [
    { id: 'si', title: 'Sí, confirmar' },
    { id: 'no', title: 'Ver otras horas' },
  ],
};

const MANAGE_APPOINTMENT_BUTTONS = {
  type: 'buttons',
  buttons: [
    { id: '1', title: 'Cancelar cita' },
    { id: '2', title: 'Reagendar' },
    { id: '3', title: 'Volver' },
  ],
};

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

  function handleAppointmentResponse({ phone, prompt }) {
    if (isAffirmative(prompt)) {
      const slotsToShow = (config && config.APPOINTMENT_SLOTS_TO_SHOW) || 5;
      const slotDuration = (config && config.APPOINTMENT_SLOT_DURATION) || 30;
      const slots = database.getAvailableSlots(getTodayStr(), slotsToShow, slotDuration);

      if (!slots || slots.length === 0) {
        patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
        return {
          body: 'No hay horarios disponibles en las proximas semanas. Nos pondremos en contacto.',
        };
      }

      patientFlowStore.setStateWithData(phone, FLOW_STATES.SELECTING_APPOINTMENT, { slots });
      return slotsReply(slots);
    }

    if (isNegative(prompt)) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      database.updateAppointmentStatus(phone, 'declined');
      return { body: APPOINTMENT_DECLINE_MESSAGE };
    }

    return {
      body: 'Responda "si" si desea agendar una hora con el doctor, o "no" si prefiere no agendar por ahora.',
      interactive: AGENDAR_BUTTONS,
    };
  }

  function handleSelectingAppointment({ phone, prompt }) {
    const stateData = patientFlowStore.getStateData(phone);
    const slots = stateData?.slots || [];

    if (slots.length === 0) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      return { body: 'Ocurrio un error. Nos pondremos en contacto para agendar su hora.' };
    }

    const trimmed = String(prompt || '').trim();
    const num = parseInt(trimmed, 10);

    if (Number.isNaN(num) || num < 1 || num > slots.length) {
      return slotsReply(slots);
    }

    const selectedSlot = slots[num - 1];

    patientFlowStore.setStateWithData(phone, FLOW_STATES.CONFIRMING_APPOINTMENT, {
      slots,
      selectedSlot,
    });

    const confirmMsg = [
      `Ha seleccionado: ${formatSlotDate(selectedSlot)}`,
      'Confirma esta hora? (si/no)',
    ].join('\n');

    return { body: confirmMsg, interactive: CONFIRM_SLOT_BUTTONS };
  }

  function handleConfirmingAppointment({ phone, prompt }) {
    const stateData = patientFlowStore.getStateData(phone);
    const selectedSlot = stateData?.selectedSlot;
    const slots = stateData?.slots || [];

    if (!selectedSlot) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      return { body: 'Ocurrio un error. Nos pondremos en contacto para agendar su hora.' };
    }

    const normalized = normalizeText(prompt);
    const wantsOther = /\botra\b|\botra hora\b|\bcambiar\b/.test(normalized);

    if (isNegative(prompt) || wantsOther) {
      // Re-generate slots in case availability changed
      const slotsToShow = (config && config.APPOINTMENT_SLOTS_TO_SHOW) || 5;
      const slotDuration = (config && config.APPOINTMENT_SLOT_DURATION) || 30;
      const freshSlots = database.getAvailableSlots(getTodayStr(), slotsToShow, slotDuration);

      if (!freshSlots || freshSlots.length === 0) {
        patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
        return {
          body: 'No hay horarios disponibles en las proximas semanas. Nos pondremos en contacto.',
        };
      }

      patientFlowStore.setStateWithData(phone, FLOW_STATES.SELECTING_APPOINTMENT, { slots: freshSlots });
      return slotsReply(freshSlots);
    }

    if (isAffirmative(prompt)) {
      const patient = database.getPatientByPhone(phone);
      const consultation = database.getLastConsultation(phone);

      const result = database.createAppointment({
        consultationId: consultation?.id || null,
        patientId: patient?.id || null,
        phone,
        date: selectedSlot.date,
        time: selectedSlot.time,
        duration: (config && config.APPOINTMENT_SLOT_DURATION) || 30,
      });

      if (result.conflict) {
        // Slot was taken, re-generate
        log('info', 'appointment.conflict', { phone, slot: selectedSlot });
        const slotsToShow = (config && config.APPOINTMENT_SLOTS_TO_SHOW) || 5;
        const slotDuration = (config && config.APPOINTMENT_SLOT_DURATION) || 30;
        const freshSlots = database.getAvailableSlots(getTodayStr(), slotsToShow, slotDuration);

        if (!freshSlots || freshSlots.length === 0) {
          patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
          return {
            body: 'Lo sentimos, ese horario ya no esta disponible y no hay mas horarios. Nos pondremos en contacto.',
          };
        }

        patientFlowStore.setStateWithData(phone, FLOW_STATES.SELECTING_APPOINTMENT, { slots: freshSlots });
        return {
          body: `Lo sentimos, ese horario ya no esta disponible. Elija otro:\n\n${buildSlotsMessage(freshSlots)}`,
          skipWordLimit: true,
          interactive: slotsListInteractive(freshSlots),
        };
      }

      // Success
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

      const confirmBody = [
        '✅ Su hora quedo agendada:',
        '',
        `📅 Fecha: ${formatSlotDateFull(selectedSlot)}`,
        `🕐 Hora: ${selectedSlot.time}`,
        '',
        'Si necesita cancelar o reagendar, escribanos 😊',
      ].join('\n');

      return { body: confirmBody, skipWordLimit: true };
    }

    return {
      body: 'Responda "si" para confirmar la hora, o "no" para ver otras opciones.',
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
      const monthNames = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
        'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
      const monthNum = parseInt(month, 10);
      const dayNum = parseInt(day, 10);

      return {
        body: `Su cita del ${dayNum} de ${monthNames[monthNum]} a las ${appointment.appointment_time} ha sido cancelada.\n\nSi desea agendar una nueva hora, escriba "1" para iniciar una nueva consulta.`,
        skipWordLimit: true,
      };
    }

    if (trimmed === '2' || /\breagendar\b|\bcambiar hora\b|\botra hora\b/.test(normalized)) {
      const slotsToShow = (config && config.APPOINTMENT_SLOTS_TO_SHOW) || 5;
      const slotDuration = (config && config.APPOINTMENT_SLOT_DURATION) || 30;
      const slots = database.getAvailableSlots(getTodayStr(), slotsToShow, slotDuration);

      if (!slots || slots.length === 0) {
        patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
        return { body: 'No hay horarios disponibles en las próximas semanas. Nos pondremos en contacto.' };
      }

      patientFlowStore.setStateWithData(phone, FLOW_STATES.RESCHEDULING_APPOINTMENT, {
        step: 'selecting',
        slots,
        appointmentId: appointment.id,
      });
      return slotsReply(slots);
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

  function handleReschedulingAppointment({ phone, prompt }) {
    const stateData = patientFlowStore.getStateData(phone);
    const step = stateData?.step || 'selecting';
    const appointmentId = stateData?.appointmentId;

    if (!appointmentId) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      return { body: 'Ocurrió un error. Intente nuevamente.' };
    }

    if (step === 'selecting') {
      const slots = stateData?.slots || [];

      if (slots.length === 0) {
        patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
        return { body: 'Ocurrió un error. Nos pondremos en contacto para reagendar su hora.' };
      }

      const trimmed = String(prompt || '').trim();
      const num = parseInt(trimmed, 10);

      if (Number.isNaN(num) || num < 1 || num > slots.length) {
        return slotsReply(slots);
      }

      const selectedSlot = slots[num - 1];

      patientFlowStore.setStateWithData(phone, FLOW_STATES.RESCHEDULING_APPOINTMENT, {
        step: 'confirming',
        slots,
        selectedSlot,
        appointmentId,
      });

      return {
        body: `Ha seleccionado: ${formatSlotDate(selectedSlot)}\n¿Confirma reagendar a esta hora? (si/no)`,
        interactive: CONFIRM_SLOT_BUTTONS,
      };
    }

    if (step === 'confirming') {
      const selectedSlot = stateData?.selectedSlot;

      if (!selectedSlot) {
        patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
        return { body: 'Ocurrió un error. Nos pondremos en contacto para reagendar su hora.' };
      }

      if (isNegative(prompt)) {
        const slotsToShow = (config && config.APPOINTMENT_SLOTS_TO_SHOW) || 5;
        const slotDuration = (config && config.APPOINTMENT_SLOT_DURATION) || 30;
        const freshSlots = database.getAvailableSlots(getTodayStr(), slotsToShow, slotDuration);

        if (!freshSlots || freshSlots.length === 0) {
          patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
          return { body: 'No hay horarios disponibles en las próximas semanas. Nos pondremos en contacto.' };
        }

        patientFlowStore.setStateWithData(phone, FLOW_STATES.RESCHEDULING_APPOINTMENT, {
          step: 'selecting',
          slots: freshSlots,
          appointmentId,
        });
        return slotsReply(freshSlots);
      }

      if (isAffirmative(prompt)) {
        // Get old appointment info before rescheduling
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
            `🕐 Hora: ${selectedSlot.time}`,
            '',
            'Si necesita cancelar o reagendar, escríbanos 😊',
          ].join('\n'),
          skipWordLimit: true,
        };
      }

      return {
        body: 'Responda "si" para confirmar la hora, o "no" para ver otras opciones.',
        interactive: CONFIRM_SLOT_BUTTONS,
      };
    }

    patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
    return { body: 'Ocurrió un error. Intente nuevamente.' };
  }

  async function handleMessage({ phone, prompt, patient }) {
    const activePatient = patient || database.getPatientByPhone(phone);
    const currentState = patientFlowStore.getState(phone);

    if (currentState === FLOW_STATES.MANAGING_APPOINTMENT) {
      return handleManagingAppointment({ phone, prompt });
    }

    if (currentState === FLOW_STATES.RESCHEDULING_APPOINTMENT) {
      return handleReschedulingAppointment({ phone, prompt });
    }

    if (currentState === FLOW_STATES.CONFIRMING_APPOINTMENT) {
      return handleConfirmingAppointment({ phone, prompt });
    }

    if (currentState === FLOW_STATES.SELECTING_APPOINTMENT) {
      return handleSelectingAppointment({ phone, prompt });
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
