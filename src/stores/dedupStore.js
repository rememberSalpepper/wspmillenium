class DedupStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  cleanup() {
    const now = Date.now();

    for (const [key, expiresAt] of this.items.entries()) {
      if (expiresAt <= now) {
        this.items.delete(key);
      }
    }
  }

  addIfNew(key) {
    if (!key) return false;

    this.cleanup();

    const now = Date.now();
    const current = this.items.get(key);

    if (current && current > now) {
      return false;
    }

    this.items.set(key, now + this.ttlMs);
    return true;
  }

  size() {
    this.cleanup();
    return this.items.size;
  }
}

module.exports = { DedupStore };