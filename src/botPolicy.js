const EMERGENCY_PATTERNS = [
  'dolor intenso',
  'dolor muy fuerte',
  'dificultad para respirar',
  'no puedo respirar',
  'me falta el aire',
  'sangrado abundante',
  'mucho sangrado',
  'hemorragia',
  'dolor en el pecho',
  'dolor toracico',
  'presion en el pecho',
  'sintomas neurologicos',
  'cara caida',
  'convulsion',
  'convulsiones',
  'desmayo',
  'desmaye',
  'perdida de conciencia',
  'paralisis',
  'debilidad en un lado',
  'no puedo mover',
  'hablo enredado',
  'hablar raro',
];

const HUMAN_HANDOFF_PATTERNS = [
  /\b(hablar|comunicarme|derivarme|derivame|pasarme|pasar|transferirme|transferir)\b.{0,30}\b(persona|humano|humana|asesor|asesora|agente|operador)\b/,
  /\b(persona real|agente humano|asistente humana)\b/,
  /\bnecesito\b.{0,20}\b(persona|humano|humana|asesor|asesora|agente|operador)\b/,
];

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function hasPattern(text, patterns) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return false;

  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) {
      return pattern.test(normalized);
    }

    return normalized.includes(pattern);
  });
}

function isEmergencyMessage(text) {
  return hasPattern(text, EMERGENCY_PATTERNS);
}

function wantsHumanHandoff(text) {
  return hasPattern(text, HUMAN_HANDOFF_PATTERNS);
}

function limitReplyWords(text, maxWords) {
  const clean = String(text || '').trim();
  if (!clean) return '';

  const limit = Number(maxWords);
  if (!Number.isFinite(limit) || limit <= 0) {
    return clean;
  }

  const lines = clean.split('\n');
  let wordCount = 0;
  const resultLines = [];

  for (const line of lines) {
    const trimmedLine = line.replace(/[ \t]+/g, ' ').trim();
    if (!trimmedLine) {
      resultLines.push('');
      continue;
    }

    const lineWords = trimmedLine.split(' ');
    if (wordCount + lineWords.length <= limit) {
      resultLines.push(trimmedLine);
      wordCount += lineWords.length;
    } else {
      const remaining = limit - wordCount;
      if (remaining > 0) {
        resultLines.push(`${lineWords.slice(0, remaining).join(' ')}...`);
      }
      break;
    }
  }

  return resultLines.join('\n').trim();
}

function getAutomatedReply({ prompt, isFirstInteraction, config }) {
  if (isEmergencyMessage(prompt)) {
    return {
      kind: 'emergency',
      body: config.BOT_EMERGENCY_MESSAGE,
    };
  }

  if (wantsHumanHandoff(prompt)) {
    return {
      kind: 'human_handoff',
      body: config.BOT_HUMAN_HANDOFF_MESSAGE,
    };
  }

  if (isFirstInteraction) {
    return {
      kind: 'welcome',
      body: config.BOT_WELCOME_MESSAGE,
    };
  }

  return null;
}

module.exports = {
  getAutomatedReply,
  isEmergencyMessage,
  wantsHumanHandoff,
  limitReplyWords,
};
