import type {UiFrame} from './types.js';
import type {UiRuntimeContext} from './run-provenance.js';
import type {LocalQuery} from '../tutorial/types.js';
import {canonical} from '../behavior/validation.js';
export function freshTutorialObservation(run_id:string,frame:UiFrame,context:UiRuntimeContext):{data:Record<string,unknown>;query:LocalQuery}{
  const o=frame.collected.observation,fields=o.fields,surface=fields['target.world_npc_surface'],instruction=fields['tutorial.instruction'];
  const evidence=frame.native_evidence,native=evidence?.sample.memory_frame;
  const target=native?{...native.target,session_id:native.target.windows_session_id}:null;if(target)delete (target as Partial<typeof target>).windows_session_id;
  if(!frame.native_evidence||!frame.source.capture||frame.source.clock.domain!=='windows-qpc'||frame.source.observation_id!==o.id||
    !native||native.frame_id!==frame.source.frame_id||native.seq!==frame.source.seq||native.layout_id!==frame.source.layout_id||native.source_qpc_ms!==frame.source.clock.ticks||native.windows_clock_id!==frame.source.clock.clock_id||canonical(target)!==canonical(frame.source.target)||evidence!.artifact.source_frame_id!==native.frame_id||evidence!.artifact.source_qpc_ms!==native.source_qpc_ms||evidence!.artifact.sha256!==frame.source.capture.sha256||
    surface?.status!=='known'||surface.source!=='cv'||surface.source_observation_id!==o.id||surface.captured_at_ms!==frame.collected.bracket.started_at_ms||
    instruction?.status!=='known'||instruction.value!=='与吉安娜·普罗德摩尔交谈'||instruction.source!=='cv'||instruction.source_observation_id!==o.id||instruction.captured_at_ms!==frame.collected.bracket.started_at_ms||o.at_ms!==frame.collected.bracket.received_at_ms)throw new Error('tutorial_fresh_current_native_instruction_and_surface_required');
  const query:LocalQuery={world_pack_sha256:context.world_pack_sha256,client_version:structuredClone(context.client_version),actor_id:context.actor_id,session:structuredClone(frame.source.target) as LocalQuery['session'],local_key:'exiles-reach.talk-jaina',predicate:'interaction_instruction',as_of_clock:structuredClone(frame.source.clock),maximum_age:600000};
  return{data:{run_id,frame:structuredClone(frame.source),native_evidence:structuredClone(frame.native_evidence),observation:structuredClone(o)},query};
}
