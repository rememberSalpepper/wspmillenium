const { formatSpanishDate } = require('../src/utils/dateFormat');
const { normalizeForPatterns, wantsRestart, isResetCommand } = require('../src/utils/intent');
const { stripMarkdown, truncateText, isStaleMessage, normalizeDigits } = require('../src/utils/text');

describe('formatSpanishDate', () => {
  test('basic day + month', () => {
    expect(formatSpanishDate('2026-03-05')).toBe('5 de marzo');
  });

  test('with weekday', () => {
    // 2026-03-05 is a Thursday.
    expect(formatSpanishDate('2026-03-05', { withWeekday: true })).toBe('Jueves 5 de marzo');
  });

  test('with year', () => {
    expect(formatSpanishDate('2026-03-05', { withYear: true })).toBe('5 de marzo 2026');
  });

  test('returns input on malformed date', () => {
    expect(formatSpanishDate('not-a-date')).toBe('not-a-date');
  });
});

describe('intent helpers', () => {
  test('normalizeForPatterns strips accents and lowercases', () => {
    expect(normalizeForPatterns('Otra Consúlta')).toBe('otra consulta');
  });

  test('wantsRestart detects restart phrases', () => {
    expect(wantsRestart('quiero una nueva consulta')).toBe(true);
    expect(wantsRestart('hola, me duele la cabeza')).toBe(false);
  });

  test('isResetCommand matches exact reset commands only', () => {
    expect(isResetCommand('borrar datos')).toBe(true);
    expect(isResetCommand('reset')).toBe(true);
    expect(isResetCommand('por favor borra mis datos ahora')).toBe(false);
  });
});

describe('text helpers', () => {
  test('stripMarkdown removes bold/italic/code', () => {
    expect(stripMarkdown('**hola** _mundo_ `code`')).toBe('hola mundo code');
  });

  test('truncateText caps length', () => {
    expect(truncateText('abcdef', 3)).toBe('abc');
    expect(truncateText('   ', 10)).toBe('No pude generar una respuesta.');
  });

  test('normalizeDigits keeps only digits', () => {
    expect(normalizeDigits('+56 9 1234 5678')).toBe('56912345678');
  });

  test('isStaleMessage compares against max age', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(isStaleMessage(nowSec - 1000, 300)).toBe(true);
    expect(isStaleMessage(nowSec - 10, 300)).toBe(false);
    expect(isStaleMessage(null, 300)).toBe(false);
  });
});
