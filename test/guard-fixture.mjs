import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
export const python=process.env.LLMS_INK_GUARD_TEST_PYTHON;
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function ctl(owner,...args){return JSON.parse(execFileSync(python,['-m','llms_ink.guard',...args,'--owner-file',owner],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}));}
export async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'ink-node-'));
 const proc=spawn(python,[fileURLToPath(new URL('./fixtures/guard-service.py',import.meta.url)),dir],{stdio:['ignore','pipe','pipe']});
 let errors='';proc.stderr.on('data',chunk=>errors+=chunk);
 const ended=once(proc,'exit');
 const lines=createInterface({input:proc.stdout});
 let deadline;let first;
 try{first=await Promise.race([once(lines,'line'),ended.then(()=>{throw Error('Fixture exited: '+errors);}),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Fixture unavailable')),30000);})]);}
 catch(error){proc.kill('SIGTERM');await ended;await rm(dir,{recursive:true,force:true});throw error;}
 finally{clearTimeout(deadline);}
 assert.ok(first);const {ownerFile}=JSON.parse(first[0]);
 for(let n=0;n<100;n++){try{ctl(ownerFile,'service-status');break;}catch{if(n===99)throw Error('Service unavailable: '+errors);await pause(30);}}
 return {dir,ownerFile,proc,status:()=>ctl(ownerFile,'service-status'),effects:async()=>{try{return(await readFile(join(dir,'effects'),'utf8')).trim().split('\n').map(JSON.parse);}catch{return[];}},
 async close(){proc.kill('SIGTERM');await ended;lines.close();assert.equal(proc.exitCode,0,errors);let pids=[];try{pids=(await readFile(join(dir,'pids'),'utf8')).trim().split('\n');}catch{}
 for(const pid of pids)assert.throws(()=>process.kill(Number(pid),0),{code:'ESRCH'});await rm(dir,{recursive:true,force:true});}};
}
export function wire(options){
 const conf=options.mcpServers.guarded, proc=spawn(conf.command,conf.args,{stdio:['pipe','pipe','pipe']});proc.stderr.resume();
 const lines=createInterface({input:proc.stdout}), values=[],waiters=[];
 lines.on('line',raw=>{const value=JSON.parse(raw);if(waiters.length)waiters.shift().resolve(value);else values.push(value);});
 proc.on('exit',()=>{for(const waiter of waiters.splice(0))waiter.reject(Error('Connector closed'));});
 return {send:m=>proc.stdin.write(JSON.stringify(m)+'\n'),next:()=>values.length?Promise.resolve(values.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject})),close:()=>proc.stdin.end()};
}
