const crypto = require('crypto');

// Verifies Meta's X-Hub-Signature-256 header against the raw request body.
// Returns true when no secret is configured (verification disabled by caller).
function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret) return true;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  if (!rawBody || !rawBody.length) return false;

  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const received = Buffer.from(signatureHeader);
  const computed = Buffer.from(expected);

  if (received.length !== computed.length) return false;

  try {
    return crypto.timingSafeEqual(received, computed);
  } catch {
    return false;
  }
}

module.exports = { verifyWebhookSignature };
