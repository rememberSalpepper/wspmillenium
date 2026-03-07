class InboundBufferStore {
  constructor({ bufferMs }) {
    this.bufferMs = bufferMs;
    this.buffers = new Map();
  }

  push(senderId, messageData, onFlush) {
    if (!senderId) {
      throw new Error('senderId es requerido en InboundBufferStore.push');
    }

    const now = Date.now();
    const existing = this.buffers.get(senderId);

    if (!existing) {
      const entry = {
        senderId,
        items: [messageData],
        timer: null,
        createdAt: now,
        updatedAt: now,
      };

      entry.timer = this.#buildTimer(senderId, onFlush);
      this.buffers.set(senderId, entry);
      return;
    }

    existing.items.push(messageData);
    existing.updatedAt = now;

    clearTimeout(existing.timer);
    existing.timer = this.#buildTimer(senderId, onFlush);
  }

  #buildTimer(senderId, onFlush) {
    return setTimeout(async () => {
      const entry = this.buffers.get(senderId);
      if (!entry) return;

      this.buffers.delete(senderId);

      const batch = this.#buildBatch(entry.items, senderId);

      try {
        await onFlush(batch);
      } catch (err) {
        // El manejo del error se hace fuera
      }
    }, this.bufferMs);
  }

  #buildBatch(items, senderId) {
    const sorted = [...items].sort((a, b) => {
      const at = Number(a.timestamp || 0);
      const bt = Number(b.timestamp || 0);
      return at - bt;
    });

    const combinedText = sorted
      .map((item) => String(item.text || '').trim())
      .filter(Boolean)
      .join('\n');

    const lastItem = sorted[sorted.length - 1] || {};

    return {
      senderId,
      items: sorted,
      count: sorted.length,
      combinedText,
      firstMsgId: sorted[0]?.msgId || null,
      lastMsgId: lastItem?.msgId || null,
      timestamp: lastItem?.timestamp || null,
      metadata: lastItem?.metadata || null,
    };
  }

  size() {
    return this.buffers.size;
  }
}

module.exports = { InboundBufferStore };