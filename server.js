require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json({ limit: '2mb' }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GRAPH_VER = process.env.GRAPH_VERSION || 'v22.0';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PORT = Number(process.env.PORT || 3000);

const FALLBACK_QUOTA_MESSAGE =
  'Se agotó la cuota de la cuenta API de IA. Estamos en pruebas. Intenta nuevamente en un rato.';

const FALLBACK_TEMPORARY_MESSAGE =
  'Tu mensaje llegó, pero hubo un problema temporal al procesarlo. Intenta nuevamente en un rato.';

if (!VERIFY_TOKEN) console.error('Falta VERIFY_TOKEN en .env');
if (!WA_TOKEN) console.error('Falta WHATSAPP_TOKEN en .env');
if (!PHONE_NUMBER_ID) console.error('Falta PHONE_NUMBER_ID en .env');
if (!GEMINI_API_KEY) console.error('Falta GEMINI_API_KEY en .env');

console.log('CONFIG:', {
  VERIFY_TOKEN: VERIFY_TOKEN ? 'OK' : 'MISSING',
  WA_TOKEN: WA_TOKEN ? 'OK' : 'MISSING',
  PHONE_NUMBER_ID: PHONE_NUMBER_ID || 'MISSING',
  GRAPH_VER,
  GEMINI_API_KEY: GEMINI_API_KEY ? 'OK' : 'MISSING',
  GEMINI_MODEL,
  PORT,
});

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('GET /webhook', {
    mode,
    token,
    expected: VERIFY_TOKEN,
    match: token === VERIFY_TOKEN,
  });

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

function extractInboundText(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];

  if (!msg) return null;
  if (msg.type !== 'text') return null;

  return {
    from: msg.from,
    text: msg.text?.body ?? '',
    msgId: msg.id,
  };
}

async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/${GRAPH_VER}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: {
      body,
    },
  };

  console.log('POST WhatsApp URL:', url);
  console.log('TO:', to);
  console.log('BODY:', body);

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

  console.log('WhatsApp send OK:', JSON.stringify(response.data, null, 2));
  return response.data;
}

async function generateReply(prompt) {
  const result = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  const text = (result?.text ?? '').trim();
  return text || 'No pude generar una respuesta.';
}

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

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    if (value?.messages) {
      console.log('Inbound message event');
      console.log(JSON.stringify(value.messages, null, 2));
    } else if (value?.statuses) {
      console.log('Status event:', JSON.stringify(value.statuses, null, 2));
      return;
    } else {
      console.log('Webhook event ignorado');
      return;
    }

    const inbound = extractInboundText(req.body);
    if (!inbound) {
      console.log('No hay mensaje de texto procesable');
      return;
    }

    const { from, text, msgId } = inbound;
    const prompt = text.trim();

    console.log('FROM:', from);
    console.log('MSG ID:', msgId);
    console.log('TEXT:', prompt);

    if (!prompt) {
      console.log('Mensaje vacío, no se responde');
      return;
    }

    let reply;

    try {
      reply = await generateReply(prompt);
    } catch (geminiErr) {
      console.error('GEMINI ERR RAW:', geminiErr);
      console.error(
        'GEMINI ERR DATA:',
        JSON.stringify(geminiErr?.response?.data || null, null, 2)
      );
      console.error('GEMINI ERR STATUS:', geminiErr?.status ?? geminiErr?.response?.status ?? null);
      console.error('GEMINI ERR MSG:', geminiErr?.message);

      const fallbackMessage = isGeminiQuotaError(geminiErr)
        ? FALLBACK_QUOTA_MESSAGE
        : FALLBACK_TEMPORARY_MESSAGE;

      console.log('Enviando fallback por WhatsApp:', fallbackMessage);

      try {
        await sendWhatsAppText(from, fallbackMessage);
        console.log('Fallback enviado OK');
      } catch (waErr) {
        console.error('FALLBACK WA ERR RAW:', waErr);
        console.error(
          'FALLBACK WA ERR DATA:',
          JSON.stringify(waErr?.response?.data || null, null, 2)
        );
        console.error('FALLBACK WA ERR MSG:', waErr?.message);
      }

      return;
    }

    const safeReply = reply.length > 3500 ? reply.slice(0, 3500) : reply;

    await sendWhatsAppText(from, safeReply);
    console.log('Reply enviado OK');
  } catch (err) {
    console.error('ERR RAW:', err);
    console.error(
      'ERR DATA:',
      JSON.stringify(err?.response?.data || null, null, 2)
    );
    console.error('ERR MSG:', err?.message);
  }
});

app.listen(PORT, () => {
  console.log(`OK: http://localhost:${PORT}/webhook`);
});