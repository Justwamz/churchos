/** Injectable clock so the 48h hold, 72h reversal window and daily settlement can be tested and demoed without waiting. */
export class Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number) {
    this.offsetMs += ms;
  }
  advanceHours(h: number) {
    this.advance(h * 3600_000);
  }
  get offsetHours() {
    return this.offsetMs / 3600_000;
  }
}
