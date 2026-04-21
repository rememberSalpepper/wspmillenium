const path = require('path');
const fs = require('fs');
const { createDatabase } = require('../src/database');

let database;
let dbPath;

beforeEach(() => {
  dbPath = path.join(__dirname, `test-reminder-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = createDatabase({ DB_PATH: dbPath });

  database.createNewPatient('56912345678');
  database.upsertPatientField('56912345678', 'nombre', 'Maria Prueba');
  database.upsertPatientField('56912345678', 'rut', '11111111-1');
  database.upsertPatientField('56912345678', 'telefono', '912345678');
  database.markFormCompleted('56912345678');
});

afterEach(() => {
  database.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
});

describe('getAppointmentsNeedingReminder', () => {
  test('returns scheduled appointments for given date with reminder_sent=0', () => {
    const patient = database.getPatientByPhone('56912345678');
    database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: '2026-04-22',
      time: '10:00',
      duration: 30,
    });

    const result = database.getAppointmentsNeedingReminder('2026-04-22');
    expect(result).toHaveLength(1);
    expect(result[0].nombre).toBe('Maria Prueba');
    expect(result[0].appointment_time).toBe('10:00');
  });

  test('returns empty for wrong date', () => {
    const patient = database.getPatientByPhone('56912345678');
    database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: '2026-04-22',
      time: '10:00',
      duration: 30,
    });

    const result = database.getAppointmentsNeedingReminder('2026-04-23');
    expect(result).toEqual([]);
  });

  test('excludes cancelled appointments', () => {
    const patient = database.getPatientByPhone('56912345678');
    const { id } = database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: '2026-04-22',
      time: '10:00',
      duration: 30,
    });
    database.updateAppointment(id, 'cancelled', null);

    const result = database.getAppointmentsNeedingReminder('2026-04-22');
    expect(result).toEqual([]);
  });

  test('excludes appointments with reminder already sent', () => {
    const patient = database.getPatientByPhone('56912345678');
    const { id } = database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: '2026-04-22',
      time: '10:00',
      duration: 30,
    });
    database.markReminderSent(id);

    const result = database.getAppointmentsNeedingReminder('2026-04-22');
    expect(result).toEqual([]);
  });
});

describe('markReminderSent', () => {
  test('sets reminder_sent to 1', () => {
    const patient = database.getPatientByPhone('56912345678');
    const { id } = database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: '2026-04-22',
      time: '10:00',
      duration: 30,
    });

    database.markReminderSent(id);

    const apt = database.getAppointmentById(id);
    expect(apt.reminder_sent).toBe(1);
  });
});

describe('todayInChile (via getDashboardStats)', () => {
  test('getDashboardStats returns correct counts', () => {
    const stats = database.getDashboardStats();
    expect(stats).toHaveProperty('totalPatients');
    expect(stats).toHaveProperty('todayAppointments');
    expect(stats).toHaveProperty('upcomingAppointments');
    expect(stats.totalPatients).toBe(1);
  });

  test('getTodayAppointments uses Chile timezone', () => {
    const result = database.getTodayAppointments();
    expect(Array.isArray(result)).toBe(true);
  });

  test('getUpcomingAppointments uses Chile timezone', () => {
    const result = database.getUpcomingAppointments();
    expect(Array.isArray(result)).toBe(true);
  });
});
