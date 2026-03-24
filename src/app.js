const express = require('express');
const { config, missingEnv } = require('./config');
const { log } = require('./logger');
const { DedupStore } = require('./stores/dedupStore');
const { ConversationStore } = require('./stores/conversationStore');
const { SenderQueue } = require('./stores/senderQueue');
const { createWhatsAppService } = require('./services/whatsapp');
const { createGeminiService } = require('./services/gemini');
const { createWebhookRouter } = require('./routes/webhook');
const { InboundBufferStore } = require('./stores/inboundBufferStore');
const { createDatabase } = require('./database');
const { PatientFlowStore } = require('./stores/patientFlowStore');
const { createFormHandler } = require('./handlers/formHandler');
const { createConsultationHandler } = require('./handlers/consultationHandler');

if (missingEnv.length > 0) {
  log('error', 'config.missing', { missingEnv });
  process.exit(1);
}

log('info', 'config.ok', {
  VERIFY_TOKEN: 'OK',
  WA_TOKEN: 'OK',
  PHONE_NUMBER_ID: config.PHONE_NUMBER_ID,
  GRAPH_VER: config.GRAPH_VER,
  GEMINI_API_KEY: 'OK',
  GEMINI_MODEL: config.GEMINI_MODEL,
  PORT: config.PORT,
  MAX_REPLY_CHARS: config.MAX_REPLY_CHARS,
  GEMINI_TIMEOUT_MS: config.GEMINI_TIMEOUT_MS,
  MESSAGE_MAX_AGE_SECONDS: config.MESSAGE_MAX_AGE_SECONDS,
  DEDUP_TTL_MS: config.DEDUP_TTL_MS,
  CONVERSATION_TTL_MS: config.CONVERSATION_TTL_MS,
  CONTEXT_MAX_TURNS: config.CONTEXT_MAX_TURNS,
  CONTEXT_MAX_CHARS: config.CONTEXT_MAX_CHARS,
  PATIENT_FLOW_TTL_MS: config.PATIENT_FLOW_TTL_MS,
  DB_PATH: config.DB_PATH,
  IGNORE_SELF_MESSAGES: config.IGNORE_SELF_MESSAGES,

  BOT_SYSTEM_INSTRUCTION: config.BOT_SYSTEM_INSTRUCTION ? 'OK' : 'MISSING',

});

const app = express();
app.use(express.json({ limit: '2mb' }));

const dedupStore = new DedupStore({
  ttlMs: config.DEDUP_TTL_MS,
});

const conversationStore = new ConversationStore({
  ttlMs: config.CONVERSATION_TTL_MS,
  maxTurns: config.CONTEXT_MAX_TURNS,
  maxChars: config.CONTEXT_MAX_CHARS,
});

const senderQueue = new SenderQueue();

const inboundBufferStore = new InboundBufferStore({
  bufferMs: config.MESSAGE_BUFFER_MS,
});

const database = createDatabase(config);
const whatsappService = createWhatsAppService(config);
const geminiService = createGeminiService(config);
const patientFlowStore = new PatientFlowStore({
  database,
  ttlMs: config.PATIENT_FLOW_TTL_MS,
});
const formHandler = createFormHandler({
  database,
  patientFlowStore,
  geminiService,
});
const consultationHandler = createConsultationHandler({
  database,
  patientFlowStore,
  geminiService,
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'wa-bot',
    now: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    stores: {
      processedMessageIds: dedupStore.size(),
      activeConversations: conversationStore.size(),
      activeSenderQueues: senderQueue.size(),
      pendingInboundBuffers: inboundBufferStore.size(),
      activePatientFlows: patientFlowStore.size(),

    },
    config: {
      graphVersion: config.GRAPH_VER,
      geminiModel: config.GEMINI_MODEL,
      messageMaxAgeSeconds: config.MESSAGE_MAX_AGE_SECONDS,
      dedupTtlMs: config.DEDUP_TTL_MS,
      conversationTtlMs: config.CONVERSATION_TTL_MS,
      contextMaxTurns: config.CONTEXT_MAX_TURNS,
      contextMaxChars: config.CONTEXT_MAX_CHARS,
      ignoreSelfMessages: config.IGNORE_SELF_MESSAGES,
      hasSystemInstruction: Boolean(config.BOT_SYSTEM_INSTRUCTION),
      hasPriceTable: Boolean(config.BOT_PRICE_TABLE),
      botMaxWords: config.BOT_MAX_WORDS,
      messageBufferMs: config.MESSAGE_BUFFER_MS,
      patientFlowTtlMs: config.PATIENT_FLOW_TTL_MS,
      dbPath: config.DB_PATH,

    },
  });
});

app.use(
  '/webhook',
  createWebhookRouter({
    config,
    dedupStore,
    conversationStore,
    senderQueue,
    inboundBufferStore,
    whatsappService,
    geminiService,
    database,
    patientFlowStore,
    formHandler,
    consultationHandler,
  })
);

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    log('error', 'http.invalid_json', {
      message: err.message,
    });

    return res.status(400).json({
      ok: false,
      error: 'invalid_json',
    });
  }

  return next(err);
});

setInterval(() => {
  dedupStore.cleanup();
  conversationStore.cleanup();
  patientFlowStore.cleanup();
}, 5 * 60 * 1000).unref();

module.exports = {
  app,
  config,
  database,
};
