type State = "closed" | "open" | "half_open";

interface Entry {
  state: State;
  consecutiveFailures: number;
  openedAt: number;
}

export class CircuitBreaker {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { state: "closed", consecutiveFailures: 0, openedAt: 0 };
      this.entries.set(key, e);
    }
    return e;
  }

  isOpen(key: string): boolean {
    const e = this.entry(key);
    if (e.state === "open" && this.now() - e.openedAt >= this.cooldownMs) {
      e.state = "half_open";
      return false;
    }
    return e.state === "open";
  }

  recordSuccess(key: string) {
    const e = this.entry(key);
    e.state = "closed";
    e.consecutiveFailures = 0;
  }

  recordFailure(key: string) {
    const e = this.entry(key);
    e.consecutiveFailures += 1;

    if (e.state === "half_open" || e.consecutiveFailures >= this.threshold) {
      e.state = "open";
      e.openedAt = this.now();
    }
  }

  snapshot() {
    return [...this.entries.entries()].map(([target, e]) => ({
      target,
      state: e.state,
      consecutive_failures: e.consecutiveFailures,
    }));
  }
}
