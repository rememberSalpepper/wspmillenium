const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const PATIENT_FIELDS = new Set(['rut', 'nombre', 'correo', 'telefono', 'direccion']);

function createDatabase(config) {
  const dbPath = path.resolve(config.DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      rut TEXT,
      nombre TEXT,
      correo TEXT,
      telefono TEXT,
      direccion TEXT,
      form_completed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS consultations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      sintomas TEXT,
      motivo_consulta TEXT,
      orientacion TEXT,
      resumen TEXT,
      appointment_status TEXT DEFAULT 'pending',
      appointment_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS consulta_sintomas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consulta_id INTEGER NOT NULL,
      sintoma TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (consulta_id) REFERENCES consultations(id)
    );
  `);

  // Cleanup orphaned migration table if a previous attempt failed
  db.exec('DROP TABLE IF EXISTS patients_new');

  // Migration: remove old UNIQUE constraint on phone if present
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='patients'")
    .get();

  if (tableInfo?.sql && /phone\s+TEXT\s+UNIQUE/i.test(tableInfo.sql)) {
    db.pragma('foreign_keys = OFF');

    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE patients_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT NOT NULL,
          rut TEXT,
          nombre TEXT,
          correo TEXT,
          telefono TEXT,
          direccion TEXT,
          form_completed INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        INSERT INTO patients_new SELECT * FROM patients;
        DROP TABLE patients;
        ALTER TABLE patients_new RENAME TO patients;
      `);
    });

    migrate();
    db.pragma('foreign_keys = ON');
  }

  // Migrate: drop old consultation_symptoms table if it exists (replaced by consulta_sintomas)
  try {
    db.exec('DROP TABLE IF EXISTS consultation_symptoms');
  } catch (_) {}

  // Drop the rut unique index if it was created before
  try {
    db.exec('DROP INDEX IF EXISTS idx_patients_rut');
  } catch (_) {}

  const getPatientByPhoneStmt = db.prepare(`
    SELECT * FROM patients WHERE phone = ? ORDER BY updated_at DESC LIMIT 1
  `);

  const insertPatientStmt = db.prepare(`
    INSERT INTO patients (phone, created_at, updated_at)
    VALUES (?, datetime('now'), datetime('now'))
  `);

  const isFormCompletedStmt = db.prepare(`
    SELECT form_completed FROM patients WHERE phone = ? ORDER BY updated_at DESC LIMIT 1
  `);

  const markFormCompletedByIdStmt = db.prepare(`
    UPDATE patients SET form_completed = 1, updated_at = datetime('now') WHERE id = ?
  `);

  const createConsultationStmt = db.prepare(`
    INSERT INTO consultations (
      patient_id, phone, sintomas, motivo_consulta,
      orientacion, resumen, appointment_status, appointment_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getLastConsultationStmt = db.prepare(`
    SELECT * FROM consultations WHERE phone = ? ORDER BY id DESC LIMIT 1
  `);

  const insertSymptomStmt = db.prepare(`
    INSERT INTO consulta_sintomas (consulta_id, sintoma)
    VALUES (?, ?)
  `);

  const getSymptomsByConsultationStmt = db.prepare(`
    SELECT id, sintoma, created_at FROM consulta_sintomas
    WHERE consulta_id = ? ORDER BY id ASC
  `);

  const updateFieldStmts = Object.fromEntries(
    ['rut', 'nombre', 'correo', 'telefono', 'direccion'].map((field) => [
      field,
      db.prepare(`UPDATE patients SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`),
    ])
  );

  const updateAppointmentStatusStmt = db.prepare(`
    UPDATE consultations SET appointment_status = ?
    WHERE id = (SELECT id FROM consultations WHERE phone = ? ORDER BY id DESC LIMIT 1)
  `);

  function ensurePatient(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) throw new Error('Phone is required');

    const existing = getPatientByPhoneStmt.get(cleanPhone);
    if (existing) return existing;

    insertPatientStmt.run(cleanPhone);
    return getPatientByPhoneStmt.get(cleanPhone);
  }

  function createNewPatient(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) throw new Error('Phone is required');

    insertPatientStmt.run(cleanPhone);
    return getPatientByPhoneStmt.get(cleanPhone);
  }

  function getPatientByPhone(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return null;
    return getPatientByPhoneStmt.get(cleanPhone) || null;
  }

  function upsertPatientField(phone, field, value) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) throw new Error('Phone is required');
    if (!PATIENT_FIELDS.has(field)) throw new Error(`Unsupported patient field: ${field}`);

    const patient = ensurePatient(cleanPhone);

    updateFieldStmts[field].run(String(value || '').trim(), patient.id);
    return getPatientByPhone(cleanPhone);
  }

  function markFormCompleted(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) throw new Error('Phone is required');

    const patient = getPatientByPhone(cleanPhone);
    if (!patient) throw new Error('Patient not found');

    markFormCompletedByIdStmt.run(patient.id);
    return getPatientByPhone(cleanPhone);
  }

  function isFormCompleted(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return false;
    const row = isFormCompletedStmt.get(cleanPhone);
    return Boolean(row?.form_completed);
  }

  function createConsultation({
    phone, patientId, sintomas, motivo,
    orientacion, resumen,
    appointmentStatus = 'pending', appointmentDate = null,
  }) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) throw new Error('Phone is required');
    if (!patientId) throw new Error('patientId is required');

    const result = createConsultationStmt.run(
      patientId, cleanPhone,
      String(sintomas || '').trim() || null,
      String(motivo || '').trim() || null,
      String(orientacion || '').trim() || null,
      String(resumen || '').trim() || null,
      appointmentStatus, appointmentDate
    );

    return result.lastInsertRowid;
  }

  function getLastConsultation(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return null;
    return getLastConsultationStmt.get(cleanPhone) || null;
  }

  const addSymptomsTransaction = db.transaction((consultationId, symptoms) => {
    for (const symptom of symptoms) {
      const clean = String(symptom || '').trim();
      if (clean) {
        insertSymptomStmt.run(consultationId, clean);
      }
    }
  });

  function addSymptoms(consultationId, symptoms) {
    if (!consultationId) throw new Error('consultationId is required');
    const list = Array.isArray(symptoms) ? symptoms : [symptoms];
    addSymptomsTransaction(consultationId, list);
  }

  function getSymptomsByConsultation(consultationId) {
    if (!consultationId) return [];
    return getSymptomsByConsultationStmt.all(consultationId);
  }

  const resetPatientTransaction = db.transaction((phone) => {
    const patients = db.prepare('SELECT id FROM patients WHERE phone = ?').all(phone);
    const patientIds = patients.map((p) => p.id);

    if (patientIds.length > 0) {
      const placeholders = patientIds.map(() => '?').join(',');

      const consultations = db
        .prepare(`SELECT id FROM consultations WHERE patient_id IN (${placeholders})`)
        .all(...patientIds);
      const consultationIds = consultations.map((c) => c.id);

      if (consultationIds.length > 0) {
        const cPlaceholders = consultationIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM consulta_sintomas WHERE consulta_id IN (${cPlaceholders})`)
          .run(...consultationIds);
      }

      db.prepare(`DELETE FROM consultations WHERE patient_id IN (${placeholders})`)
        .run(...patientIds);
      db.prepare(`DELETE FROM patients WHERE phone = ?`).run(phone);
    }

    return patientIds.length;
  });

  function resetPatient(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) throw new Error('Phone is required');
    return resetPatientTransaction(cleanPhone);
  }

  function updateAppointmentStatus(phone, status) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) throw new Error('Phone is required');
    updateAppointmentStatusStmt.run(status, cleanPhone);
  }

  function close() {
    db.close();
  }

  return {
    db, dbPath,
    getPatientByPhone, createNewPatient, upsertPatientField,
    markFormCompleted, isFormCompleted,
    createConsultation, getLastConsultation, updateAppointmentStatus,
    addSymptoms, getSymptomsByConsultation,
    resetPatient,
    close,
  };
}

module.exports = { createDatabase };
