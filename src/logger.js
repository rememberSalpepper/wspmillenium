// Field names whose values are phone numbers (masked, keeping last 4 digits).
const PHONE_KEYS = new Set(['from', 'to', 'phone', 'recipientId', 'displayPhoneNumber']);

// Field names whose values are free-text content that may contain PII (redacted).
const CONTENT_KEYS = new Set([
  'textPreview',
  'combinedPreview',
  'replyPreview',
  'lastTurns',
]);

function maskPhone(value) {
  const str = String(value ?? '');
  const digits = str.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return '*'.repeat(digits.length - 4) + digits.slice(-4);
}

function redact(value, key) {
  if (PHONE_KEYS.has(key)) {
    return value == null ? value : maskPhone(value);
  }

  if (CONTENT_KEYS.has(key)) {
    return '[redacted]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, key));
  }

  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redact(v, k);
    }
    return out;
  }

  return value;
}

function log(level, event, data = {}) {
  const logPii = String(process.env.LOG_PII || '').toLowerCase();
  const piiEnabled = ['1', 'true', 'yes', 'on'].includes(logPii);

  const safeData = piiEnabled ? data : redact(data, null);

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...safeData,
  };

  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
    return;
  }

  console.log(line);
}

module.exports = { log, maskPhone };
