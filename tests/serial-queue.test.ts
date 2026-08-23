import { describe, expect, it } from 'vitest';

import { SerialQueue } from '../src/serial-queue.js';

describe('SerialQueue', () => {
  it('never overlaps browser operations', async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = queue.run(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    expect(queue.pendingCount).toBe(2);
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(queue.pendingCount).toBe(0);
  });
});
