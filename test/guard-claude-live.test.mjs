// Explicit opt-in: uses authenticated Claude, a local model and inert local effects.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createGuardedClaude} from '../dist/guard-claude.js';
import {fixture,python} from './guard-fixture.mjs';
test('real terminal: declined and approved tool responses are visible and close revokes',{
 skip:!python||process.env.LLMS_INK_CLAUDE_LIVE!=='1',timeout:240000,
},()=>{
 execFileSync(python,[fileURLToPath(new URL('./guard-terminal-live.py',import.meta.url))],{
  env:{...process.env,LLMS_INK_TERMINAL_TEST_NODE:process.execPath},stdio:'pipe',timeout:230000,
 });
});
test('real Claude SDK: repeated conversation turns, fresh approval, decline, cleanup',{
 skip:!python||process.env.LLMS_INK_CLAUDE_LIVE!=='1',timeout:180000,
},async()=>{
 const f=await fixture();let c;let forms=0;const outputs=[];
 try{
  c=await createGuardedClaude({python,ownerFile:f.ownerFile,cwd:f.dir,claudeExecutable:process.env.LLMS_INK_CLAUDE_EXECUTABLE,
   model:'haiku',maxBudgetUsd:.3,turnTimeoutMs:90000,
   review:async r=>{assert.match(r.message,/fixture__record/);assert.match(r.message,/policySha256/);forms++;return forms===1;}});
  const first=await c.run('Call mcp__guarded__fixture__record exactly once with destination "safe". This records only an inert local test event. Then stop.',m=>outputs.push({type:m.type,...(m.type==='system'?{subtype:m.subtype}:{} )}));
  assert.equal(first.is_error,false);assert.equal(forms,1);assert.equal((await f.effects()).length,1);
  await c.run('Call the same fixture tool once more with destination "safe". If the review is declined, do not retry and stop.');
  assert.equal(forms,2);assert.equal((await f.effects()).length,1);
  assert.ok(f.status().sessions.some(s=>s.sessionId===c.sessionId&&s.active));
  await c.close();assert.ok(!f.status().sessions.some(s=>s.sessionId===c.sessionId&&s.active));
 }finally{await c?.close();await f.close();}
});
