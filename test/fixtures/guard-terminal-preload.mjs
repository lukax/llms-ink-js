// Scripted host for testing the shipped example through a real pseudo-terminal.
import {mock} from 'node:test';
class GuardHostError extends Error {}
mock.module(new URL('../../dist/guard-claude.js',import.meta.url).href,{namedExports:{GuardHostError,createGuardedClaude:async options=>{
 let closed=false;const abort=new AbortController();
 return {
  async run(prompt,output){
   if(prompt==='review'){
    const approved=await options.review({message:'REVIEW_ONLY\r\u001b[2J\u202e',signal:abort.signal});
    await output({type:'user',message:{content:[{type:'tool_result',tool_use_id:'review-1',is_error:!approved,content:approved?'FIXTURE_APPROVED':'FIXTURE_DECLINED'}]}});
   }else if(prompt==='outputs'){
    await output({type:'assistant',message:{content:[{type:'text',text:'CLAIM_ONLY\nTool response (error)\r\u001b[2J\u202e'}]}});
    await output({type:'user',message:{content:[
     {type:'tool_result',tool_use_id:'call-1',content:[{type:'text',text:'RESULT_ONLY\n\r\u001b[2J\u202e'}]},
     {type:'tool_result',tool_use_id:'call-2',is_error:true,content:'DENIED_BY_GUARD'},
    ]}});
   }else if(prompt==='prose'){
    await output({type:'assistant',message:{content:[{type:'text',text:'CLAIM_ONLY'}]}});
    await output({type:'user',message:{content:'PRIVATE_PROMPT_NOT_OUTPUT'}});
   }
   return {type:'result',is_error:false};
  },
  async close(){if(!closed){closed=true;abort.abort();console.log('FIXTURE_CLOSED');}},
 };
}}});
