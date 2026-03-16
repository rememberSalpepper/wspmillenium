const DEFAULT_WELCOME_MESSAGE = [
  'Hola 👋 Bienvenido(a) a Consultas Millenium.',
  '',
  'Soy Catalina, asistente del Dr. Luis Martínez.',
  '',
  'Para continuar, envíeme en un solo mensaje estos datos:',
  '',
  'RUT: 12.345.678-9',
  'Nombre completo: Juan Pérez Soto',
  'Correo: juan@correo.cl',
  'Teléfono: 912345678',
  'Dirección: Calle 123, Providencia',
].join('\n');

const DEFAULT_HUMAN_HANDOFF_MESSAGE =
  'Te voy a derivar con una asistente humana para continuar por este medio. Si quieres adelantar el proceso, enviame tu nombre completo y RUT.';

const DEFAULT_EMERGENCY_MESSAGE =
  'Por los sintomas que describes, debes acudir a un servicio de urgencia de inmediato. No es seguro continuar esta evaluacion por WhatsApp. Como siguiente paso, busca atencion presencial ahora.';

function buildPricingInstruction(pricingTableText) {
  const cleanTable = String(pricingTableText || '').trim();

  if (!cleanTable) {
    return [
      'No hay una tabla de precios configurada en el sistema.',
      'Si preguntan por valores exactos, no inventes montos.',
      'Indica que el valor exacto se comparte al avanzar con el pre-agendamiento o por una asistente humana.',
    ].join('\n');
  }

  return [
    'Usa solo la siguiente tabla para entregar presupuesto inicial.',
    'Nunca inventes montos fuera de esta tabla.',
    cleanTable,
  ].join('\n');
}

function buildBotSystemInstruction({ pricingTableText, extraInstruction = '' }) {
  const pricingInstruction = buildPricingInstruction(pricingTableText);
  const cleanExtraInstruction = String(extraInstruction || '').trim();

  const sections = [
    [
      'Eres Catalina, asistente virtual de Consultas Millenium.',
      'Atiendes por WhatsApp a pacientes de telemedicina y respondes siempre en espanol simple de Chile.',
    ].join('\n'),
    [
      'REGLAS DE FORMATO OBLIGATORIAS:',
      '- Maximo 2 o 3 oraciones por mensaje.',
      '- No repitas informacion que ya diste.',
      '- Se directa, breve y concreta.',
      '- No uses listas largas ni explicaciones extensas.',
      '- Si la pregunta es simple, responde en una sola frase.',
    ].join('\n'),
    [
      'FLUJO DE ATENCION:',
      '- Primero se completa el formulario de atencion en un solo mensaje.',
      '- Luego se consultan sintomas y motivo de consulta.',
      '- Despues se entrega una orientacion breve y se deja la consulta registrada.',
      '- Si falta algun dato, pide solo los datos faltantes o a corregir.',
    ].join('\n'),
    [
      'NORMAS MEDICAS:',
      '- Nunca diagnostiques enfermedades graves.',
      '- Solo entrega orientaciones breves sobre causas leves y comunes cuando ya existan sintomas descritos.',
      '- Nunca indiques tratamientos personalizados.',
      '- Nunca prescribir medicamentos.',
      '- Ante sintomas de emergencia, indica ir a urgencias de inmediato.',
      '- Siempre recomienda validar con el doctor en la consulta.',
    ].join('\n'),
    [
      'REGLAS OPERATIVAS:',
      '- Para el formulario inicial, pide RUT, nombre, correo, telefono y direccion en un solo mensaje.',
      '- Si faltan datos o vienen mal escritos, solicita solo esos datos.',
      '- Si preguntan por precios y no hay tabla configurada, no inventes montos.',
      '- No inventes disponibilidad ni confirmes horas medicas.',
      '- Si el usuario quiere hablar con una persona, deriva de inmediato.',
    ].join('\n'),
    ['Tabla de precios / presupuesto inicial:', pricingInstruction].join('\n'),
  ];

  if (cleanExtraInstruction) {
    sections.push(['Instrucciones adicionales configuradas:', cleanExtraInstruction].join('\n'));
  }

  return sections.join('\n\n');
}

function buildFieldExtractionInstruction({ fieldLabel, extraRules = '' }) {
  const cleanFieldLabel = String(fieldLabel || '').trim();
  const cleanExtraRules = String(extraRules || '').trim();
  const sections = [
    'Extrae un solo dato desde un mensaje de WhatsApp en espanol de Chile.',
    `Dato objetivo: ${cleanFieldLabel}.`,
    'Responde solo con JSON valido usando este formato exacto:',
    '{"value":"texto extraido","valid":true}',
    'Si no puedes identificar el dato, responde {"value":null,"valid":false}.',
    'No agregues explicaciones, markdown ni texto adicional.',
  ];

  if (cleanExtraRules) {
    sections.push(`Reglas extra: ${cleanExtraRules}`);
  }

  return sections.join('\n');
}

function buildFieldExtractionPrompt({ fieldLabel, userMessage }) {
  return [
    `Extrae el valor de ${fieldLabel} desde el mensaje del usuario.`,
    `Mensaje: """${String(userMessage || '').trim()}"""`,
  ].join('\n');
}

function buildFormExtractionInstruction() {
  return [
    'Extrae datos de un formulario de atencion enviado por WhatsApp en espanol de Chile.',
    'Responde solo con JSON valido usando exactamente estas claves:',
    '{"rut":null,"nombre":null,"correo":null,"telefono":null,"direccion":null}',
    'En cada clave responde con texto o null.',
    'No inventes datos. Si un campo no aparece, dejalo en null.',
    'El usuario puede enviar uno, varios o todos los campos en el mismo mensaje.',
    'Reconoce formatos con o sin etiquetas, por ejemplo RUT:, Nombre:, Correo:, Telefono:, Direccion:.',
    'No agregues explicaciones, markdown ni texto adicional.',
  ].join('\n');
}

function buildFormExtractionPrompt(userMessage) {
  return [
    'Extrae los datos del formulario desde el siguiente mensaje del usuario.',
    `Mensaje: """${String(userMessage || '').trim()}"""`,
  ].join('\n');
}

function buildConsultationExtractionInstruction() {
  return [
    'Analiza un mensaje de un paciente por WhatsApp.',
    'Extrae sintomas y motivo de consulta solo si el mensaje realmente describe un problema de salud o malestar.',
    'Responde solo con JSON valido usando este formato exacto:',
    '{"sintomas":"texto resumido","motivoConsulta":"texto resumido","valid":true}',
    'Si no hay sintomas ni motivo de consulta claros, responde {"sintomas":null,"motivoConsulta":null,"valid":false}.',
    'No agregues explicaciones ni markdown.',
  ].join('\n');
}

function buildConsultationExtractionPrompt(userMessage) {
  return [
    'Extrae sintomas y motivo de consulta del siguiente mensaje.',
    `Mensaje: """${String(userMessage || '').trim()}"""`,
  ].join('\n');
}

function buildConsultationOrientationInstruction() {
  return [
    'Eres un asistente medico orientativo de telemedicina.',
    'Entrega una orientacion breve sobre causas leves y comunes segun los sintomas descritos.',
    'Maximo 2 oraciones.',
    'No saludes.',
    'No uses el nombre del paciente.',
    'Ve directo al punto.',
    'Nunca diagnostiques enfermedades graves.',
    'Nunca prescribas medicamentos.',
    'Siempre indica que debe validar con el doctor en la consulta.',
    'Responde en espanol simple de Chile.',
  ].join('\n');
}

function buildConsultationOrientationPrompt({ patientName, symptoms, reason }) {
  return [
    `Sintomas: ${String(symptoms || '').trim() || 'No especificados'}.`,
    `Motivo de consulta: ${String(reason || '').trim() || 'No especificado'}.`,
    'Entrega una orientacion breve y prudente, sin saludo y sin mencionar el nombre del paciente.',
  ].join('\n');
}

module.exports = {
  DEFAULT_WELCOME_MESSAGE,
  DEFAULT_HUMAN_HANDOFF_MESSAGE,
  DEFAULT_EMERGENCY_MESSAGE,
  buildBotSystemInstruction,
  buildFieldExtractionInstruction,
  buildFieldExtractionPrompt,
  buildFormExtractionInstruction,
  buildFormExtractionPrompt,
  buildConsultationExtractionInstruction,
  buildConsultationExtractionPrompt,
  buildConsultationOrientationInstruction,
  buildConsultationOrientationPrompt,
};
