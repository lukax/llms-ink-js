import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {fixture,python,pause,wire,ctl} from './guard-fixture.mjs';
let latest,behavior='normal';
mock.module('@anthropic-ai/claude-agent-sdk',{namedExports:{query:({prompt,options})=>{
 latest=options;
 if(behavior==='startup-fail')throw Error('PRIVATE startup details');
 const connection=wire(options), id=options.sessionId;
 const messages=(async function*(){
  if(behavior==='early-result-error'){yield{type:'result',subtype:'error_during_execution',session_id:id,is_error:true,errors:['PRIVATE host failure']};return;}
  if(behavior==='missing-init'){yield{type:'assistant',session_id:id,message:{content:[]}};return;}
  connection.send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{elicitation:{form:{}}}}});await connection.next();
  connection.send({jsonrpc:'2.0',method:'notifications/initialized'});
  connection.send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});const listed=await connection.next();
  yield{type:'system',subtype:'init',session_id:behavior==='wrong-id'?'different':id,mcp_servers:behavior==='malformed-connection'?null:[{name:'guarded',status:behavior==='disconnected'?'failed':'connected'}],tools:behavior==='extra-tool'?['Bash']:behavior==='malformed-tools'?[null]:listed.result.tools.map(t=>'mcp__guarded__'+t.name)};
  if(behavior==='stream-fail')throw Error('PRIVATE stream payload');
  if(behavior==='stream-ended')return;
  let serial=2,turn=0;
  for await(const input of prompt){
   if(behavior.startsWith('result-')){yield{type:'result',subtype:behavior==='result-turns'?'error_max_turns':behavior==='result-budget'?'error_max_budget_usd':behavior==='result-output'?'error_max_structured_output_retries':behavior==='result-unknown'?'PRIVATE-subtype':'error_during_execution',session_id:id,is_error:true,errors:['PRIVATE provider payload'],result:'PRIVATE content'};return;}
   if(turn++)yield{type:'system',subtype:'init',session_id:id,mcp_servers:[{name:'guarded',status:'connected'}],tools:listed.result.tools.map(t=>'mcp__guarded__'+t.name)};
   if(input.message.content!=='no-tool'){
    connection.send({jsonrpc:'2.0',id:++serial,method:'tools/call',params:{name:'fixture__record',arguments:{destination:input.message.content}}});
    let result=await connection.next();
    if(result.method==='elicitation/create'){
     const approval=await options.onElicitation({serverName:'guarded',...result.params},{signal:options.abortController.signal});
     connection.send({jsonrpc:'2.0',id:result.id,result:approval});result=await connection.next();
    }
    yield{type:'assistant',session_id:id,message:{content:[{type:'text',text:result.error?'denied':'recorded'}]}};
   }
   yield{type:'result',subtype:'success',session_id:id,is_error:false,result:'done'};
  }
 })();return{next:()=>messages.next(),close:()=>{connection.close();if(['close-fail','result-close-fail'].includes(behavior))throw Error('PRIVATE host cleanup details');}};
}}});
const {createGuardedClaude,GuardHostError}=await import('../dist/guard-claude.js');
const opts=(f,review=async()=>false)=>({python,ownerFile:f.ownerFile,cwd:f.dir,review});
const settings={skip:!python,timeout:30000};
test('one session across turns, new conversations isolated, close revokes and removes credentials',settings,async()=>{
 const f=await fixture();let a,b;
 try{
  a=await createGuardedClaude(opts(f,async r=>{assert.match(r.message,/policySha256/);assert.match(r.message,/destination/);return true;}));
  const first=latest, dir=dirname(first.mcpServers.guarded.args.at(-1));
  assert.equal(JSON.stringify(first).includes(f.ownerFile),false);assert.equal(first.persistSession,false);assert.equal(first.strictMcpConfig,true);assert.deepEqual(first.tools,[]);assert.equal((await first.canUseTool('Bash',{})).behavior,'deny');
  await a.run('safe');await a.run('safe');assert.equal((await f.effects()).length,2);
  b=await createGuardedClaude(opts(f));assert.notEqual(a.sessionId,b.sessionId);await b.run('safe');assert.equal((await f.effects()).length,2);
  await a.close();await a.close();assert.equal(existsSync(dir),false);assert.ok(!f.status().sessions.some(s=>s.sessionId===a.sessionId&&s.active));
  assert.ok(f.status().sessions.some(s=>s.sessionId===b.sessionId&&s.active));await assert.rejects(a.run('safe'),GuardHostError);
 }finally{await a?.close();await b?.close();await f.close();}
});
test('exact policy denial never invokes review or dispatches',settings,async()=>{
 const f=await fixture();let c;let reviews=0;try{c=await createGuardedClaude(opts(f,async()=>{reviews++;return true;}));await c.run('outside');assert.equal(reviews,0);assert.deepEqual(await f.effects(),[]);}finally{await c?.close();await f.close();}
});
test('closing with approval pending aborts the review and prevents late acceptance',settings,async()=>{
 const f=await fixture();let c,accept,seen;const reached=new Promise(r=>seen=r);let signal;
 try{c=await createGuardedClaude(opts(f,r=>{signal=r.signal;seen();return new Promise(resolve=>accept=resolve);}));const running=c.run('safe');const failure=assert.rejects(running,GuardHostError);await reached;await c.close();assert.equal(signal.aborted,true);accept(true);await failure;assert.deepEqual(await f.effects(),[]);}finally{await c?.close();await f.close();}
});
for(const [mode,code] of Object.entries({
 'startup-fail':'host_startup_failed','wrong-id':'session_mismatch','extra-tool':'unexpected_tools',
 'disconnected':'guard_connection_failed','malformed-connection':'guard_connection_failed','malformed-tools':'unexpected_tools',
 'stream-fail':'host_stream_failed','stream-ended':'host_stream_ended','missing-init':'host_not_initialized',
 'early-result-error':'host_result_error','result-error':'host_result_error','result-unknown':'host_result_error',
 'result-turns':'host_turn_limit','result-budget':'host_budget_limit','result-output':'host_output_retry_limit',
}))test(mode+' identifies the failure and revokes authority without disclosing host content',settings,async()=>{
 const f=await fixture();let c;behavior=mode;
 try{await assert.rejects(async()=>{c=await createGuardedClaude(opts(f));await c.run('safe');},error=>{
  assert.ok(error instanceof GuardHostError);assert.equal(error.code,code);assert.equal(error.operationCode,undefined);assert.equal(error.cause,undefined);assert.ok(!JSON.stringify(error).includes('PRIVATE'));assert.ok(!error.message.includes('PRIVATE'));return true;
 });assert.ok(!f.status().sessions.some(s=>s.active));assert.deepEqual(await f.effects(),[]);}finally{behavior='normal';await c?.close();await f.close();}
});
test('overlapping turns and host slash commands are refused',settings,async()=>{
 const f=await fixture();let c,finish,seen;const reached=new Promise(r=>seen=r);
 try{c=await createGuardedClaude(opts(f,()=>{seen();return new Promise(r=>finish=r);}));await assert.rejects(c.run('/clear'),GuardHostError);const run=c.run('safe');await reached;await assert.rejects(c.run('safe'),GuardHostError);finish(false);await run;assert.deepEqual(await f.effects(),[]);}finally{await c?.close();await f.close();}
});
test('review errors decline; malformed forms never reach the callback',settings,async()=>{
 const f=await fixture();let c,calls=0;
 try{c=await createGuardedClaude(opts(f,async()=>{calls++;throw Error('PRIVATE review details');}));await c.run('safe');assert.equal(calls,1);const bad=await latest.onElicitation({serverName:'other',message:'approve',requestedSchema:{}},{signal:new AbortController().signal});assert.equal(bad.action,'decline');assert.equal(calls,1);assert.deepEqual(await f.effects(),[]);}finally{await c?.close();await f.close();}
});
test('expiry closes idle host and refuses another turn',settings,async()=>{
 const f=await fixture();let c;try{c=await createGuardedClaude({...opts(f),ttl:1});await c.run('no-tool');await pause(1200);await assert.rejects(c.run('safe'),error=>error.code==='session_expired');await c.close();assert.ok(!f.status().sessions.some(s=>s.active));}finally{await c?.close();await f.close();}
});
test('a stalled output callback cannot keep a timed-out conversation authorized',settings,async()=>{
 const f=await fixture();let c;
 try{c=await createGuardedClaude({...opts(f),turnTimeoutMs:500});await assert.rejects(c.run('no-tool',()=>new Promise(()=>{})),error=>error.code==='turn_timeout');assert.ok(!f.status().sessions.some(s=>s.active));}finally{await c?.close();await f.close();}
});
test('external revocation refuses future turns without dispatch',settings,async()=>{
 const f=await fixture();let c;
 try{c=await createGuardedClaude(opts(f,async()=>true));await c.run('no-tool');ctl(f.ownerFile,'session-revoke','--session-id',c.sessionId);await assert.rejects(c.run('safe'),error=>error.code==='session_inactive');assert.deepEqual(await f.effects(),[]);}finally{await c?.close();await f.close();}
});
test('failed revocation retains recovery metadata and the private credential',settings,async()=>{
 const f=await fixture();let c,dir;
 try{c=await createGuardedClaude(opts(f));await c.run('no-tool');f.proc.kill('SIGTERM');await new Promise(r=>f.proc.once('exit',r));
  await assert.rejects(c.close(),error=>{assert.equal(error.sessionId,c.sessionId);dir=error.credentialDirectory;assert.ok(existsSync(dir));return /revocation could not be confirmed/.test(error.message);});
 }finally{await f.close();if(dir){const {rm}=await import('node:fs/promises');await rm(dir,{recursive:true,force:true});}}
});
test('host cleanup errors are sanitized and close can be retried',settings,async()=>{
 const f=await fixture();let c,dir;
 try{c=await createGuardedClaude(opts(f));await c.run('no-tool');behavior='close-fail';await assert.rejects(c.close(),error=>{assert.equal(error.sessionId,c.sessionId);dir=error.credentialDirectory;return !error.message.includes('PRIVATE');});assert.ok(existsSync(dir));assert.ok(!f.status().sessions.some(s=>s.active));behavior='normal';await c.close();assert.equal(existsSync(dir),false);}finally{behavior='normal';await c?.close();await f.close();}
});
test('untrusted form shapes are refused during an active review',settings,async()=>{
 const f=await fixture();let c,seen,finish,calls=0;const reached=new Promise(r=>seen=r);
 try{c=await createGuardedClaude(opts(f,()=>{calls++;seen();return new Promise(r=>finish=r);}));const run=c.run('safe');await reached;
  const schema={type:'object',properties:{approve:{type:'boolean',title:'Approve this call once',default:false}},required:['approve']};
  for(const change of [{serverName:'other'},{mode:'url'},{message:'x'.repeat(8193)},{requestedSchema:{...schema,additionalProperties:true}},{requestedSchema:{...schema,properties:{approve:{type:'boolean',default:true}}}}]){
   assert.deepEqual(await latest.onElicitation({serverName:'guarded',message:'review',requestedSchema:schema,...change},{signal:new AbortController().signal}),{action:'decline'});
  }
  assert.equal(calls,1);finish(false);await run;assert.deepEqual(await f.effects(),[]);
 }finally{await c?.close();await f.close();}
});

test('callback exceptions cannot spoof a host failure code or leak their payload',settings,async()=>{
 const f=await fixture();let c;
 try{c=await createGuardedClaude(opts(f));await assert.rejects(c.run('no-tool',()=>{throw new GuardHostError('PRIVATE callback payload',undefined,undefined,'host_budget_limit');}),error=>{
  assert.equal(error.code,'message_callback_failed');assert.ok(!error.message.includes('PRIVATE'));assert.equal(error.cause,undefined);return true;
 });assert.ok(!f.status().sessions.some(s=>s.active));assert.deepEqual(await f.effects(),[]);}finally{await c?.close();await f.close();}
});
test('cleanup failure retains the operation code and recoverable credential',settings,async()=>{
 const f=await fixture();let c,dir;behavior='result-close-fail';
 try{c=await createGuardedClaude(opts(f));await assert.rejects(c.run('no-tool'),error=>{
  assert.equal(error.code,'host_cleanup_failed');assert.equal(error.operationCode,'host_result_error');assert.equal(error.sessionId,c.sessionId);dir=error.credentialDirectory;assert.ok(existsSync(dir));assert.ok(!error.message.includes('PRIVATE'));return true;
 });assert.ok(!f.status().sessions.some(s=>s.active));behavior='normal';await c.close();assert.equal(existsSync(dir),false);}finally{behavior='normal';await c?.close();await f.close();}
});
test('service loss identifies status failure while keeping unconfirmed revocation primary',settings,async()=>{
 const f=await fixture();let c,dir;
 try{c=await createGuardedClaude(opts(f));await c.run('no-tool');f.proc.kill('SIGTERM');await new Promise(r=>f.proc.once('exit',r));
  await assert.rejects(c.run('no-tool'),error=>{assert.equal(error.code,'revocation_unconfirmed');assert.equal(error.operationCode,'service_status_failed');dir=error.credentialDirectory;assert.ok(existsSync(dir));return true;});
 }finally{await f.close();if(dir){const {rm}=await import('node:fs/promises');await rm(dir,{recursive:true,force:true});}}
});
test('an output failure after an approved effect revokes without replaying the action',settings,async()=>{
 const f=await fixture();let c,reviews=0;
 try{c=await createGuardedClaude(opts(f,async()=>{reviews++;return true;}));await assert.rejects(c.run('safe',message=>{if(message.type==='assistant')throw Error('PRIVATE output failure after effect');}),error=>error.code==='message_callback_failed');
  assert.equal(reviews,1);assert.equal((await f.effects()).length,1);assert.ok(!f.status().sessions.some(s=>s.active));await assert.rejects(c.run('safe'),GuardHostError);assert.equal((await f.effects()).length,1);
 }finally{await c?.close();await f.close();}
});
