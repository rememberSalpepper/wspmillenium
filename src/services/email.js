const nodemailer = require('nodemailer');
const { log } = require('../logger');

function createEmailService(config) {
  if (!config.SMTP_HOST || !config.NOTIFY_EMAIL) {
    log('info', 'email.disabled', { reason: 'SMTP_HOST or NOTIFY_EMAIL not configured' });
    return {
      sendAppointmentNotification: async () => false,
      sendEmergencyNotification: async () => false,
      sendAppointmentReminder: async () => false,
      sendCancellationNotification: async () => false,
      sendRescheduleNotification: async () => false,
    };
  }

  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    },
  });

  async function sendAppointmentNotification({ patient, consultation, symptoms, appointmentDate, appointmentTime }) {
    const symptomList = Array.isArray(symptoms)
      ? symptoms.map((s) => s.sintoma || s).join(', ')
      : '';

    const lines = [
      'Nueva cita médica agendada',
      '',
      `Paciente: ${patient?.nombre || '-'}`,
      `RUT: ${patient?.rut || '-'}`,
      `Teléfono: ${patient?.telefono || patient?.phone || '-'}`,
      `Email: ${patient?.correo || '-'}`,
      `Dirección: ${patient?.direccion || '-'}`,
    ];

    if (appointmentDate) {
      lines.push('');
      lines.push(`Fecha cita: ${appointmentDate}`);
      if (appointmentTime) lines.push(`Hora cita: ${appointmentTime}`);
    }

    lines.push(
      '',
      `Síntomas: ${consultation?.sintomas || symptomList || '-'}`,
      `Motivo: ${consultation?.motivo_consulta || '-'}`,
      `Orientación: ${consultation?.orientacion || '-'}`,
      '',
      `Fecha solicitud: ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}`,
    );

    const body = lines.join('\n');

    try {
      await transporter.sendMail({
        from: config.SMTP_USER,
        to: config.NOTIFY_EMAIL,
        subject: `Nueva cita - ${patient?.nombre || 'Paciente'}`,
        text: body,
      });

      log('info', 'email.appointment_sent', {
        to: config.NOTIFY_EMAIL,
        patient: patient?.nombre,
      });
      return true;
    } catch (err) {
      log('error', 'email.appointment_failed', {
        error: err?.message,
        to: config.NOTIFY_EMAIL,
      });
      return false;
    }
  }

  async function sendEmergencyNotification({ phone, message }) {
    const body = [
      'ALERTA DE EMERGENCIA',
      '',
      `Número: ${phone}`,
      `Mensaje del paciente: ${message}`,
      '',
      `Fecha: ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}`,
      '',
      'El paciente fue instruido a acudir a urgencias.',
    ].join('\n');

    try {
      await transporter.sendMail({
        from: config.SMTP_USER,
        to: config.NOTIFY_EMAIL,
        subject: `EMERGENCIA - Paciente ${phone}`,
        text: body,
      });

      log('info', 'email.emergency_sent', { to: config.NOTIFY_EMAIL, phone });
      return true;
    } catch (err) {
      log('error', 'email.emergency_failed', {
        error: err?.message,
        to: config.NOTIFY_EMAIL,
      });
      return false;
    }
  }

  async function sendAppointmentReminder({ patient, appointmentDate, appointmentTime }) {
    const monthNames = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const [, month, day] = appointmentDate.split('-');
    const dateLabel = `${parseInt(day)} de ${monthNames[parseInt(month)]}`;

    const body = [
      'RECORDATORIO DE CITA',
      '',
      `Paciente: ${patient?.nombre || '-'}`,
      `RUT: ${patient?.rut || '-'}`,
      `Teléfono: ${patient?.telefono || '-'}`,
      '',
      `Fecha: ${dateLabel}`,
      `Hora: ${appointmentTime}`,
      '',
      'Esta cita es en aproximadamente 1 hora.',
    ].join('\n');

    try {
      await transporter.sendMail({
        from: config.SMTP_USER,
        to: config.NOTIFY_EMAIL,
        subject: `Recordatorio: ${patient?.nombre || 'Paciente'} a las ${appointmentTime}`,
        text: body,
      });

      log('info', 'email.reminder_sent', { to: config.NOTIFY_EMAIL, patient: patient?.nombre, time: appointmentTime });
      return true;
    } catch (err) {
      log('error', 'email.reminder_failed', { error: err?.message, to: config.NOTIFY_EMAIL });
      return false;
    }
  }

  async function sendCancellationNotification({ patient, appointment }) {
    const monthNames = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const [, month, day] = appointment.appointment_date.split('-');
    const dateLabel = `${parseInt(day)} de ${monthNames[parseInt(month)]}`;

    const body = [
      'CITA CANCELADA POR PACIENTE',
      '',
      `Paciente: ${patient?.nombre || '-'}`,
      `RUT: ${patient?.rut || '-'}`,
      `Teléfono: ${patient?.telefono || patient?.phone || '-'}`,
      '',
      `Fecha cita: ${dateLabel}`,
      `Hora cita: ${appointment.appointment_time}`,
      '',
      `Fecha cancelación: ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}`,
    ].join('\n');

    try {
      await transporter.sendMail({
        from: config.SMTP_USER,
        to: config.NOTIFY_EMAIL,
        subject: `Cita cancelada - ${patient?.nombre || 'Paciente'}`,
        text: body,
      });

      log('info', 'email.cancellation_sent', { to: config.NOTIFY_EMAIL, patient: patient?.nombre });
      return true;
    } catch (err) {
      log('error', 'email.cancellation_failed', { error: err?.message, to: config.NOTIFY_EMAIL });
      return false;
    }
  }

  async function sendRescheduleNotification({ patient, oldAppointment, newDate, newTime }) {
    const monthNames = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

    const [, oldMonth, oldDay] = oldAppointment.appointment_date.split('-');
    const oldDateLabel = `${parseInt(oldDay)} de ${monthNames[parseInt(oldMonth)]}`;

    const [, newMonth, newDay] = newDate.split('-');
    const newDateLabel = `${parseInt(newDay)} de ${monthNames[parseInt(newMonth)]}`;

    const body = [
      'CITA REAGENDADA POR PACIENTE',
      '',
      `Paciente: ${patient?.nombre || '-'}`,
      `RUT: ${patient?.rut || '-'}`,
      `Teléfono: ${patient?.telefono || patient?.phone || '-'}`,
      '',
      `Fecha anterior: ${oldDateLabel} a las ${oldAppointment.appointment_time}`,
      `Nueva fecha: ${newDateLabel} a las ${newTime}`,
      '',
      `Fecha reagendamiento: ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}`,
    ].join('\n');

    try {
      await transporter.sendMail({
        from: config.SMTP_USER,
        to: config.NOTIFY_EMAIL,
        subject: `Cita reagendada - ${patient?.nombre || 'Paciente'}`,
        text: body,
      });

      log('info', 'email.reschedule_sent', { to: config.NOTIFY_EMAIL, patient: patient?.nombre });
      return true;
    } catch (err) {
      log('error', 'email.reschedule_failed', { error: err?.message, to: config.NOTIFY_EMAIL });
      return false;
    }
  }

  log('info', 'email.enabled', { notifyEmail: config.NOTIFY_EMAIL });

  return {
    sendAppointmentNotification,
    sendEmergencyNotification,
    sendAppointmentReminder,
    sendCancellationNotification,
    sendRescheduleNotification,
  };
}

module.exports = { createEmailService };
