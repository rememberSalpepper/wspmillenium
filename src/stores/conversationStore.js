class ConversationStore {
  constructor({ ttlMs, maxTurns, maxChars, database = null }) {
    this.ttlMs = ttlMs;
    this.maxTurns = maxTurns;
    this.maxChars = maxChars;
    this.database = database;
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

  // Load persisted turns from the database (oldest-first) into the in-memory shape.
  loadTurnsFromDb(id) {
    if (!this.database?.getRecentConversationTurns) return [];

    const rows = this.database.getRecentConversationTurns(id, this.maxTurns);
    return rows.map((row) => ({
      role: row.role,
      text: row.text,
      at: row.created_at || new Date().toISOString(),
    }));
  }

  getSession(id) {
    this.cleanup();

    const now = Date.now();
    const existing = this.sessions.get(id);

    if (!existing || now - existing.lastTouchedAt > this.ttlMs) {
      const fresh = {
        turns: this.loadTurnsFromDb(id),
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
    if (existing) return existing;

    // Cache miss (e.g. after a restart): rehydrate from the database if available.
    const turns = this.loadTurnsFromDb(id);
    if (turns.length === 0) return null;

    const session = { turns, lastTouchedAt: Date.now() };
    this.sessions.set(id, session);
    return session;
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

    // Write-through to the database so memory survives restarts.
    if (this.database?.appendConversationTurn) {
      this.database.appendConversationTurn(id, role, cleanText);
    }
  }

  hasTurns(id) {
    const session = this.peekSession(id);
    return Boolean(session?.turns?.length);
  }

  turnCount(id) {
    const session = this.peekSession(id);
    return session?.turns?.length || 0;
  }

  // Returns the recent turns as plain { role, text } objects (oldest-first).
  getTurns(id) {
    const session = this.peekSession(id);
    if (!session?.turns?.length) return [];
    return session.turns.map((turn) => ({ role: turn.role, text: turn.text }));
  }

  clear(id) {
    this.sessions.delete(id);

    if (this.database?.clearConversationTurns) {
      this.database.clearConversationTurns(id);
    }
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
