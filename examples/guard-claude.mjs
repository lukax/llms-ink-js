#!/usr/bin/env node
// Run from an installed llms-ink package with the optional Claude SDK peer installed.
import {parseArgs} from 'node:util';
import {createInterface} from 'node:readline/promises';
import {createGuardedClaude,GuardHostError} from '../dist/guard-claude.js';
const {values}=parseArgs({options:{'owner-file':{type:'string'},python:{type:'string'},cwd:{type:'string'},model:{type:'string'},'claude-executable':{type:'string'}}});
if(!process.stdin.isTTY || !process.stdout.isTTY) throw Error('This example requires an interactive terminal for each approval.');
if(!values['owner-file'] || !values.python || !values.cwd) throw Error('Pass --owner-file, --python and --cwd with absolute paths.');
const terminal=createInterface({input:process.stdin,output:process.stdout});
// Preserve complete text while making terminal controls and bidi controls visible.
const plain=text=>text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
let conversation,stopping=false;
const report=error=>{
 console.error(error instanceof GuardHostError?error.message:'The terminal conversation did not complete.');
 if(error instanceof GuardHostError){
  console.error('Failure code:',error.code);
  if(error.operationCode)console.error('Original operation:',error.operationCode);
  if(error.sessionId)console.error('Session ID:',error.sessionId);
  if(error.credentialDirectory)console.error('Credential directory:',error.credentialDirectory);
 }
};
const stop=()=>{stopping=true;terminal.close();void conversation?.close().catch(()=>{});};
terminal.on('SIGINT',stop);terminal.on('close',()=>{stopping=true;void conversation?.close().catch(()=>{});});process.on('SIGTERM',stop);
try{
 conversation=await createGuardedClaude({ownerFile:values['owner-file'],python:values.python,cwd:values.cwd,model:values.model,claudeExecutable:values['claude-executable'],
  review:async({message,signal})=>{
   process.stdout.write('\n'+plain(message)+'\n\n');
   try{return(await terminal.question('Type approve to send this call once; Enter declines: ',{signal}))==='approve';}catch{return false;}
  }});
 console.log('Guarded conversation. /exit closes and revokes this session.');
 while(!stopping){
  const prompt=await terminal.question('\nYou: ');
  if(prompt.trim()==='/exit')break;
  if(!prompt.trim())continue;
  await conversation.run(prompt,message=>{
   if(message.type==='assistant')for(const part of message.message.content)if(part.type==='text'){
    for(const line of plain(part.text).split('\n'))process.stdout.write('Claude: '+line+'\n');
   }
   if(message.type==='user' && Array.isArray(message.message.content))for(const part of message.message.content)if(part.type==='tool_result'){
    process.stdout.write('\nTool response'+(part.is_error===true?' (error)':'')+'\n');
    process.stdout.write(plain(JSON.stringify({toolUseId:part.tool_use_id,content:part.content},null,2))+'\n');
   }
  });
 }
}catch(error){if(!stopping){report(error);process.exitCode=1;}}
finally{
 terminal.close();process.removeListener('SIGTERM',stop);
 try{await conversation?.close();}catch(error){report(error);process.exitCode=1;}
}
