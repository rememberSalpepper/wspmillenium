const path = require('path');
const fs = require('fs');
const { createDatabase } = require('../src/database');
const { PatientFlowStore, FLOW_STATES } = require('../src/stores/patientFlowStore');
const { createConsultationHandler } = require('../src/handlers/consultationHandler');

let database;
let dbPath;
let patientFlowStore;
let handler;

const PHONE = '56912345678';

const config = {
  APPOINTMENT_SLOT_DURATION: 30,
  APPOINTMENT_LOOKAHEAD_DAYS: 14,
  CLINIC_NAME: 'Consultas Milenium',
};

// Gemini is not used by the appointment-selection states, so a stub is enough.
const geminiServiceStub = {
  generateText: async () => '{}',
  isGeminiQuotaError: () => false,
};

beforeEach(() => {
  dbPath = path.join(__dirname, `test-flow-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = createDatabase({ DB_PATH: dbPath });

  database.createNewPatient(PHONE);
  database.upsertPatientField(PHONE, 'rut', '12345678-9');
  database.upsertPatientField(PHONE, 'nombre', 'Juan Test');
  database.upsertPatientField(PHONE, 'correo', 'juan@test.cl');
  database.upsertPatientField(PHONE, 'telefono', '912345678');
  database.upsertPatientField(PHONE, 'direccion', 'Calle 123');
  database.markFormCompleted(PHONE);

  patientFlowStore = new PatientFlowStore({ database, ttlMs: 60_000 });
  handler = createConsultationHandler({
    database,
    patientFlowStore,
    geminiService: geminiServiceStub,
    emailService: null,
    config,
  });
});

afterEach(() => {
  database.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
});

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

describe('database.getAvailableDays', () => {
  test('returns distinct upcoming days with at least one free slot', () => {
    const days = database.getAvailableDays(todayStr(), 9, 30, 14);
    expect(days.length).toBeGreaterThan(0);

    const dates = days.map((d) => d.date);
    expect(new Set(dates).size).toBe(dates.length); // no duplicate days

    for (const day of days) {
      expect(day.slotCount).toBeGreaterThan(0);
      expect(typeof day.dayLabel).toBe('string');
      // Sundays are not in the default schedule
      expect(new Date(day.date + 'T00:00:00').getDay()).not.toBe(0);
    }
  });
});

describe('database.getSlotsForDate', () => {
  test('returns the times for one specific day, all sharing that date', () => {
    const days = database.getAvailableDays(todayStr(), 9, 30, 14);
    const target = days[0];

    const times = database.getSlotsForDate(target.date, 30);
    expect(times.length).toBe(target.slotCount);
    for (const t of times) {
      expect(t.date).toBe(target.date);
      expect(t.time).toMatch(/^\d{2}:\d{2}$/);
    }
  });
});

describe('two-step appointment flow (day → time)', () => {
  test('happy path: pick day, pick time, confirm, books the appointment', async () => {
    patientFlowStore.setState(PHONE, FLOW_STATES.AWAITING_APPOINTMENT);

    // 1) Patient accepts → day list
    const dayList = await handler.handleMessage({ phone: PHONE, prompt: 'sí' });
    expect(patientFlowStore.getState(PHONE)).toBe(FLOW_STATES.SELECTING_DAY);
    expect(dayList.interactive.type).toBe('list');
    expect(dayList.interactive.button).toBe('Ver días');
    expect(dayList.interactive.footer).toBe('Consultas Milenium');
    expect(dayList.interactive.rows.length).toBeGreaterThan(0);
    expect(dayList.interactive.rows[0].description).toMatch(/disponible/);

    // 2) Patient picks the first day → time list
    const timeList = await handler.handleMessage({ phone: PHONE, prompt: '1' });
    expect(patientFlowStore.getState(PHONE)).toBe(FLOW_STATES.SELECTING_APPOINTMENT);
    expect(timeList.interactive.type).toBe('list');
    expect(timeList.interactive.button).toBe('Ver horarios');
    // Last row is the "back to days" escape hatch
    const lastRow = timeList.interactive.rows[timeList.interactive.rows.length - 1];
    expect(lastRow.id).toBe('otro_dia');

    const stateData = patientFlowStore.getStateData(PHONE);
    const firstTime = stateData.slots[0];

    // 3) Patient picks the first time → confirm
    const confirm = await handler.handleMessage({ phone: PHONE, prompt: '1' });
    expect(patientFlowStore.getState(PHONE)).toBe(FLOW_STATES.CONFIRMING_APPOINTMENT);
    expect(confirm.interactive.buttons[0].id).toBe('si');

    // 4) Patient confirms → booked
    const booked = await handler.handleMessage({ phone: PHONE, prompt: 'sí, confirmar' });
    expect(patientFlowStore.getState(PHONE)).toBe(FLOW_STATES.COMPLETED);
    expect(booked.body).toMatch(/agendada/i);

    const scheduled = database.getScheduledAppointmentsByPhone(PHONE);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].appointment_date).toBe(firstTime.date);
    expect(scheduled[0].appointment_time).toBe(firstTime.time);
  });

  test('"otro_dia" from the time list returns to the day list', async () => {
    patientFlowStore.setState(PHONE, FLOW_STATES.AWAITING_APPOINTMENT);
    await handler.handleMessage({ phone: PHONE, prompt: 'sí' });
    await handler.handleMessage({ phone: PHONE, prompt: '1' }); // pick a day → time list

    const back = await handler.handleMessage({ phone: PHONE, prompt: 'otro_dia' });
    expect(patientFlowStore.getState(PHONE)).toBe(FLOW_STATES.SELECTING_DAY);
    expect(back.interactive.button).toBe('Ver días');
  });

  test('invalid day selection re-shows the day list', async () => {
    patientFlowStore.setState(PHONE, FLOW_STATES.AWAITING_APPOINTMENT);
    await handler.handleMessage({ phone: PHONE, prompt: 'sí' });

    const reShown = await handler.handleMessage({ phone: PHONE, prompt: '999' });
    expect(patientFlowStore.getState(PHONE)).toBe(FLOW_STATES.SELECTING_DAY);
    expect(reShown.interactive.button).toBe('Ver días');
  });

  test('reschedule path reuses the day → time flow and updates the appointment', async () => {
    const patient = database.getPatientByPhone(PHONE);
    const days = database.getAvailableDays(todayStr(), 9, 30, 14);
    const original = database.createAppointment({
      patientId: patient.id,
      phone: PHONE,
      date: days[days.length - 1].date,
      time: '17:00',
      duration: 30,
    });

    // Enter the manage flow directly with the appointment in state.
    patientFlowStore.setStateWithData(PHONE, FLOW_STATES.MANAGING_APPOINTMENT, {
      appointment: database.getAppointmentById(original.id),
    });

    // Choose "reagendar" → day list (reschedule mode)
    const dayList = await handler.handleMessage({ phone: PHONE, prompt: '2' });
    expect(patientFlowStore.getState(PHONE)).toBe(FLOW_STATES.SELECTING_DAY);
    expect(patientFlowStore.getStateData(PHONE).mode).toBe('reschedule');
    expect(dayList.interactive.button).toBe('Ver días');

    await handler.handleMessage({ phone: PHONE, prompt: '1' }); // pick day
    const stateData = patientFlowStore.getStateData(PHONE);
    const newSlot = stateData.slots[0];

    await handler.handleMessage({ phone: PHONE, prompt: '1' }); // pick time
    const done = await handler.handleMessage({ phone: PHONE, prompt: 'sí' }); // confirm
    expect(done.body).toMatch(/reagendada/i);

    const updated = database.getAppointmentById(original.id);
    expect(updated.appointment_date).toBe(newSlot.date);
    expect(updated.appointment_time).toBe(newSlot.time);
  });

  test('reschedule re-offers times if the chosen slot was taken before confirming', async () => {
    const patient = database.getPatientByPhone(PHONE);
    const days = database.getAvailableDays(todayStr(), 9, 30, 14);
    const original = database.createAppointment({
      patientId: patient.id,
      phone: PHONE,
      date: days[days.length - 1].date,
      time: '17:30',
      duration: 30,
    });

    patientFlowStore.setStateWithData(PHONE, FLOW_STATES.MANAGING_APPOINTMENT, {
      appointment: database.getAppointmentById(original.id),
    });

    await handler.handleMessage({ phone: PHONE, prompt: '2' }); // reagendar → days
    await handler.handleMessage({ phone: PHONE, prompt: '1' }); // pick day → times

    const stateData = patientFlowStore.getStateData(PHONE);
    const target = stateData.slots[0];
    await handler.handleMessage({ phone: PHONE, prompt: '1' }); // pick first time

    // Someone else grabs that exact slot before the patient confirms.
    database.createAppointment({
      patientId: patient.id,
      phone: '56999999999',
      date: target.date,
      time: target.time,
      duration: 30,
    });

    const blocked = await handler.handleMessage({ phone: PHONE, prompt: 'sí' });
    expect(blocked.body).toMatch(/ya no est[áa] disponible/i);
    expect(patientFlowStore.getState(PHONE)).toBe(FLOW_STATES.SELECTING_APPOINTMENT);

    // Original appointment is untouched
    const unchanged = database.getAppointmentById(original.id);
    expect(unchanged.appointment_time).toBe('17:30');
  });
});
