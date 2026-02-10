/**
 * A lazily-initialized singleton that guarantees the factory runs at most once,
 * even under concurrent access. Concurrent callers share the same in-flight
 * promise rather than each triggering their own factory call.
 */
export class LazySingleton<T> {
  private instance: T | null = null;
  private pending: Promise<T> | null = null;

  constructor(private factory: () => Promise<T>) {}

  async get(): Promise<T> {
    if (this.instance) return this.instance;
    if (this.pending) return this.pending;

    this.pending = this.factory().then(
      (val) => {
        this.instance = val;
        this.pending = null;
        return val;
      },
      (err) => {
        this.pending = null;
        throw err;
      },
    );

    return this.pending;
  }

  clear(): void {
    this.instance = null;
    this.pending = null;
  }

  get current(): T | null {
    return this.instance;
  }
}
