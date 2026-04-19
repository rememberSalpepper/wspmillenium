const express = require('express');
const jwt = require('jsonwebtoken');
const { createAuthMiddleware, createLoginRateLimiter } = require('../middleware/crmAuth');

function createCrmRouter({ config, database }) {
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

  // List patients (paginated)
  router.get('/patients', requireAuth, (req, res) => {
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

  return router;
}

module.exports = { createCrmRouter };
