const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { verifyWebhookSignature } = require('../src/utils/signature');
const { maskPhone } = require('../src/logger');
const { createDatabase } = require('../src/database');

describe('verifyWebhookSignature', () => {
  const secret = 'super-secret-app-key';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const validSig =
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  test('accepts a valid signature', () => {
    expect(verifyWebhookSignature(body, validSig, secret)).toBe(true);
  });

  test('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ hello: 'evil' }));
    expect(verifyWebhookSignature(tampered, validSig, secret)).toBe(false);
  });

  test('rejects a missing or malformed header', () => {
    expect(verifyWebhookSignature(body, '', secret)).toBe(false);
    expect(verifyWebhookSignature(body, 'md5=abc', secret)).toBe(false);
  });

  test('returns true (disabled) when no secret is configured', () => {
    expect(verifyWebhookSignature(body, validSig, '')).toBe(true);
  });
});

describe('maskPhone', () => {
  test('keeps only the last 4 digits', () => {
    expect(maskPhone('56912345678')).toBe('*******5678');
  });

  test('masks short values fully', () => {
    expect(maskPhone('123')).toBe('****');
  });
});

describe('password hashing (scrypt + legacy compat)', () => {
  let database;
  let dbPath;

  beforeEach(() => {
    dbPath = path.join(__dirname, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    database = createDatabase({ DB_PATH: dbPath });
  });

  afterEach(() => {
    database.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  test('default admin user is created with a scrypt hash and verifies', () => {
    database.ensureDefaultCrmUser('admin', 'secret123');
    const user = database.getCrmUser('admin');
    expect(user.password_hash.startsWith('scrypt:')).toBe(true);
    expect(database.isLegacyPasswordHash(user.password_hash)).toBe(false);
    expect(database.verifyPassword('secret123', user.password_hash)).toBe(true);
    expect(database.verifyPassword('wrong', user.password_hash)).toBe(false);
  });

  test('verifies a legacy SHA-256 hash and upgrades it to scrypt', () => {
    // Build a legacy hash the old way: salt + sha256(salt + password)
    const salt = crypto.randomBytes(16).toString('hex');
    const legacyHash = `${salt}:${crypto.createHash('sha256').update(salt + 'legacypass').digest('hex')}`;

    database.createCrmUser('legacy', 'placeholder');
    // Force the stored hash to legacy format directly.
    database.db.prepare('UPDATE crm_users SET password_hash = ? WHERE username = ?')
      .run(legacyHash, 'legacy');

    let user = database.getCrmUser('legacy');
    expect(database.isLegacyPasswordHash(user.password_hash)).toBe(true);
    expect(database.verifyPassword('legacypass', user.password_hash)).toBe(true);

    // Simulate the login upgrade path.
    database.updateCrmUserPassword('legacy', 'legacypass');
    user = database.getCrmUser('legacy');
    expect(user.password_hash.startsWith('scrypt:')).toBe(true);
    expect(database.verifyPassword('legacypass', user.password_hash)).toBe(true);
  });
});
