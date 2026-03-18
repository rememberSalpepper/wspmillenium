const {
  buildConsultationExtractionInstruction,
  buildConsultationExtractionPrompt,
  buildConsultationOrientationInstruction,
  buildConsultationOrientationPrompt,
} = require('../botPrompt');
const { FLOW_STATES } = require('../stores/patientFlowStore');

const CONSULTATION_PROMPT =
  '¿Cómo se siente? Cuénteme brevemente sus síntomas y el motivo de su consulta 🩺';

const APPOINTMENT_CONFIRM_MESSAGE =
  'Perfecto, su agendamiento quedó pendiente. Nos pondremos en contacto para confirmar la hora 📅';

const APPOINTMENT_DECLINE_MESSAGE =
  'Entendido. Si más adelante necesita agendar, no dude en escribirnos. ¡Que se mejore! 🙏';

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
      return items
        .map((d) => {
          const name = cleanText(d.diagnostico);
          const explanation = cleanText(d.explicacion) || 'Pendiente de evaluación médica.';
          return `${name}:\n• ${explanation}`;
        })
        .join('\n\n');
    }
  }

  const fallback = cleanText(rawResponse);
  if (fallback) return `Orientación general:\n• ${fallback}`;
  return 'Orientación general:\n• Pendiente de evaluación médica.';
}

function buildConsultationSummary({ patient, diagnosticsText }) {
  return [
    '📋 Resumen de su consulta',
    '',
    `RUT: ${patient?.rut || '-'}`,
    `Nombre: ${patient?.nombre || '-'}`,
    '',
    '🩺 Posibles diagnósticos:',
    '',
    diagnosticsText,
    '',
    'En cualquier caso, lo mejor es validar con el doctor.',
    '¿Desea que le agende una hora? 😊',
  ].join('\n');
}

function createConsultationHandler({ database, patientFlowStore, geminiService }) {
  async function extractConsultationDetails(prompt) {
    const rawResponse = await geminiService.generateText({
      prompt: buildConsultationExtractionPrompt(prompt),
      systemInstruction: buildConsultationExtractionInstruction(),
    });

    return parseJsonResponse(rawResponse);
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
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      return { body: APPOINTMENT_CONFIRM_MESSAGE };
    }

    if (isNegative(prompt)) {
      patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);
      return { body: APPOINTMENT_DECLINE_MESSAGE };
    }

    return {
      body: 'Responda "sí" si desea agendar una hora, o "no" si prefiere no agendar por ahora 😊',
    };
  }

  async function handleMessage({ phone, prompt, patient }) {
    const activePatient = patient || database.getPatientByPhone(phone);
    const currentState = patientFlowStore.getState(phone);

    if (currentState === FLOW_STATES.AWAITING_APPOINTMENT) {
      return handleAppointmentResponse({ phone, prompt });
    }

    if (currentState === FLOW_STATES.COMPLETED) {
      patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION);
      return { body: CONSULTATION_PROMPT };
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

    const symptoms = clipText(extracted.sintomas || prompt, 220);
    const reason = clipText(extracted.motivoConsulta || prompt, 180);
    const diagnostics = await buildDiagnostics({ symptoms, reason });

    patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION_SUMMARY);

    const summary = buildConsultationSummary({
      patient: activePatient,
      diagnosticsText: diagnostics.formatted,
    });

    const consultationId = database.createConsultation({
      phone,
      patientId: activePatient.id,
      sintomas: symptoms,
      motivo: reason,
      orientacion: diagnostics.raw,
      resumen: summary,
    });

    patientFlowStore.setState(phone, FLOW_STATES.AWAITING_APPOINTMENT);

    return {
      body: summary,
      consultationId,
      skipWordLimit: true,
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
