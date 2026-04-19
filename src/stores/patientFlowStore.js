const FLOW_STATES = {
  WELCOME: 'welcome',
  COLLECTING_RUT: 'collecting_rut',
  COLLECTING_NOMBRE: 'collecting_nombre',
  COLLECTING_CORREO: 'collecting_correo',
  COLLECTING_TELEFONO: 'collecting_telefono',
  COLLECTING_DIRECCION: 'collecting_direccion',
  CONFIRMING_FORM: 'confirming_form',
  CONSULTATION: 'consultation',
  CONSULTATION_SUMMARY: 'consultation_summary',
  AWAITING_APPOINTMENT: 'awaiting_appointment',
  COMPLETED: 'completed',
  CONFIRMING_IDENTITY: 'confirming_identity',
};

const FORM_STATES = new Set([
  FLOW_STATES.COLLECTING_RUT,
  FLOW_STATES.COLLECTING_NOMBRE,
  FLOW_STATES.COLLECTING_CORREO,
  FLOW_STATES.COLLECTING_TELEFONO,
  FLOW_STATES.COLLECTING_DIRECCION,
  FLOW_STATES.CONFIRMING_FORM,
]);

const FIELD_TO_STATE = {
  rut: FLOW_STATES.COLLECTING_RUT,
  nombre: FLOW_STATES.COLLECTING_NOMBRE,
  correo: FLOW_STATES.COLLECTING_CORREO,
  telefono: FLOW_STATES.COLLECTING_TELEFONO,
  direccion: FLOW_STATES.COLLECTING_DIRECCION,
};

function deriveFlowStateFromPatient(patient) {
  if (!patient) {
    return FLOW_STATES.COLLECTING_RUT;
  }

  if (!patient.rut) return FLOW_STATES.COLLECTING_RUT;
  if (!patient.nombre) return FLOW_STATES.COLLECTING_NOMBRE;
  if (!patient.correo) return FLOW_STATES.COLLECTING_CORREO;
  if (!patient.telefono) return FLOW_STATES.COLLECTING_TELEFONO;
  if (!patient.direccion) return FLOW_STATES.COLLECTING_DIRECCION;
  if (!patient.form_completed) return FLOW_STATES.CONFIRMING_FORM;
  return FLOW_STATES.CONSULTATION;
}

function deriveFlowStateFromDatabase(database, phone, patient = null) {
  const resolvedPatient = patient || database.getPatientByPhone(phone);
  const baseState = deriveFlowStateFromPatient(resolvedPatient);

  if (baseState !== FLOW_STATES.CONSULTATION) {
    return baseState;
  }

  const lastConsultation = database.getLastConsultation(phone);
  if (lastConsultation) {
    return FLOW_STATES.COMPLETED;
  }

  return FLOW_STATES.CONSULTATION;
}

class PatientFlowStore {
  constructor({ database, ttlMs }) {
    this.database = database;
    this.ttlMs = ttlMs;
    this.states = new Map();
  }

  cleanup() {
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) return;

    const now = Date.now();

    for (const [phone, entry] of this.states.entries()) {
      if (!entry?.lastUpdated || now - entry.lastUpdated > this.ttlMs) {
        this.states.delete(phone);
      }
    }
  }

  inferState(phone) {
    return deriveFlowStateFromDatabase(this.database, phone);
  }

  getState(phone) {
    this.cleanup();

    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return FLOW_STATES.COLLECTING_RUT;

    const existing = this.states.get(cleanPhone);
    if (existing?.state) {
      existing.lastUpdated = Date.now();
      return existing.state;
    }

    const state = this.inferState(cleanPhone);
    this.setState(cleanPhone, state);
    return state;
  }

  setState(phone, state) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return state;

    this.states.set(cleanPhone, {
      state,
      lastUpdated: Date.now(),
    });

    return state;
  }

  syncState(phone, patient = null) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return FLOW_STATES.COLLECTING_RUT;

    const state = deriveFlowStateFromDatabase(this.database, cleanPhone, patient);
    this.setState(cleanPhone, state);
    return state;
  }

  clearState(phone) {
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) return;
    this.states.delete(cleanPhone);
  }

  size() {
    this.cleanup();
    return this.states.size;
  }
}

function isFormCollectionState(state) {
  return FORM_STATES.has(state);
}

module.exports = {
  FLOW_STATES,
  FIELD_TO_STATE,
  PatientFlowStore,
  deriveFlowStateFromPatient,
  deriveFlowStateFromDatabase,
  isFormCollectionState,
};
