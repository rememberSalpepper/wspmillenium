function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeRut(value) {
  const compact = String(value || '')
    .replace(/[.\s]/g, '')
    .toUpperCase();

  const match = compact.match(/^(\d{7,8})-?([\dK])$/);
  if (!match) return '';

  const [, body, verifier] = match;
  return `${body}-${verifier}`;
}

function validateRut(value) {
  const normalized = normalizeRut(value);
  const valid = /^\d{7,8}-[\dK]$/.test(normalized);

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
  let digits = cleanText(value).replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('56') && digits.length > 9) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('0') && digits.length > 8) {
    digits = digits.slice(1);
  }

  return digits;
}

function validatePhone(value) {
  const normalized = normalizePhone(value);
  const valid = /^\d{8,11}$/.test(normalized);

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
