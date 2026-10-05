import type { JsonValue, ObservedField } from '../../core/protocol.js';
import type { Rect } from './types.js';
const roles=new Set(['talk','accept','turn_in','reward','complete']);
const known=(f:ObservedField|undefined):f is ObservedField&{status:'known';value:JsonValue}=>f?.status==='known';
export interface UnitView { ui_ref:string; entity_guid:null; name:ObservedField|null; health_ratio:ObservedField|null; dead:ObservedField|null; signature:ObservedField|null }
export interface ObjectViews { units:UnitView[]; action_slots:{ui_ref:string;ready:ObservedField|null;rectangle:ObservedField|null}[]; quests:{ui_ref:string;title:ObservedField|null;count:ObservedField|null}[]; bag_slots:{ui_ref:string;rectangle:ObservedField|null;text:ObservedField|null}[]; map_markers:{ui_ref:string;rectangle:ObservedField|null}[] }
/** Views keep each leaf's evidence. UI refs do not become game spell/item/quest IDs or coordinates. */
export function buildObjectViews(fields:Record<string,ObservedField>):ObjectViews {
  const groups=(pattern:RegExp):string[]=>[...new Set(Object.keys(fields).map((key)=>pattern.exec(key)?.[1]).filter((v):v is string=>v!==undefined))];
  return {
    units:['player','target'].map((id)=>({ui_ref:id,entity_guid:null,name:fields[`${id}.name`]??null,health_ratio:fields[`${id}.health_ratio`]??null,dead:fields[`${id}.dead`]??null,signature:fields[`${id}.signature`]??null})),
    action_slots:groups(/^actionbar\.slot\.([^.]+)\./).map((id)=>({ui_ref:`actionbar.slot.${id}`,ready:fields[`actionbar.slot.${id}.ready`]??null,rectangle:fields[`actionbar.slot.${id}.rectangle`]??null})),
    quests:groups(/^quest\.entry\.([^.]+)\./).map((id)=>({ui_ref:`quest.entry.${id}`,title:fields[`quest.entry.${id}.text`]??null,count:fields[`quest.entry.${id}.count`]??null})),
    bag_slots:groups(/^inventory\.slot\.([^.]+)\./).map((id)=>({ui_ref:`inventory.slot.${id}`,rectangle:fields[`inventory.slot.${id}.rectangle`]??null,text:fields[`inventory.slot.${id}.text`]??null})),
    map_markers:groups(/^minimap\.marker\.([^.]+)\./).map((id)=>({ui_ref:`minimap.marker.${id}`,rectangle:fields[`minimap.marker.${id}.rectangle`]??null})),
  };
}
/** A click target needs current CV geometry, role and enabled state, all from the same image. */
export function composeDialogueElements(fields:Record<string,ObservedField>,observationId:string):ObservedField {
  const ids=[...new Set(Object.keys(fields).map((key)=>/^dialog\.choice\.([^.]+)\./.exec(key)?.[1]).filter((v):v is string=>v!==undefined))];
  const layout=fields['ui.layout_id'];const elements:JsonValue[]=[];let source:ObservedField|undefined;
  const unknown=(code:string):ObservedField=>({source:'cv',status:'unknown',value:null,captured_at_ms:layout?.captured_at_ms??0,source_observation_id:observationId,reason:{code}});
  if(!known(layout)||layout.source!=='cv'||layout.source_observation_id!==observationId||typeof layout.value!=='string')return unknown('dialog_layout_unknown');
  for(const id of ids){
    const geometry=fields[`dialog.choice.${id}.rectangle`],role=fields[`dialog.choice.${id}.role`],enabled=fields[`dialog.choice.${id}.enabled`];
    const parts=[geometry,role,enabled];
    if(!parts.every((f)=>known(f)&&f.source==='cv'&&f.source_observation_id===observationId&&f.captured_at_ms===layout.captured_at_ms))return unknown('dialog_element_evidence_incomplete');
    const r=geometry!.value as unknown as Rect;
    if(!r||typeof r!=='object'||!['x','y','width','height'].every((k)=>Number.isSafeInteger(r[k as keyof Rect]))||r.width<1||r.height<1||typeof role!.value!=='string'||!roles.has(role!.value)||typeof enabled!.value!=='boolean')return unknown('dialog_element_type');
    elements.push({id,ui_ref:`dialog.choice.${id}`,role:role!.value,x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2),enabled:enabled!.value,layout_id:layout.value});source=geometry;
  }
  if(!source||!elements.length)return unknown('dialog_elements_not_observed');
  return {...source,source:'cv',status:'known',value:elements,reason:{code:'dialog_cv_elements_composed'}};
}
