const path = require('path');
const fs = require('fs');
const { createDatabase } = require('../src/database');

let database;
let dbPath;

beforeEach(() => {
  dbPath = path.join(__dirname, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = createDatabase({ DB_PATH: dbPath });

  // Seed a patient
  database.createNewPatient('56912345678');
  database.upsertPatientField('56912345678', 'rut', '12345678-9');
  database.upsertPatientField('56912345678', 'nombre', 'Juan Test');
  database.upsertPatientField('56912345678', 'correo', 'juan@test.cl');
  database.upsertPatientField('56912345678', 'telefono', '912345678');
  database.upsertPatientField('56912345678', 'direccion', 'Calle 123');
  database.markFormCompleted('56912345678');
});

afterEach(() => {
  database.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
});

describe('getScheduledAppointmentsByPhone', () => {
  test('returns empty array when no appointments exist', () => {
    const result = database.getScheduledAppointmentsByPhone('56912345678');
    expect(result).toEqual([]);
  });

  test('returns scheduled future appointments', () => {
    const patient = database.getPatientByPhone('56912345678');
    const futureDate = getFutureDate(3);

    database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: futureDate,
      time: '10:00',
      duration: 30,
    });

    const result = database.getScheduledAppointmentsByPhone('56912345678');
    expect(result).toHaveLength(1);
    expect(result[0].appointment_date).toBe(futureDate);
    expect(result[0].appointment_time).toBe('10:00');
    expect(result[0].status).toBe('scheduled');
    expect(result[0].nombre).toBe('Juan Test');
  });

  test('excludes cancelled appointments', () => {
    const patient = database.getPatientByPhone('56912345678');
    const futureDate = getFutureDate(3);

    const { id } = database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: futureDate,
      time: '10:00',
      duration: 30,
    });

    database.updateAppointment(id, 'cancelled', null);

    const result = database.getScheduledAppointmentsByPhone('56912345678');
    expect(result).toEqual([]);
  });

  test('excludes past appointments', () => {
    const patient = database.getPatientByPhone('56912345678');

    // Insert directly with a past date
    database.db.prepare(
      "INSERT INTO appointments (patient_id, phone, appointment_date, appointment_time, duration_min, status) VALUES (?, ?, ?, ?, ?, 'scheduled')"
    ).run(patient.id, '56912345678', '2020-01-01', '10:00', 30);

    const result = database.getScheduledAppointmentsByPhone('56912345678');
    expect(result).toEqual([]);
  });

  test('returns multiple appointments sorted by date and time', () => {
    const patient = database.getPatientByPhone('56912345678');
    const date1 = getFutureDate(5);
    const date2 = getFutureDate(3);

    database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: date1,
      time: '14:00',
      duration: 30,
    });

    database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: date2,
      time: '09:00',
      duration: 30,
    });

    const result = database.getScheduledAppointmentsByPhone('56912345678');
    expect(result).toHaveLength(2);
    // Earlier date first
    expect(result[0].appointment_date).toBe(date2);
    expect(result[1].appointment_date).toBe(date1);
  });

  test('does not return appointments for other phone numbers', () => {
    const patient = database.getPatientByPhone('56912345678');

    database.createAppointment({
      patientId: patient.id,
      phone: '56999999999',
      date: getFutureDate(3),
      time: '10:00',
      duration: 30,
    });

    const result = database.getScheduledAppointmentsByPhone('56912345678');
    expect(result).toEqual([]);
  });
});

describe('rescheduleAppointment', () => {
  test('updates date, time, and resets status to scheduled', () => {
    const patient = database.getPatientByPhone('56912345678');
    const { id } = database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: getFutureDate(3),
      time: '10:00',
      duration: 30,
    });

    const newDate = getFutureDate(7);
    const result = database.rescheduleAppointment(id, newDate, '15:00', 30);
    expect(result.conflict).toBe(false);

    const updated = database.getAppointmentById(id);
    expect(updated.appointment_date).toBe(newDate);
    expect(updated.appointment_time).toBe('15:00');
    expect(updated.status).toBe('scheduled');
  });

  test('rejects rescheduling onto a slot taken by another appointment', () => {
    const patient = database.getPatientByPhone('56912345678');
    const date = getFutureDate(4);

    // Another patient already holds 10:00
    database.createAppointment({
      patientId: patient.id, phone: '56999999999',
      date, time: '10:00', duration: 30,
    });

    // The appointment we will try to move
    const { id } = database.createAppointment({
      patientId: patient.id, phone: '56912345678',
      date, time: '12:00', duration: 30,
    });

    const result = database.rescheduleAppointment(id, date, '10:00', 30);
    expect(result.conflict).toBe(true);

    // Nothing changed
    const unchanged = database.getAppointmentById(id);
    expect(unchanged.appointment_time).toBe('12:00');
  });

  test('allows rescheduling to the appointment own current slot (no self-conflict)', () => {
    const patient = database.getPatientByPhone('56912345678');
    const date = getFutureDate(4);
    const { id } = database.createAppointment({
      patientId: patient.id, phone: '56912345678',
      date, time: '09:00', duration: 30,
    });

    // Re-confirm the same slot — must not collide with itself
    const result = database.rescheduleAppointment(id, date, '09:00', 30);
    expect(result.conflict).toBe(false);
  });
});

describe('updateAppointment (cancel)', () => {
  test('sets status to cancelled', () => {
    const patient = database.getPatientByPhone('56912345678');
    const { id } = database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date: getFutureDate(3),
      time: '10:00',
      duration: 30,
    });

    database.updateAppointment(id, 'cancelled', null);

    const updated = database.getAppointmentById(id);
    expect(updated.status).toBe('cancelled');
  });

  test('cancelled appointment no longer appears in date queries', () => {
    const patient = database.getPatientByPhone('56912345678');
    const date = getFutureDate(3);
    const { id } = database.createAppointment({
      patientId: patient.id,
      phone: '56912345678',
      date,
      time: '10:00',
      duration: 30,
    });

    database.updateAppointment(id, 'cancelled', null);

    const dayResults = database.getAppointmentsByDate(date);
    expect(dayResults).toEqual([]);
  });
});

// Helper
function getFutureDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().split('T')[0];
}
