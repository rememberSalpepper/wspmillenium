const { GoogleGenAI } = require('@google/genai');
const { withTimeout } = require('../utils/timeout');
const { log } = require('../logger');

function isGeminiQuotaError(err) {
  const status = err?.status ?? err?.response?.status ?? err?.code ?? null;
  const message = String(err?.message || '').toLowerCase();
  const details = JSON.stringify(err?.response?.data || err || {}).toLowerCase();

  return (
    status === 429 ||
    String(status) === '429' ||
    message.includes('quota exceeded') ||
    message.includes('resource exhausted') ||
    message.includes('resource_exhausted') ||
    details.includes('quota exceeded') ||
    details.includes('resource exhausted') ||
    details.includes('resource_exhausted') ||
    details.includes('generate_content_free_tier_requests')
  );
}

function isTransientError(err) {
  const message = String(err?.message || '').toLowerCase();
  const status = err?.status ?? err?.response?.status ?? err?.code ?? null;
  return (
    status === 503 ||
    String(status) === '503' ||
    message.includes('503') ||
    message.includes('unavailable') ||
    message.includes('high demand') ||
    message.includes('overloaded') ||
    message.includes('internal error') ||
    status === 500 ||
    String(status) === '500'
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGeminiService(config) {
  const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  const maxRetries = config.GEMINI_RETRY_COUNT ?? 2;
  const baseDelay = config.GEMINI_RETRY_DELAY_MS ?? 1500;
  const fallbackModel = config.GEMINI_FALLBACK_MODEL || '';

  async function callGemini({ model, contents, systemInstruction }) {
    const result = await withTimeout(
      ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
        },
      }),
      config.GEMINI_TIMEOUT_MS,
      'Gemini timeout'
    );
    const text = (result?.text ?? '').trim();
    return text || 'No pude generar una respuesta.';
  }

  async function generateText({
    contents = null,
    prompt = '',
    systemInstruction = config.BOT_SYSTEM_INSTRUCTION,
  }) {
    const requestContents = Array.isArray(contents) && contents.length > 0
      ? contents
      : [
          {
            role: 'user',
            parts: [{ text: String(prompt || '').trim() }],
          },
        ];

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await callGemini({
          model: config.GEMINI_MODEL,
          contents: requestContents,
          systemInstruction,
        });
      } catch (err) {
        lastError = err;
        const retryable = isTransientError(err) || isGeminiQuotaError(err);

        if (attempt < maxRetries && retryable) {
          const delay = baseDelay * Math.pow(2, attempt);
          log('warn', 'gemini.retry', {
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
            model: config.GEMINI_MODEL,
            error: String(err?.message || '').slice(0, 200),
          });
          await sleep(delay);
          continue;
        }

        if (retryable && fallbackModel && fallbackModel !== config.GEMINI_MODEL) {
          try {
            log('warn', 'gemini.fallback', {
              from: config.GEMINI_MODEL,
              to: fallbackModel,
              error: String(err?.message || '').slice(0, 200),
            });
            return await callGemini({
              model: fallbackModel,
              contents: requestContents,
              systemInstruction,
            });
          } catch (fallbackErr) {
            log('error', 'gemini.fallback_failed', {
              model: fallbackModel,
              error: String(fallbackErr?.message || '').slice(0, 200),
            });
            throw fallbackErr;
          }
        }

        throw err;
      }
    }

    throw lastError;
  }

  async function generateReply(contents) {
    return generateText({ contents });
  }

  // data: base64-encoded audio bytes. Returns the transcribed text.
  async function transcribeAudio({ data, mimeType }) {
    const contents = [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: mimeType || 'audio/ogg', data } },
          {
            text:
              'Transcribe este audio en español. Devuelve únicamente el texto transcrito, ' +
              'sin comentarios ni explicaciones.',
          },
        ],
      },
    ];

    return generateText({
      contents,
      systemInstruction:
        'Eres un transcriptor de audio. Devuelve solo la transcripción literal del audio en español.',
    });
  }

  return {
    generateText,
    generateReply,
    transcribeAudio,
    isGeminiQuotaError,
    isTransientError,
  };
}

module.exports = {
  createGeminiService,
  isGeminiQuotaError,
};
