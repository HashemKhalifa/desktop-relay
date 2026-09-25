import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimiter } from '../src/rate-limit.ts';

test('rate limit preserves bounded bursts, refill, and principal isolation', () => {
  const limiter = new RateLimiter();
  for (let i = 0; i < 30; i++) assert.equal(limiter.take('legacy', 60, 0), 0);
  assert.equal(limiter.take('legacy', 60, 0), 1);
  assert.equal(limiter.take('legacy', 60, 1000), 0);
  assert.equal(limiter.take('legacy', 60, 1000), 1);
  for (let i = 0; i < 150; i++) assert.equal(limiter.take('chatgpt', 300, 0), 0);
  assert.equal(limiter.take('chatgpt', 300, 0), 1);
  assert.equal(limiter.take('chatgpt', 300, 200), 0);
  assert.equal(limiter.take('other', 300, 200), 0);
  limiter.reset('chatgpt');
  assert.equal(limiter.take('chatgpt', 300, 200), 0);
});
