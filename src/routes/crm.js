const express = require('express');
const jwt = require('jsonwebtoken');
const { createAuthMiddleware, createLoginRateLimiter } = require('../middleware/crmAuth');

const { log } = require('../logger');

function createCrmRouter({ config, database, whatsappService }) {
  const router = express.Router();
  const requireAuth = createAuthMiddleware(config);
  const rateLimitLogin = createLoginRateLimiter();

  // Login
  router.post('/login', rateLimitLogin, (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'missing_credentials' });
    }

    const user = database.getCrmUser(username);
    if (!user || !database.verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    // Transparent upgrade: re-hash legacy SHA-256 passwords to scrypt on login.
    if (database.isLegacyPasswordHash(user.password_hash)) {
      try {
        database.updateCrmUserPassword(user.username, password);
        log('info', 'crm.password_rehashed', { username: user.username });
      } catch (err) {
        log('error', 'crm.password_rehash_failed', { username: user.username, error: err?.message });
      }
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      config.CRM_JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ token, username: user.username });
  });

  // Dashboard stats
  router.get('/stats', requireAuth, (req, res) => {
    const stats = database.getDashboardStats();
    res.json(stats);
  });

  // Search / list patients (paginated)
  router.get('/patients', requireAuth, (req, res) => {
    const search = req.query.search;
    if (search && search.trim()) {
      const patients = database.searchPatients(search.trim());
      res.json({ patients, total: patients.length });
      return;
    }
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 100);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const result = database.getAllPatients({ limit, offset });
    res.json(result);
  });

  // Patient detail with consultations
  router.get('/patients/:id', requireAuth, (req, res) => {
    const patient = database.getPatientById(parseInt(req.params.id));
    if (!patient) return res.status(404).json({ error: 'not_found' });

    const consultations = database.getConsultationsByPatient(patient.id);
    res.json({ patient, consultations });
  });

  // Consultation detail with symptoms
  router.get('/consultations/:id', requireAuth, (req, res) => {
    const consultation = database.getConsultationById(parseInt(req.params.id));
    if (!consultation) return res.status(404).json({ error: 'not_found' });

    const symptoms = database.getSymptomsByConsultation(consultation.id);
    const patient = database.getPatientById(consultation.patient_id);
    res.json({ consultation, symptoms, patient });
  });

  // Update consultation status/notes
  router.patch('/consultations/:id', requireAuth, (req, res) => {
    const id = parseInt(req.params.id);
    const consultation = database.getConsultationById(id);
    if (!consultation) return res.status(404).json({ error: 'not_found' });

    const { status, notes } = req.body || {};

    if (status && ['open', 'closed', 'attended'].includes(status)) {
      database.updateConsultationStatus(id, status);
    }

    if (notes !== undefined) {
      database.updateConsultationNotes(id, notes);
    }

    const updated = database.getConsultationById(id);
    res.json(updated);
  });

  // ─── Schedule endpoints ───────────────────────────────────────────

  // Get weekly schedule
  router.get('/schedule', requireAuth, (req, res) => {
    try {
      const schedule = database.getWeeklySchedule();
      res.json(schedule);
    } catch (err) {
      log('error', 'crm.schedule_error', { error: err?.message });
      res.status(500).json({ error: 'schedule_load_failed', details: err?.message });
    }
  });

  // Get all date blocks (must be before /schedule/:id)
  router.get('/schedule/blocks', requireAuth, (req, res) => {
    try {
      res.json(database.getDateBlocks());
    } catch (err) {
      log('error', 'crm.blocks_error', { error: err?.message });
      res.status(500).json({ error: 'blocks_load_failed', details: err?.message });
    }
  });

  // Add date block
  router.post('/schedule/blocks', requireAuth, (req, res) => {
    const { block_date, start_time, end_time, block_type, reason } = req.body || {};
    if (!block_date) return res.status(400).json({ error: 'block_date_required' });
    const id = database.addDateBlock(block_date, start_time, end_time, block_type, reason);
    res.json({ id });
  });

  // Remove date block
  router.delete('/schedule/blocks/:id', requireAuth, (req, res) => {
    database.removeDateBlock(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // Replace entire weekly schedule
  router.put('/schedule', requireAuth, (req, res) => {
    const { blocks } = req.body || {};
    if (!Array.isArray(blocks)) return res.status(400).json({ error: 'blocks_required' });
    database.replaceWeeklySchedule(blocks);
    res.json(database.getWeeklySchedule());
  });

  // Add schedule block
  router.post('/schedule', requireAuth, (req, res) => {
    const { day_of_week, start_time, end_time, slot_duration_min } = req.body || {};
    if (day_of_week === undefined || !start_time || !end_time) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const id = database.addScheduleBlock(day_of_week, start_time, end_time, slot_duration_min || 30);
    res.json({ id });
  });

  // Delete schedule block
  router.delete('/schedule/:id', requireAuth, (req, res) => {
    database.deleteScheduleBlock(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // ─── Appointment endpoints ──────────────────────────────────────

  // List appointments (with optional date range filter)
  router.get('/appointments', requireAuth, (req, res) => {
    try {
      const { from, to } = req.query;
      if (from && to) {
        res.json(database.getAppointmentsByDateRange(from, to));
      } else {
        res.json(database.getUpcomingAppointments());
      }
    } catch (err) {
      log('error', 'crm.appointments_error', { error: err?.message });
      res.status(500).json({ error: 'appointments_load_failed', details: err?.message });
    }
  });

  // Get appointments for a specific day
  router.get('/appointments/day/:date', requireAuth, (req, res) => {
    try {
      res.json(database.getAppointmentsByDate(req.params.date));
    } catch (err) {
      log('error', 'crm.appointments_day_error', { date: req.params.date, error: err?.message });
      res.status(500).json({ error: 'appointments_day_failed', details: err?.message });
    }
  });

  // Today's appointments
  router.get('/appointments/today', requireAuth, (req, res) => {
    res.json(database.getTodayAppointments());
  });

  // Available slots for rescheduling
  router.get('/appointments/:id/available-slots', requireAuth, (req, res) => {
    const apt = database.getAppointmentById(parseInt(req.params.id));
    if (!apt) return res.status(404).json({ error: 'not_found' });

    const fromDate = req.query.date || new Date().toISOString().split('T')[0];
    const slots = database.getAvailableSlots(fromDate, 10, apt.duration_min || 30);
    res.json(slots);
  });

  // Update appointment (status, notes, reschedule)
  router.patch('/appointments/:id', requireAuth, (req, res) => {
    const id = parseInt(req.params.id);
    const apt = database.getAppointmentById(id);
    if (!apt) return res.status(404).json({ error: 'not_found' });

    const { status, notes, appointment_date, appointment_time } = req.body || {};
    const patient = database.getPatientById(apt.patient_id);
    const patientName = patient?.nombre || 'paciente';

    if (appointment_date && appointment_time) {
      database.rescheduleAppointment(id, appointment_date, appointment_time);

      // Notify patient via WhatsApp
      if (whatsappService && apt.phone) {
        const msg = [
          `Estimado(a) ${patientName},`,
          '',
          'Su cita ha sido reagendada.',
          `Nueva fecha: ${appointment_date}`,
          `Nueva hora: ${appointment_time}`,
          '',
          'Si necesita cancelar o reagendar, escríbanos.',
        ].join('\n');

        whatsappService.sendText(apt.phone, msg).catch((err) => {
          log('error', 'crm.reschedule_notification_failed', { phone: apt.phone, error: err?.message });
        });
      }
    } else if (status) {
      database.updateAppointment(id, status, notes !== undefined ? notes : apt.notes);

      // Notify patient via WhatsApp on cancellation
      if (status === 'cancelled' && whatsappService && apt.phone) {
        const msg = [
          `Estimado(a) ${patientName},`,
          '',
          'Lamentamos informarle que su cita ha sido cancelada.',
          `Fecha original: ${apt.appointment_date}`,
          `Hora original: ${apt.appointment_time}`,
          '',
          'Si desea reagendar, escríbanos por este medio.',
        ].join('\n');

        whatsappService.sendText(apt.phone, msg).catch((err) => {
          log('error', 'crm.cancel_notification_failed', { phone: apt.phone, error: err?.message });
        });
      }
    }

    res.json(database.getAppointmentById(id));
  });

  return router;
}

module.exports = { createCrmRouter };
