import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResultStore } from '../src/results.ts';

function id(result: ReturnType<ResultStore['compact']>): string {
  const text = result.content?.[0];
  assert.equal(text?.type, 'text');
  return (text as { text: string }).text.match(/resultId: ([\w-]+)/)![1];
}

test('large Unicode output is recovered byte-for-byte across pages and text blocks', () => {
  const store = new ResultStore();
  const originals = ['one 😀 é '.repeat(5000), 'second block\n'.repeat(2000)];
  const output = store.compact('a', 'read_file', { isError: true, content: originals.map(text => ({ type: 'text', text })) });
  assert.equal(output.isError, true);
  assert.ok(JSON.stringify(output).length < 6000);
  const resultId = id(output);
  for (let contentIndex = 0; contentIndex < originals.length; contentIndex++) {
    let offset: number | null = 0;
    let actual = '';
    while (offset !== null) {
      const result = store.read('a', new Set(['read_file']), { resultId, contentIndex, offset });
      const chunk = result.content?.[0] as { text: string };
      assert.ok(Buffer.byteLength(chunk.text) <= 12288);
      actual += chunk.text;
      offset = (result.structuredContent as { nextOffset: number | null }).nextOffset;
    }
    assert.equal(actual, originals[contentIndex]);
  }
  assert.throws(() => store.read('a', new Set(['read_file']), { resultId, offset: 5 }), /UTF-8 byte boundary/);
});

test('retained results enforce principal, grants, revoke, expiry, and memory eviction', () => {
  let now = 0;
  const store = new ResultStore(100_000, () => now);
  const make = () => id(store.compact('a', 'start_process', { content: [{ type: 'text', text: 'x'.repeat(30000) }] }));
  const first = make();
  assert.throws(() => store.read('b', new Set(['start_process']), { resultId: first }), /unavailable/);
  assert.throws(() => store.read('a', new Set(['read_file']), { resultId: first }), /unavailable/);
  const second = make();
  assert.throws(() => store.read('a', new Set(['start_process']), { resultId: first }), /unavailable/);
  assert.ok(store.read('a', new Set(['start_process']), { resultId: second }));
  store.revoke('a');
  assert.throws(() => store.read('a', new Set(['start_process']), { resultId: second }), /unavailable/);
  const third = make();
  now = 3600000;
  assert.throws(() => store.read('a', new Set(['start_process']), { resultId: third }), /unavailable/);
});

test('small, structured, media and over-cache-limit results retain their full contract', () => {
  const store = new ResultStore(50000);
  for (const original of [
    { content: [{ type: 'text' as const, text: 'unchanged' }], isError: true },
    { content: [{ type: 'text' as const, text: 'x'.repeat(20000) }], structuredContent: { value: 1 } },
    { content: [{ type: 'image' as const, data: 'AA==', mimeType: 'image/png' }] },
    { content: [{ type: 'text' as const, text: 'x'.repeat(26000) }] },
  ]) assert.equal(store.compact('a', 'read_file', original), original);
});
