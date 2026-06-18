// User-intent detection helpers (restart / reset commands) shared by the
// webhook and the menu handler.

const RESTART_PATTERNS = [
  /\bformulario\b/,
  /\breinicia/,
  /\brenuev/,
  /\bempezar de nuevo\b/,
  /\bempezar desde cero\b/,
  /\bde nuevo\b/,
  /\bdesde cero\b/,
  /\bnuevo paciente\b/,
  /\bnueva consulta\b/,
  /\botra consulta\b/,
  /\breset\b/,
];

const RESET_COMMAND = /^\s*(?:borrar datos|borrar|reset|limpiar datos|limpiar)\s*$/;

function normalizeForPatterns(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function wantsRestart(prompt) {
  const normalized = normalizeForPatterns(prompt);
  return RESTART_PATTERNS.some((p) => p.test(normalized));
}

function isResetCommand(prompt) {
  const normalized = normalizeForPatterns(prompt);
  return RESET_COMMAND.test(normalized);
}

module.exports = {
  RESTART_PATTERNS,
  RESET_COMMAND,
  normalizeForPatterns,
  wantsRestart,
  isResetCommand,
};
