const { log } = require('../logger');
const { formatSpanishDate } = require('../utils/dateFormat');

// Builds the plain-text WhatsApp reminder body from the configured template.
function buildReminderText(config, { nombre, appointmentDate, appointmentTime }) {
  const fecha = formatSpanishDate(appointmentDate, { withWeekday: true });
  return String(config.BOT_REMINDER_MESSAGE || '')
    .replace(/\{nombre\}/g, nombre || '')
    .replace(/\{fecha\}/g, fecha)
    .replace(/\{hora\}/g, appointmentTime || '')
    .trim();
}

function createReminderService({ database, whatsappService, emailService, config }) {
  // Sends a reminder to the patient via WhatsApp. Uses a pre-approved template
  // when configured (works outside the 24h window), otherwise plain text.
  async function sendWhatsAppReminder(apt) {
    if (!config.WHATSAPP_REMINDERS || !apt?.phone) return false;

    const fecha = formatSpanishDate(apt.appointment_date, { withWeekday: true });

    try {
      if (config.WHATSAPP_REMINDER_TEMPLATE) {
        await whatsappService.sendTemplate(apt.phone, {
          name: config.WHATSAPP_REMINDER_TEMPLATE,
          languageCode: config.WHATSAPP_REMINDER_TEMPLATE_LANG,
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: String(apt.nombre || 'paciente') },
                { type: 'text', text: fecha },
                { type: 'text', text: String(apt.appointment_time || '') },
              ],
            },
          ],
        });
      } else {
        const body = buildReminderText(config, {
          nombre: apt.nombre,
          appointmentDate: apt.appointment_date,
          appointmentTime: apt.appointment_time,
        });
        await whatsappService.sendText(apt.phone, body);
      }

      log('info', 'reminder.whatsapp_sent', { aptId: apt.id, phone: apt.phone });
      return true;
    } catch (err) {
      log('error', 'reminder.whatsapp_failed', {
        aptId: apt.id,
        phone: apt.phone,
        error: err?.message,
        status: err?.response?.status ?? err?.status ?? null,
      });
      return false;
    }
  }

  async function sendEmailReminder(apt) {
    if (!config.EMAIL_REMINDERS) return false;

    try {
      return await emailService.sendAppointmentReminder({
        patient: { nombre: apt.nombre, rut: apt.rut, telefono: apt.telefono },
        appointmentDate: apt.appointment_date,
        appointmentTime: apt.appointment_time,
      });
    } catch (err) {
      log('error', 'reminder.email_failed', { aptId: apt.id, error: err?.message });
      return false;
    }
  }

  // Checks today's appointments and sends reminders for those starting soon.
  async function runReminderCheck() {
    try {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
      const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

      const appointments = database.getAppointmentsNeedingReminder(today);

      for (const apt of appointments) {
        const [h, m] = String(apt.appointment_time || '').split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) continue;

        const aptMinutes = h * 60 + m;
        const diff = aptMinutes - nowMinutes;

        // Send when the appointment is between 30 and 65 minutes away.
        if (diff > 0 && diff <= 65) {
          const [whatsappSent, emailSent] = await Promise.all([
            sendWhatsAppReminder(apt),
            sendEmailReminder(apt),
          ]);

          if (whatsappSent || emailSent) {
            database.markReminderSent(apt.id);
          }
        }
      }
    } catch (err) {
      log('error', 'reminder.scheduler_error', { error: err?.message });
    }
  }

  return { runReminderCheck, sendWhatsAppReminder, sendEmailReminder, buildReminderText };
}

module.exports = { createReminderService, buildReminderText };
