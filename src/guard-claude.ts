/** Node/POSIX host integration for explicitly scoped Claude Agent SDK conversations. */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, chmod, lstat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { query, type ElicitationRequest, type Options, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface GuardReview {
  /** Complete guard-authored review, including command, arguments and policy/definition hashes. Render as plain text. */
  message: string;
  /** Stop displaying the form when this signal aborts. Never reuse a decision. */
  signal: AbortSignal;
}
export interface GuardedClaudeOptions {
  /** Private owner credential. This path is used by the control process, never sent to Claude. */
  ownerFile: string;
  /** Absolute Python interpreter with llms-ink[guard] 0.14.0+ installed. */
  python: string;
  /** Called for each fresh approval. Only literal true accepts. Errors, cancellation and timeout decline. */
  review: (request: GuardReview) => Promise<boolean>;
  cwd: string;
  model?: string;
  /** Optional absolute path to a supported Claude Code executable. */
  claudeExecutable?: string;
  /** Fixed lifetime, 1–86400 seconds. Default 900. No automatic renewal. */
  ttl?: number;
  /** Per-turn deadline, including reviews. Default 120000, maximum 600000. */
  turnTimeoutMs?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
}
export interface GuardedClaudeConversation {
  /** Non-secret guard session ID, distinct from Claude's conversation UUID. */
  readonly sessionId: string;
  /** Run one turn. Calls must be sequential; callbacks receive host output, never owner credentials. */
  run(prompt: string, onMessage?: (message: SDKMessage) => void | Promise<void>): Promise<SDKResultMessage>;
  /** Revoke authority and close the host. Idempotent after confirmed cleanup; retry on cleanup errors. */
  close(): Promise<void>;
}
/** Local failure categories. No provider text, tool output or credentials are copied into these values. */
export type GuardHostErrorCode = 'host_error' | 'session_create_failed' | 'host_startup_failed'
  | 'service_status_failed' | 'session_inactive' | 'host_stream_failed' | 'host_stream_ended'
  | 'session_mismatch' | 'guard_connection_failed' | 'unexpected_tools' | 'host_not_initialized'
  | 'message_callback_failed' | 'host_result_error' | 'host_turn_limit' | 'host_budget_limit'
  | 'host_output_retry_limit' | 'turn_timeout' | 'session_expired' | 'conversation_closed'
  | 'revocation_unconfirmed' | 'host_cleanup_failed' | 'credential_cleanup_failed'
  | 'host_watch_failed' | 'host_watch_cleanup_failed';
export class GuardHostError extends Error {
  readonly sessionId: string | undefined;
  readonly credentialDirectory: string | undefined;
  readonly code: GuardHostErrorCode;
  /** Original operation failure when cleanup itself failed. Cleanup remains the primary error. */
  readonly operationCode: GuardHostErrorCode | undefined;
  constructor(message: string, sessionId?: string, credentialDirectory?: string, code: GuardHostErrorCode = 'host_error', operationCode?: GuardHostErrorCode) {
    super(message); this.name = 'GuardHostError'; this.sessionId = sessionId; this.credentialDirectory = credentialDirectory;
    this.code = code; this.operationCode = operationCode;
  }
}

const idPattern = /^[a-f0-9]{32}$/;
const reviewSchema = {type:'object',properties:{approve:{type:'boolean',title:'Approve this call once',default:false}},required:['approve']};
function sameShape(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak=Object.keys(a), bk=Object.keys(b);
  return ak.length===bk.length && ak.every(k=>Object.hasOwn(b,k) && sameShape((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
}
function control(python: string, args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve,reject)=>execFile(python,['-m','llms_ink.guard',...args],{timeout:30000,maxBuffer:16384,encoding:'utf8'},(error,stdout)=>{
    if(error) { reject(new GuardHostError('Guard control did not complete.')); return; }
    try {
      const value: unknown=JSON.parse(stdout);
      if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error();
      resolve(value as Record<string,unknown>);
    } catch { reject(new GuardHostError('Guard control returned an invalid response.')); }
  }));
}

interface HostWatcher { stop(): Promise<void>; }
async function watchHost(python: string, ownerFile: string, sessionId: string, lost: ()=>void): Promise<HostWatcher> {
  const child=spawn(python,['-m','llms_ink.guard','session-watch','--owner-file',ownerFile,'--session-id',sessionId],{stdio:['pipe','pipe','ignore']});
  let expected=false, finished=false, acknowledged=false, data='';
  let accept: ()=>void=()=>{}, reject: ()=>void=()=>{};
  const ready=new Promise<void>((resolve,fail)=>{accept=resolve;reject=()=>fail(new GuardHostError('Host lifetime binding failed.',undefined,undefined,'host_watch_failed'));});
  const failure=():void=>{reject();if(!expected)lost();};
  const ended=new Promise<void>(resolve=>child.once('close',()=>{finished=true;failure();resolve();}));
  child.once('error',failure);
  child.stdin.on('error',failure);
  child.stdout.once('end',()=>{if(!expected)failure();});
  child.stdout.on('data',(chunk:Buffer)=>{
    if(acknowledged || chunk.length+Buffer.byteLength(data)>16384) { failure();return; }
    data+=chunk.toString('utf8');
    if(!data.includes('\n'))return;
    try {
      const value:unknown=JSON.parse(data);
      if(!sameShape(value,{ok:true,sessionId}))throw new Error();
      acknowledged=true;data='';accept();
    }catch{failure();}
  });
  async function waitForExit(ms:number):Promise<boolean> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {return await Promise.race([ended.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}
    finally{clearTimeout(timer);}
  }
  const watcher:HostWatcher={async stop(){
    expected=true;child.stdin.destroy();
    if(finished || await waitForExit(5000))return;
    child.kill('SIGKILL');
    if(!await waitForExit(2000))throw new GuardHostError('Host watcher cleanup did not complete.',undefined,undefined,'host_watch_cleanup_failed');
  }};
  const timer=setTimeout(failure,30000);
  try {await ready;return watcher;}
  catch(error){await watcher.stop();throw error;}
  finally{clearTimeout(timer);}
}
class Input implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage | undefined;
  private wake: (()=>void) | undefined;
  private ended = false;
  send(prompt: string, session: string): void {
    if(this.ended || this.pending) throw new GuardHostError('Conversation input is unavailable.');
    this.pending={type:'user',session_id:session,message:{role:'user',content:prompt},parent_tool_use_id:null};
    this.wake?.();
  }
  close(): void { this.ended=true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while(!this.ended) {
      if(!this.pending) await new Promise<void>(resolve=>{this.wake=resolve;});
      this.wake=undefined;
      if(this.ended) return;
      const next=this.pending;this.pending=undefined;
      if(next) yield next;
    }
  }
}

/**
 * Create one non-resumable, tool-scoped conversation. New conversations require new instances.
 * The owner process, SDK and review callback are trusted. This is not an OS sandbox.
 * A private owner watcher revokes authority on observed host disconnect, with a fixed TTL backstop.
 * A stopped host/watcher can retain its socket until TTL; this is not an exposure ledger or a sandbox.
 */
export async function createGuardedClaude(options: GuardedClaudeOptions): Promise<GuardedClaudeConversation> {
  options={...options};
  if(process.platform==='win32') throw new GuardHostError('Guard sessions require macOS or Linux.');
  const {python,ownerFile,review,cwd,claudeExecutable}=options;
  const ttl=options.ttl??900, timeout=options.turnTimeoutMs??120000;
  if(!isAbsolute(python) || !isAbsolute(ownerFile) || !isAbsolute(cwd) || (claudeExecutable && !isAbsolute(claudeExecutable)) || typeof review!=='function'
    || !Number.isInteger(ttl) || ttl<1 || ttl>86400 || !Number.isInteger(timeout) || timeout<1 || timeout>600000
    || (options.maxTurns!==undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns<1 || options.maxTurns>100))
    || (options.maxBudgetUsd!==undefined && (!Number.isFinite(options.maxBudgetUsd) || options.maxBudgetUsd<=0)))
    throw new GuardHostError('Absolute paths, a review callback and bounded lifetimes are required.');
  const directory=await mkdtemp(join(tmpdir(),'ink-host-'));await chmod(directory,0o700);
  const file=join(directory,'session.json');
  const issueStarted=performance.now();
  let sessionId: string | undefined;
  async function revoke(): Promise<void> {
    if(!sessionId) return;
    try { const result=await control(python,['session-revoke','--owner-file',ownerFile,'--session-id',sessionId]); if(result.ok!==true) throw new Error(); }
    catch {
      try {
        const state=await control(python,['service-status','--owner-file',ownerFile]);
        if(state.ok!==true || !Array.isArray(state.sessions) || state.sessions.some(s=>!s || typeof s!=='object' || typeof s.sessionId!=='string' || (s.sessionId===sessionId && s.active!==false))) throw new Error();
      } catch { throw new GuardHostError('Session revocation could not be confirmed. Keep the credential directory and retry close or revoke it with the owner CLI.',sessionId,directory,'revocation_unconfirmed'); }
    }
  }
  try {
    const result=await control(python,['session-create','--owner-file',ownerFile,'--output',file,'--ttl',String(ttl),'--host-bound']);
    if(typeof result.sessionId!=='string' || !idPattern.test(result.sessionId)) throw new Error();
    sessionId=result.sessionId;
    const info=await lstat(file);
    if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o077)!==0 || info.uid!==process.getuid?.()) throw new Error();
  } catch {
    // A terminated CLI may have written a capability before printing its ID.
    if(!sessionId) {
      try { const saved=JSON.parse(await readFile(file,'utf8')); if(typeof saved.sessionId==='string' && idPattern.test(saved.sessionId)) sessionId=saved.sessionId; } catch { /* no recoverable credential */ }
    }
    try { await revoke();await rm(directory,{recursive:true,force:true}); }
    catch(error) { throw cleanupError(error,'session_create_failed'); }
    throw new GuardHostError('Could not create a guarded conversation.',undefined,undefined,'session_create_failed');
  }
  const guardId=sessionId;
  const hostId=randomUUID(), input=new Input(), abort=new AbortController();
  let closing=false, closed=false, busy=false, initialized=false, closeWork: Promise<void>|undefined;
  let host: ReturnType<typeof query> | undefined;
  let watcher: HostWatcher | undefined;
  let expiresTimer: ReturnType<typeof setTimeout> | undefined;
  let stopReason: GuardHostErrorCode | undefined;
  function cleanupError(error: unknown, operationCode: GuardHostErrorCode): GuardHostError {
    if(error instanceof GuardHostError) return new GuardHostError(error.message,error.sessionId,error.credentialDirectory,error.code,operationCode);
    return new GuardHostError('Credential cleanup did not complete. Retry cleanup.',sessionId,directory,'credential_cleanup_failed',operationCode);
  }
  async function whileOpen<T>(work: Promise<T>): Promise<T> {
    if(abort.signal.aborted) throw new GuardHostError('Conversation closed.');
    let cancel: (()=>void) | undefined;
    try {
      return await Promise.race([work,new Promise<never>((_,reject)=>{
        cancel=()=>reject(new GuardHostError('Conversation closed.'));
        abort.signal.addEventListener('abort',cancel,{once:true});
      })]);
    } finally { if(cancel) abort.signal.removeEventListener('abort',cancel); }
  }
  async function close(): Promise<void> {
    if(closed) return;
    if(closeWork) return closeWork;
    stopReason??='conversation_closed';closing=true;input.close();abort.abort();clearTimeout(expiresTimer);
    closeWork=(async()=>{
      let failure: unknown;
      try { await revoke(); } catch(error) { failure=error; }
      try { host?.close(); } catch { failure??=new GuardHostError('Claude host cleanup did not complete. Retry close.',guardId,directory,'host_cleanup_failed'); }
      try { await watcher?.stop(); } catch { failure??=new GuardHostError('Host watcher cleanup did not complete. Retry close.',guardId,directory,'host_watch_cleanup_failed'); }
      if(failure) throw failure;
      try { await rm(directory,{recursive:true,force:true}); }
      catch { throw new GuardHostError('Credential cleanup did not complete. Retry close.',guardId,directory,'credential_cleanup_failed'); }
      closed=true;
    })();
    try { await closeWork; } finally { closeWork=undefined; }
  }
  async function elicit(request: ElicitationRequest, context: {signal:AbortSignal}): Promise<{action:'accept'|'decline';content?:{approve:boolean}}> {
    if(closing || !initialized || !busy || context.signal.aborted || request.serverName!=='guarded' || (request.mode??'form')!=='form'
      || typeof request.message!=='string' || Buffer.byteLength(request.message)>8192 || !sameShape(request.requestedSchema,reviewSchema)) return {action:'decline'};
    const lifetime=new AbortController();
    const cancel=():void=>lifetime.abort();
    abort.signal.addEventListener('abort',cancel,{once:true});context.signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(cancel,55000);
    try {
      const answer=await Promise.race([
        Promise.resolve().then(()=>review(Object.freeze({message:request.message,signal:lifetime.signal}))),
        new Promise<false>(resolve=>lifetime.signal.addEventListener('abort',()=>resolve(false),{once:true})),
      ]);
      return answer===true && !lifetime.signal.aborted && !closing ? {action:'accept',content:{approve:true}} : {action:'decline'};
    } catch { return {action:'decline'}; }
    finally { clearTimeout(timer);cancel();abort.signal.removeEventListener('abort',cancel);context.signal.removeEventListener('abort',cancel); }
  }
  try {
    watcher=await watchHost(python,ownerFile,guardId,()=>{
      if(!closing){stopReason=performance.now()-issueStarted>=ttl*1000?'session_expired':'host_watch_failed';if(watcher)void close().catch(()=>{});}
    });
    if(closing || stopReason)throw new Error();
    const sdkOptions: Options={
      abortController:abort,sessionId:hostId,persistSession:false,settingSources:[],plugins:[],tools:[],
      strictMcpConfig:true,mcpServers:{guarded:{command:python,args:['-m','llms_ink.guard','connect','--session-file',file]}},
      canUseTool:async name=>name.startsWith('mcp__guarded__') && initialized && busy && !closing
        ? {behavior:'allow'} : {behavior:'deny',message:'Only guarded tools are available.'},
      settings:{disableAllHooks:true,disableClaudeAiConnectors:true,disabledMcpServers:['claude-in-chrome']},
      extraArgs:{'disable-slash-commands':null,'no-chrome':null},
      cwd,model:options.model,pathToClaudeCodeExecutable:claudeExecutable,
      maxTurns:options.maxTurns??12,maxBudgetUsd:options.maxBudgetUsd??1,onElicitation:elicit,
    };
    host=query({prompt:input,options:sdkOptions});
    // Revocation on idle expiry does not wait for another prompt. Failures remain
    // observable through close(); the service independently enforces its TTL.
    expiresTimer=setTimeout(()=>{stopReason??='session_expired';void close().catch(()=>{});},Math.max(0,ttl*1000-(performance.now()-issueStarted)));expiresTimer.unref();
  } catch {
    const code=stopReason??(watcher?'host_startup_failed':'host_watch_failed');
    try { await close(); } catch(error) { throw cleanupError(error,code); }
    throw new GuardHostError('Claude host startup failed.',undefined,undefined,code);
  }
  return Object.freeze({sessionId:guardId,
    async run(prompt: string,onMessage?: (message: SDKMessage)=>void|Promise<void>): Promise<SDKResultMessage> {
      if(closing) {
        const code=stopReason??'conversation_closed';
        try{await close();}catch(error){throw cleanupError(error,code);}
        throw new GuardHostError('The conversation is closed.',undefined,undefined,code);
      }
      if(busy) throw new GuardHostError('Another turn is running.');
      if(typeof prompt!=='string' || !prompt.trim() || prompt.trimStart().startsWith('/') || Buffer.byteLength(prompt)>131072)
        throw new GuardHostError('Provide a text prompt up to 128 KiB; host commands require a new conversation.');
      busy=true;
      let failureCode: GuardHostErrorCode = 'service_status_failed';
      function fail(code:GuardHostErrorCode):never { failureCode=code;throw new Error(); }
      const timer=setTimeout(()=>{stopReason??='turn_timeout';void close().catch(()=>{});},timeout);
      try {
        const state=await control(python,['service-status','--owner-file',ownerFile]);
        if(closing || state.ok!==true || !Array.isArray(state.sessions) || !state.sessions.some(s=>s?.sessionId===guardId && s.active===true)) fail('session_inactive');
        failureCode='host_stream_failed';
        input.send(prompt,hostId);
        while(true) {
          failureCode='host_stream_failed';
          const next=await whileOpen(host!.next());
          if(next.done || closing) fail('host_stream_ended');
          const message=next.value;
          if('session_id' in message && message.session_id!==hostId) fail('session_mismatch');
          if(message.type==='system' && message.subtype==='init') {
            if(!Array.isArray(message.mcp_servers) || message.mcp_servers.length!==1 || message.mcp_servers[0]?.name!=='guarded' || message.mcp_servers[0]?.status!=='connected') fail('guard_connection_failed');
            if(!Array.isArray(message.tools) || !message.tools.length || message.tools.some(t=>typeof t!=='string' || !t.startsWith('mcp__guarded__'))) fail('unexpected_tools');
            initialized=true;
          }
          // Error results can precede initialization. Only fixed subtype names are retained.
          if(message.type==='result' && message.is_error) {
            const code=message.subtype==='error_max_turns'?'host_turn_limit':message.subtype==='error_max_budget_usd'?'host_budget_limit':message.subtype==='error_max_structured_output_retries'?'host_output_retry_limit':'host_result_error';
            fail(code);
          }
          // Claude can emit subscription rate status before its initialization
          // announcement. Discard it until the guard connection and tools are
          // verified; it grants no authority and never reaches the callback.
          if(!initialized && message.type==='rate_limit_event') continue;
          if(!initialized && message.type!=='system') fail('host_not_initialized');
          if(onMessage) { failureCode='message_callback_failed';await whileOpen(Promise.resolve().then(()=>onMessage(message))); }
          if(message.type==='result') {
            return message;
          }
        }
      } catch {
        const code=stopReason??failureCode;
        try { await close(); } catch(error) { throw cleanupError(error,code); }
        throw new GuardHostError(`Guarded turn did not complete (${code}); the conversation was closed.`,undefined,undefined,code);
      }
      finally { clearTimeout(timer);busy=false; }
    },close,
  });
}
