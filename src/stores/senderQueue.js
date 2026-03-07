class SenderQueue {
  constructor() {
    this.queues = new Map();
  }

  enqueue(senderId, task) {
    const previous = this.queues.get(senderId) || Promise.resolve();

    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this.queues.get(senderId) === next) {
          this.queues.delete(senderId);
        }
      });

    this.queues.set(senderId, next);
    return next;
  }

  size() {
    return this.queues.size;
  }
}

module.exports = { SenderQueue };