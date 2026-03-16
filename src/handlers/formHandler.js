const {
  buildFieldExtractionInstruction,
  buildFieldExtractionPrompt,
} = require('../botPrompt');
const {
  FLOW_STATES,
  FIELD_TO_STATE,
} = require('../stores/patientFlowStore');
const {
  validateRut,
  validateFullName,
  validateEmail,
  validatePhone,
  validateAddress,
} = require('../validators');

const FORM_FIELD_CONFIG = {
  [FLOW_STATES.COLLECTING_RUT]: {
    key: 'rut',
    label: 'RUT',
    extraRules: 'Si aparece con puntos o sin puntos, conserva solo el RUT. Ejemplo valido: 12.345.678-9 o 12345678-9.',
    question: '¿Cuál es su RUT?',
    correctionMessage:
      'No pude verificar ese RUT. ¿Podrías escribirlo de nuevo? Por ejemplo: 12.345.678-9',
    validate: validateRut,
  },
  [FLOW_STATES.COLLECTING_NOMBRE]: {
    key: 'nombre',
    label: 'nombre completo',
    extraRules: 'Debe incluir nombre y apellido. No inventes informacion.',
    question: 'Gracias. ¿Cuál es su nombre completo?',
    correctionMessage:
      'Necesito su nombre y apellido para continuar. ¿Podrías escribirlos nuevamente?',
    validate: validateFullName,
  },
  [FLOW_STATES.COLLECTING_CORREO]: {
    key: 'correo',
    label: 'correo electronico',
    extraRules: 'Extrae solo el correo electronico, sin texto adicional.',
    question: 'Perfecto. ¿Cuál es su correo electrónico?',
    correctionMessage:
      'No pude reconocer ese correo. ¿Podrías escribirlo nuevamente? Ejemplo: nombre@correo.cl',
    validate: validateEmail,
  },
  [FLOW_STATES.COLLECTING_TELEFONO]: {
    key: 'telefono',
    label: 'telefono de contacto',
    extraRules: 'Extrae solo el numero de contacto. Puede incluir +56.',
    question: 'Gracias. ¿Cuál es su teléfono de contacto?',
    correctionMessage:
      'No pude reconocer ese teléfono. ¿Podrías escribirlo nuevamente? Puede ser, por ejemplo, +56912345678',
    validate: validatePhone,
  },
  [FLOW_STATES.COLLECTING_DIRECCION]: {
    key: 'direccion',
    label: 'direccion con comuna',
    extraRules: 'Debe incluir direccion y comuna si aparecen en el mensaje.',
    question: 'Por último, indíqueme su dirección con comuna.',
    correctionMessage:
      'Necesito su dirección con comuna para completar el formulario. ¿Podrías escribirla nuevamente?',
    validate: validateAddress,
  },
};

const FORM_SEQUENCE = [
  FLOW_STATES.COLLECTING_RUT,
  FLOW_STATES.COLLECTING_NOMBRE,
  FLOW_STATES.COLLECTING_CORREO,
  FLOW_STATES.COLLECTING_TELEFONO,
  FLOW_STATES.COLLECTING_DIRECCION,
];

const AFFIRMATIVE_PATTERNS = [
  /\bsi\b/,
  /\bsí\b/,
  /\bcorrecto\b/,
  /\best[aá] bien\b/,
  /\bconfirmo\b/,
  /\bok\b/,
  /\bde acuerdo\b/,
];

const CORRECTION_FIELD_PATTERNS = [
  { field: 'rut', patterns: [/\brut\b/] },
  { field: 'nombre', patterns: [/\bnombre\b/, /\bapellido\b/] },
  { field: 'correo', patterns: [/\bcorreo\b/, /\bmail\b/, /\bemail\b/] },
  { field: 'telefono', patterns: [/\btelefono\b/, /\btel[eé]fono\b/, /\bcelular\b/] },
  { field: 'direccion', patterns: [/\bdireccion\b/, /\bdirecci[oó]n\b/] },
];

function normalizeIntentText(value) {
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

function buildFormSummary(patient) {
  return [
    'Estos son los datos registrados:',
    `• RUT: ${patient?.rut || '-'}`,
    `• Nombre: ${patient?.nombre || '-'}`,
    `• Correo: ${patient?.correo || '-'}`,
    `• Teléfono: ${patient?.telefono || '-'}`,
    `• Dirección: ${patient?.direccion || '-'}`,
    '',
    'Si todo está correcto, responda "sí". Si necesita corregir algo, indíqueme cuál dato.',
  ].join('\n');
}

function getNextState(currentState) {
  const currentIndex = FORM_SEQUENCE.indexOf(currentState);
  if (currentIndex === -1) return FLOW_STATES.COLLECTING_RUT;

  return FORM_SEQUENCE[currentIndex + 1] || FLOW_STATES.CONFIRMING_FORM;
}

function buildNextQuestion(state) {
  return FORM_FIELD_CONFIG[state]?.question || '¿Podría indicarme el dato nuevamente?';
}

function detectCorrectionField(prompt) {
  const normalized = normalizeIntentText(prompt);

  for (const candidate of CORRECTION_FIELD_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(normalized))) {
      return candidate.field;
    }
  }

  return null;
}

function isAffirmative(prompt) {
  const normalized = normalizeIntentText(prompt);
  return AFFIRMATIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildConsultationKickoffMessage() {
  return [
    'Gracias, su formulario quedó completo.',
    '¿Cómo se siente? Cuénteme brevemente sus síntomas y el motivo de su consulta.',
  ].join(' ');
}

function createFormHandler({ database, patientFlowStore, geminiService }) {
  async function extractFieldValue({ config, prompt }) {
    const rawResponse = await geminiService.generateText({
      prompt: buildFieldExtractionPrompt({
        fieldLabel: config.label,
        userMessage: prompt,
      }),
      systemInstruction: buildFieldExtractionInstruction({
        fieldLabel: config.label,
        extraRules: config.extraRules,
      }),
    });

    return parseJsonResponse(rawResponse);
  }

  async function handleFieldCollection({ phone, prompt, state }) {
    const config = FORM_FIELD_CONFIG[state] || FORM_FIELD_CONFIG[FLOW_STATES.COLLECTING_RUT];
    const extraction = await extractFieldValue({ config, prompt });

    if (!extraction?.valid || extraction?.value === null || extraction?.value === undefined) {
      return {
        body: config.correctionMessage,
      };
    }

    const validation = config.validate(extraction.value);

    if (!validation.valid || !validation.value) {
      return {
        body: config.correctionMessage,
      };
    }

    database.upsertPatientField(phone, config.key, validation.value);
    const patient = database.getPatientByPhone(phone);
    const nextState = getNextState(state);

    if (nextState === FLOW_STATES.CONFIRMING_FORM) {
      patientFlowStore.syncState(phone, patient);

      return {
        body: buildFormSummary(patient),
        skipWordLimit: true,
      };
    }

    patientFlowStore.setState(phone, nextState);

    return {
      body: buildNextQuestion(nextState),
    };
  }

  async function handleConfirmation({ phone, prompt }) {
    const correctionField = detectCorrectionField(prompt);

    if (correctionField && FIELD_TO_STATE[correctionField]) {
      const nextState = FIELD_TO_STATE[correctionField];
      patientFlowStore.setState(phone, nextState);

      return {
        body: `Perfecto, actualicemos ese dato. ${buildNextQuestion(nextState)}`,
      };
    }

    if (isAffirmative(prompt)) {
      database.markFormCompleted(phone);
      patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION);

      return {
        body: buildConsultationKickoffMessage(),
      };
    }

    return {
      body:
        'Indíqueme si los datos están correctos respondiendo "sí", o dígame cuál dato desea corregir: RUT, nombre, correo, teléfono o dirección.',
    };
  }

  async function handleMessage({ phone, prompt, state }) {
    if (state === FLOW_STATES.CONFIRMING_FORM) {
      return handleConfirmation({ phone, prompt });
    }

    return handleFieldCollection({ phone, prompt, state });
  }

  return {
    handleMessage,
    buildFormSummary,
    buildConsultationKickoffMessage,
  };
}

module.exports = {
  createFormHandler,
  FORM_FIELD_CONFIG,
};
