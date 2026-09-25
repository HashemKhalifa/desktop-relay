export class RateLimiter {
  private buckets = new Map<string, { tokens: number; ts: number }>();

  take(principalId: string, perMinute: number, now = Date.now()): number {
    const capacity = Math.max(1, Math.min(150, Math.ceil(perMinute / 2)));
    let bucket = this.buckets.get(principalId);
    if (!bucket) {
      bucket = { tokens: capacity, ts: now };
      this.buckets.set(principalId, bucket);
    }
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.ts) * perMinute / 60_000);
    bucket.ts = now;
    if (bucket.tokens < 1) return Math.ceil((1 - bucket.tokens) * 60 / perMinute);
    bucket.tokens--;
    return 0;
  }

  reset(principalId: string): void {
    this.buckets.delete(principalId);
  }
}
