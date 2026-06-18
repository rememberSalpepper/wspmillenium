const path = require('path');
const fs = require('fs');
const { createDatabase } = require('../src/database');
const { createMemoryService } = require('../src/services/memory');

let database;
let dbPath;

beforeEach(() => {
  dbPath = path.join(__dirname, `test-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  database = createDatabase({ DB_PATH: dbPath });
});

afterEach(() => {
  database.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { fs.unlinkSync(dbPath + '-shm'); } catch {}
});

describe('patient_memory (database)', () => {
  test('upsert + get returns the stored summary', () => {
    database.upsertPatientMemory('56911112222', 'Paciente con cefalea recurrente.', 4);
    const row = database.getPatientMemory('56911112222');
    expect(row.summary).toBe('Paciente con cefalea recurrente.');
    expect(row.turns_at_update).toBe(4);
  });

  test('upsert overwrites existing summary (ON CONFLICT)', () => {
    database.upsertPatientMemory('56911112222', 'Primer resumen', 2);
    database.upsertPatientMemory('56911112222', 'Segundo resumen', 6);
    const row = database.getPatientMemory('56911112222');
    expect(row.summary).toBe('Segundo resumen');
    expect(row.turns_at_update).toBe(6);
  });

  test('empty summary is ignored', () => {
    database.upsertPatientMemory('56911112222', '   ', 1);
    expect(database.getPatientMemory('56911112222')).toBeNull();
  });

  test('clearPatientMemory removes the row', () => {
    database.upsertPatientMemory('56911112222', 'algo', 1);
    database.clearPatientMemory('56911112222');
    expect(database.getPatientMemory('56911112222')).toBeNull();
  });

  test('resetPatient also clears long-term memory', () => {
    database.createNewPatient('56911112222');
    database.upsertPatientMemory('56911112222', 'algo', 1);
    database.resetPatient('56911112222');
    expect(database.getPatientMemory('56911112222')).toBeNull();
  });
});

describe('memoryService', () => {
  function fakeConversationStore(turns) {
    return {
      getTurns: () => turns,
      turnCount: () => turns.length,
    };
  }

  test('getSummary reads persisted summary when enabled', () => {
    database.upsertPatientMemory('569', 'Resumen guardado', 3);
    const svc = createMemoryService({
      database,
      geminiService: { summarizeConversation: jest.fn() },
      config: { LONGTERM_MEMORY: true, MEMORY_SUMMARY_EVERY_TURNS: 10 },
    });
    expect(svc.getSummary('569')).toBe('Resumen guardado');
  });

  test('getSummary returns empty when disabled', () => {
    database.upsertPatientMemory('569', 'Resumen guardado', 3);
    const svc = createMemoryService({
      database,
      geminiService: { summarizeConversation: jest.fn() },
      config: { LONGTERM_MEMORY: false, MEMORY_SUMMARY_EVERY_TURNS: 10 },
    });
    expect(svc.getSummary('569')).toBe('');
  });

  test('noteTurn triggers a summary update after enough turns', async () => {
    const summarize = jest.fn().mockResolvedValue('Resumen nuevo del paciente');
    const svc = createMemoryService({
      database,
      geminiService: { summarizeConversation: summarize },
      config: { LONGTERM_MEMORY: true, MEMORY_SUMMARY_EVERY_TURNS: 3 },
    });

    const store = fakeConversationStore([
      { role: 'user', text: 'me duele la cabeza hace dias' },
      { role: 'assistant', text: 'entiendo, cuenteme mas detalles por favor' },
    ]);

    svc.noteTurn('569', store); // 1
    svc.noteTurn('569', store); // 2
    expect(summarize).not.toHaveBeenCalled();

    svc.noteTurn('569', store); // 3 -> triggers
    // Allow the fire-and-forget promise to resolve.
    await new Promise((r) => setImmediate(r));

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(database.getPatientMemory('569').summary).toBe('Resumen nuevo del paciente');
  });

  test('noteTurn does nothing when memory disabled', () => {
    const summarize = jest.fn();
    const svc = createMemoryService({
      database,
      geminiService: { summarizeConversation: summarize },
      config: { LONGTERM_MEMORY: false, MEMORY_SUMMARY_EVERY_TURNS: 1 },
    });
    svc.noteTurn('569', fakeConversationStore([{ role: 'user', text: 'hola que tal todo' }]));
    expect(summarize).not.toHaveBeenCalled();
  });
});
