const jwt = require('jsonwebtoken');

function createAuthMiddleware(config) {
  return function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const token = authHeader.slice(7);
      const payload = jwt.verify(token, config.CRM_JWT_SECRET);
      req.adminUser = payload;
      next();
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
  };
}

// Simple in-memory rate limiter for login
function createLoginRateLimiter() {
  const attempts = new Map();
  const MAX_ATTEMPTS = 5;
  const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  return function rateLimitLogin(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const record = attempts.get(ip);

    if (record) {
      // Clean old attempts
      record.times = record.times.filter((t) => now - t < WINDOW_MS);

      if (record.times.length >= MAX_ATTEMPTS) {
        return res.status(429).json({ error: 'too_many_attempts' });
      }
    }

    // Track this attempt after response
    res.on('finish', () => {
      if (res.statusCode === 401) {
        const r = attempts.get(ip) || { times: [] };
        r.times.push(now);
        attempts.set(ip, r);
      }
    });

    next();
  };
}

module.exports = { createAuthMiddleware, createLoginRateLimiter };
