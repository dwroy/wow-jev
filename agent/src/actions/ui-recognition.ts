import type {Observation,JsonValue} from '../core/protocol.js';

/** Native threshold margins are distances, not model probability scores. */
export function uiStateRecognized(observation:Observation,confidence:JsonValue|undefined):boolean {
  const field=observation.fields['ui.recognition'];
  if(!field)return typeof confidence==='number'&&Number.isFinite(confidence)&&confidence>=.95&&confidence<=1;
  const state=observation.fields['ui.state'],v=field.value;
  if(field.status!=='known'||field.source!=='cv'||field.source_observation_id!==observation.id||!state||field.captured_at_ms!==state.captured_at_ms||!v||typeof v!=='object'||Array.isArray(v))return false;
  const margin=v.match_margin;
  return v.status==='known'&&v.confidence_basis==='match_margin_v1'&&v.modal_status!=='present'&&!!margin&&typeof margin==='object'&&!Array.isArray(margin)&&
    typeof margin.positive_distance==='number'&&Number.isFinite(margin.positive_distance)&&margin.positive_distance>=0&&margin.positive_distance<1&&margin.acceptance_threshold===1&&
    (margin.next_state_distance===null||typeof margin.next_state_distance==='number'&&Number.isFinite(margin.next_state_distance)&&margin.next_state_distance>1);
}
