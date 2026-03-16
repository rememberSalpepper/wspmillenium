const {
  buildConsultationExtractionInstruction,
  buildConsultationExtractionPrompt,
  buildConsultationOrientationInstruction,
  buildConsultationOrientationPrompt,
} = require('../botPrompt');
const { FLOW_STATES } = require('../stores/patientFlowStore');

const CONSULTATION_PROMPT =
  '¿Cómo se siente? Cuénteme brevemente sus síntomas y el motivo de su consulta.';

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
    const match = cleanText.match(/\{[\s\S]*\}/);
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

function sanitizeOrientationText(value) {
  return cleanText(value)
    .replace(/^hola(?:\s+[a-záéíóúñ]+)?[,:\s-]*/i, '')
    .replace(/^estimado(?:\/a)?(?:\s+[a-záéíóúñ]+)?[,:\s-]*/i, '');
}

function looksLikeGreeting(text) {
  const normalized = normalizeText(text);
  return GREETING_PATTERNS.includes(normalized);
}

function buildConsultationSummary({ patient, symptoms, orientation }) {
  return [
    '📋 Resumen de su consulta:',
    `• Paciente: ${patient?.nombre || '-'}`,
    `• RUT: ${patient?.rut || '-'}`,
    `• Síntomas: ${clipText(symptoms, 120) || '-'}`,
    `• Orientación: ${cleanText(orientation) || '-'}`,
    '',
    'Su caso quedó registrado y el agendamiento quedó pendiente.',
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

  async function buildOrientation({ patient, symptoms, reason }) {
    return geminiService.generateText({
      prompt: buildConsultationOrientationPrompt({
        patientName: patient?.nombre,
        symptoms,
        reason,
      }),
      systemInstruction: buildConsultationOrientationInstruction(),
    });
  }

  async function handleMessage({ phone, prompt, patient }) {
    const activePatient = patient || database.getPatientByPhone(phone);

    if (!activePatient?.form_completed) {
      patientFlowStore.syncState(phone, activePatient);
      return {
        body: CONSULTATION_PROMPT,
      };
    }

    if (looksLikeGreeting(prompt)) {
      patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION);
      return {
        body: CONSULTATION_PROMPT,
      };
    }

    const extracted = await extractConsultationDetails(prompt);

    if (!extracted?.valid) {
      patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION);
      return {
        body: CONSULTATION_PROMPT,
      };
    }

    const symptoms = clipText(extracted.sintomas || prompt, 220);
    const reason = clipText(extracted.motivoConsulta || prompt, 180);
    const orientation = sanitizeOrientationText(
      await buildOrientation({
        patient: activePatient,
        symptoms,
        reason,
      })
    );

    patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION_SUMMARY);

    const summary = buildConsultationSummary({
      patient: activePatient,
      symptoms,
      orientation,
    });

    const consultationId = database.createConsultation({
      phone,
      patientId: activePatient.id,
      sintomas: symptoms,
      motivo: reason,
      orientacion: orientation,
      resumen: summary,
    });

    patientFlowStore.setState(phone, FLOW_STATES.COMPLETED);

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
