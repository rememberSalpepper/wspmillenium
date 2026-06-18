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

  // Optional header/footer used to make interactive messages look more polished.
  // header is rendered in bold above the body; footer is small grey text below it.
  function decorateInteractive(interactive, options = {}) {
    const header = options.header ? String(options.header).trim() : '';
    const footer = options.footer ? String(options.footer).trim() : '';
    if (header) interactive.header = { type: 'text', text: header.slice(0, 60) };
    if (footer) interactive.footer = { text: footer.slice(0, 60) };
    return interactive;
  }

  // buttons: [{ id, title }] — max 3, title max 20 chars
  // options: { header?, footer? }
  async function sendInteractiveButtons(to, body, buttons, options = {}) {
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
      interactive: decorateInteractive(
        {
          type: 'button',
          body: { text: String(body).slice(0, 1024) },
          action: { buttons: safeButtons },
        },
        options
      ),
    });
  }

  function mapListRow(r) {
    const row = { id: String(r.id), title: String(r.title).slice(0, 24) };
    if (r.description) row.description = String(r.description).slice(0, 72);
    return row;
  }

  // rows: [{ id, title, description? }] — max 10 rows total, title max 24 chars
  // options: { header?, footer?, sections? }
  //   sections: [{ title?, rows: [...] }] — used instead of `rows` when provided.
  // WhatsApp caps the total number of rows across all sections at 10.
  async function sendInteractiveList(to, body, buttonText, rows, options = {}) {
    let sections;
    let budget = 10;

    if (Array.isArray(options.sections) && options.sections.length > 0) {
      sections = [];
      for (const s of options.sections) {
        if (budget <= 0) break;
        const sectionRows = (Array.isArray(s.rows) ? s.rows : [])
          .slice(0, budget)
          .map(mapListRow);
        if (sectionRows.length === 0) continue;
        budget -= sectionRows.length;
        const section = { rows: sectionRows };
        if (s.title) section.title = String(s.title).slice(0, 24);
        sections.push(section);
      }
    } else {
      const safeRows = (Array.isArray(rows) ? rows : []).slice(0, 10).map(mapListRow);
      sections = [{ rows: safeRows }];
    }

    return postMessage({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: decorateInteractive(
        {
          type: 'list',
          body: { text: String(body).slice(0, 1024) },
          action: {
            button: String(buttonText || 'Ver opciones').slice(0, 20),
            sections,
          },
        },
        options
      ),
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
