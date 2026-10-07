import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {StringDecoder} from 'node:string_decoder';
import type {ValidateFunction} from 'ajv';
import type {ActionIntent} from '../core/protocol.js';
import type {Collected} from '../eye/runtime.js';
import type {ExecutionContext} from '../layers/contracts.js';
import {assertNativeMessage,assertNativeTimeline,type NativeAction,type NativeReady,type NativeReceipt,type NativeValidator} from '../hand/protocol.js';
import {assertResident,type ResidentCommand,type ResidentEvidence,type ResidentHostReady,type ResidentIntentBinding,type ResidentMemoryFrame,type ResidentMemorySample,type ResidentMessage,type ResidentOp,type ResidentSourceOwner,type ResidentStopped} from './protocol.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}':JSON.stringify(value);
const actionDigest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
interface Pending {op:ResidentOp;started:number;resolve:(reply:ResidentMessage)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}
export interface ResidentClientOptions {config:string;runDir:string;repository:string;python?:string;now?:()=>number;startupTimeoutMs?:number;signal?:AbortSignal;
  /** Protocol-only tests; production always launches the fixed Python entry. */
  launcher?:(args:readonly string[])=>ChildProcessWithoutNullStreams}
export interface ResidentCleanup {stopped:ResidentStopped|null;task_deleted:boolean;task_absence_verified:boolean;launcher_exit_code:number|null;release_scope:'native_receipt_and_ledger'|'no_executor_acquired'|'unconfirmed'}
/** The private source register accepts only intact messages from this connection. */
export class ResidentClient extends EventEmitter implements ResidentSourceOwner {
  readonly runDir:string;ready:NativeReady|null=null;hostReady:ResidentHostReady|null=null;
  private readonly child:ChildProcessWithoutNullStreams;private readonly now:()=>number;
  private state:'starting'|'ready'|'closing'|'closed'|'failed'='starting';private pending=new Map<string,Pending>();private counter=0;
  private decoder=new StringDecoder('utf8');private buffer='';private stderrBytes=0;private heartbeat:ReturnType<typeof setInterval>|null=null;
  private startTimer:ReturnType<typeof setTimeout>;private started:Promise<void>;private startResolve!:()=>void;private startReject!:(error:Error)=>void;
  private original=new WeakMap<ResidentMemorySample,string>();private readyHash:string|null=null;private brackets=new WeakMap<ResidentMemorySample,{started_at_ms:number;received_at_ms:number}>();private current:{sample:ResidentMemorySample;hash:string;received:number;nativeSentQpc:number}|null=null;
  private bound:{source:ResidentMemoryFrame;intent:ResidentIntentBinding;commandId:string}|null=null;
  private stopped:ResidentStopped|null=null;private executorAcquired=false;private exitCode:number|null=null;private exitPromise:Promise<void>;private exitResolve!:()=>void;private closeJob:Promise<ResidentCleanup>|null=null;
  private constructor(options:ResidentClientOptions,private validator:ValidateFunction,private nativeValidator:NativeValidator){
    super();this.runDir=options.runDir;const clock=options.now??(()=>performance.now());this.now=()=>{const at=clock();if(!Number.isFinite(at)||at<0)throw new Error('resident_coordinator_clock');return Math.floor(at);};
    const args=[join(options.repository,'tools/resident_session.py'),'serve','--config',options.config,'--run-dir',options.runDir];
    this.child=options.launcher?options.launcher(args):spawn(options.python??'/usr/bin/python3',args,{cwd:options.repository,shell:false,windowsHide:true,detached:false,stdio:['pipe','pipe','pipe']});
    this.started=new Promise((resolve,reject)=>{this.startResolve=resolve;this.startReject=reject;});this.exitPromise=new Promise(resolve=>{this.exitResolve=resolve;});
    this.startTimer=setTimeout(()=>this.fail(new Error('resident_startup_timeout')),options.startupTimeoutMs??35000);
    this.child.stdout.on('data',(chunk:Buffer)=>this.receive(chunk));
    this.child.stderr.on('data',(chunk:Buffer)=>{this.stderrBytes+=chunk.length;if(this.stderrBytes>65536)this.fail(new Error('resident_stderr_limit'));});
    this.child.stdin.on('error',()=>this.fail(new Error('resident_stdin_disconnected')));
    this.child.on('error',(error:NodeJS.ErrnoException)=>this.fail(new Error('resident_launch_failed:'+(error.code??'unknown'))));
    this.child.on('exit',(code)=>{this.exitCode=code;this.exitResolve();if(this.state!=='closing'&&this.state!=='closed')this.fail(new Error('resident_launcher_disconnected'));});
  }
  static async start(options:ResidentClientOptions,validator:ValidateFunction,nativeValidator:NativeValidator):Promise<ResidentClient>{
    if(options.signal?.aborted)throw new Error('resident_startup_cancelled');
    const client=new ResidentClient(options,validator,nativeValidator),abort=()=>client.fail(new Error('resident_startup_cancelled'));
    options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    try{await client.started;if(options.signal?.aborted)throw new Error('resident_startup_cancelled');return client;}catch(error){await client.close().catch(()=>{});throw error;}
    finally{options.signal?.removeEventListener('abort',abort);}
  }
  get sessionId():string {if(!this.hostReady)throw new Error('resident_not_ready');return this.hostReady.session_id;}
  isConnected():boolean{return this.state==='ready'&&this.hostReady!==null&&this.readyHash===digest(this.hostReady);}
  channelGeneration():string|null{return this.isConnected()?this.hostReady!.channel_generation:null;}
  validateOriginal(sample:ResidentMemorySample):boolean{return this.isConnected()&&this.original.get(sample)===digest(sample)&&this.isFrameActive(sample.memory_frame);}
  validateBracket(sample:ResidentMemorySample,bracket:{started_at_ms:number;received_at_ms:number}):boolean{const known=this.brackets.get(sample);return this.validateOriginal(sample)&&known!==undefined&&known.started_at_ms===bracket.started_at_ms&&known.received_at_ms===bracket.received_at_ms;}
  isFrameActive(frame:ResidentMemoryFrame):boolean{
    const source=this.current,ready=this.hostReady;if(!this.isConnected()||!source||!ready||source.hash!==digest(source.sample))return false;
    const age=source.nativeSentQpc-source.sample.memory_frame.source_qpc_ms+this.now()-source.received;
    return age>=0&&age<=5000&&frame.channel_generation===ready.channel_generation&&frame.session_id===ready.session_id&&
      frame.host_pid===ready.host_pid&&frame.host_start_ticks===ready.host_start_ticks&&frame.windows_clock_id===ready.windows_clock_id&&
      digest(frame)===digest(source.sample.memory_frame);
  }
  private fail(error:Error):void{
    if(this.state==='failed'||this.state==='closed')return;this.state='failed';this.current=null;this.bound=null;clearTimeout(this.startTimer);if(this.heartbeat)clearInterval(this.heartbeat);
    this.startReject(error);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    // EOF closes the local pipe; it does not itself prove release or task deletion.
    this.child.stdin.end();this.emit('disconnect',{error:error.message,release:'unconfirmed'});
  }
  private receive(chunk:Buffer):void{
    try{this.buffer+=this.decoder.write(chunk);if(Buffer.byteLength(this.buffer)>524288)throw new Error('resident_line_limit');let at:number;
      while((at=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,at).replace(/\r$/,'');this.buffer=this.buffer.slice(at+1);if(!line)continue;
        const value:unknown=JSON.parse(line);assertResident(value,this.validator);if(value.type==='command')throw new Error('resident_unexpected_command');this.message(value);
      }
    }catch(error){this.fail(error instanceof Error?error:new Error('resident_invalid_output'));}
  }
  private message(message:ResidentMessage):void{
    if(message.type==='ready'){
      if(this.hostReady||message.target.pid!==message.window.pid||message.target.start_ticks!==message.window.start_ticks||BigInt(message.target.hwnd)!==BigInt(message.window.hwnd))throw new Error('resident_ready_identity');
      if(message.native_ready){assertNativeMessage(message.native_ready,this.nativeValidator);if(message.native_ready.session_id!==message.session_id||message.native_ready.window.pid!==message.target.pid||BigInt(message.native_ready.window.hwnd)!==BigInt(message.target.hwnd))throw new Error('resident_hand_binding');}
      this.hostReady=message;this.ready=message.native_ready;this.readyHash=digest(message);this.executorAcquired=message.native_ready!==null;this.state='ready';clearTimeout(this.startTimer);this.startResolve();
      this.heartbeat=setInterval(()=>{if(this.state==='ready'||this.state==='closing')try{this.write('heartbeat','hb-'+ ++this.counter);}catch{this.fail(new Error('resident_heartbeat_failed'));}},200);return;
    }
    if(!this.hostReady||message.session_id!==this.hostReady.session_id)throw new Error('resident_output_session');
    if(message.type==='stopped'){
      if(message.release_receipt)assertNativeMessage(message.release_receipt,this.nativeValidator);
      const released=message.release_receipt;
      if(message.release_confirmed&&(this.executorAcquired?!(released?.session_id===message.session_id&&released.op==='release_all'&&released.status==='ok'&&released.input.released&&message.ledger_empty===true&&message.native_exited===true):released!==null||message.ledger_empty!==null||message.native_exited!==null))throw new Error('resident_stopped_release_identity_unconfirmed');
      this.stopped=message;this.current=null;this.bound=null;
      if(this.heartbeat)clearInterval(this.heartbeat);this.emit('stopped',message);for(const [id,p]of this.pending){clearTimeout(p.timer);if(p.op==='shutdown'||p.op==='cancel')p.resolve(message);else p.reject(new Error('resident_stopped:'+message.reason));this.pending.delete(id);}return;
    }
    if(message.type==='receipt'){assertNativeMessage(message.native,this.nativeValidator);if(message.native.session_id!==this.sessionId||message.native.id!==message.id)throw new Error('resident_native_receipt_binding');this.emit('receipt',message.native);this.emit('resident_receipt',message);}
    const pending=this.pending.get(message.id??'');if(!pending)throw new Error('resident_unrequested_message');
    if(message.type==='error'){clearTimeout(pending.timer);this.pending.delete(message.id!);pending.reject(new Error(message.reason.code));return;}
    if(message.type==='sample'||message.type==='evidence'){
      if(pending.op!==(message.type==='sample'?'observe':'evidence')&&!(message.type==='sample'&&pending.op==='load_ui_skills'))throw new Error('resident_reply_operation');const sample=message.type==='sample'?message:message.sample;
      if(sample.memory_frame.target_scope!==this.hostReady.target_scope||sample.memory_frame.channel_generation!==this.hostReady.channel_generation||sample.memory_frame.host_pid!==this.hostReady.host_pid||sample.memory_frame.host_start_ticks!==this.hostReady.host_start_ticks||sample.memory_frame.windows_clock_id!==this.hostReady.windows_clock_id||
        this.current&&sample.seq<=this.current.sample.seq||digest(sample.memory_frame.target)!==digest(this.hostReady.target))throw new Error('resident_frame_identity_or_sequence');
      this.original.set(sample,digest(sample));this.current={sample,hash:digest(sample),received:this.now(),nativeSentQpc:message.local_clock.at_ms};
    }
    clearTimeout(pending.timer);this.pending.delete(message.id!);pending.resolve(message);
  }
  private write(op:ResidentOp,id:string,extra:Partial<ResidentCommand>={}):void{
    const command:ResidentCommand={protocol:'wow-resident',version:1,type:'command',session_id:this.sessionId,id,op,...extra};assertResident(command,this.validator);
    this.child.stdin.write(JSON.stringify(command)+'\n');
  }
  private request(op:ResidentOp,extra:Partial<ResidentCommand>={},timeout=2000):Promise<ResidentMessage>{
    if(this.state!=='ready'&&!(this.state==='closing'&&op==='shutdown'))return Promise.reject(new Error('resident_not_connected'));
    const id=extra.id??'resident-'+ ++this.counter;return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('resident_request_timeout:'+op));if(op==='execute')this.fail(new Error('resident_input_transport_unconfirmed'));},timeout);
      this.pending.set(id,{op,resolve,reject,timer,started:this.now()});try{this.write(op,id,extra);}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error instanceof Error?error:new Error('resident_write_failed'));}
    });
  }
  async loadUiSkills(snapshotCanonical:string,snapshotSha256:string,uiScope:NonNullable<ResidentCommand['ui_scope']>):Promise<ResidentMemorySample>{
    if(createHash('sha256').update(snapshotCanonical).digest('hex')!==snapshotSha256)throw new Error('resident_ui_knowledge_sha');
    const reply=await this.request('load_ui_skills',{snapshot_canonical:snapshotCanonical,snapshot_sha256:snapshotSha256,ui_scope:uiScope},3000);
    if(reply.type!=='sample'||reply.ui_skills?.knowledge_sha256!==snapshotSha256)throw new Error('resident_ui_knowledge_reply');
    return reply;
  }
  async sample(_legacySave=false):Promise<{sample:ResidentMemorySample;started_at_ms:number;received_at_ms:number}>{
    const started=this.now(),reply=await this.request('observe');if(reply.type!=='sample')throw new Error('resident_sample_reply');const bracket={sample:reply,started_at_ms:started,received_at_ms:this.now()};this.brackets.set(reply,{started_at_ms:bracket.started_at_ms,received_at_ms:bracket.received_at_ms});return bracket;
  }
  async evidence(options:{ocr?:boolean}={}):Promise<ResidentEvidence&{bracket:{sample:ResidentMemorySample;started_at_ms:number;received_at_ms:number}}>{const started=this.now(),reply=await this.request('evidence',{ocr:options.ocr??false},12000);if(reply.type!=='evidence')throw new Error('resident_evidence_reply');const bracket={sample:reply.sample,started_at_ms:started,received_at_ms:this.now()};this.brackets.set(reply.sample,{started_at_ms:bracket.started_at_ms,received_at_ms:bracket.received_at_ms});return Object.assign(reply,{bracket});}
  async bindSource(before:Collected,intent:ActionIntent,context:ExecutionContext):Promise<void>{
    const sample=before.bracket.sample as unknown as ResidentMemorySample;
    if(sample.protocol!=='wow-resident'||!this.isFrameActive(sample.memory_frame)||intent.mode!=='live'||context.mode!=='live'||context.signal.aborted||
      intent.based_on_observation_id!==before.observation.id||intent.id!==context.command_id||intent.plan.id!==context.task_id||intent.plan.revision!==context.task_revision)
      throw new Error('resident_intent_source_binding');
    if(intent.action?.name!=='native_input')throw new Error('resident_intent_not_native');
    const binding:ResidentIntentBinding={observation_id:before.observation.id,intent_id:intent.id,actor:intent.actor,plan_id:intent.plan.id,plan_revision:intent.plan.revision,
      task_id:context.task_id,task_revision:context.task_revision,run_epoch:context.run_epoch,gate_id:digest({intent,context:{...context,signal:undefined}}),action_sha256:actionDigest(intent.action.args)};
    this.bound={source:structuredClone(sample.memory_frame),intent:binding,commandId:context.command_id};
  }
  async execute(action:NativeAction,options:{id?:string}={}):Promise<NativeReceipt>{
    const binding=this.bound;this.bound=null;if(!binding||!options.id||options.id!==binding.commandId||!this.isFrameActive(binding.source))throw new Error('resident_execute_without_current_gate_source');
    if(actionDigest(action)!==binding.intent.action_sha256)throw new Error('resident_approved_action_changed');
    assertResidentActionBounds(action,this.hostReady?.capabilities.max_duration_ms===950);
    const reply=await this.request('execute',{id:options.id,action,source:binding.source,intent:binding.intent},2400);if(reply.type!=='receipt'||reply.native.op!=='execute'||!reply.source||digest(reply.source)!==digest(binding.source)||!reply.intent||digest(reply.intent)!==digest(binding.intent))throw new Error('resident_execute_receipt_source');return reply.native;
  }
  async cancel():Promise<NativeReceipt>{const reply=await this.request('cancel');if(reply.type!=='receipt'||reply.native.op!=='cancel')throw new Error('resident_cancel_release_unconfirmed');return reply.native;}
  async releaseAll():Promise<NativeReceipt>{const reply=await this.request('release_all');if(reply.type!=='receipt'||reply.native.op!=='release_all')throw new Error('resident_release_reply');return reply.native;}
  close():Promise<ResidentCleanup>{if(!this.closeJob)this.closeJob=this.doClose();return this.closeJob;}
  private async doClose():Promise<ResidentCleanup>{
    if(this.state==='ready'){this.state='closing';await this.request('shutdown',{},12000).catch(()=>{});}this.current=null;this.bound=null;clearTimeout(this.startTimer);if(this.heartbeat)clearInterval(this.heartbeat);
    this.child.stdin.end();let exitTimer:ReturnType<typeof setTimeout>|undefined;await Promise.race([this.exitPromise,new Promise<void>(resolve=>{exitTimer=setTimeout(resolve,15000);})]);if(exitTimer)clearTimeout(exitTimer);this.state='closed';
    let taskDeleted=false,absence=false;try{const lifecycle=JSON.parse(await readFile(join(this.runDir,'task-lifecycle.json'),'utf8')) as {cleanup?:{deleted?:boolean;deletion_rechecked?:boolean;error?:unknown}};taskDeleted=lifecycle.cleanup?.deleted===true&&!lifecycle.cleanup.error;absence=lifecycle.cleanup?.deletion_rechecked===true&&!lifecycle.cleanup.error;}catch{}
    const stopped=this.stopped,released=stopped?.release_receipt;
    const nativeConfirmed=Boolean(stopped?.release_confirmed&&this.executorAcquired&&released&&released.session_id===this.hostReady?.session_id&&released.op==='release_all'&&released.status==='ok'&&released.input.released&&stopped.ledger_empty===true&&stopped.native_exited===true);
    return{stopped,task_deleted:taskDeleted,task_absence_verified:absence,launcher_exit_code:this.exitCode,
      release_scope:nativeConfirmed?'native_receipt_and_ledger':stopped?.release_confirmed&&!this.executorAcquired&&stopped.release_receipt===null&&stopped.ledger_empty===null&&stopped.native_exited===null?'no_executor_acquired':'unconfirmed'};
  }
}

export function assertResidentActionBounds(action:NativeAction,reviewedCamera=false):void {
  if(!('duration_ms'in action)||action.duration_ms<1)throw new Error('resident_finite_action_bounds');
  if(action.kind==='timeline') {
    assertNativeTimeline(action);
    if(action.duration_ms>150) {
      if(reviewedCamera&&isReviewedCameraSweep(action))return;
      const [move,down,up]=action.events;
      if(action.duration_ms>300||action.events.length!==3||move?.kind!=='absolute_mouse_move'||move.at_ms!==0||down?.kind!=='button_down'||down.at_ms!==150||up?.kind!=='button_up'||up.button!==down.button||up.at_ms!==action.duration_ms||up.at_ms-down.at_ms<80||up.at_ms-down.at_ms>150)throw new Error('resident_finite_action_bounds');
    }
  } else if(action.duration_ms>150)throw new Error('resident_finite_action_bounds');
}
export function isReviewedCameraSweep(action:NativeAction):boolean {
 if(action.kind!=='timeline'||action.duration_ms!==950||action.events.length!==11)return false;
 const [move,down,...tail]=action.events,up=tail.pop();
 if(move?.kind!=='absolute_mouse_move'||move.at_ms!==0||down?.kind!=='button_down'||down.button!=='right'||down.at_ms!==150||up?.kind!=='button_up'||up.button!=='right'||up.at_ms!==950)return false;
 let total=0,out=0;
 for(let i=0;i<tail.length;i++){const e=tail[i];if(e?.kind!=='relative_mouse_move'||e.at_ms!==250+i*100||e.dy!==0||Math.abs(e.dx)>512||(i<4?e.dx<=0:e.dx>=0))return false;total+=e.dx;if(i<4)out+=e.dx;}
 return total===0&&out>0&&out<=2048;
}
