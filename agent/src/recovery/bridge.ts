import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {lstat,mkdir,readFile,writeFile,open} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {Ajv,type ValidateFunction} from 'ajv';
import {assertNativeMessage,loadNativeValidator,type NativeValidator} from '../hand/protocol.js';
import {strictJson} from '../brain/execution/planner.js';
import type {BridgeRequest,BridgeResult,RecoveryReview,RecoveryFrame,RecoveryEvent} from './types.js';
import type {RecoveryPorts} from './orchestrator.js';
export interface RecoveryValidators {request:ValidateFunction;result:ValidateFunction;native:NativeValidator}
export async function loadRecoveryValidators(repository:string):Promise<RecoveryValidators>{const schema=strictJson(await readFile(join(repository,'protocol/session-recovery-v1.schema.json'),'utf8')) as object;const ajv=new Ajv({strict:true,allErrors:true});ajv.addSchema(schema,'recovery');return{request:ajv.compile({$ref:'recovery#/definitions/request'}),result:ajv.compile({$ref:'recovery#/definitions/result'}),native:await loadNativeValidator(join(repository,'protocol/native-input-v1.schema.json'))};}
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
/** Fixed bridge process. Cancellation asks its Windows task to release; it never kills the watchdog group. */
export class InteractiveRecoveryBridge {
  private active:{child:ChildProcessWithoutNullStreams;done:Promise<BridgeResult>;request:BridgeRequest}|null=null;
  private lastInput:BridgeResult|null=null;private uncertain=false;
  constructor(private repository:string,private mainOutputRoot:string,private validators:RecoveryValidators){}
  async call(request:BridgeRequest,directory:string,signal:AbortSignal):Promise<BridgeResult>{
    if(this.active)throw new Error('recovery_bridge_single_flight');if(signal.aborted)throw new Error('recovery_bridge_cancelled');
    if(!this.validators.request(request))throw new Error('recovery_bridge_request_schema');
    const root=resolve(this.mainOutputRoot),location=resolve(directory),rel=relative(root,location);if(!isAbsolute(directory)||!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('recovery_main_output_required');
    await mkdir(dirname(location),{recursive:true});const requestPath=`${location}.request.json`;await writeFile(requestPath,`${JSON.stringify(request)}\n`,{flag:'wx',mode:0o600});
    // Python owns the new directory. Coordinator stores request alongside it, not inside it before creation.
    if(signal.aborted)throw new Error('recovery_bridge_cancelled_before_spawn');const child=spawn('/usr/bin/python3',['-B',join(this.repository,'tools/session_recovery_once.py'),'--request',requestPath,'--out',location],{cwd:this.repository,shell:false,detached:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    if(request.op==='input')this.uncertain=true;
    let outputBytes=0;const out:Buffer[]=[],err:Buffer[]=[];let ended=false;
    const done=new Promise<BridgeResult>((resolveResult,reject)=>{
      const collect=(target:Buffer[],b:Buffer)=>{outputBytes+=b.length;if(outputBytes>1024*1024){child.kill('SIGTERM');reject(new Error('recovery_bridge_output_limit'));}else target.push(b);};child.stdout.on('data',(b:Buffer)=>collect(out,b));child.stderr.on('data',(b:Buffer)=>collect(err,b));child.stdin.end();
      child.on('error',()=>{ended=true;reject(new Error('recovery_bridge_spawn_environment_failure'));});
      child.on('close',async code=>{ended=true;try{await writeFile(`${location}.stdout.txt`,Buffer.concat(out),{flag:'wx',mode:0o400});await writeFile(`${location}.stderr.txt`,Buffer.concat(err),{flag:'wx',mode:0o400});const info=await lstat(join(location,'result.json'));if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new Error('recovery_bridge_result_file');const result=strictJson(await readFile(join(location,'result.json'),'utf8')) as BridgeResult;if(!this.validators.result(result))throw new Error('recovery_bridge_result_schema');if(request.op==='observe'&&result.status==='observed'){const capture=result.capture!;const image=await readFile(join(location,capture.file));if(sha(image)!==capture.sha256)throw new Error('recovery_bridge_capture_hash');}if(request.op==='input'){for(const receipt of result.receipts??[])assertNativeMessage(receipt,this.validators.native);if(result.native_raw_file){if(result.native_raw_file!=='native-input.jsonl'||!result.native_raw_sha256||sha(await readFile(join(location,result.native_raw_file)))!==result.native_raw_sha256)throw new Error('recovery_native_raw_hash');}this.lastInput=result;this.uncertain=false;}if(code!==0){this.uncertain=true;if(request.op==='input')this.lastInput={...result,release_confirmed:false};throw new Error('recovery_bridge_program_or_cleanup_failure');}resolveResult(result);}catch(error){reject(error);}});
    });
    this.active={child,done,request};const abort=()=>{if(!ended)child.kill('SIGTERM');};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    try{return await done;}finally{signal.removeEventListener('abort',abort);if(this.active?.child===child)this.active=null;}
  }
  async release():Promise<{release:'confirmed'|'unconfirmed';pending_result?:BridgeResult}>{
    const current=this.active;if(current){current.child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;try{const result=await Promise.race([current.done,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('recovery_bridge_cancel_drain_deadline')),6000);})]);if(current.request.op==='input')return{release:result.release_confirmed===true?'confirmed':'unconfirmed',pending_result:result};}catch{return{release:'unconfirmed'};}finally{if(timer)clearTimeout(timer);}}
    return{release:this.uncertain||this.lastInput&&this.lastInput.release_confirmed!==true?'unconfirmed':'confirmed',...(this.lastInput?{pending_result:this.lastInput}:{})};
  }
}
export async function openRecoveryPorts(options:{repository:string;mainOutputRoot:string;directory:string;now:()=>number;reviewFile?:string}):Promise<{ports:RecoveryPorts;close:()=>Promise<void>}>{
  await mkdir(options.directory,{recursive:false,mode:0o700});const log=await open(join(options.directory,'recovery.jsonl'),'wx',0o600);let previous:string|null=null;
  const bridge=new InteractiveRecoveryBridge(options.repository,options.mainOutputRoot,await loadRecoveryValidators(options.repository));
  const append=async(event:RecoveryEvent)=>{const record={protocol:'wow-session-recovery-log',version:1,previous_sha256:previous,event},digest=sha(JSON.stringify(record));await log.write(`${JSON.stringify({...record,sha256:digest})}\n`);previous=digest;};
  const review=options.reviewFile?async(frame:RecoveryFrame)=>{const value=strictJson(await readFile(options.reviewFile!,'utf8')) as RecoveryReview|{reviews:RecoveryReview[]};const values='reviews'in value?value.reviews:[value];return values.find(v=>v.source.observation_id===frame.source.observation_id);} : undefined;
  return{ports:{now:options.now,call:(request,directory,signal)=>bridge.call(request,directory,signal),release:()=>bridge.release(),append,sleep:async(ms,signal)=>{await new Promise<void>((resolveSleep,reject)=>{const timeout=setTimeout(()=>{signal.removeEventListener('abort',abort);resolveSleep();},ms);const abort=()=>{clearTimeout(timeout);reject(new Error('recovery_sleep_cancelled'));};if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});},...(review?{review}:{})},close:async()=>{await log.close();}};
}
