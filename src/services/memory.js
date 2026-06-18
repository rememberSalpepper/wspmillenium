const { log } = require('../logger');

// Long-term summarized memory per patient (Fase 5).
// Keeps a persistent summary that is injected into the system prompt so the bot
// retains useful context across sessions, beyond the rolling conversation window.
function createMemoryService({ database, geminiService, config }) {
  const enabled = Boolean(config.LONGTERM_MEMORY);
  const every = Math.max(2, Number(config.MEMORY_SUMMARY_EVERY_TURNS) || 10);

  // Per-phone count of turns observed since the last summary was written.
  // In-memory only: if the process restarts the counter resets, but the stored
  // summary is preserved, so we just rebuild momentum from zero.
  const turnsSinceSummary = new Map();

  function getSummary(phone) {
    if (!enabled) return '';
    const row = database.getPatientMemory(phone);
    return row?.summary || '';
  }

  async function updateSummary(phone, turns) {
    const previousSummary = getSummary(phone);
    const summary = await geminiService.summarizeConversation({ previousSummary, turns });

    if (summary && summary !== previousSummary) {
      database.upsertPatientMemory(phone, summary, turns.length);
      log('info', 'memory.summary_updated', { phone, length: summary.length });
    }
  }

  // Call after each general-conversation reply. Once enough new turns have
  // accumulated, refresh the summary in the background (fire-and-forget).
  function noteTurn(phone, conversationStore) {
    if (!enabled) return;

    const count = (turnsSinceSummary.get(phone) || 0) + 1;

    if (count < every) {
      turnsSinceSummary.set(phone, count);
      return;
    }

    turnsSinceSummary.set(phone, 0);

    const turns = conversationStore.getTurns(phone);
    if (turns.length === 0) return;

    updateSummary(phone, turns).catch((err) => {
      log('error', 'memory.update_failed', { phone, error: err?.message });
    });
  }

  function clear(phone) {
    turnsSinceSummary.delete(phone);
    database.clearPatientMemory(phone);
  }

  return { enabled, getSummary, updateSummary, noteTurn, clear };
}

module.exports = { createMemoryService };
