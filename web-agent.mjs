import { createActualTools } from './actual-tools.mjs';
import { createAgent } from './agent.mjs';

const OWNER = 'web-owner';

export function createWebAgent({ agent, api, generate, statePath, currency = 'CAD', timezone = 'America/Toronto', lock = async (work) => work() } = {}) {
  if (!agent) {
    if (!api || !generate || !statePath) throw new Error('api, generate, and statePath are required.');
    agent = createAgent({ tools: createActualTools(api, { currency }), generate, statePath, allowedChatId: OWNER, currency, timezone });
  }
  const text = (value) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('A message is required.');
    if (value.length > 4000) throw new Error('Message is too long.');
    return value.trim();
  };
  const plan = (value) => {
    if (typeof value !== 'string' || !value) throw new Error('A plan ID is required.');
    return value;
  };
  return {
    message: (value) => lock(() => agent.message(OWNER, text(value))),
    confirm: (value) => lock(() => agent.confirm(OWNER, plan(value))),
    cancel: (value) => lock(() => agent.cancel(OWNER, plan(value))),
    pending: () => agent.pending(OWNER),
  };
}
