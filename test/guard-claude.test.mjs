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
  connection.send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{elicitation:{form:{}}}}});await connection.next();
  connection.send({jsonrpc:'2.0',method:'notifications/initialized'});
  connection.send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});const listed=await connection.next();
  yield{type:'system',subtype:'init',session_id:behavior==='wrong-id'?'different':id,mcp_servers:[{name:'guarded',status:'connected'}],tools:behavior==='extra-tool'?['Bash']:listed.result.tools.map(t=>'mcp__guarded__'+t.name)};
  let serial=2,turn=0;
  for await(const input of prompt){
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
 })();return{next:()=>messages.next(),close:()=>{connection.close();if(behavior==='close-fail')throw Error('PRIVATE host cleanup details');}};
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
for(const mode of ['startup-fail','wrong-id','extra-tool'])test(mode+' revokes authority',settings,async()=>{
 const f=await fixture();let c;behavior=mode;
 try{await assert.rejects(async()=>{c=await createGuardedClaude(opts(f));await c.run('safe');},GuardHostError);assert.ok(!f.status().sessions.some(s=>s.active));assert.deepEqual(await f.effects(),[]);}finally{behavior='normal';await c?.close();await f.close();}
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
 const f=await fixture();let c;try{c=await createGuardedClaude({...opts(f),ttl:1});await c.run('no-tool');await pause(1200);await assert.rejects(c.run('safe'),GuardHostError);await c.close();assert.ok(!f.status().sessions.some(s=>s.active));}finally{await c?.close();await f.close();}
});
test('a stalled output callback cannot keep a timed-out conversation authorized',settings,async()=>{
 const f=await fixture();let c;
 try{c=await createGuardedClaude({...opts(f),turnTimeoutMs:500});await assert.rejects(c.run('no-tool',()=>new Promise(()=>{})),GuardHostError);assert.ok(!f.status().sessions.some(s=>s.active));}finally{await c?.close();await f.close();}
});
test('external revocation refuses future turns without dispatch',settings,async()=>{
 const f=await fixture();let c;
 try{c=await createGuardedClaude(opts(f,async()=>true));await c.run('no-tool');ctl(f.ownerFile,'session-revoke','--session-id',c.sessionId);await assert.rejects(c.run('safe'),GuardHostError);assert.deepEqual(await f.effects(),[]);}finally{await c?.close();await f.close();}
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
