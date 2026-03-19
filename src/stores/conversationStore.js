class ConversationStore {
  constructor({ ttlMs, maxTurns, maxChars }) {
    this.ttlMs = ttlMs;
    this.maxTurns = maxTurns;
    this.maxChars = maxChars;
    this.sessions = new Map();
  }

  cleanup() {
    const now = Date.now();

    for (const [id, session] of this.sessions.entries()) {
      if (!session?.lastTouchedAt || now - session.lastTouchedAt > this.ttlMs) {
        this.sessions.delete(id);
      }
    }
  }

  getSession(id) {
    this.cleanup();

    const now = Date.now();
    const existing = this.sessions.get(id);

    if (!existing || now - existing.lastTouchedAt > this.ttlMs) {
      const fresh = {
        turns: [],
        lastTouchedAt: now,
      };

      this.sessions.set(id, fresh);
      return fresh;
    }

    existing.lastTouchedAt = now;
    return existing;
  }

  peekSession(id) {
    this.cleanup();

    const existing = this.sessions.get(id);
    if (!existing) return null;

    return existing;
  }

  trimTurns(turns) {
    const recent = turns.slice(-this.maxTurns);

    let totalChars = 0;
    const selected = [];

    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const turn = recent[i];
      const size = String(turn?.text || '').length;

      if (selected.length > 0 && totalChars + size > this.maxChars) {
        break;
      }

      totalChars += size;
      selected.push(turn);
    }

    return selected.reverse();
  }

  append(id, role, text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return;

    const session = this.getSession(id);

    session.turns.push({
      role,
      text: cleanText,
      at: new Date().toISOString(),
    });

    session.turns = this.trimTurns(session.turns);
    session.lastTouchedAt = Date.now();
  }

  hasTurns(id) {
    const session = this.peekSession(id);
    return Boolean(session?.turns?.length);
  }

  turnCount(id) {
    const session = this.peekSession(id);
    return session?.turns?.length || 0;
  }

  clear(id) {
    this.sessions.delete(id);
  }

  buildContents(id) {
    const session = this.getSession(id);
    const turns = this.trimTurns(session.turns);

    return turns.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.text }],
    }));
  }

  size() {
    this.cleanup();
    return this.sessions.size;
  }
}

module.exports = { ConversationStore };
