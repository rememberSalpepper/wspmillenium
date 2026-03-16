function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeRut(value) {
  const compact = String(value || '')
    .replace(/\./g, '')
    .replace(/\s+/g, '')
    .toUpperCase();

  const match = compact.match(/^(\d{7,8})-?([\dK])$/);
  if (!match) return '';

  const [, body, verifier] = match;
  return `${body}-${verifier}`;
}

function computeRutVerifier(body) {
  const digits = String(body || '').replace(/\D/g, '');
  if (!digits) return '';

  let sum = 0;
  let multiplier = 2;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += Number(digits[index]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  if (remainder === 11) return '0';
  if (remainder === 10) return 'K';
  return String(remainder);
}

function validateRut(value) {
  const normalized = normalizeRut(value);
  if (!normalized) {
    return { valid: false, value: null };
  }

  const [body, verifier] = normalized.split('-');
  const expected = computeRutVerifier(body);
  const valid = verifier === expected;

  return {
    valid,
    value: valid ? normalized : null,
  };
}

function normalizeFullName(value) {
  return cleanText(value);
}

function validateFullName(value) {
  const normalized = normalizeFullName(value);
  const parts = normalized.split(' ').filter(Boolean);

  return {
    valid: parts.length >= 2 && normalized.length >= 5,
    value: parts.length >= 2 ? normalized : null,
  };
}

function normalizeEmail(value) {
  return cleanText(value).toLowerCase();
}

function validateEmail(value) {
  const normalized = normalizeEmail(value);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);

  return {
    valid,
    value: valid ? normalized : null,
  };
}

function normalizePhone(value) {
  const trimmed = cleanText(value);
  if (!trimmed) return '';

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

function validatePhone(value) {
  const normalized = normalizePhone(value);
  const digits = normalized.replace(/\D/g, '');
  const valid = digits.length >= 8;

  return {
    valid,
    value: valid ? normalized : null,
  };
}

function normalizeAddress(value) {
  return cleanText(value);
}

function validateAddress(value) {
  const normalized = normalizeAddress(value);

  return {
    valid: normalized.length >= 5,
    value: normalized.length >= 5 ? normalized : null,
  };
}

module.exports = {
  normalizeRut,
  validateRut,
  normalizeFullName,
  validateFullName,
  normalizeEmail,
  validateEmail,
  normalizePhone,
  validatePhone,
  normalizeAddress,
  validateAddress,
};
