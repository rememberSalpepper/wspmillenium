const axios = require('axios');

function createWhatsAppService(config) {
  async function sendText(to, body) {
    const url = `https://graph.facebook.com/${config.GRAPH_VER}/${config.PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body,
      },
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${config.WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    return response.data;
  }

  async function markAsReadAndTyping(messageId) {
    const url = `https://graph.facebook.com/${config.GRAPH_VER}/${config.PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: {
        type: 'text',
      },
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${config.WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    return response.data;
  }

  return {
    sendText,
    markAsReadAndTyping,
  };
}

module.exports = { createWhatsAppService };