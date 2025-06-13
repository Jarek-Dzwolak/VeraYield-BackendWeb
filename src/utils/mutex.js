class Mutex {
  constructor() {
    this.locks = new Map();
    this.queues = new Map();
  }

  async acquire(key) {
    if (this.locks.has(key)) {
      return new Promise((resolve) => {
        if (!this.queues.has(key)) {
          this.queues.set(key, []);
        }
        this.queues.get(key).push(resolve);
      });
    }

    this.locks.set(key, true);
    return Promise.resolve();
  }
  //RELEASW
  release(key) {
    if (!this.locks.has(key)) {
      return;
    }

    this.locks.delete(key);

    if (this.queues.has(key)) {
      const queue = this.queues.get(key);
      if (queue.length > 0) {
        const resolve = queue.shift();
        this.locks.set(key, true);
        resolve();
      } else {
        this.queues.delete(key);
      }
    }
  }

  async withLock(key, fn) {
    await this.acquire(key);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  isLocked(key) {
    return this.locks.has(key);
  }
}

const mutex = new Mutex();
module.exports = mutex;
