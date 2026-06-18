const path = require('path');
const fs = require('fs');
const { createDatabase } = require('../src/database');
const { createMenuHandler } = require('../src/handlers/menuHandler');
const { PatientFlowStore, FLOW_STATES } = require('../src/stores/patientFlowStore');

let database;
let dbPath;
let patientFlowStore;
let conversationStore;
let menuHandler;

const PHONE = '56912345678';

const config = {
  BOT_WELCOME_MESSAGE: 'Bienvenido al formulario',
  WHATSAPP_INTERACTIVE: true,
};

beforeEach(() => {
  dbPath = path.join(__dirname, `test-menu-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = createDatabase({ DB_PATH: dbPath });

  database.createNewPatient(PHONE);
  database.upsertPatientField(PHONE, 'nombre', 'Maria');
  database.markFormCompleted(PHONE);

  patientFlowStore = new PatientFlowStore({ database, ttlMs: 60000 });
  conversationStore = { clear: jest.fn() };

  menuHandler = createMenuHandler({ database, patientFlowStore, conversationStore, config });
});

afterEach(() => {
  database.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
});

describe('menuHandler', () => {
  test('option 1 starts a new consultation', () => {
    const reply = menuHandler.handleMessage({ phone: PHONE, prompt: '1' });
    expect(reply.body).toContain('nueva consulta');
    expect(conversationStore.clear).toHaveBeenCalledWith(PHONE);
    expect(patientFlowStore.getState(PHONE)).toBe(FLOW_STATES.CONSULTATION);
  });

  test('option 2 with no scheduled appointment says so (ignores consultation status)', () => {
    const patient = database.getPatientByPhone(PHONE);
    // A stale consultation marked 'confirmed' must NOT make option 2 lie.
    database.createConsultation({
      phone: PHONE, patientId: patient.id, sintomas: 'tos',
      appointmentStatus: 'confirmed',
    });
    const reply = menuHandler.handleMessage({ phone: PHONE, prompt: '2' });
    expect(reply.body).toContain('No tienes citas agendadas');
  });

  test('option 2 with a scheduled appointment shows its date and time', () => {
    const patient = database.getPatientByPhone(PHONE);
    database.createAppointment({
      patientId: patient.id, phone: PHONE,
      date: '2026-12-15', time: '11:00', duration: 30,
    });
    const reply = menuHandler.handleMessage({ phone: PHONE, prompt: '2' });
    expect(reply.body).toContain('próxima cita');
    expect(reply.body).toContain('11:00');
  });

  test('option 3 with no appointments informs the user', () => {
    const reply = menuHandler.handleMessage({ phone: PHONE, prompt: '3' });
    expect(reply.body).toContain('No tiene citas');
  });

  test('option 3 with an appointment enters MANAGING_APPOINTMENT', () => {
    const patient = database.getPatientByPhone(PHONE);
    database.createAppointment({
      patientId: patient.id, phone: PHONE,
      date: '2026-12-15', time: '11:00', duration: 30,
    });

    const reply = menuHandler.handleMessage({ phone: PHONE, prompt: '3' });
    expect(reply.body).toContain('próxima cita');
    expect(reply.body).toContain('11:00');
    expect(reply.interactive.type).toBe('buttons');
    expect(patientFlowStore.getState(PHONE)).toBe(FLOW_STATES.MANAGING_APPOINTMENT);
  });

  test('reset command deletes data and returns welcome', () => {
    const reply = menuHandler.handleMessage({ phone: PHONE, prompt: 'borrar datos' });
    expect(reply.body).toContain('Datos eliminados');
    expect(reply.body).toContain(config.BOT_WELCOME_MESSAGE);
    expect(database.getPatientByPhone(PHONE)).toBeNull();
  });

  test('unrecognized input shows the menu with buttons', () => {
    const reply = menuHandler.handleMessage({ phone: PHONE, prompt: 'hola' });
    expect(reply.body).toContain('Elige una opción');
    expect(reply.interactive.buttons).toHaveLength(3);
  });
});
