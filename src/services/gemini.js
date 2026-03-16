const { GoogleGenAI } = require('@google/genai');
const { withTimeout } = require('../utils/timeout');

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

function createGeminiService(config) {
  const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

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

    const result = await withTimeout(
      ai.models.generateContent({
        model: config.GEMINI_MODEL,
        contents: requestContents,
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

  async function generateReply(contents) {
    return generateText({ contents });
  }

  return {
    generateText,
    generateReply,
    isGeminiQuotaError,
  };
}

module.exports = {
  createGeminiService,
  isGeminiQuotaError,
};
