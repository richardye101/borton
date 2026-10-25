import assert from 'node:assert/strict';
import test from 'node:test';
import { matchItem } from '../frontend/src/lib/expense-form.js';

test('matches a picker value without caring about case or surrounding whitespace', () => {
  const accounts = [{ id: 'simplii', name: 'Simplii CC' }, { id: 'vip', name: 'Wealthsimple VIP' }];
  assert.deepEqual(matchItem(accounts, '  simplii cc '), { id: 'simplii', name: 'Simplii CC' });
});

test('does not accept an unmatched picker value', () => {
  assert.equal(matchItem([{ id: 'simplii', name: 'Simplii CC' }], 'not an account'), null);
});
