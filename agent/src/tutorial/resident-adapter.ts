import {createHash} from 'node:crypto';
import type {ActionIntent,JsonValue,Observation,ObservedField} from '../core/protocol.js';
import type {Collected} from '../eye/runtime.js';
import type {SampleBracket} from '../eye/protocol.js';
import {MemoryFrameRegistry} from '../eye/memory-frame.js';
import type {ExecutionContext} from '../layers/contracts.js';
import type {ResidentClient} from '../resident/client.js';
import type {ResidentEvidence,ResidentMemorySample,ResidentReceipt} from '../resident/protocol.js';
import type {TraceRecorder} from '../benchmark/trace.js';
import {recognizeResidentTutorial} from './recognition.js';
import {FIRST_TUTORIAL_INSTRUCTION} from './plan.js';
import type {LocalClock} from './types.js';
type EvidenceWithBracket=ResidentEvidence&{bracket:SampleBracket<ResidentMemorySample>};
export interface ResidentCollectorOptions {
  client:ResidentClient;registry:MemoryFrameRegistry;runId:string;now:()=>number;calibrationSha256:string;
  absenceCalibrationSha256?:string;trace?:TraceRecorder;
  append:(kind:string,data:unknown)=>Promise<void>;
  saveEvidence:(evidence:EvidenceWithBracket,observationId:string)=>Promise<{path:string;sha256:string}>;
}
function rect(value:unknown):value is{x:number;y:number;width:number;height:number}{if(!value||typeof value!=='object'||Array.isArray(value))return false;const r=value as Record<string,unknown>;return['x','y','width','height'].every(k=>Number.isSafeInteger(r[k]))&&Number(r.x)>=0&&Number(r.y)>=0&&Number(r.width)>0&&Number(r.height)>0;}
/** Trusted mapper: all current CV/window fields originate in the intact native DTO.
 * Full PNG and ROI witnesses are separate. Nothing writes into a registered frame. */
export class ResidentTutorialCollector {
  private latestClock:LocalClock|null=null;
  private pendingEvidence:{collected:Collected<ResidentMemorySample>;evidence:EvidenceWithBracket;image:{path:string;sha256:string}}|null=null;
  private logFailure:unknown=null;
  private sources=new Map<string,ResidentMemorySample>();
  constructor(readonly options:ResidentCollectorOptions){
    options.client.on('resident_receipt',(receipt:ResidentReceipt)=>{
      if(receipt.native.op!=='execute'||!receipt.source)return;
      const source=this.sources.get(receipt.intent?.observation_id??'');
      if(source&&options.trace&&receipt.dispatch_qpc_ms>=source.processing_timing.cv_finished_ms)options.trace.record({kind:'span',trace_id:options.trace.traceId,action_id:receipt.native.id,timing_kind:'measured',stage:'input_transport',start:{domain:'windows-qpc',id:receipt.source.windows_clock_id,ms:source.processing_timing.cv_finished_ms},end:{domain:'windows-qpc',id:receipt.source.windows_clock_id,ms:receipt.dispatch_qpc_ms},outcome:'ok',meta:{includes:'native JSON export,WSL route and gates,return transport',source_frame_id:receipt.source.frame_id}});
      void options.append('resident_receipt_original',receipt).catch(error=>{this.logFailure=error;});
    });
  }
  sourceClock():LocalClock{if(!this.latestClock)throw new Error('tutorial_native_clock_unobserved');return structuredClone(this.latestClock);}
  windowToken(sample:ResidentMemorySample):string{return`wow-${sample.window.pid}-${sample.window.start_ticks}-${sample.memory_frame.channel_generation}`;}
  observationId(sample:ResidentMemorySample):string{return`resident-${sample.session_id}-${sample.seq}`;}
  private observation(bracket:SampleBracket<ResidentMemorySample>,evidence?:ResidentEvidence):Observation{
    const sample=bracket.sample,id=this.observationId(sample),f=sample.memory_frame;
    if(!this.options.client.validateBracket(sample,bracket))throw new Error('tutorial_native_bracket_not_original');
    const visual=recognizeResidentTutorial(sample,id,this.options.calibrationSha256,evidence);
    const fields:Record<string,ObservedField>={};
    const add=(name:string,value:JsonValue,source:ObservedField['source'],qpc=f.source_qpc_ms)=>{fields[name]={status:'known',value,source,captured_at_ms:bracket.started_at_ms,source_observation_id:id,capture_window:{earliest_ms:bracket.started_at_ms,latest_ms:bracket.received_at_ms},source_clock:{domain:'windows-qpc',value_ms:qpc}};};
    const unknown=(name:string,source:ObservedField['source'],reason:string)=>{fields[name]={status:'unknown',value:null,source,captured_at_ms:bracket.started_at_ms,source_observation_id:id,reason:{code:reason},capture_window:{earliest_ms:bracket.started_at_ms,latest_ms:bracket.received_at_ms}};};
    add('capture.available',true,'cv');add('window.focused',sample.window.focused,'window');add('ui.layout_id',f.layout_id,'cv');
    if(visual.instruction_present&&visual.target_signature&&visual.screen_point){add('tutorial.instruction',FIRST_TUTORIAL_INSTRUCTION,'cv');add('target.signature',visual.target_signature,'cv');add('target.screen_interaction',{id:'tutorial-visible-npc',signature:visual.target_signature,layout_id:f.layout_id,x:visual.screen_point.x,y:visual.screen_point.y,enabled:true},'cv');}
    else{unknown('tutorial.instruction','cv','current_tutorial_regions_unknown');unknown('target.signature','cv','current_target_region_unknown');unknown('target.screen_interaction','cv','current_target_point_unknown');}
    const input=sample.input_state;
    if(input.status==='known'&&typeof input.cursor_free==='boolean'&&typeof input.mouse_buttons_held==='boolean'&&input.sampled_qpc_ms>=f.source_qpc_ms&&input.sampled_qpc_ms<=sample.local_clock.at_ms){add('input.cursor_free',input.cursor_free,'window',input.sampled_qpc_ms);add('input.mouse_buttons_held',input.mouse_buttons_held,'window',input.sampled_qpc_ms);}else{unknown('input.cursor_free','window','native_cursor_state_unknown');unknown('input.mouse_buttons_held','window','native_buttons_state_unknown');}
    const absence=sample.cv.dialog_absence;
    if(absence?.status==='known'&&absence.dialog_open===false&&absence.coverage_complete===true&&absence.calibration_sha256===this.options.absenceCalibrationSha256&&Array.isArray(absence.regions)&&absence.regions.length===1){
      const region=absence.regions[0] as Record<string,unknown>;
      const coverage=region.live_rect;
      if(region.id!=='dialog_absence'||region.matched!==true||!rect(coverage)||coverage.x!==0||coverage.y!==0||coverage.width<Math.ceil(f.client_width*.45)||coverage.height<Math.ceil(f.client_height*.9)||!f.rois.some(r=>r.id==='dialog-absence-dialog_absence'&&r.calibration_sha256===this.options.absenceCalibrationSha256&&r.x===coverage.x&&r.y===coverage.y&&r.width===coverage.width&&r.height===coverage.height))throw new Error('tutorial_absence_full_coverage_not_native_bound');
      add('dialog.open',false,'cv');add('dialog.absence_coverage_complete',true,'cv');
    }else{unknown('dialog.open','cv','no_current_independent_dialog_absence_proof');unknown('dialog.absence_coverage_complete','cv','dialog_coverage_unknown');}
    if(visual.dialog==='open'&&visual.target_signature&&visual.dialog_proof&&evidence){add('dialog.open',true,'local_ocr');add('dialog.target_signature',visual.target_signature,'local_ocr');add('target.signature',visual.target_signature,'local_ocr');add('dialog.paired_ocr_proof',{...visual.dialog_proof,capture_sha256:evidence.artifact.sha256,source_frame_id:f.frame_id,source_qpc_ms:f.source_qpc_ms},'local_ocr');}
    return{protocol:'wow-agent',version:1,type:'observation',id,run_id:this.options.runId,at_ms:this.options.now(),observation_seq:sample.seq,window:{token:this.windowToken(sample),hwnd:sample.window.hwnd,pid:sample.window.pid,client_width:f.client_width,client_height:f.client_height,focused:sample.window.focused},fields,artifacts:[]};
  }
  private register(bracket:SampleBracket<ResidentMemorySample>,evidence?:ResidentEvidence):Collected<ResidentMemorySample>{
    if(this.logFailure)throw new Error('tutorial_original_receipt_log_failed');
    const c=this.options.registry.register(bracket,b=>this.observation(b,evidence));const sample=bracket.sample;
    this.latestClock={domain:'windows-qpc',clock_id:sample.memory_frame.windows_clock_id,ticks:sample.local_clock.at_ms,unit:'ms'};this.sources.set(c.observation.id,sample);while(this.sources.size>64)this.sources.delete(this.sources.keys().next().value!);
    const t=sample.processing_timing,clockId=sample.memory_frame.windows_clock_id;
    if(this.options.trace)for(const [stage,start,end] of [['capture',t.request_ms,t.frame_arrived_ms],['cv',t.roi_started_ms,t.roi_finished_ms],['cv',t.cv_started_ms,t.cv_finished_ms]] as const)this.options.trace.record({kind:'span',trace_id:this.options.trace.traceId,action_id:null,timing_kind:'measured',stage,start:{domain:'windows-qpc',id:clockId,ms:start},end:{domain:'windows-qpc',id:clockId,ms:end},outcome:'ok',meta:{source_frame_id:sample.memory_frame.frame_id,hot_path:evidence===undefined,scope:stage==='capture'?'fresh WGC frame wait':start===t.roi_started_ms?'ROI readback and hashing':'calibrated ROI CV'}});
    return c;
  }
  async collect(_saveIgnored=false):Promise<Collected<ResidentMemorySample>>{const bracket=await this.options.client.sample(false),c=this.register(bracket);await this.options.append('observation',c.observation);return c;}
  async evidence(ocr=false):Promise<{collected:Collected<ResidentMemorySample>;evidence:EvidenceWithBracket;image:{path:string;sha256:string}}>{
    const e=await this.options.client.evidence({ocr}),id=this.observationId(e.sample);const image=await this.options.saveEvidence(e,id);
    if(image.sha256!==e.artifact.sha256)throw new Error('tutorial_saved_full_image_hash');
    const c=this.register(e.bracket,e);this.pendingEvidence={collected:c,evidence:e,image};await this.options.append('evidence_observation',{observation:c.observation,full_image:image,source:e});return this.pendingEvidence;
  }
  async collectEffect():Promise<Collected<ResidentMemorySample>>{return(await this.evidence(true)).collected;}
  lastEvidence(){return this.pendingEvidence;}
  async bindSource(before:Collected,intent:ActionIntent,context:ExecutionContext):Promise<void>{
    if(!this.options.registry.owns(before)||before.bracket.sample.protocol!=='wow-resident')throw new Error('tutorial_dispatch_source_not_registered');
    const source=before.bracket.sample.memory_frame;
    this.options.trace?.mark('observation',intent.id,{source_observation_id:before.observation.id,source_frame_id:source.frame_id,roi_sha256:source.roi_sha256,scope:'source of this approved input'}, {domain:'windows-qpc',id:source.windows_clock_id,ms:source.source_qpc_ms});
    await this.options.client.bindSource(before,intent,context);
  }
}
