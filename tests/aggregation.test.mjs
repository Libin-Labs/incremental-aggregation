import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAggregator } from '../dist/esm/index.js';
const row = (id, group, value) => ({ id, group, value });
test('group summaries distinguish nulls from numeric zero and include finite extrema', () => {
  const aggregate = createAggregator();
  aggregate.upsert(row('a', 'x', 0));
  aggregate.upsert(row('b', 'x', null));
  aggregate.upsert(row('c', 'x', 6));
  assert.deepEqual(aggregate.get('x'), {
    group: 'x',
    count: 3,
    numericCount: 2,
    missingCount: 1,
    sum: 6,
    min: 0,
    max: 6,
    mean: 3,
  });
  aggregate.upsert(row('d', 'null-only', null));
  assert.deepEqual(aggregate.get('null-only'), {
    group: 'null-only',
    count: 1,
    numericCount: 0,
    missingCount: 1,
    sum: 0,
    min: null,
    max: null,
    mean: null,
  });
});
test('upsert replaces existing values, moves group membership and returns the change kind', () => {
  const aggregate = createAggregator();
  assert.equal(aggregate.upsert(row('a', 'x', 1)), 'inserted');
  assert.equal(aggregate.upsert(row('a', 'x', 5)), 'updated');
  assert.equal(aggregate.get('x').sum, 5);
  aggregate.upsert(row('a', 'y', 7));
  assert.equal(aggregate.get('x'), undefined);
  assert.equal(aggregate.get('y').sum, 7);
  assert.equal(aggregate.size, 1);
});
test('deleting extrema recalculates affected group and removes an empty group', () => {
  const aggregate = createAggregator();
  aggregate.rebuild([row('a', 'x', -5), row('b', 'x', 2), row('c', 'x', 10)]);
  assert.equal(aggregate.delete('a'), true);
  assert.equal(aggregate.get('x').min, 2);
  aggregate.delete('c');
  assert.equal(aggregate.get('x').max, 2);
  aggregate.delete('b');
  assert.deepEqual(aggregate.snapshot(), []);
  assert.equal(aggregate.delete('b'), false);
});
test('compensated summation preserves small residuals through cancellation', () => {
  const aggregate = createAggregator();
  aggregate.rebuild([row('a', 'x', 1e16), row('b', 'x', 1), row('c', 'x', -1e16)]);
  assert.equal(aggregate.get('x').sum, 1);
  aggregate.delete('b');
  assert.equal(aggregate.get('x').sum, 0);
});
test('capacity limits allow updates and group moves that remove the old group', () => {
  const aggregate = createAggregator({ maxRecords: 1, maxGroups: 1 });
  aggregate.upsert(row('a', 'x', 1));
  aggregate.upsert(row('a', 'y', 2));
  assert.equal(aggregate.get('y').sum, 2);
  assert.throws(() => aggregate.upsert(row('b', 'y', 3)), /maxRecords/);
  const limited = createAggregator({ maxGroups: 1 });
  limited.rebuild([row('a', 'x', 1), row('b', 'x', 2)]);
  assert.throws(() => limited.upsert(row('a', 'y', 1)), /maxGroups/);
  assert.equal(limited.get('x').count, 2);
});
test('overflow and invalid updates are atomic including cross-group moves', () => {
  const aggregate = createAggregator();
  aggregate.rebuild([row('a', 'x', 1), row('b', 'y', Number.MAX_VALUE)]);
  const before = aggregate.snapshot();
  assert.throws(() => aggregate.upsert(row('a', 'y', Number.MAX_VALUE)), /overflow/);
  assert.deepEqual(aggregate.snapshot(), before);
  assert.throws(() => aggregate.upsert(row('a', 'x', NaN)), TypeError);
  assert.deepEqual(aggregate.snapshot(), before);
});
test('deletion that would overflow a cancellation-sensitive remainder rejects atomically', () => {
  const aggregate = createAggregator();
  aggregate.rebuild([
    row('a', 'x', -Number.MAX_VALUE),
    row('b', 'x', Number.MAX_VALUE),
    row('c', 'x', Number.MAX_VALUE),
  ]);
  const before = aggregate.snapshot();
  assert.throws(() => aggregate.delete('a'), /overflow/);
  assert.equal(aggregate.size, 3);
  assert.deepEqual(aggregate.snapshot(), before);
});
test('rebuild rejects duplicate IDs and source errors without destroying prior state', () => {
  const aggregate = createAggregator();
  aggregate.upsert(row('old', 'x', 2));
  const before = aggregate.snapshot();
  assert.throws(() => aggregate.rebuild([row('a', 'x', 1), row('a', 'x', 2)]), /Duplicate/);
  assert.deepEqual(aggregate.snapshot(), before);
  function* bad() {
    yield row('a', 'x', 1);
    throw new Error('source');
  }
  assert.throws(() => aggregate.rebuild(bad()), /source/);
  assert.deepEqual(aggregate.snapshot(), before);
  aggregate.rebuild([]);
  assert.equal(aggregate.size, 0);
});
test('caller mutation cannot change retained scalar observations or summaries', () => {
  const aggregate = createAggregator();
  const input = row('a', '__proto__', 2);
  aggregate.upsert(input);
  input.value = 999;
  aggregate.get('__proto__').sum = 999;
  aggregate.snapshot()[0].sum = 999;
  assert.equal(aggregate.get('__proto__').sum, 2);
  assert.equal({}.polluted, undefined);
});
test('generated updates and deletes match full rebuilds and a separate integer-sum oracle', () => {
  const aggregate = createAggregator();
  const records = new Map();
  for (let step = 0; step < 500; step++) {
    const id = String((step * 17) % 83);
    if (step % 5 === 0) {
      records.delete(id);
      aggregate.delete(id);
    } else {
      const input = row(id, `group-${step % 7}`, step % 11 === 0 ? null : step - 250);
      records.set(id, input);
      aggregate.upsert(input);
    }
    const rebuilt = createAggregator();
    rebuilt.rebuild(records.values());
    assert.deepEqual(aggregate.snapshot(), rebuilt.snapshot());
    assert.equal(aggregate.size, records.size);
    for (const summary of aggregate.snapshot()) {
      const values = [...records.values()].filter((item) => item.group === summary.group);
      assert.equal(summary.count, values.length);
      assert.equal(
        summary.sum,
        values.reduce((sum, item) => sum + (item.value ?? 0), 0),
      );
    }
  }
});
test('invalid options and observations fail explicitly', () => {
  for (const value of [-1, 1.5, NaN, Infinity])
    assert.throws(() => createAggregator({ maxRecords: value }), RangeError);
  const aggregate = createAggregator();
  for (const value of [undefined, Infinity, NaN, '1'])
    assert.throws(() => aggregate.upsert(row('a', 'x', value)), TypeError);
  assert.throws(() => aggregate.upsert(row('', 'x', 1)), TypeError);
  assert.throws(() => aggregate.rebuild(null), TypeError);
  assert.throws(() => createAggregator({ maxGroups: 0 }).upsert(row('a', 'x', 1)), RangeError);
});
test('CommonJS supports independent keyed group maintenance', () => {
  const api = createRequire(import.meta.url)('../dist/cjs/index.js');
  const aggregate = api.createAggregator();
  aggregate.upsert(row('a', 'x', 3));
  assert.equal(aggregate.get('x').mean, 3);
});
