import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebAgent } from '../web-agent.mjs';

test('uses one private identity and serializes web assistant messages and confirmations', async () => {
  const calls = []; let locks = 0;
  const agent = {
    async message(id, text) { calls.push(['message', id, text]); return { text: 'Plan ready', planId: 'plan-1' }; },
    async confirm(id, planId) { calls.push(['confirm', id, planId]); return { text: 'Applied' }; },
    async cancel(id, planId) { calls.push(['cancel', id, planId]); return { text: 'Cancelled' }; },
  };
  const webAgent = createWebAgent({ agent, lock: async (work) => { locks += 1; return work(); } });
  assert.deepEqual(await webAgent.message('categorize these'), { text: 'Plan ready', planId: 'plan-1' });
  await webAgent.confirm('plan-1');
  await webAgent.cancel('plan-1');
  assert.deepEqual(calls, [['message', 'web-owner', 'categorize these'], ['confirm', 'web-owner', 'plan-1'], ['cancel', 'web-owner', 'plan-1']]);
  assert.equal(locks, 3);
  await assert.rejects(() => webAgent.message(''), /message is required/);
});
