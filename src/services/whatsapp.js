const axios = require('axios');

function createWhatsAppService(config) {
  const messagesUrl = `https://graph.facebook.com/${config.GRAPH_VER}/${config.PHONE_NUMBER_ID}/messages`;

  function authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${config.WA_TOKEN}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async function postMessage(payload) {
    const response = await axios.post(messagesUrl, payload, {
      headers: authHeaders(),
      timeout: 15000,
    });
    return response.data;
  }

  async function sendText(to, body) {
    return postMessage({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    });
  }

  // buttons: [{ id, title }] — max 3, title max 20 chars
  async function sendInteractiveButtons(to, body, buttons) {
    const safeButtons = (Array.isArray(buttons) ? buttons : [])
      .slice(0, 3)
      .map((b) => ({
        type: 'reply',
        reply: { id: String(b.id), title: String(b.title).slice(0, 20) },
      }));

    return postMessage({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(body).slice(0, 1024) },
        action: { buttons: safeButtons },
      },
    });
  }

  // rows: [{ id, title, description? }] — max 10, title max 24 chars
  async function sendInteractiveList(to, body, buttonText, rows) {
    const safeRows = (Array.isArray(rows) ? rows : [])
      .slice(0, 10)
      .map((r) => {
        const row = { id: String(r.id), title: String(r.title).slice(0, 24) };
        if (r.description) row.description = String(r.description).slice(0, 72);
        return row;
      });

    return postMessage({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: String(body).slice(0, 1024) },
        action: {
          button: String(buttonText || 'Ver opciones').slice(0, 20),
          sections: [{ rows: safeRows }],
        },
      },
    });
  }

  // Send a pre-approved template message. Required to message a user outside the
  // 24h customer-service window (e.g. appointment reminders).
  // components: Meta template components array (e.g. body parameters). Optional.
  async function sendTemplate(to, { name, languageCode = 'es', components = [] } = {}) {
    if (!name) throw new Error('Template name is required');

    const template = {
      name: String(name),
      language: { code: String(languageCode || 'es') },
    };

    if (Array.isArray(components) && components.length > 0) {
      template.components = components;
    }

    return postMessage({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template,
    });
  }

  async function markAsReadAndTyping(messageId) {
    return postMessage({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    });
  }

  // Resolve a media id to a temporary download URL + mime type.
  async function getMediaInfo(mediaId) {
    const url = `https://graph.facebook.com/${config.GRAPH_VER}/${mediaId}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${config.WA_TOKEN}` },
      timeout: 15000,
    });
    return response.data; // { url, mime_type, sha256, file_size, id }
  }

  // Download media bytes; returns { buffer, mimeType }.
  async function downloadMedia(mediaId) {
    const info = await getMediaInfo(mediaId);
    const response = await axios.get(info.url, {
      headers: { Authorization: `Bearer ${config.WA_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 20000,
    });
    return { buffer: Buffer.from(response.data), mimeType: info.mime_type };
  }

  return {
    sendText,
    sendTemplate,
    sendInteractiveButtons,
    sendInteractiveList,
    markAsReadAndTyping,
    getMediaInfo,
    downloadMedia,
  };
}

module.exports = { createWhatsAppService };
