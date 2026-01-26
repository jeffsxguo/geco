const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeValueTransfers, mergeKeyTransfersEqualAmount, mergeKeyThenValueTransfers, mergeBookkeepingValue } = require('./window-merge');

function t(from, to, amount) {
  return { from, to, amount, key: `${from}\u0000${to}` };
}

function strip(extra) {
  return extra.map((x) => ({ from: x.from, to: x.to, amount: x.amount, key: x.key }));
}

test('value merge aggregates same (from,to) by summing amount', () => {
  const out = mergeValueTransfers([t('A', 'B', 10), t('A', 'B', 5), t('B', 'C', 2)]);
  assert.deepEqual(strip(out), [t('A', 'B', 15), t('B', 'C', 2)]);
});

test('key merge compresses chains when amount is equal', () => {
  const out = mergeKeyTransfersEqualAmount([t('A', 'B', 10), t('B', 'C', 10)]);
  assert.deepEqual(strip(out), [t('A', 'C', 10)]);
});

test('key merge does not compress when amounts differ', () => {
  const out = mergeKeyTransfersEqualAmount([t('A', 'B', 10), t('B', 'C', 6)]);
  assert.deepEqual(strip(out), [t('A', 'B', 10), t('B', 'C', 6)]);
});

test('CTM uses key-then-value merge (no amount splitting)', () => {
  const out = mergeKeyThenValueTransfers([t('A', 'B', 10), t('B', 'C', 6), t('B', 'D', 4)]);
  assert.deepEqual(strip(out), [t('A', 'B', 10), t('B', 'C', 6), t('B', 'D', 4)]);
});

test('bookkeeping value merge aggregates deltas per id', () => {
  const out = mergeBookkeepingValue([
    { id: 'acct00000001', delta: 10, requestId: 'T1' },
    { id: 'acct00000001', delta: -3, requestId: 'T2' },
    { id: 'acct00000002', delta: 5, requestId: 'T3' }
  ]);
  assert.deepEqual(out, [
    { id: 'acct00000001', delta: 7, originalTxIds: ['T1', 'T2'] },
    { id: 'acct00000002', delta: 5, originalTxIds: ['T3'] }
  ]);
});
