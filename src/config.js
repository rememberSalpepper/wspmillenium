require('dotenv').config();

const {
  DEFAULT_WELCOME_MESSAGE,
  DEFAULT_HUMAN_HANDOFF_MESSAGE,
  DEFAULT_EMERGENCY_MESSAGE,
  buildBotSystemInstruction,
} = require('./botPrompt');

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

function toMultilineText(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;

  return String(value)
    .replace(/\\n/g, '\n')
    .trim();
}

const botPriceTable =
  toMultilineText(process.env.BOT_PRICE_TABLE) ||
  toMultilineText(process.env.BOT_PRICING_TABLE);

const botAdditionalInstruction = toMultilineText(process.env.BOT_SYSTEM_INSTRUCTION);
const botInstructionOverride = toMultilineText(process.env.BOT_SYSTEM_INSTRUCTION_OVERRIDE);
const botWelcomeMessage =
  toMultilineText(process.env.BOT_WELCOME_MESSAGE, DEFAULT_WELCOME_MESSAGE) ||
  DEFAULT_WELCOME_MESSAGE;
const botHumanHandoffMessage =
  toMultilineText(process.env.BOT_HUMAN_HANDOFF_MESSAGE, DEFAULT_HUMAN_HANDOFF_MESSAGE) ||
  DEFAULT_HUMAN_HANDOFF_MESSAGE;
const botEmergencyMessage =
  toMultilineText(process.env.BOT_EMERGENCY_MESSAGE, DEFAULT_EMERGENCY_MESSAGE) ||
  DEFAULT_EMERGENCY_MESSAGE;
const botSystemInstruction =
  botInstructionOverride ||
  buildBotSystemInstruction({
    pricingTableText: botPriceTable,
    extraInstruction: botAdditionalInstruction,
  });

const config = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  WA_TOKEN: process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  GRAPH_VER: process.env.GRAPH_VERSION || 'v22.0',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  PORT: toNumber(process.env.PORT, 3000),

  BOT_SYSTEM_INSTRUCTION: botSystemInstruction,
  BOT_PRICE_TABLE: botPriceTable,
  BOT_WELCOME_MESSAGE: botWelcomeMessage,
  BOT_HUMAN_HANDOFF_MESSAGE: botHumanHandoffMessage,
  BOT_EMERGENCY_MESSAGE: botEmergencyMessage,
  BOT_MAX_WORDS: toNumber(process.env.BOT_MAX_WORDS, 120),

  MAX_REPLY_CHARS: toNumber(process.env.MAX_REPLY_CHARS, 3500),
  GEMINI_TIMEOUT_MS: toNumber(process.env.GEMINI_TIMEOUT_MS, 20000),
  MESSAGE_MAX_AGE_SECONDS: toNumber(process.env.MESSAGE_MAX_AGE_SECONDS, 300),
  MESSAGE_BUFFER_MS: toNumber(process.env.MESSAGE_BUFFER_MS, 2500),

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
