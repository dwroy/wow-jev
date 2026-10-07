import {createHash} from 'node:crypto';
import {copyFile,readFile,writeFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import type {JsonValue,Observation,ObservedField} from '../core/protocol.js';
import type {Collected} from '../eye/runtime.js';
import {MemoryFrameRegistry} from '../eye/memory-frame.js';
import type {ResidentClient} from './client.js';
import type {ResidentMemorySample} from './protocol.js';
import type {UiFrame,UiSkill,UiScope,UiSource,UiState,UiElement} from '../ui-skills/types.js';
import type {TargetScopeVerifier} from '../layers/contracts.js';
import {canonical} from '../behavior/validation.js';
import {recognizeTutorialVisual} from '../tutorial/recognition.js';
import {memorySource,evidenceOcr} from '../tutorial/tagged-evidence.js';
const sha=(x:Buffer|string)=>createHash('sha256').update(x).digest('hex');
/** Trusted current-native mapper. JSON from models/DB never creates a current CV field. */
export class UiResidentCollector {
  private frames=new WeakMap<Collected,UiFrame>();
  private serial=0;
  private scopes=new Map<string,{collected:Collected<ResidentMemorySample>;fingerprint:string}>();
  constructor(readonly options:{client:ResidentClient;registry:MemoryFrameRegistry;runId:string;scope:UiScope;directory:string;now:()=>number;skills:()=>UiSkill[];knowledgeSha:()=>string}){}
  owns(frame:UiFrame):boolean{return this.frames.get(frame.collected)===frame&&this.options.registry.owns(frame.collected);}
  readonly targetScopeVerifier:TargetScopeVerifier=observation=>{
    const saved=this.scopes.get(observation.id);if(!saved||canonical(observation)!==saved.fingerprint||!this.options.registry.owns(saved.collected)||!observation.window)return null;
    const native=saved.collected.bracket.sample.memory_frame;if(native.target_scope!=='retail_wow')return null;
    return{scope:'retail_wow',source_observation_id:observation.id,window:{token:observation.window.token,hwnd:observation.window.hwnd,pid:observation.window.pid},native_target_id:sha(canonical([native.target,native.channel_generation]))};
  };
  async collect(kind:'hot'|'evidence'|'effect',ocr=false):Promise<UiFrame>{
    const client=this.options.client;
    const evidence=kind==='hot'?null:await client.evidence({ocr});
    const bracket=evidence?.bracket??await client.sample();const s=bracket.sample,m=s.memory_frame;
    if(!client.validateBracket(s,bracket))throw new Error('ui_original_native_bracket_required');
    const id=`ui-${s.session_id}-${s.seq}`,fields:Record<string,ObservedField>={};
    const add=(name:string,value:JsonValue,source:ObservedField['source'],qpc=m.source_qpc_ms)=>{fields[name]={status:'known',value,source,captured_at_ms:bracket.started_at_ms,source_observation_id:id,capture_window:{earliest_ms:bracket.started_at_ms,latest_ms:bracket.received_at_ms},source_clock:{domain:'windows-qpc',value_ms:qpc}};};
    add('capture.available',true,'cv');add('window.focused',s.window.focused,'window');add('window.scope',m.target_scope,'window');add('ui.layout_id',m.layout_id,'cv');
    if(s.input_state.status==='known'){add('input.cursor_free',s.input_state.cursor_free===true,'window',s.input_state.sampled_qpc_ms);add('input.mouse_buttons_held',s.input_state.mouse_buttons_held===true,'window',s.input_state.sampled_qpc_ms);}
    let state:UiState|null=null;const elements:UiElement[]=[];const matched=s.ui_skills,skills=this.options.skills();
    const skillMatches:Array<{skill_id:string;signature_sha256:string}>=[];
    if(matched&&matched.knowledge_sha256===this.options.knowledgeSha()) {
      if(matched.started_qpc_ms<m.source_qpc_ms||matched.finished_qpc_ms<matched.started_qpc_ms||matched.finished_qpc_ms>s.local_clock.at_ms)throw new Error('ui_native_match_timing');
      for(const match of matched.matches){
        const skill=skills.find(k=>k.skill_id===match.skill_id);if(!skill||match.signature_id!==skill.signature.signature_id)throw new Error('ui_native_signature_not_current_knowledge');
        const roi=m.rois.find(r=>r.id==='learned-ui-'+skill.skill_id);if(!roi||roi.sha256!==match.roi_sha256||roi.calibration_sha256!==matched.knowledge_sha256)throw new Error('ui_native_roi_not_bound');
        skillMatches.push({skill_id:skill.skill_id,signature_sha256:skill.signature.sha256});
        if(matched.status==='known'&&match.state_id===matched.state_id){
          // Same state may expose multiple independently matched elements; route chooses among them.
          if(!state||skill.action?.kind==='key')state={id:match.state_id,confidence:matched.confidence,signature_sha256:skill.signature.sha256,hard_stop:match.hard_stop?'credentials':null};
          const b=skill.element.bbox;if(!skill.action&&!/(?:npc|talk|dialogue|quest)/i.test(skill.element.purpose))elements.push({id:skill.element.id,x:Math.floor((b.x+b.width/2)*m.client_width),y:Math.floor((b.y+b.height/2)*m.client_height),layout_id:m.layout_id,enabled:true,signature_sha256:skill.signature.sha256});
        }
      }
    }
    const selected=s.cv.selected_character;
    if(selected?.verified===true&&selected.name==='小呵'&&selected.class==='warrior'&&selected.faction==='alliance'&&m.rois.some(r=>r.calibration_sha256===selected.calibration_sha256))add('ui.selected_character',{name:'小呵',class:'warrior',faction:'alliance'},'cv');
    const tutorial=s.cv.tutorial_interaction as Record<string,unknown>|undefined;
    // A tutorial background may remain visible behind a modal. Preserve native
    // ambiguity instead of upgrading its conflicting learned matches to world.
    const learnedAmbiguous=matched?.status==='unknown'&&matched.matches.length>0;
    if(!state&&!learnedAmbiguous&&tutorial?.verified===true&&m.rois.some(r=>r.calibration_sha256===tutorial.calibration_sha256))state={id:'in_world',confidence:.95,signature_sha256:String(tutorial.calibration_sha256),hard_stop:null};
    if(matched?.hard_stop===true)add('ui.hard_stop','credentials','cv'); // Conservative unclassified stop; never authorizes input.
    if(skillMatches.length)add('ui.skill_matches',skillMatches,'cv');
    if(state)add('ui.state',state as unknown as JsonValue,'cv');
    if(state?.id==='tutorial_look_around')add('input.mouse_mode','world','cv');
    if(state?.id==='tutorial_move_around'){
      add('input.mouse_mode','world','cv');add('player.movement_mode','ground','cv');
      add('input.forward_binding',{keys:['W'],mode:'ground',layout_id:m.layout_id},'cv');
    }
    if(state?.id==='tutorial_talk_jaina'&&matched?.status==='known'){
      const entry=matched.matches.map(match=>skills.find(k=>k.skill_id===match.skill_id)).find(k=>k?.element.purpose==='talk_jaina_layered'&&k.element.label==='吉安娜·普罗德摩尔');
      const roi=entry?m.rois.find(r=>r.id==='learned-ui-'+entry.skill_id):null;
      if(entry&&roi){
        const b=entry.element.bbox,point={x:Math.floor((b.x+b.width/2)*m.client_width),y:Math.floor((b.y+b.height/2)*m.client_height)},signature='visible-name:'+entry.element.label;
        if(point.x<roi.x||point.y<roi.y||point.x>=roi.x+roi.width||point.y>=roi.y+roi.height)throw new Error('ui_npc_point_outside_current_body_roi');
        add('tutorial.instruction','与吉安娜·普罗德摩尔交谈','cv');add('target.signature',signature,'cv');
        add('input.mouse_mode','world','cv');
        add('target.screen_interaction',{id:entry.element.id,signature,layout_id:m.layout_id,...point,enabled:true},'cv');
        add('target.world_npc_surface',{id:entry.element.id,signature,layout_id:m.layout_id,rect:{x:roi.x,y:roi.y,width:roi.width,height:roi.height},point,frame_id:m.frame_id,roi_id:roi.id,roi_sha256:roi.sha256,calibration_sha256:roi.calibration_sha256,visible:true},'cv');
      }
    }
    if(elements.length){add('ui.elements',elements.map(({signature_sha256:_,...e})=>e),'cv');add('ui.control_signatures',elements.map(e=>({id:e.id,signature_sha256:e.signature_sha256})),'cv');add('input.mouse_mode','ui','cv');}
    if(evidence&&ocr){
      const dialog=recognizeTutorialVisual(memorySource(s,id),undefined,evidenceOcr(evidence));
      if(dialog.dialog==='open'&&dialog.target_signature&&dialog.dialog_proof){
        add('dialog.open',true,'local_ocr');add('dialog.target_signature',dialog.target_signature,'local_ocr');add('target.signature',dialog.target_signature,'local_ocr');
        add('dialog.paired_ocr_proof',{...dialog.dialog_proof,capture_sha256:evidence.artifact.sha256,source_frame_id:m.frame_id,source_qpc_ms:m.source_qpc_ms},'local_ocr');
      }
    }
    const observation:Observation={protocol:'wow-agent',version:1,type:'observation',run_id:this.options.runId,id,at_ms:this.options.now(),observation_seq:s.seq,window:{token:'resident-ui-'+m.target.pid+'-'+m.channel_generation,hwnd:s.window.hwnd,pid:s.window.pid,client_width:s.window.client_width,client_height:s.window.client_height,focused:s.window.focused},fields,artifacts:[]};
    let capture:UiSource['capture']=null;
    if(evidence){const filename='frame-'+ ++this.serial+'-'+basename(evidence.artifact.windows_path.replaceAll('\\','/')),path=join(this.options.directory,filename);await copyFile(join(client.runDir,basename(evidence.artifact.windows_path.replaceAll('\\','/'))),path).catch(async()=>{const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {stdout}=await promisify(execFile)('/usr/bin/wslpath',['-u',evidence.artifact.windows_path]);await copyFile(stdout.trim(),path);});if(sha(await readFile(path))!==evidence.artifact.sha256)throw new Error('ui_full_png_sha');capture={path,sha256:evidence.artifact.sha256};}
    const collected=this.options.registry.register(bracket,()=>observation);
    this.scopes.set(id,{collected,fingerprint:canonical(observation)});while(this.scopes.size>64)this.scopes.delete(this.scopes.keys().next().value!);
    const {windows_session_id,...target}=m.target;
    const source:UiSource={observation_id:id,frame_id:m.frame_id,seq:m.seq,width:m.client_width,height:m.client_height,layout_id:m.layout_id,target:{...target,session_id:windows_session_id},clock:{domain:'windows-qpc',clock_id:m.windows_clock_id,ticks:m.source_qpc_ms,unit:'ms'},capture,producer:'resident_wgc',roi_sha256:m.roi_sha256};
    const frame:UiFrame={collected,source,state,elements,hard_stop:matched?.hard_stop?'credentials':state?.hard_stop??null,scope:this.options.scope};this.frames.set(collected,frame);
    await writeFile(join(this.options.directory,id+'.json'),JSON.stringify({source,native:s,observation})+'\n',{flag:'wx'});return frame;
  }
}
