import { createGuardedClaude, GuardHostError, type GuardHostErrorCode, type GuardReview } from '../dist/guard-claude.js';
const code: GuardHostErrorCode = new GuardHostError('Example').code;
void code;
async function example() {
  const conversation = await createGuardedClaude({
    ownerFile: '/private/owner.json', python: '/venv/bin/python', cwd: '/workspace',
    review: async (request: GuardReview): Promise<boolean> => { console.log(request.message, request.signal.aborted); return false; },
  });
  try { await conversation.run('Read the configured source', message => { console.log(message.type); }); }
  finally { await conversation.close(); }
}
void example;
