import { describe, test, expect } from "bun:test";
import { LazySingleton } from "@/lazy-singleton.ts";

describe("LazySingleton", () => {
  test("concurrent .get() calls only invoke factory once", async () => {
    let factoryCalls = 0;
    const singleton = new LazySingleton(async () => {
      factoryCalls++;
      await new Promise((r) => setTimeout(r, 50));
      return "browser";
    });

    // 3 concurrent calls
    const results = await Promise.all([
      singleton.get(),
      singleton.get(),
      singleton.get(),
    ]);

    expect(results).toEqual(["browser", "browser", "browser"]);
    expect(factoryCalls).toBe(1);
  });

  test("without launch guard, concurrent calls invoke factory multiple times", async () => {
    // Proves the race condition that existed before LazySingleton.
    // This is what the old getContext() did: check instance, then await factory.
    let instance: string | null = null;
    let factoryCalls = 0;

    async function getBroken(): Promise<string> {
      if (instance) return instance;
      factoryCalls++;
      await new Promise((r) => setTimeout(r, 50));
      instance = "browser";
      return instance;
    }

    const results = await Promise.all([getBroken(), getBroken(), getBroken()]);

    expect(results).toEqual(["browser", "browser", "browser"]);
    expect(factoryCalls).toBeGreaterThan(1); // BUG: factory called 3 times
  });

  test("returns cached instance on subsequent calls", async () => {
    let factoryCalls = 0;
    const singleton = new LazySingleton(async () => {
      factoryCalls++;
      return "browser";
    });

    const first = await singleton.get();
    const second = await singleton.get();

    expect(first).toBe("browser");
    expect(second).toBe("browser");
    expect(factoryCalls).toBe(1);
  });

  test("clear allows re-initialization", async () => {
    let factoryCalls = 0;
    const singleton = new LazySingleton(async () => {
      factoryCalls++;
      return `instance-${factoryCalls}`;
    });

    const first = await singleton.get();
    expect(first).toBe("instance-1");

    singleton.clear();
    expect(singleton.current).toBeNull();

    const second = await singleton.get();
    expect(second).toBe("instance-2");
    expect(factoryCalls).toBe(2);
  });

  test("factory error does not leave stale pending promise", async () => {
    let attempt = 0;
    const singleton = new LazySingleton(async () => {
      attempt++;
      if (attempt === 1) throw new Error("launch failed");
      return "browser";
    });

    // First call fails
    await expect(singleton.get()).rejects.toThrow("launch failed");
    expect(singleton.current).toBeNull();

    // Second call retries and succeeds
    const result = await singleton.get();
    expect(result).toBe("browser");
    expect(attempt).toBe(2);
  });

  test("concurrent calls during factory error all reject", async () => {
    const singleton = new LazySingleton(async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error("crash");
    });

    const results = await Promise.allSettled([
      singleton.get(),
      singleton.get(),
      singleton.get(),
    ]);

    // All three should reject with the same error
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason.message).toBe("crash");
    }

    // Singleton should be clear for retry
    expect(singleton.current).toBeNull();
  });
});
