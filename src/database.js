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
  `);

  const hasUniquePhone = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='patients'`)
    .get();

  if (hasUniquePhone?.sql && /phone\s+TEXT\s+UNIQUE/i.test(hasUniquePhone.sql)) {
    db.pragma('foreign_keys = OFF');

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

      INSERT INTO patients_new
        SELECT * FROM patients;

      DROP TABLE patients;

      ALTER TABLE patients_new RENAME TO patients;
    `);

    db.pragma('foreign_keys = ON');
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_rut
      ON patients(rut) WHERE rut IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_patients_phone
      ON patients(phone);
  `);

  const getPatientByPhoneStmt = db.prepare(`
    SELECT *
    FROM patients
    WHERE phone = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `);

  const getPatientByRutStmt = db.prepare(`
    SELECT *
    FROM patients
    WHERE rut = ?
    LIMIT 1
  `);

  const insertPatientStmt = db.prepare(`
    INSERT INTO patients (phone, created_at, updated_at)
    VALUES (?, datetime('now'), datetime('now'))
  `);

  const isFormCompletedStmt = db.prepare(`
    SELECT form_completed
    FROM patients
    WHERE phone = ?
    LIMIT 1
  `);

  const markFormCompletedByIdStmt = db.prepare(`
    UPDATE patients
    SET form_completed = 1,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const createConsultationStmt = db.prepare(`
    INSERT INTO consultations (
      patient_id,
      phone,
      sintomas,
      motivo_consulta,
      orientacion,
      resumen,
      appointment_status,
      appointment_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getLastConsultationStmt = db.prepare(`
    SELECT *
    FROM consultations
    WHERE phone = ?
    ORDER BY id DESC
    LIMIT 1
  `);

  function ensurePatient(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) {
      throw new Error('Phone is required');
    }

    const existing = getPatientByPhoneStmt.get(cleanPhone);
    if (existing) return existing;

    insertPatientStmt.run(cleanPhone);
    return getPatientByPhoneStmt.get(cleanPhone);
  }

  function getPatientByPhone(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return null;
    return getPatientByPhoneStmt.get(cleanPhone) || null;
  }

  function getPatientByRut(rut) {
    const cleanRut = String(rut || '').trim();
    if (!cleanRut) return null;
    return getPatientByRutStmt.get(cleanRut) || null;
  }

  function upsertPatientField(phone, field, value) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) throw new Error('Phone is required');
    if (!PATIENT_FIELDS.has(field)) {
      throw new Error(`Unsupported patient field: ${field}`);
    }

    const cleanValue = String(value || '').trim();

    if (field === 'rut') {
      const existingByRut = getPatientByRut(cleanValue);
      if (existingByRut && existingByRut.phone !== cleanPhone) {
        const updatePhoneStmt = db.prepare(`
          UPDATE patients
          SET phone = ?, updated_at = datetime('now')
          WHERE id = ?
        `);
        updatePhoneStmt.run(cleanPhone, existingByRut.id);
        return getPatientByPhone(cleanPhone);
      }
    }

    const patient = ensurePatient(cleanPhone);

    const stmt = db.prepare(`
      UPDATE patients
      SET ${field} = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);

    stmt.run(cleanValue, patient.id);
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
    phone,
    patientId,
    sintomas,
    motivo,
    orientacion,
    resumen,
    appointmentStatus = 'pending',
    appointmentDate = null,
  }) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) {
      throw new Error('Phone is required');
    }

    if (!patientId) {
      throw new Error('patientId is required');
    }

    const result = createConsultationStmt.run(
      patientId,
      cleanPhone,
      String(sintomas || '').trim() || null,
      String(motivo || '').trim() || null,
      String(orientacion || '').trim() || null,
      String(resumen || '').trim() || null,
      appointmentStatus,
      appointmentDate
    );

    return result.lastInsertRowid;
  }

  function getLastConsultation(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return null;
    return getLastConsultationStmt.get(cleanPhone) || null;
  }

  function close() {
    db.close();
  }

  return {
    db,
    dbPath,
    getPatientByPhone,
    getPatientByRut,
    upsertPatientField,
    markFormCompleted,
    isFormCompleted,
    createConsultation,
    getLastConsultation,
    close,
  };
}

module.exports = {
  createDatabase,
};
