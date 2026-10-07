import {createHash} from 'node:crypto';
import {copyFile,readFile,writeFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import type {JsonValue,Observation,ObservedField} from '../core/protocol.js';
import type {Collected} from '../eye/runtime.js';
import {MemoryFrameRegistry} from '../eye/memory-frame.js';
import type {ResidentClient} from './client.js';
import type {ResidentMemorySample,ResidentMemoryFrame} from './protocol.js';
import type {UiFrame,UiSkill,UiScope,UiSource,UiState,UiElement,HardStop} from '../ui-skills/types.js';
import type {TargetScopeVerifier} from '../layers/contracts.js';
import {canonical} from '../behavior/validation.js';
import {recognizeTutorialVisual,tutorialQuestTracker} from '../tutorial/recognition.js';
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
    const stopKind=(raw:unknown):HardStop=>typeof raw==='string'&&['credentials','two_factor','terms','update'].includes(raw)?raw as HardStop:'unclassified';
    const skillMatches:NonNullable<UiFrame['skill_matches']>=[];
    if(matched&&matched.knowledge_sha256===this.options.knowledgeSha()) {
      if(matched.started_qpc_ms<m.source_qpc_ms||matched.finished_qpc_ms<matched.started_qpc_ms||matched.finished_qpc_ms>s.local_clock.at_ms)throw new Error('ui_native_match_timing');
      for(const match of matched.matches){
        const skill=skills.find(k=>k.skill_id===match.skill_id);if(!skill||match.signature_id!==skill.signature.signature_id)throw new Error('ui_native_signature_not_current_knowledge');
        const dynamic=nativeNpcSurface(m,match),roi=dynamic?.roi??m.rois.find(r=>r.id==='learned-ui-'+skill.skill_id);if((match as unknown as Record<string,unknown>).location&&!dynamic||!roi||roi.sha256!==match.roi_sha256||roi.calibration_sha256!==matched.knowledge_sha256)throw new Error('ui_native_roi_not_bound');
        const governanceMatch=match as unknown as Record<string,unknown>;
        skillMatches.push({skill_id:skill.skill_id,signature_sha256:skill.signature.sha256,active_qualified:governanceMatch.active_qualified===true,...(typeof governanceMatch.negative_validation_sha256==='string'?{negative_validation_sha256:governanceMatch.negative_validation_sha256}:{})});
        if(matched.status==='known'&&match.state_id===matched.state_id){
          // Same state may expose multiple independently matched elements; route chooses among them.
          if(!state||skill.action?.kind==='key')state={id:match.state_id,confidence:matched.confidence,signature_sha256:skill.signature.sha256,hard_stop:match.hard_stop?stopKind((match as unknown as Record<string,unknown>).hard_stop_kind):null};
          const b=skill.element.bbox;if(!skill.action&&!/(?:npc|talk|dialogue|quest|engage|attack|training)/i.test(skill.element.purpose))elements.push({id:skill.element.id,x:Math.floor((b.x+b.width/2)*m.client_width),y:Math.floor((b.y+b.height/2)*m.client_height),layout_id:m.layout_id,enabled:true,signature_sha256:skill.signature.sha256});
        }
      }
    }
    const selected=s.cv.selected_character;
    if(selected?.verified===true&&selected.name==='小呵'&&selected.class==='warrior'&&selected.faction==='alliance'&&m.rois.some(r=>r.calibration_sha256===selected.calibration_sha256))add('ui.selected_character',{name:'小呵',class:'warrior',faction:'alliance'},'cv');
    const tutorial=s.cv.tutorial_interaction as Record<string,unknown>|undefined;
    // A specific tutorial template is never a general playable-world proof.
    // Unknown or modal recognition stays on the slow path.
    const recognitionRaw=matched as unknown as {recognition_status?:string;route_eligibility?:string;confidence_basis?:string;modal?:{status?:string};match_margin?:{positive_distance:number;acceptance_threshold:number;next_state_distance:number|null}}|undefined;
    const recognition={status:recognitionRaw?.recognition_status==='known'?'known' as const:recognitionRaw?.recognition_status==='hard_stop'?'hard_stop' as const:'unknown' as const,
      route_eligibility:recognitionRaw?.route_eligibility==='candidate'?'candidate' as const:recognitionRaw?.route_eligibility==='hard_stop'?'hard_stop' as const:'slow_path' as const,
      confidence_basis:recognitionRaw?.confidence_basis??'unverified',modal_status:recognitionRaw?.modal?.status==='clear'?'clear' as const:recognitionRaw?.modal?.status==='present'?'present' as const:'unknown' as const,...(recognitionRaw?.match_margin?{match_margin:recognitionRaw.match_margin}:{})};
    add('ui.recognition',recognition,'cv');
    const hardStop=matched?.hard_stop?stopKind((matched as unknown as Record<string,unknown>).hard_stop_kind):state?.hard_stop??null;
    if(hardStop)add('ui.hard_stop',hardStop,'cv');
    if(skillMatches.length)add('ui.skill_matches',skillMatches,'cv');
    if(state)add('ui.state',state as unknown as JsonValue,'cv');
    if(state?.id==='tutorial_look_around')add('input.mouse_mode','world','cv');
    if(state?.id==='tutorial_move_around'){
      add('input.mouse_mode','world','cv');add('player.movement_mode','ground','cv');
      add('input.forward_binding',{keys:['W'],mode:'ground',layout_id:m.layout_id},'cv');
    }
    if(state?.id==='tutorial_talk_jaina'&&matched?.status==='known'){
      const entry=matched.matches.map(match=>skills.find(k=>k.skill_id===match.skill_id)).find(k=>k?.element.purpose==='talk_jaina_layered'&&k.element.label==='吉安娜·普罗德摩尔');
      const match=entry?matched.matches.find(row=>row.skill_id===entry.skill_id):null;
      const surface=nativeNpcSurface(m,match);
      if(entry&&surface){
        const {point,rect,roi}=surface,signature='visible-name:'+surface.name;
        add('tutorial.instruction','与吉安娜·普罗德摩尔交谈','cv');add('target.signature',signature,'cv');
        add('input.mouse_mode','world','cv');
        add('target.screen_interaction',{id:entry.element.id,signature,layout_id:m.layout_id,...point,enabled:true},'cv');
        add('target.world_npc_surface',{id:entry.element.id,signature,layout_id:m.layout_id,rect,point,frame_id:m.frame_id,roi_id:roi.id,roi_sha256:roi.sha256,calibration_sha256:roi.calibration_sha256,visible:true},'cv');
      }
    }
    if(state?.id==='tutorial_attack_training'&&matched?.status==='known'){
      const entry=matched.matches.map(match=>skills.find(k=>k.skill_id===match.skill_id)).find(k=>k?.element.purpose==='engage_training_dummy_layered'&&k.element.label==='作战假人');
      const match=entry?matched.matches.find(row=>row.skill_id===entry.skill_id):null;const surface=nativeNpcSurface(m,match);
      if(entry&&surface&&surface.name==='作战假人'){
        state={id:'tutorial_attack_training',confidence:matched.confidence,signature_sha256:entry.signature.sha256,hard_stop:null};add('ui.state',state as unknown as JsonValue,'cv');
        const {point,rect,roi}=surface,signature='visible-name:作战假人';add('tutorial.instruction','攻击一个作战假人','cv');add('target.entity_kind','training_dummy','cv');add('target.signature',signature,'cv');add('input.mouse_mode','world','cv');
        add('target.screen_interaction',{id:entry.element.id,signature,layout_id:m.layout_id,...point,enabled:true},'cv');add('target.world_npc_surface',{id:entry.element.id,signature,layout_id:m.layout_id,rect,point,frame_id:m.frame_id,roi_id:roi.id,roi_sha256:roi.sha256,calibration_sha256:roi.calibration_sha256,visible:true},'cv');
      }
    }
    if(elements.length){add('ui.elements',elements.map(({signature_sha256:_,...e})=>e),'cv');add('ui.control_signatures',elements.map(e=>({id:e.id,signature_sha256:e.signature_sha256})),'cv');add('input.mouse_mode','ui','cv');}
    if(state?.id==='dialog_jaina_warmup'&&matched?.status==='known'){
      const accept=matched.matches.map(match=>skills.find(k=>k.skill_id===match.skill_id)).find(k=>k?.element.purpose==='quest_accept_jaina_warmup'&&k.element.label==='接受');
      if(accept&&!hardStop){const b=accept.element.bbox;add('dialog.open',true,'cv');add('dialog.target_signature','visible-name:吉安娜·普罗德摩尔','cv');add('target.signature','visible-name:吉安娜·普罗德摩尔','cv');add('input.mouse_mode','ui','cv');add('dialog.elements',[{id:accept.element.id,role:'accept',quest_id:'session-local.exiles-reach.warmup',x:Math.floor((b.x+b.width/2)*m.client_width),y:Math.floor((b.y+b.height/2)*m.client_height),layout_id:m.layout_id,enabled:true}],'cv');
        // All named components must match the current Native signature; labels
        // or a model's scene description alone cannot assert a task panel.
        const anchors=Array.isArray(accept.signature.anchors)?accept.signature.anchors.map((a:unknown)=>a&&typeof a==='object'&&'id' in a?a.id:null):[];
        const match=matched.matches.find(row=>row.skill_id===accept.skill_id);
        if(match&&anchors.includes('npc-portrait')&&anchors.includes('quest-parchment'))add('dialog.npc_quest_panel',{kind:'npc_quest',target_signature:'visible-name:吉安娜·普罗德摩尔',portrait:true,parchment:true,controls:['accept'],signature_sha256:accept.signature.sha256,roi_sha256:match.roi_sha256,layout_id:m.layout_id},'cv');
      }
    }
    if(evidence&&ocr){
      const source=memorySource(s,id),items=evidenceOcr(evidence);
      const dialog=recognizeTutorialVisual(source,undefined,items);
      if(dialog.dialog==='open'&&dialog.target_signature&&dialog.dialog_proof){
        add('dialog.open',true,'local_ocr');add('dialog.target_signature',dialog.target_signature,'local_ocr');add('target.signature',dialog.target_signature,'local_ocr');
        add('dialog.paired_ocr_proof',{...dialog.dialog_proof,capture_sha256:evidence.artifact.sha256,source_frame_id:m.frame_id,source_qpc_ms:m.source_qpc_ms},'local_ocr');
      }
      if(evidence.ocr?.status==='available'){
        add('quest.tracker.entries',tutorialQuestTracker(source,items),'local_ocr');
        add('quest.tracker.source',{capture_sha256:evidence.artifact.sha256,source_frame_id:m.frame_id,source_qpc_ms:m.source_qpc_ms},'local_ocr');
      }
    }
    if(evidence&&ocr&&evidence.ocr?.status==='available'&&Array.isArray(evidence.ocr.items)){
      const target=(evidence.ocr.items as Array<Record<string,unknown>>).find(item=>item.text==='作战假人'&&[item.x,item.y,item.width,item.height].every(n=>typeof n==='number'&&Number.isSafeInteger(n))&&Number(item.x)>=m.client_width*.65&&Number(item.y)>=m.client_height*.60&&Number(item.x)+Number(item.width)<=m.client_width&&Number(item.y)+Number(item.height)<=m.client_height*.78);
      if(target){add('target.selected_signature','visible-name:作战假人','local_ocr');add('target.selection_source',{kind:'current_target_frame_ocr',label:'作战假人',capture_sha256:evidence.artifact.sha256,source_frame_id:m.frame_id,source_qpc_ms:m.source_qpc_ms,box:{x:Number(target.x),y:Number(target.y),width:Number(target.width),height:Number(target.height)}},'local_ocr');}
    }
    const observation:Observation={protocol:'wow-agent',version:1,type:'observation',run_id:this.options.runId,id,at_ms:bracket.received_at_ms,observation_seq:s.seq,window:{token:'resident-ui-'+m.target.pid+'-'+m.channel_generation,hwnd:s.window.hwnd,pid:s.window.pid,client_width:s.window.client_width,client_height:s.window.client_height,focused:s.window.focused},fields,artifacts:[]};
    let capture:UiSource['capture']=null;
    if(evidence){const filename='frame-'+ ++this.serial+'-'+basename(evidence.artifact.windows_path.replaceAll('\\','/')),path=join(this.options.directory,filename);await copyFile(join(client.runDir,basename(evidence.artifact.windows_path.replaceAll('\\','/'))),path).catch(async()=>{const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {stdout}=await promisify(execFile)('/usr/bin/wslpath',['-u',evidence.artifact.windows_path]);await copyFile(stdout.trim(),path);});if(sha(await readFile(path))!==evidence.artifact.sha256)throw new Error('ui_full_png_sha');capture={path,sha256:evidence.artifact.sha256};}
    const collected=this.options.registry.register(bracket,()=>observation);
    this.scopes.set(id,{collected,fingerprint:canonical(observation)});while(this.scopes.size>64)this.scopes.delete(this.scopes.keys().next().value!);
    const {windows_session_id,...target}=m.target;
    const source:UiSource={observation_id:id,frame_id:m.frame_id,seq:m.seq,width:m.client_width,height:m.client_height,layout_id:m.layout_id,target:{...target,session_id:windows_session_id},clock:{domain:'windows-qpc',clock_id:m.windows_clock_id,ticks:m.source_qpc_ms,unit:'ms'},capture,producer:'resident_wgc',roi_sha256:m.roi_sha256};
    const nativeEvidence=evidence?structuredClone(evidence):undefined;if(nativeEvidence)delete (nativeEvidence as unknown as Record<string,unknown>).bracket;
    const frame:UiFrame={collected,source,state,elements,hard_stop:hardStop,scope:this.options.scope,recognition,skill_matches:skillMatches,...(nativeEvidence?{native_evidence:nativeEvidence}:{} )};this.frames.set(collected,frame);
    await writeFile(join(this.options.directory,id+'.json'),JSON.stringify({source,native:s,observation})+'\n',{flag:'wx'});return frame;
  }
}

/** Current native nameplate/body detector only; no reference element point. */
export function nativeNpcSurface(m:ResidentMemoryFrame,raw:unknown):{point:{x:number;y:number};rect:{x:number;y:number;width:number;height:number};name:string;roi:ResidentMemoryFrame['rois'][number]}|null{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const match=raw as Record<string,any>,location=match.location,point=match.current_point,rect=match.current_rect;
  if(!location||!((location.method==='current_nameplate_yellow_outline_v1'&&location.name==='吉安娜·普罗德摩尔')||(location.method==='current_neutral_nameplate_v1'&&location.name==='作战假人'))||location.point_semantics!=='detected_body_interior'||location.frame_id!==m.frame_id||location.source_qpc_ms!==m.source_qpc_ms||location.layout_id!==m.layout_id)return null;
  const roi=m.rois.find(r=>r.id===location.roi_id&&r.id==='learned-ui-npc-current-view');
  if(!roi||location.roi_sha256!==roi.sha256||location.calibration_sha256!==roi.calibration_sha256||!point||!rect||
    !['x','y'].every(k=>Number.isSafeInteger(point[k]))||!['x','y','width','height'].every(k=>Number.isSafeInteger(rect[k]))||
    rect.x<0||rect.y<0||rect.width<1||rect.height<1||rect.x+rect.width>m.client_width||rect.y+rect.height>m.client_height||
    rect.x<roi.x||rect.y<roi.y||rect.x+rect.width>roi.x+roi.width||rect.y+rect.height>roi.y+roi.height||
    point.x<rect.x||point.y<rect.y||point.x>=rect.x+rect.width||point.y>=rect.y+rect.height)return null;
  return{point:{x:point.x,y:point.y},rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},name:location.name,roi};
}
