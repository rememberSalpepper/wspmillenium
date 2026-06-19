const { FLOW_STATES } = require('../stores/patientFlowStore');
const { wantsRestart, isResetCommand } = require('../utils/intent');
const { formatSpanishDate } = require('../utils/dateFormat');
const { log } = require('../logger');

const NEW_CONSULTATION_MESSAGE =
  'Cuénteme brevemente sus síntomas y el motivo de su nueva consulta 🩺';

const MENU_MESSAGE = [
  'En qué puedo ayudarle?',
  '',
  '1) Nueva consulta médica',
  '2) Consultar estado de mi cita',
  '3) Cancelar o reagendar mi cita',
  '',
  'Escriba el número de la opción.',
].join('\n');

const MENU_BUTTONS = {
  type: 'buttons',
  buttons: [
    { id: '1', title: 'Nueva consulta' },
    { id: '2', title: 'Estado de cita' },
    { id: '3', title: 'Cancelar/reagendar' },
  ],
};

const MANAGE_BUTTONS = {
  type: 'buttons',
  buttons: [
    { id: '1', title: 'Cancelar cita' },
    { id: '2', title: 'Reagendar' },
    { id: '3', title: 'Volver' },
  ],
};

// Handles the COMPLETED-state main menu (post-consultation interactions).
// Returns a reply descriptor; the webhook is responsible for delivery.
function createMenuHandler({ database, patientFlowStore, conversationStore, config }) {
  const footer = (config && config.CLINIC_NAME) || undefined;
  const interactiveOn = Boolean(config && config.WHATSAPP_INTERACTIVE);
  const menuButtons = { ...MENU_BUTTONS, header: '🏥 ¿En qué le ayudamos?', footer };
  const manageButtons = { ...MANAGE_BUTTONS, header: '🗂️ Gestionar mi cita', footer };

  // With interactive buttons the numbered list is redundant; keep a short CTA and
  // let the buttons carry the options. Without interactive, fall back to the list.
  const menuBody = interactiveOn
    ? '¿En qué puedo ayudarte? Elige una opción 👇'
    : MENU_MESSAGE;

  // The default main-menu reply descriptor. Reused by the webhook to append the
  // menu after the returning-patient greeting.
  function getMenuReply() {
    return {
      body: menuBody,
      interactive: menuButtons,
      successEvent: 'outbound.completed_menu_sent',
      errorEvent: 'whatsapp.completed_menu_error',
    };
  }

  function handleMessage({ phone, prompt }) {
    const trimmed = String(prompt || '').trim();

    // Explicit reset / "borrar datos" → full delete.
    if (isResetCommand(prompt)) {
      database.resetPatient(phone);
      patientFlowStore.clearState(phone);
      conversationStore.clear(phone);
      log('info', 'flow.completed_reset', { from: phone });

      return {
        body: `Datos eliminados ✅\n\n${config.BOT_WELCOME_MESSAGE}`,
        skipWordLimit: true,
        successEvent: 'outbound.completed_reset_sent',
        errorEvent: 'whatsapp.completed_reset_error',
      };
    }

    // "nueva consulta" / "otra consulta" → new consultation, keep patient data.
    if (wantsRestart(prompt)) {
      log('info', 'flow.completed_new_consultation', { from: phone });
      conversationStore.clear(phone);
      patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION);

      return {
        body: NEW_CONSULTATION_MESSAGE,
        successEvent: 'outbound.new_consultation_sent',
        errorEvent: 'whatsapp.new_consultation_error',
      };
    }

    // Menu option "1" → new consultation.
    if (trimmed === '1') {
      log('info', 'flow.completed_menu_new_consultation', { from: phone });
      conversationStore.clear(phone);
      patientFlowStore.setState(phone, FLOW_STATES.CONSULTATION);

      return {
        body: NEW_CONSULTATION_MESSAGE,
        successEvent: 'outbound.menu_new_consultation_sent',
        errorEvent: 'whatsapp.menu_new_consultation_error',
      };
    }

    // Menu option "2" → appointment status (read from the real appointments
    // table, consistent with option 3 — never from consultation.appointment_status).
    if (trimmed === '2') {
      const scheduled = database.getScheduledAppointmentsByPhone(phone);

      if (!scheduled || scheduled.length === 0) {
        return {
          body: 'No tienes citas agendadas actualmente.\n\nSi deseas agendar, escribe "1" para una nueva consulta.',
          skipWordLimit: true,
          successEvent: 'outbound.appointment_status_sent',
          errorEvent: 'whatsapp.appointment_status_error',
        };
      }

      const apt = scheduled[0];
      const dateLabel = formatSpanishDate(apt.appointment_date, { withWeekday: true });

      return {
        body: [
          'Tu próxima cita está agendada:',
          `📅 ${dateLabel}`,
          `🕐 ${apt.appointment_time} hrs`,
        ].join('\n'),
        skipWordLimit: true,
        successEvent: 'outbound.appointment_status_sent',
        errorEvent: 'whatsapp.appointment_status_error',
      };
    }

    // Menu option "3" → cancel or reschedule appointment.
    if (trimmed === '3') {
      const scheduled = database.getScheduledAppointmentsByPhone(phone);

      if (!scheduled || scheduled.length === 0) {
        return {
          body: 'No tiene citas agendadas actualmente.',
          successEvent: 'outbound.no_appointments_sent',
          errorEvent: 'whatsapp.no_appointments_error',
        };
      }

      const apt = scheduled[0];
      const dateLabel = formatSpanishDate(apt.appointment_date, { withWeekday: true });

      const msgLines = [
        'Tu próxima cita:',
        `📅 Fecha: ${dateLabel}`,
        `🕐 Hora: ${apt.appointment_time} hrs`,
        '',
        '¿Qué deseas hacer?',
      ];
      if (interactiveOn) {
        msgLines.push('Elige una opción 👇');
      } else {
        msgLines.push('1) Cancelar cita', '2) Reagendar cita', '3) Volver', '', 'Responde con el número de la opción.');
      }
      const msg = msgLines.join('\n');

      patientFlowStore.setStateWithData(phone, FLOW_STATES.MANAGING_APPOINTMENT, { appointment: apt });

      return {
        body: msg,
        skipWordLimit: true,
        interactive: manageButtons,
        successEvent: 'outbound.manage_appointment_sent',
        errorEvent: 'whatsapp.manage_appointment_error',
      };
    }

    // Any other message → show menu.
    return getMenuReply();
  }

  return { handleMessage, getMenuReply };
}

module.exports = { createMenuHandler };
