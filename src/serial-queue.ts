export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  get pendingCount(): number {
    return this.waiting;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      this.waiting -= 1;
      release();
    }
  }
}
