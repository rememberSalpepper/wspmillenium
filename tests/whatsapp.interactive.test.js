jest.mock('axios');
const axios = require('axios');
const { createWhatsAppService } = require('../src/services/whatsapp');

const config = { GRAPH_VER: 'v22.0', PHONE_NUMBER_ID: '123', WA_TOKEN: 'tok' };

beforeEach(() => {
  axios.post = jest.fn().mockResolvedValue({ data: {} });
  axios.get = jest.fn();
});

describe('sendInteractiveButtons', () => {
  test('builds a button interactive payload', async () => {
    const wa = createWhatsAppService(config);
    await wa.sendInteractiveButtons('569', 'Elige', [
      { id: '1', title: 'Uno' },
      { id: '2', title: 'Dos' },
    ]);

    const [url, payload] = axios.post.mock.calls[0];
    expect(url).toContain('/123/messages');
    expect(payload.type).toBe('interactive');
    expect(payload.interactive.type).toBe('button');
    expect(payload.interactive.body.text).toBe('Elige');
    expect(payload.interactive.action.buttons).toHaveLength(2);
    expect(payload.interactive.action.buttons[0]).toEqual({
      type: 'reply',
      reply: { id: '1', title: 'Uno' },
    });
  });

  test('caps at 3 buttons and truncates titles to 20 chars', async () => {
    const wa = createWhatsAppService(config);
    await wa.sendInteractiveButtons('569', 'b', [
      { id: '1', title: 'x'.repeat(30) },
      { id: '2', title: 'b' },
      { id: '3', title: 'c' },
      { id: '4', title: 'd' },
    ]);

    const payload = axios.post.mock.calls[0][1];
    expect(payload.interactive.action.buttons).toHaveLength(3);
    expect(payload.interactive.action.buttons[0].reply.title).toHaveLength(20);
  });
});

describe('sendInteractiveList', () => {
  test('builds a list interactive payload', async () => {
    const wa = createWhatsAppService(config);
    await wa.sendInteractiveList('569', 'Horarios', 'Ver', [
      { id: '1', title: 'Lun 09:00' },
      { id: '2', title: 'Mar 10:00' },
    ]);

    const payload = axios.post.mock.calls[0][1];
    expect(payload.interactive.type).toBe('list');
    expect(payload.interactive.action.button).toBe('Ver');
    expect(payload.interactive.action.sections[0].rows).toHaveLength(2);
    expect(payload.interactive.action.sections[0].rows[0]).toEqual({ id: '1', title: 'Lun 09:00' });
  });

  test('attaches header and footer when provided', async () => {
    const wa = createWhatsAppService(config);
    await wa.sendInteractiveList('569', 'Elige día', 'Ver días', [{ id: '1', title: 'Lun 18' }], {
      header: 'Agendar hora',
      footer: 'Consultas Milenium',
    });

    const payload = axios.post.mock.calls[0][1];
    expect(payload.interactive.header).toEqual({ type: 'text', text: 'Agendar hora' });
    expect(payload.interactive.footer).toEqual({ text: 'Consultas Milenium' });
  });

  test('uses explicit sections and caps total rows at 10', async () => {
    const wa = createWhatsAppService(config);
    const manyRows = Array.from({ length: 8 }, (_, i) => ({ id: String(i), title: `r${i}` }));
    await wa.sendInteractiveList('569', 'b', 'Ver', null, {
      sections: [
        { title: 'Mañana', rows: manyRows },
        { title: 'Tarde', rows: manyRows },
      ],
    });

    const payload = axios.post.mock.calls[0][1];
    const sections = payload.interactive.action.sections;
    const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0);
    expect(totalRows).toBe(10);
    expect(sections[0].title).toBe('Mañana');
  });
});

describe('sendInteractiveButtons header/footer', () => {
  test('attaches header and footer when provided', async () => {
    const wa = createWhatsAppService(config);
    await wa.sendInteractiveButtons('569', 'Confirmar', [{ id: 'si', title: 'Sí' }], {
      header: 'Confirmar hora',
      footer: 'Consultas Milenium',
    });

    const payload = axios.post.mock.calls[0][1];
    expect(payload.interactive.header).toEqual({ type: 'text', text: 'Confirmar hora' });
    expect(payload.interactive.footer).toEqual({ text: 'Consultas Milenium' });
  });
});

describe('downloadMedia', () => {
  test('resolves the media url then downloads the bytes', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { url: 'https://media/x', mime_type: 'audio/ogg' } })
      .mockResolvedValueOnce({ data: Buffer.from('hola') });

    const wa = createWhatsAppService(config);
    const res = await wa.downloadMedia('media123');

    expect(res.mimeType).toBe('audio/ogg');
    expect(Buffer.isBuffer(res.buffer)).toBe(true);
    expect(res.buffer.toString()).toBe('hola');
    expect(axios.get).toHaveBeenCalledTimes(2);
    // First call resolves media info, second downloads from the returned url.
    expect(axios.get.mock.calls[0][0]).toContain('/media123');
    expect(axios.get.mock.calls[1][0]).toBe('https://media/x');
  });
});
