jest.mock('axios');
const axios = require('axios');
const { createWhatsAppService } = require('../src/services/whatsapp');

const config = { GRAPH_VER: 'v22.0', PHONE_NUMBER_ID: '123', WA_TOKEN: 'tok' };

beforeEach(() => {
  axios.post = jest.fn().mockResolvedValue({ data: {} });
});

describe('sendTemplate', () => {
  test('builds a template payload with language and components', async () => {
    const wa = createWhatsAppService(config);
    await wa.sendTemplate('569', {
      name: 'recordatorio_cita',
      languageCode: 'es',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Maria' }] }],
    });

    const [url, payload] = axios.post.mock.calls[0];
    expect(url).toContain('/123/messages');
    expect(payload.type).toBe('template');
    expect(payload.template.name).toBe('recordatorio_cita');
    expect(payload.template.language).toEqual({ code: 'es' });
    expect(payload.template.components).toHaveLength(1);
  });

  test('omits components when none are given', async () => {
    const wa = createWhatsAppService(config);
    await wa.sendTemplate('569', { name: 'hello_world' });

    const [, payload] = axios.post.mock.calls[0];
    expect(payload.template.name).toBe('hello_world');
    expect(payload.template.language.code).toBe('es');
    expect(payload.template.components).toBeUndefined();
  });

  test('throws when template name is missing', async () => {
    const wa = createWhatsAppService(config);
    await expect(wa.sendTemplate('569', {})).rejects.toThrow('Template name is required');
  });
});
