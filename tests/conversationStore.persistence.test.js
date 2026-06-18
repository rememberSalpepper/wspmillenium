const path = require('path');
const fs = require('fs');
const { createDatabase } = require('../src/database');
const { ConversationStore } = require('../src/stores/conversationStore');

let database;
let dbPath;

const PHONE = '56999999999';
const STORE_OPTS = {
  ttlMs: 24 * 60 * 60 * 1000,
  maxTurns: 12,
  maxChars: 12000,
};

function newStore() {
  return new ConversationStore({ ...STORE_OPTS, database });
}

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

describe('ConversationStore persistence', () => {
  test('rehydrates turns from the database after a "restart"', () => {
    const store = newStore();
    store.append(PHONE, 'user', 'Hola, me duele la cabeza');
    store.append(PHONE, 'assistant', 'Cuénteme hace cuánto');
    store.append(PHONE, 'user', 'Desde ayer');

    // Simulate a process restart: brand new store, same database.
    const revived = newStore();
    const contents = revived.buildContents(PHONE);

    expect(contents).toHaveLength(3);
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'Hola, me duele la cabeza' }] });
    expect(contents[1]).toEqual({ role: 'model', parts: [{ text: 'Cuénteme hace cuánto' }] });
    expect(contents[2]).toEqual({ role: 'user', parts: [{ text: 'Desde ayer' }] });
  });

  test('hasTurns / turnCount reflect persisted turns after restart', () => {
    const store = newStore();
    store.append(PHONE, 'user', 'Mensaje persistido');

    const revived = newStore();
    expect(revived.hasTurns(PHONE)).toBe(true);
    expect(revived.turnCount(PHONE)).toBe(1);
  });

  test('respects maxTurns when rehydrating', () => {
    const store = newStore();
    for (let i = 0; i < 20; i++) {
      store.append(PHONE, i % 2 === 0 ? 'user' : 'assistant', `turno ${i}`);
    }

    const revived = newStore();
    const contents = revived.buildContents(PHONE);
    expect(contents.length).toBeLessThanOrEqual(STORE_OPTS.maxTurns);
    // Most recent turn should be present.
    expect(contents[contents.length - 1].parts[0].text).toBe('turno 19');
  });

  test('clear removes turns from the database', () => {
    const store = newStore();
    store.append(PHONE, 'user', 'algo');
    store.clear(PHONE);

    const revived = newStore();
    expect(revived.hasTurns(PHONE)).toBe(false);
    expect(database.getRecentConversationTurns(PHONE, 12)).toEqual([]);
  });

  test('resetPatient also clears conversation history', () => {
    const store = newStore();
    store.append(PHONE, 'user', 'datos viejos');
    database.resetPatient(PHONE);

    expect(database.getRecentConversationTurns(PHONE, 12)).toEqual([]);
  });
});
