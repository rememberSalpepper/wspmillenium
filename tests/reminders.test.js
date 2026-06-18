const { createReminderService, buildReminderText } = require('../src/services/reminders');

const baseConfig = {
  WHATSAPP_REMINDERS: true,
  WHATSAPP_REMINDER_TEMPLATE: '',
  WHATSAPP_REMINDER_TEMPLATE_LANG: 'es',
  EMAIL_REMINDERS: true,
  BOT_REMINDER_MESSAGE: 'Hola {nombre}, su cita es el {fecha} a las {hora}.',
};

const apt = {
  id: 7,
  phone: '56912345678',
  nombre: 'Maria',
  rut: '11.111.111-1',
  telefono: '912345678',
  appointment_date: '2026-03-05',
  appointment_time: '10:30',
};

describe('buildReminderText', () => {
  test('fills placeholders with formatted date', () => {
    const text = buildReminderText(baseConfig, {
      nombre: 'Maria',
      appointmentDate: '2026-03-05',
      appointmentTime: '10:30',
    });
    expect(text).toContain('Hola Maria');
    expect(text).toContain('5 de marzo');
    expect(text).toContain('10:30');
  });
});

describe('createReminderService.sendWhatsAppReminder', () => {
  test('sends plain text when no template configured', async () => {
    const whatsappService = { sendText: jest.fn().mockResolvedValue({}), sendTemplate: jest.fn() };
    const svc = createReminderService({
      database: {}, whatsappService, emailService: {}, config: baseConfig,
    });

    const ok = await svc.sendWhatsAppReminder(apt);
    expect(ok).toBe(true);
    expect(whatsappService.sendText).toHaveBeenCalledTimes(1);
    expect(whatsappService.sendTemplate).not.toHaveBeenCalled();
    const [to, body] = whatsappService.sendText.mock.calls[0];
    expect(to).toBe('56912345678');
    expect(body).toContain('Maria');
  });

  test('sends a template when configured', async () => {
    const whatsappService = { sendText: jest.fn(), sendTemplate: jest.fn().mockResolvedValue({}) };
    const config = { ...baseConfig, WHATSAPP_REMINDER_TEMPLATE: 'recordatorio_cita' };
    const svc = createReminderService({
      database: {}, whatsappService, emailService: {}, config,
    });

    const ok = await svc.sendWhatsAppReminder(apt);
    expect(ok).toBe(true);
    expect(whatsappService.sendTemplate).toHaveBeenCalledTimes(1);
    const [to, opts] = whatsappService.sendTemplate.mock.calls[0];
    expect(to).toBe('56912345678');
    expect(opts.name).toBe('recordatorio_cita');
    expect(opts.components[0].parameters).toHaveLength(3);
  });

  test('returns false and does not throw when sending fails', async () => {
    const whatsappService = { sendText: jest.fn().mockRejectedValue(new Error('boom')), sendTemplate: jest.fn() };
    const svc = createReminderService({
      database: {}, whatsappService, emailService: {}, config: baseConfig,
    });
    const ok = await svc.sendWhatsAppReminder(apt);
    expect(ok).toBe(false);
  });

  test('skips WhatsApp when disabled', async () => {
    const whatsappService = { sendText: jest.fn(), sendTemplate: jest.fn() };
    const svc = createReminderService({
      database: {}, whatsappService, emailService: {},
      config: { ...baseConfig, WHATSAPP_REMINDERS: false },
    });
    const ok = await svc.sendWhatsAppReminder(apt);
    expect(ok).toBe(false);
    expect(whatsappService.sendText).not.toHaveBeenCalled();
  });

  test('marks reminder sent when at least one channel succeeds', async () => {
    // Appointment ~45 min from "now" in Chile.
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
    const target = new Date(now.getTime() + 45 * 60 * 1000);
    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });

    const soonApt = { ...apt, appointment_date: today, appointment_time: `${hh}:${mm}` };

    const markReminderSent = jest.fn();
    const database = {
      getAppointmentsNeedingReminder: jest.fn().mockReturnValue([soonApt]),
      markReminderSent,
    };
    const whatsappService = { sendText: jest.fn().mockResolvedValue({}), sendTemplate: jest.fn() };
    const emailService = { sendAppointmentReminder: jest.fn().mockResolvedValue(false) };

    const svc = createReminderService({ database, whatsappService, emailService, config: baseConfig });
    await svc.runReminderCheck();

    expect(whatsappService.sendText).toHaveBeenCalledTimes(1);
    expect(markReminderSent).toHaveBeenCalledWith(7);
  });
});
