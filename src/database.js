const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PATIENT_FIELDS = new Set(['rut', 'nombre', 'correo', 'telefono', 'direccion']);

function todayInChile() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

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

  // Migration: add new columns for CRM / email features
  try { db.exec("ALTER TABLE consultations ADD COLUMN status TEXT DEFAULT 'open'"); } catch (_) {}
  try { db.exec('ALTER TABLE consultations ADD COLUMN notes TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE consultations ADD COLUMN email_notified INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE consultations ADD COLUMN email_notified_at TEXT'); } catch (_) {}

  // CRM users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Appointment scheduling tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS doctor_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      slot_duration_min INTEGER DEFAULT 30,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schedule_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      block_type TEXT DEFAULT 'blocked',
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consultation_id INTEGER,
      patient_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      appointment_date TEXT NOT NULL,
      appointment_time TEXT NOT NULL,
      duration_min INTEGER DEFAULT 30,
      status TEXT DEFAULT 'scheduled',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (consultation_id) REFERENCES consultations(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    )
  `);

  // Ensure reminder_sent column exists (migration)
  const appointmentCols = db.prepare("PRAGMA table_info(appointments)").all().map(c => c.name);
  if (!appointmentCols.includes('reminder_sent')) {
    db.exec("ALTER TABLE appointments ADD COLUMN reminder_sent INTEGER DEFAULT 0");
  }

  // Conversation history (AI memory) — persisted so it survives restarts/redeploys
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conv_turns_phone ON conversation_turns(phone, id);
  `);

  // Seed default doctor schedule if empty
  const scheduleCount = db.prepare('SELECT COUNT(*) as total FROM doctor_schedule').get().total;
  if (scheduleCount === 0) {
    const seedSchedule = db.transaction(() => {
      const ins = db.prepare('INSERT INTO doctor_schedule (day_of_week, start_time, end_time) VALUES (?, ?, ?)');
      for (let day = 1; day <= 5; day++) {
        ins.run(day, '09:00', '13:00');
        ins.run(day, '15:00', '18:00');
      }
      ins.run(6, '09:00', '13:00');
    });
    seedSchedule();
  }

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

  // CRM prepared statements
  const updateConsultationStatusStmt = db.prepare(
    'UPDATE consultations SET status = ? WHERE id = ?'
  );
  const updateConsultationNotesStmt = db.prepare(
    'UPDATE consultations SET notes = ? WHERE id = ?'
  );
  const markEmailNotifiedStmt = db.prepare(
    "UPDATE consultations SET email_notified = 1, email_notified_at = datetime('now') WHERE id = ?"
  );
  const getAllPatientsStmt = db.prepare(
    'SELECT * FROM patients WHERE form_completed = 1 ORDER BY updated_at DESC LIMIT ? OFFSET ?'
  );
  const countPatientsStmt = db.prepare(
    'SELECT COUNT(*) as total FROM patients WHERE form_completed = 1'
  );
  const getPatientByIdStmt = db.prepare('SELECT * FROM patients WHERE id = ?');
  const getConsultationsByPatientStmt = db.prepare(
    'SELECT * FROM consultations WHERE patient_id = ? ORDER BY id DESC'
  );
  const getConsultationByIdStmt = db.prepare('SELECT * FROM consultations WHERE id = ?');
  const getCrmUserStmt = db.prepare('SELECT * FROM crm_users WHERE username = ?');
  const insertCrmUserStmt = db.prepare(
    'INSERT INTO crm_users (username, password_hash) VALUES (?, ?)'
  );
  const updateCrmUserPasswordStmt = db.prepare(
    'UPDATE crm_users SET password_hash = ? WHERE username = ?'
  );
  const countCrmUsersStmt = db.prepare('SELECT COUNT(*) as total FROM crm_users');
  const getDashboardStatsStmt = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM patients WHERE form_completed = 1) as totalPatients,
      (SELECT COUNT(*) FROM consultations WHERE status = 'open') as openConsultations,
      (SELECT COUNT(*) FROM consultations WHERE appointment_status = 'confirmed') as confirmedAppointments,
      (SELECT COUNT(*) FROM consultations WHERE appointment_status = 'pending') as pendingAppointments,
      (SELECT COUNT(*) FROM consultations) as totalConsultations,
      (SELECT COUNT(*) FROM appointments WHERE appointment_date = ? AND status != 'cancelled') as todayAppointments,
      (SELECT COUNT(*) FROM appointments WHERE appointment_date > ? AND status = 'scheduled') as upcomingAppointments
  `);

  // --- Schedule prepared statements ---
  const getWeeklyScheduleStmt = db.prepare(
    'SELECT * FROM doctor_schedule WHERE is_active = 1 ORDER BY day_of_week, start_time'
  );
  const insertScheduleBlockStmt = db.prepare(
    'INSERT INTO doctor_schedule (day_of_week, start_time, end_time, slot_duration_min) VALUES (?, ?, ?, ?)'
  );
  const updateScheduleBlockStmt = db.prepare(
    'UPDATE doctor_schedule SET day_of_week = ?, start_time = ?, end_time = ?, slot_duration_min = ? WHERE id = ?'
  );
  const deactivateScheduleBlockStmt = db.prepare(
    'UPDATE doctor_schedule SET is_active = 0 WHERE id = ?'
  );
  const activateScheduleBlockStmt = db.prepare(
    'UPDATE doctor_schedule SET is_active = 1 WHERE id = ?'
  );
  const deleteScheduleBlockStmt = db.prepare(
    'DELETE FROM doctor_schedule WHERE id = ?'
  );
  const clearWeeklyScheduleStmt = db.prepare(
    'DELETE FROM doctor_schedule'
  );

  // --- Date blocks prepared statements ---
  const getDateBlocksStmt = db.prepare(
    'SELECT * FROM schedule_blocks ORDER BY block_date, start_time'
  );
  const getDateBlocksByDateStmt = db.prepare(
    'SELECT * FROM schedule_blocks WHERE block_date = ?'
  );
  const insertDateBlockStmt = db.prepare(
    'INSERT INTO schedule_blocks (block_date, start_time, end_time, block_type, reason) VALUES (?, ?, ?, ?, ?)'
  );
  const deleteDateBlockStmt = db.prepare(
    'DELETE FROM schedule_blocks WHERE id = ?'
  );

  // --- Appointment prepared statements ---
  const insertAppointmentStmt = db.prepare(`
    INSERT INTO appointments (consultation_id, patient_id, phone, appointment_date, appointment_time, duration_min, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)
  `);
  const getAppointmentByIdStmt = db.prepare(
    'SELECT * FROM appointments WHERE id = ?'
  );
  const getAppointmentsByDateStmt = db.prepare(
    "SELECT a.*, p.nombre, p.rut FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id WHERE a.appointment_date = ? AND a.status != 'cancelled' ORDER BY a.appointment_time"
  );
  const getAppointmentsByDateRangeStmt = db.prepare(
    "SELECT a.*, p.nombre, p.rut FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id WHERE a.appointment_date >= ? AND a.appointment_date <= ? AND a.status != 'cancelled' ORDER BY a.appointment_date, a.appointment_time"
  );
  const updateAppointmentStmt = db.prepare(
    "UPDATE appointments SET status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?"
  );
  const rescheduleAppointmentStmt = db.prepare(
    "UPDATE appointments SET appointment_date = ?, appointment_time = ?, status = 'scheduled', updated_at = datetime('now') WHERE id = ?"
  );
  const getTodayAppointmentsStmt = db.prepare(
    "SELECT a.*, p.nombre, p.rut, p.telefono FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id WHERE a.appointment_date = ? AND a.status != 'cancelled' ORDER BY a.appointment_time"
  );
  const getUpcomingAppointmentsStmt = db.prepare(
    "SELECT a.*, p.nombre, p.rut FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id WHERE a.appointment_date >= ? AND a.status = 'scheduled' ORDER BY a.appointment_date, a.appointment_time LIMIT 20"
  );
  const getAppointmentsNeedingReminderStmt = db.prepare(
    "SELECT a.*, p.nombre, p.rut, p.telefono, p.correo FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id WHERE a.appointment_date = ? AND a.status = 'scheduled' AND a.reminder_sent = 0"
  );
  const markReminderSentStmt = db.prepare(
    "UPDATE appointments SET reminder_sent = 1 WHERE id = ?"
  );
  const getBookedSlotsForDateStmt = db.prepare(
    "SELECT appointment_time, duration_min FROM appointments WHERE appointment_date = ? AND status != 'cancelled'"
  );
  const getScheduleForDayStmt = db.prepare(
    'SELECT * FROM doctor_schedule WHERE day_of_week = ? AND is_active = 1 ORDER BY start_time'
  );

  // --- Scheduled appointments by phone ---
  const getScheduledAppointmentsByPhoneStmt = db.prepare(
    "SELECT a.*, p.nombre, p.rut FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id WHERE a.phone = ? AND a.status = 'scheduled' AND a.appointment_date >= date('now') ORDER BY a.appointment_date, a.appointment_time"
  );

  // --- Search patients ---
  const searchPatientsStmt = db.prepare(
    "SELECT * FROM patients WHERE form_completed = 1 AND (nombre LIKE ? OR rut LIKE ? OR phone LIKE ? OR telefono LIKE ?) ORDER BY updated_at DESC LIMIT ?"
  );

  // --- Conversation turns (AI memory) ---
  const insertConversationTurnStmt = db.prepare(
    'INSERT INTO conversation_turns (phone, role, text) VALUES (?, ?, ?)'
  );
  const getRecentConversationTurnsStmt = db.prepare(
    'SELECT role, text, created_at FROM conversation_turns WHERE phone = ? ORDER BY id DESC LIMIT ?'
  );
  const deleteConversationTurnsByPhoneStmt = db.prepare(
    'DELETE FROM conversation_turns WHERE phone = ?'
  );
  const pruneConversationTurnsByAgeStmt = db.prepare(
    "DELETE FROM conversation_turns WHERE created_at < datetime('now', ?)"
  );
  const capConversationTurnsForPhoneStmt = db.prepare(
    `DELETE FROM conversation_turns
     WHERE phone = ?
       AND id NOT IN (
         SELECT id FROM conversation_turns WHERE phone = ? ORDER BY id DESC LIMIT ?
       )`
  );

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

      // Delete appointments (FK on patient_id and consultation_id)
      db.prepare(`DELETE FROM appointments WHERE patient_id IN (${placeholders})`)
        .run(...patientIds);

      db.prepare(`DELETE FROM consultations WHERE patient_id IN (${placeholders})`)
        .run(...patientIds);
      db.prepare(`DELETE FROM patients WHERE phone = ?`).run(phone);
    }

    // Always clear conversation history for this phone, even if no patient row exists yet.
    deleteConversationTurnsByPhoneStmt.run(phone);

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

  // --- CRM functions ---

  function updateConsultationStatus(consultationId, status) {
    updateConsultationStatusStmt.run(status, consultationId);
  }

  function updateConsultationNotes(consultationId, notes) {
    updateConsultationNotesStmt.run(notes, consultationId);
  }

  function markEmailNotified(consultationId) {
    markEmailNotifiedStmt.run(consultationId);
  }

  function getAllPatients({ limit = 50, offset = 0 } = {}) {
    const patients = getAllPatientsStmt.all(limit, offset);
    const total = countPatientsStmt.get().total;
    return { patients, total };
  }

  function getPatientById(id) {
    return getPatientByIdStmt.get(id) || null;
  }

  function getConsultationsByPatient(patientId) {
    return getConsultationsByPatientStmt.all(patientId);
  }

  function getConsultationById(consultationId) {
    return getConsultationByIdStmt.get(consultationId) || null;
  }

  function getDashboardStats() {
    const today = todayInChile();
    return getDashboardStatsStmt.get(today, today);
  }

  // --- Schedule functions ---

  function getWeeklySchedule() {
    return getWeeklyScheduleStmt.all();
  }

  function addScheduleBlock(dayOfWeek, startTime, endTime, slotDuration = 30) {
    const result = insertScheduleBlockStmt.run(dayOfWeek, startTime, endTime, slotDuration);
    return result.lastInsertRowid;
  }

  function updateScheduleBlock(id, dayOfWeek, startTime, endTime, slotDuration = 30) {
    updateScheduleBlockStmt.run(dayOfWeek, startTime, endTime, slotDuration, id);
  }

  function deactivateScheduleBlock(id) {
    deactivateScheduleBlockStmt.run(id);
  }

  function activateScheduleBlock(id) {
    activateScheduleBlockStmt.run(id);
  }

  function deleteScheduleBlock(id) {
    deleteScheduleBlockStmt.run(id);
  }

  function replaceWeeklySchedule(blocks) {
    const tx = db.transaction(() => {
      clearWeeklyScheduleStmt.run();
      const ins = db.prepare('INSERT INTO doctor_schedule (day_of_week, start_time, end_time, slot_duration_min) VALUES (?, ?, ?, ?)');
      for (const b of blocks) {
        ins.run(b.day_of_week, b.start_time, b.end_time, b.slot_duration_min || 30);
      }
    });
    tx();
  }

  // --- Date block functions ---

  function getDateBlocks() {
    return getDateBlocksStmt.all();
  }

  function addDateBlock(blockDate, startTime, endTime, blockType = 'blocked', reason = '') {
    const result = insertDateBlockStmt.run(blockDate, startTime || null, endTime || null, blockType, reason || null);
    return result.lastInsertRowid;
  }

  function removeDateBlock(id) {
    deleteDateBlockStmt.run(id);
  }

  // --- Appointment functions ---

  const createAppointmentTx = db.transaction((data) => {
    const { consultationId, patientId, phone, date, time, duration = 30, notes } = data;
    // Check for conflicts
    const booked = getBookedSlotsForDateStmt.all(date);
    const newStart = timeToMinutes(time);
    const newEnd = newStart + duration;
    for (const slot of booked) {
      const sStart = timeToMinutes(slot.appointment_time);
      const sEnd = sStart + (slot.duration_min || 30);
      if (newStart < sEnd && newEnd > sStart) {
        return { conflict: true };
      }
    }
    const result = insertAppointmentStmt.run(
      consultationId || null, patientId, phone, date, time, duration, notes || null
    );
    return { conflict: false, id: result.lastInsertRowid };
  });

  function createAppointment(data) {
    return createAppointmentTx(data);
  }

  function getAppointmentById(id) {
    return getAppointmentByIdStmt.get(id) || null;
  }

  function getAppointmentsByDate(date) {
    return getAppointmentsByDateStmt.all(date);
  }

  function getAppointmentsByDateRange(from, to) {
    return getAppointmentsByDateRangeStmt.all(from, to);
  }

  function updateAppointment(id, status, notes) {
    updateAppointmentStmt.run(status, notes || null, id);
  }

  function rescheduleAppointment(id, newDate, newTime) {
    rescheduleAppointmentStmt.run(newDate, newTime, id);
  }

  function getTodayAppointments() {
    return getTodayAppointmentsStmt.all(todayInChile());
  }

  function getUpcomingAppointments() {
    return getUpcomingAppointmentsStmt.all(todayInChile());
  }

  // --- Available slots algorithm ---

  function timeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  function minutesToTime(m) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }

  function getAvailableSlots(fromDate, count = 6, slotDuration = 30) {
    const slots = [];
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
    const maxDays = 14;

    const start = new Date(fromDate + 'T00:00:00');
    const now = new Date();

    for (let d = 0; d < maxDays && slots.length < count; d++) {
      const current = new Date(start);
      current.setDate(current.getDate() + d);

      const dateStr = current.toISOString().split('T')[0];
      const dayOfWeek = current.getDay(); // 0=Sun

      // Get schedule blocks for this day of week
      const scheduleBlocks = getScheduleForDayStmt.all(dayOfWeek);
      if (scheduleBlocks.length === 0) continue;

      // Get date-specific blocks
      const dateBlocks = getDateBlocksByDateStmt.all(dateStr);
      const isFullDayBlocked = dateBlocks.some((b) => !b.start_time && !b.end_time);
      if (isFullDayBlocked) continue;

      // Get already booked slots
      const booked = getBookedSlotsForDateStmt.all(dateStr);

      // Collect ALL available slots for this day across all blocks
      const daySlots = [];

      for (const block of scheduleBlocks) {
        const blockStart = timeToMinutes(block.start_time);
        const blockEnd = timeToMinutes(block.end_time);
        const dur = slotDuration || block.slot_duration_min || 30;

        for (let t = blockStart; t + dur <= blockEnd; t += dur) {
          const slotTime = minutesToTime(t);

          // Skip past slots for today
          const nowChile = todayInChile();
          if (dateStr === nowChile) {
            const nowInChile = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
            const nowMinutes = nowInChile.getHours() * 60 + nowInChile.getMinutes();
            if (t <= nowMinutes) continue;
          }

          // Check date-specific blocks
          const slotEnd = t + dur;
          const isBlocked = dateBlocks.some((b) => {
            if (!b.start_time || !b.end_time) return false;
            const bStart = timeToMinutes(b.start_time);
            const bEnd = timeToMinutes(b.end_time);
            return t < bEnd && slotEnd > bStart;
          });
          if (isBlocked) continue;

          // Check existing bookings
          const isBooked = booked.some((b) => {
            const bStart = timeToMinutes(b.appointment_time);
            const bEnd = bStart + (b.duration_min || 30);
            return t < bEnd && slotEnd > bStart;
          });
          if (isBooked) continue;

          daySlots.push({
            date: dateStr,
            time: slotTime,
            dayLabel: dayNames[dayOfWeek],
          });
        }
      }

      if (daySlots.length === 0) continue;

      // Distribute evenly across the day's available slots
      const remaining = count - slots.length;
      if (daySlots.length <= remaining) {
        slots.push(...daySlots);
      } else {
        // Pick distributed slots: first, last, and evenly spaced between
        const step = (daySlots.length - 1) / (remaining - 1);
        for (let i = 0; i < remaining; i++) {
          slots.push(daySlots[Math.round(i * step)]);
        }
      }
    }

    return slots;
  }

  // --- Search patients ---

  function getScheduledAppointmentsByPhone(phone) {
    return getScheduledAppointmentsByPhoneStmt.all(phone);
  }

  function searchPatients(query, limit = 20) {
    const q = '%' + String(query || '').trim() + '%';
    return searchPatientsStmt.all(q, q, q, q, limit);
  }

  // --- Conversation turns (AI memory) ---

  // Hard cap of rows kept per phone so the table cannot grow unbounded.
  const CONVERSATION_TURNS_CAP = 50;

  const appendConversationTurnTx = db.transaction((phone, role, text) => {
    insertConversationTurnStmt.run(phone, role, text);
    capConversationTurnsForPhoneStmt.run(phone, phone, CONVERSATION_TURNS_CAP);
  });

  function appendConversationTurn(phone, role, text) {
    const cleanPhone = String(phone || '').trim();
    const cleanText = String(text || '').trim();
    if (!cleanPhone || !cleanText) return;
    const cleanRole = role === 'assistant' ? 'assistant' : 'user';
    appendConversationTurnTx(cleanPhone, cleanRole, cleanText);
  }

  function getRecentConversationTurns(phone, limit = 12) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return [];
    const safeLimit = Math.max(1, Number(limit) || 12);
    // Stored newest-first; return oldest-first for chronological context.
    return getRecentConversationTurnsStmt.all(cleanPhone, safeLimit).reverse();
  }

  function clearConversationTurns(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return;
    deleteConversationTurnsByPhoneStmt.run(cleanPhone);
  }

  function pruneConversationTurns(maxAgeMs) {
    const ms = Number(maxAgeMs);
    if (!Number.isFinite(ms) || ms <= 0) return;
    const seconds = Math.floor(ms / 1000);
    pruneConversationTurnsByAgeStmt.run(`-${seconds} seconds`);
  }

  // --- CRM auth ---

  function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt:${salt}:${hash}`;
  }

  function timingSafeHexEqual(aHex, bHex) {
    const a = Buffer.from(String(aHex), 'hex');
    const b = Buffer.from(String(bHex), 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function verifyPassword(password, stored) {
    if (!stored) return false;

    if (String(stored).startsWith('scrypt:')) {
      const [, salt, hash] = String(stored).split(':');
      if (!salt || !hash) return false;
      const attempt = crypto.scryptSync(String(password), salt, 64).toString('hex');
      return timingSafeHexEqual(attempt, hash);
    }

    // Legacy SHA-256 (format: salt:hash)
    if (!String(stored).includes(':')) return false;
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const attempt = crypto.createHash('sha256').update(salt + password).digest('hex');
    return timingSafeHexEqual(attempt, hash);
  }

  function isLegacyPasswordHash(stored) {
    return Boolean(stored) && !String(stored).startsWith('scrypt:');
  }

  function updateCrmUserPassword(username, password) {
    updateCrmUserPasswordStmt.run(hashPassword(password), username);
  }

  function getCrmUser(username) {
    return getCrmUserStmt.get(username) || null;
  }

  function createCrmUser(username, password) {
    insertCrmUserStmt.run(username, hashPassword(password));
  }

  function ensureDefaultCrmUser(defaultUser, defaultPass) {
    const count = countCrmUsersStmt.get().total;
    if (count === 0) {
      createCrmUser(defaultUser, defaultPass);
    }
  }

  function getAppointmentsNeedingReminder(date) {
    return getAppointmentsNeedingReminderStmt.all(date);
  }

  function markReminderSent(id) {
    markReminderSentStmt.run(id);
  }

  function close() {
    db.close();
  }

  return {
    db, dbPath,
    getPatientByPhone, getPatientById, createNewPatient, upsertPatientField,
    markFormCompleted, isFormCompleted,
    createConsultation, getLastConsultation, updateAppointmentStatus,
    addSymptoms, getSymptomsByConsultation,
    resetPatient,
    // CRM
    updateConsultationStatus, updateConsultationNotes, markEmailNotified,
    getAllPatients, getConsultationsByPatient, getConsultationById,
    getDashboardStats, searchPatients,
    getCrmUser, createCrmUser, ensureDefaultCrmUser,
    verifyPassword, isLegacyPasswordHash, updateCrmUserPassword,
    // Schedule
    getWeeklySchedule, addScheduleBlock, updateScheduleBlock,
    deactivateScheduleBlock, activateScheduleBlock, deleteScheduleBlock,
    replaceWeeklySchedule,
    // Date blocks
    getDateBlocks, addDateBlock, removeDateBlock,
    // Appointments
    createAppointment, getAppointmentById, getAppointmentsByDate,
    getAppointmentsByDateRange, updateAppointment, rescheduleAppointment,
    getTodayAppointments, getUpcomingAppointments,
    getAvailableSlots, getScheduledAppointmentsByPhone,
    getAppointmentsNeedingReminder, markReminderSent,
    // Conversation memory
    appendConversationTurn, getRecentConversationTurns,
    clearConversationTurns, pruneConversationTurns,
    close,
  };
}

module.exports = { createDatabase };
