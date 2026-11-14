import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {LlmsInk,LlmsInkError} from '../dist/index.js';
const key='lk_'+'a'.repeat(32);
const receipt=(text,patch={})=>({detection:'no_finding',coverage:'complete',recommendation:'continue',reason:'no_finding',modelRevision:'4a43fec65a670e48835d8e8c85c705b4b0d1c907',policyRevision:'llms-ink-inspect-1',preprocessingRevision:'utf8-json-stringify-1',contentDigest:createHash('sha256').update(text).digest('hex'),inputTokens:5,inspectedTokens:5,windows:1,enforced:false,...patch});
test('Inspect binds exact Unicode bytes, authenticates, refuses redirects, strips extra fields',async()=>{
 const text='\uFEFF café 🌙\r\n';let calls=0;
 const r=await new LlmsInk({key,fetch:async(url,init)=>{calls++;assert.equal(url,'https://llms.ink/api/v0/inspect');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,`Bearer ${key}`);assert.deepEqual(JSON.parse(init.body),{format:'text',content:text});return Response.json(receipt(text,{secret:'not copied'}));}}).inspect(text);
 assert.equal(calls,1);assert.equal(r.recommendation,'continue');assert.ok(Object.isFrozen(r));assert.equal(r.secret,undefined);
});
test('bad input and missing credentials fail before network',async()=>{
 const fetch=()=>assert.fail('must not send');
 await assert.rejects(new LlmsInk({key:'',fetch}).inspect('x'),e=>e.code==='key_required');
 for(const text of ['', '\uD800','\n'.repeat(66000),7])await assert.rejects(new LlmsInk({key,fetch}).inspect(text),TypeError);
 await assert.rejects(new LlmsInk({key,fetch,baseUrl:'http://example.com'}).inspect('x'),TypeError);
});
test('flagged and incomplete HTTP 422/503 receipts withhold',async()=>{
 for(const [status,patch] of [[200,{detection:'flagged',recommendation:'withhold',reason:'model_detection'}],[422,{detection:'unknown',coverage:'none',recommendation:'withhold',reason:'token_limit',inputTokens:9000,inspectedTokens:0,windows:0}],[503,{detection:'unknown',coverage:'none',recommendation:'withhold',reason:'model_failure',inspectedTokens:0,windows:0}]]){
 const r=await new LlmsInk({key,fetch:async()=>Response.json(receipt('x',patch),{status})}).inspect('x');assert.equal(r.recommendation,'withhold');}
});
test('tampering, future policies, incomplete clean results and status mismatch fail closed',async()=>{
 for(const patch of [{contentDigest:'0'.repeat(64)},{policyRevision:'future'},{enforced:true},{inputTokens:9000},{inputTokens:true},{coverage:'partial'},{inspectedTokens:4},{windows:0},{reason:'safe'},{recommendation:'withhold'}])await assert.rejects(new LlmsInk({key,fetch:async()=>Response.json(receipt('x',patch))}).inspect('x'),LlmsInkError);
 await assert.rejects(new LlmsInk({key,fetch:async()=>Response.json(receipt('x'),{status:503})}).inspect('x'),LlmsInkError);
});
test('problem code, HTTP status and Retry-After survive without retry',async()=>{
 let calls=0;await assert.rejects(new LlmsInk({key,fetch:async()=>{calls++;return Response.json({code:'inspection_quota',detail:'Wait.'},{status:429,headers:{'retry-after':'42'}})}}).inspect('x'),e=>e.status===429&&e.code==='inspection_quota'&&e.retryAfter===42);assert.equal(calls,1);
});
test('invalid and oversized responses and transport failure fail closed',async()=>{
 for(const response of [new Response('x'.repeat(16385)),new Response('<html>'),new Response(null),Response.json(null)])await assert.rejects(new LlmsInk({key,fetch:async()=>response}).inspect('x'),LlmsInkError);
 await assert.rejects(new LlmsInk({key,fetch:async()=>{throw new Error('sensitive')}}).inspect('x'),e=>e instanceof LlmsInkError&&!e.message.includes('sensitive'));
});
test('environment origin is ignored; explicit development origin is honored',async()=>{
 const old=process.env.LLMS_INK_API;process.env.LLMS_INK_API='https://untrusted.test';
 try{for(const baseUrl of [undefined,'http://127.0.0.1:4444'])await new LlmsInk({key,baseUrl,fetch:async(url)=>{assert.equal(url,`${baseUrl??'https://llms.ink'}/api/v0/inspect`);return Response.json(receipt('x'));}}).inspect('x');}
 finally{if(old===undefined)delete process.env.LLMS_INK_API;else process.env.LLMS_INK_API=old;}
});
test('real fetch refuses redirect and honors cancellation',async()=>{
 let forwarded=0;const server=createServer((req,res)=>{if(req.url==='/api/v0/inspect'){res.writeHead(307,{location:'/leak'});res.end();}else{forwarded++;res.end('{}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const ink=new LlmsInk({key,baseUrl:`http://127.0.0.1:${server.address().port}`});await assert.rejects(ink.inspect('x'),LlmsInkError);assert.equal(forwarded,0);const c=new AbortController();c.abort();await assert.rejects(ink.inspect('x',{signal:c.signal}),e=>e.name==='AbortError');}
 finally{await new Promise(r=>server.close(r));}
});
test('shared receipt conformance corpus',async()=>{
 const {readFile}=await import('node:fs/promises');const {inspectionReceipt}=await import('../dist/inspect.js');
 const {cases}=JSON.parse(await readFile(new URL('fixtures/inspect-receipts-v1.json',import.meta.url)));
 for(const c of cases){if(c.valid)assert.doesNotThrow(()=>inspectionReceipt(c.receipt,c.digest,c.status),c.name);else assert.throws(()=>inspectionReceipt(c.receipt,c.digest,c.status),c.name);}
});
