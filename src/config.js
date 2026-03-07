require('dotenv').config();

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

const config = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  WA_TOKEN: process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  GRAPH_VER: process.env.GRAPH_VERSION || 'v22.0',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  PORT: toNumber(process.env.PORT, 3000),

  BOT_SYSTEM_INSTRUCTION:
  process.env.BOT_SYSTEM_INSTRUCTION ||
  'Responde siempre únicamente en español. No respondas en inglés ni en otro idioma. Si el usuario escribe en otro idioma, responde igualmente en español.',

  MAX_REPLY_CHARS: toNumber(process.env.MAX_REPLY_CHARS, 3500),
  GEMINI_TIMEOUT_MS: toNumber(process.env.GEMINI_TIMEOUT_MS, 20000),
  MESSAGE_MAX_AGE_SECONDS: toNumber(process.env.MESSAGE_MAX_AGE_SECONDS, 300),

  DEDUP_TTL_MS: toNumber(process.env.DEDUP_TTL_MS, 6 * 60 * 60 * 1000),
  CONVERSATION_TTL_MS: toNumber(process.env.CONVERSATION_TTL_MS, 24 * 60 * 60 * 1000),
  CONTEXT_MAX_TURNS: toNumber(process.env.CONTEXT_MAX_TURNS, 12),
  CONTEXT_MAX_CHARS: toNumber(process.env.CONTEXT_MAX_CHARS, 12000),

  IGNORE_SELF_MESSAGES: toBoolean(process.env.IGNORE_SELF_MESSAGES, true),
};

const requiredEnv = [
  'VERIFY_TOKEN',
  'WA_TOKEN',
  'PHONE_NUMBER_ID',
  'GEMINI_API_KEY',
];

const missingEnv = requiredEnv.filter((key) => !config[key]);

module.exports = {
  config,
  missingEnv,
};