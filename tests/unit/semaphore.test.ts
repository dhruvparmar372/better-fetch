import { describe, test, expect } from "bun:test";
import { Semaphore } from "@/semaphore.ts";

describe("Semaphore", () => {
  test("allows up to max concurrent acquires", async () => {
    const sem = new Semaphore(3);

    await sem.acquire();
    await sem.acquire();
    await sem.acquire();

    expect(sem.active).toBe(3);
    expect(sem.queued).toBe(0);
  });

  test("queues beyond max", async () => {
    const sem = new Semaphore(2);

    await sem.acquire();
    await sem.acquire();

    let thirdResolved = false;
    const thirdPromise = sem.acquire().then(() => { thirdResolved = true; });

    await Promise.resolve();
    expect(thirdResolved).toBe(false);
    expect(sem.queued).toBe(1);

    sem.release();
    await thirdPromise;
    expect(thirdResolved).toBe(true);
    expect(sem.active).toBe(2);
    expect(sem.queued).toBe(0);
  });

  test("processes queue in FIFO order", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];

    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));

    expect(sem.queued).toBe(3);

    sem.release();
    await p1;
    sem.release();
    await p2;
    sem.release();
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  test("release without waiters decrements correctly", async () => {
    const sem = new Semaphore(3);

    await sem.acquire();
    await sem.acquire();
    expect(sem.active).toBe(2);

    sem.release();
    expect(sem.active).toBe(1);

    sem.release();
    expect(sem.active).toBe(0);
  });

  test("reset clears all state", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    sem.acquire(); // queued
    sem.acquire(); // queued

    expect(sem.active).toBe(1);
    expect(sem.queued).toBe(2);

    sem.reset();

    expect(sem.active).toBe(0);
    expect(sem.queued).toBe(0);

    // Should be usable again after reset
    await sem.acquire();
    expect(sem.active).toBe(1);
  });

  test("without reset, semaphore is stuck after close", async () => {
    // Simulates the old closeBrowser() which didn't call reset().
    // After "closing", the semaphore still thinks slots are occupied,
    // so new acquires beyond the remaining capacity are stranded.
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.active).toBe(2); // full

    // "close" without reset — the slots are never returned
    // Now try to acquire again — only 2 slots total, both still held
    let newAcquireResolved = false;
    sem.acquire().then(() => { newAcquireResolved = true; });
    await Promise.resolve();

    expect(newAcquireResolved).toBe(false); // stranded — this is the bug
    expect(sem.active).toBe(2);
    expect(sem.queued).toBe(1);
  });

  test("overflow: 15 tasks through limit of 10 run in batches", async () => {
    const sem = new Semaphore(10);
    const running: number[] = [];
    let peakConcurrency = 0;
    const completionOrder: number[] = [];

    async function task(id: number, durationMs: number) {
      await sem.acquire();
      running.push(id);
      peakConcurrency = Math.max(peakConcurrency, running.length);
      // Simulate work
      await new Promise((r) => setTimeout(r, durationMs));
      running.splice(running.indexOf(id), 1);
      completionOrder.push(id);
      sem.release();
    }

    // Launch 15 tasks — first 10 should start immediately, remaining 5 wait
    const tasks = [];
    for (let i = 0; i < 15; i++) {
      tasks.push(task(i, 50));
    }

    // Before any complete, check state
    await new Promise((r) => setTimeout(r, 10));
    expect(sem.active).toBe(10);
    expect(sem.queued).toBe(5);

    // Wait for all to finish
    await Promise.all(tasks);

    expect(peakConcurrency).toBe(10); // never exceeded the limit
    expect(completionOrder.length).toBe(15); // all 15 completed
    expect(sem.active).toBe(0);
    expect(sem.queued).toBe(0);
  });

  test("with reset, semaphore is clean after close", async () => {
    // Simulates the fixed closeBrowser() which calls reset().
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.active).toBe(2);

    // "close" WITH reset
    sem.reset();
    expect(sem.active).toBe(0);
    expect(sem.queued).toBe(0);

    // Fresh acquires work immediately
    await sem.acquire();
    expect(sem.active).toBe(1);

    await sem.acquire();
    expect(sem.active).toBe(2);
  });
});
