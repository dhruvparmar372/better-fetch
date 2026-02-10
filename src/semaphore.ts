export class Semaphore {
  private inFlight = 0;
  private waitQueue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  release(): void {
    this.inFlight--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  reset(): void {
    this.inFlight = 0;
    this.waitQueue.length = 0;
  }

  get active(): number {
    return this.inFlight;
  }

  get queued(): number {
    return this.waitQueue.length;
  }
}
