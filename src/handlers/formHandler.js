const {
  buildFormExtractionInstruction,
  buildFormExtractionPrompt,
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
const { log } = require('../logger');

// Canonical field order. This same order is shown to the user (welcome message,
// re-ask templates) AND used to map a line-per-value message positionally, so
// they MUST stay in sync: line 1 → RUT, line 2 → Nombre, etc.
const FORM_FIELDS = [
  {
    key: 'rut',
    state: FLOW_STATES.COLLECTING_RUT,
    label: 'RUT',
    example: '12.345.678-9',
    validate: validateRut,
  },
  {
    key: 'nombre',
    state: FLOW_STATES.COLLECTING_NOMBRE,
    label: 'Nombre completo',
    example: 'Juan Pérez González',
    validate: validateFullName,
  },
  {
    key: 'correo',
    state: FLOW_STATES.COLLECTING_CORREO,
    label: 'Correo electrónico',
    example: 'juan@correo.cl',
    validate: validateEmail,
  },
  {
    key: 'telefono',
    state: FLOW_STATES.COLLECTING_TELEFONO,
    label: 'Teléfono',
    example: '+56912345678',
    validate: validatePhone,
  },
  {
    key: 'direccion',
    state: FLOW_STATES.COLLECTING_DIRECCION,
    label: 'Dirección (con comuna)',
    example: 'Av. Siempre Viva 123, Maipú',
    validate: validateAddress,
  },
];

const FORM_FIELD_CONFIG = Object.fromEntries(FORM_FIELDS.map((field) => [field.key, field]));
const STATE_TO_FIELD = Object.fromEntries(FORM_FIELDS.map((field) => [field.state, field.key]));

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

const LABEL_ALIASES = {
  rut: 'rut',
  nombre: 'nombre',
  'nombre completo': 'nombre',
  correo: 'correo',
  'correo electronico': 'correo',
  email: 'correo',
  mail: 'correo',
  telefono: 'telefono',
  'teléfono': 'telefono',
  celular: 'telefono',
  direccion: 'direccion',
  'dirección': 'direccion',
  'direccion con comuna': 'direccion',
  'dirección con comuna': 'direccion',
};

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
    '📝 Estos son los datos registrados:',
    '',
    `RUT: ${patient?.rut || '-'}`,
    `Nombre: ${patient?.nombre || '-'}`,
    `Correo: ${patient?.correo || '-'}`,
    `Teléfono: ${patient?.telefono || '-'}`,
    `Dirección: ${patient?.direccion || '-'}`,
    '',
    'Si todo está correcto, responda "sí" ✅ Si necesita corregir algo, indíqueme cuál dato.',
  ].join('\n');
}

function buildFormTemplate(fields, intro) {
  const useNumbering = fields.length > 1;
  const lines = fields.map((field, index) =>
    useNumbering ? `${index + 1}. ${field.label}` : field.label
  );

  // When several fields are requested, remind the user to put each one on its
  // own line and show a filled-in example (matching exactly the requested
  // fields and order) so they don't mix them up.
  if (useNumbering) {
    return [
      intro,
      '',
      ...lines,
      '',
      'Por ejemplo:',
      ...fields.map((field) => field.example),
    ].join('\n');
  }

  return [intro, '', ...lines].join('\n');
}

function buildNextQuestion(state) {
  const fieldKey = STATE_TO_FIELD[state];
  const field = FORM_FIELD_CONFIG[fieldKey];

  if (!field) {
    return buildFormTemplate(
      FORM_FIELDS,
      'Envíame tus datos en un solo mensaje, cada uno en una línea distinta (presiona Enter entre uno y otro) y en este orden:'
    );
  }

  return buildFormTemplate([field], 'Envíame nuevamente este dato:');
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
    'Gracias, su formulario quedó completo ✅',
    '',
    '¿Cómo se siente? Cuénteme brevemente sus síntomas y el motivo de su consulta 🩺',
  ].join('\n');
}

function extractLabeledFields(prompt) {
  const extracted = {
    rut: null,
    nombre: null,
    correo: null,
    telefono: null,
    direccion: null,
  };

  const lines = String(prompt || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;

    const rawLabel = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!rawLabel || !rawValue) continue;

    const normalizedLabel = normalizeIntentText(rawLabel);
    const fieldKey = LABEL_ALIASES[normalizedLabel];
    if (!fieldKey) continue;

    extracted[fieldKey] = rawValue;
  }

  return extracted;
}

// Maps a line-per-value message onto the still-missing fields, in order.
// `orderedMissingKeys` is the list of pending field keys in canonical order, so
// line 1 → first pending field, line 2 → second, etc. Only activates when the
// message clearly uses the format: multiple lines, or a single line answering a
// single pending field (so a one-field re-ask doesn't need an AI round-trip).
function extractPositionalFields(prompt, orderedMissingKeys) {
  const extracted = {
    rut: null,
    nombre: null,
    correo: null,
    telefono: null,
    direccion: null,
  };

  const keys = Array.isArray(orderedMissingKeys) ? orderedMissingKeys : [];
  if (keys.length === 0) return extracted;

  const lines = String(prompt || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return extracted;

  const isMultiLine = lines.length >= 2;
  const isSinglePending = keys.length === 1;
  if (!isMultiLine && !isSinglePending) return extracted;

  keys.forEach((key, index) => {
    if (index < lines.length && lines[index]) {
      extracted[key] = lines[index];
    }
  });

  return extracted;
}

function countExtractedFields(extracted) {
  return FORM_FIELDS.filter((field) => {
    const value = extracted?.[field.key];
    return value !== null && value !== undefined && String(value).trim() !== '';
  }).length;
}

function listMissingFields(patient) {
  return FORM_FIELDS.filter((field) => !patient?.[field.key]);
}

function buildPendingFieldsMessage({ patient, invalidKeys = [] }) {
  const missingFields = listMissingFields(patient);
  const invalidFieldSet = new Set(invalidKeys);
  const neededFields = FORM_FIELDS.filter(
    (field) => invalidFieldSet.has(field.key) || missingFields.some((missing) => missing.key === field.key)
  );

  const perLine =
    neededFields.length > 1 ? ' Escribe cada dato en una línea distinta, en este orden:' : '';

  let intro = `Envíame estos datos.${perLine}`;
  if (invalidKeys.length > 0 && neededFields.length === invalidKeys.length) {
    intro = `Hay datos que debo corregir.${perLine}`;
  } else if (invalidKeys.length > 0) {
    intro = `Faltan o debo corregir algunos datos.${perLine}`;
  } else if (neededFields.length !== FORM_FIELDS.length) {
    intro = `Me faltan estos datos.${perLine}`;
  }

  return buildFormTemplate(neededFields, intro);
}

function createFormHandler({ database, patientFlowStore, geminiService }) {
  // Structured (deterministic) extraction: explicit "Label: value" lines first,
  // then a line-per-value message mapped onto the pending fields in order.
  function extractStructuredFields(prompt, orderedMissingKeys) {
    const labeledFields = extractLabeledFields(prompt);
    if (countExtractedFields(labeledFields) > 0) {
      log('info', 'form.extraction_labeled', {
        fieldsFound: countExtractedFields(labeledFields),
        keys: Object.keys(labeledFields).filter((k) => labeledFields[k]),
      });
      return { fields: labeledFields, source: 'labeled' };
    }

    const positionalFields = extractPositionalFields(prompt, orderedMissingKeys);
    if (countExtractedFields(positionalFields) > 0) {
      log('info', 'form.extraction_positional', {
        fieldsFound: countExtractedFields(positionalFields),
        keys: Object.keys(positionalFields).filter((k) => positionalFields[k]),
      });
      return { fields: positionalFields, source: 'positional' };
    }

    return { fields: {}, source: 'none' };
  }

  // Free-text fallback via Gemini for messages that don't follow the structured
  // formats (e.g. "hola, soy Juan, mi rut es 12.345.678-9 ...").
  async function extractWithGemini(prompt) {
    const rawResponse = await geminiService.generateText({
      prompt: buildFormExtractionPrompt(prompt),
      systemInstruction: buildFormExtractionInstruction(),
    });

    const parsed = parseJsonResponse(rawResponse);

    if (!parsed || countExtractedFields(parsed) === 0) {
      log('warn', 'form.extraction_failed', {
        promptPreview: String(prompt || '').slice(0, 200),
        rawResponsePreview: String(rawResponse || '').slice(0, 300),
        parsed,
      });
      return {};
    }

    log('info', 'form.extraction_gemini', {
      fieldsFound: countExtractedFields(parsed),
      keys: Object.keys(parsed).filter((k) => parsed[k]),
    });

    return parsed;
  }

  // Validates each extracted field and persists the valid ones.
  function saveValidFields(phone, extractedFields) {
    const savedKeys = [];
    const invalidKeys = [];

    for (const field of FORM_FIELDS) {
      const rawValue = extractedFields?.[field.key];
      if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
        continue;
      }

      const validation = field.validate(rawValue);
      if (!validation.valid || !validation.value) {
        log('warn', 'form.field_validation_failed', {
          phone,
          field: field.key,
          rawValue: String(rawValue).slice(0, 100),
        });
        invalidKeys.push(field.key);
        continue;
      }

      database.upsertPatientField(phone, field.key, validation.value);
      savedKeys.push(field.key);
    }

    return { savedKeys, invalidKeys };
  }

  async function handleFieldCollection({ phone, prompt, state }) {
    // Pending fields in canonical order drive the positional mapping.
    const existingPatient = database.getPatientByPhone(phone);
    const orderedMissingKeys = FORM_FIELDS.map((field) => field.key).filter(
      (key) => !existingPatient?.[key]
    );

    let { fields: extractedFields, source } = extractStructuredFields(prompt, orderedMissingKeys);
    let { savedKeys, invalidKeys } = saveValidFields(phone, extractedFields);

    // If nothing was saved, fall back to the AI extractor (handles free text and
    // misaligned line input that strict structured parsing rejected).
    if (savedKeys.length === 0 && source !== 'gemini') {
      const geminiFields = await extractWithGemini(prompt);
      if (countExtractedFields(geminiFields) > 0) {
        extractedFields = geminiFields;
        source = 'gemini';
        ({ savedKeys, invalidKeys } = saveValidFields(phone, geminiFields));
      }
    }

    log('info', 'form.field_collection_result', {
      phone,
      state,
      source,
      savedKeys,
      invalidKeys,
      extractedKeys: Object.keys(extractedFields || {}).filter((k) => extractedFields[k]),
    });

    const patient = database.getPatientByPhone(phone);
    const nextState = patientFlowStore.syncState(phone, patient);

    if (nextState === FLOW_STATES.CONFIRMING_FORM) {
      return {
        body: buildFormSummary(patient),
        skipWordLimit: true,
      };
    }

    const currentFieldKey = STATE_TO_FIELD[state];

    if (savedKeys.length === 0 && invalidKeys.length === 0 && currentFieldKey) {
      return {
        body: buildNextQuestion(state),
        skipWordLimit: true,
      };
    }

    return {
      body: buildPendingFieldsMessage({
        patient,
        invalidKeys,
      }),
      skipWordLimit: true,
    };
  }

  async function handleConfirmation({ phone, prompt }) {
    const correctionField = detectCorrectionField(prompt);

    if (correctionField && FIELD_TO_STATE[correctionField]) {
      const nextState = FIELD_TO_STATE[correctionField];
      patientFlowStore.setState(phone, nextState);

      return {
        body: buildNextQuestion(nextState),
        skipWordLimit: true,
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
        'Responda "sí" si los datos están correctos. Si quiere corregir algo, escriba el dato que desea corregir: RUT, nombre, correo, teléfono o dirección.',
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
  FORM_FIELDS,
};
