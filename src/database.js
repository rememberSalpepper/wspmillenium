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
      phone TEXT UNIQUE NOT NULL,
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

  const ensurePatientStmt = db.prepare(`
    INSERT INTO patients (phone, created_at, updated_at)
    VALUES (?, datetime('now'), datetime('now'))
    ON CONFLICT(phone) DO NOTHING
  `);

  const getPatientByPhoneStmt = db.prepare(`
    SELECT *
    FROM patients
    WHERE phone = ?
    LIMIT 1
  `);

  const isFormCompletedStmt = db.prepare(`
    SELECT form_completed
    FROM patients
    WHERE phone = ?
    LIMIT 1
  `);

  const markFormCompletedStmt = db.prepare(`
    UPDATE patients
    SET form_completed = 1,
        updated_at = datetime('now')
    WHERE phone = ?
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

    ensurePatientStmt.run(cleanPhone);
    return cleanPhone;
  }

  function getPatientByPhone(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return null;
    return getPatientByPhoneStmt.get(cleanPhone) || null;
  }

  function upsertPatientField(phone, field, value) {
    const cleanPhone = ensurePatient(phone);
    if (!PATIENT_FIELDS.has(field)) {
      throw new Error(`Unsupported patient field: ${field}`);
    }

    const stmt = db.prepare(`
      UPDATE patients
      SET ${field} = ?,
          updated_at = datetime('now')
      WHERE phone = ?
    `);

    stmt.run(String(value || '').trim(), cleanPhone);
    return getPatientByPhone(cleanPhone);
  }

  function markFormCompleted(phone) {
    const cleanPhone = ensurePatient(phone);
    markFormCompletedStmt.run(cleanPhone);
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
