import {clockDuration,type TraceRecord} from '../benchmark/trace.js';
function percentiles(values:number[]){if(!values.length)return{samples:0,p50_ms:null,p95_ms:null,min_ms:null,max_ms:null};const a=[...values].sort((x,y)=>x-y),at=(p:number)=>a[Math.min(a.length-1,Math.ceil(a.length*p)-1)]!;return{samples:a.length,p50_ms:at(.5),p95_ms:at(.95),min_ms:a[0]!,max_ms:a.at(-1)!};}
/** Every latency below uses one identical domain/clock ID. Cross-domain envelopes
 * are reported independently and nested stages are never added together. */
export function tutorialLatency(records:TraceRecord[]){
  const observations=new Map<string,Extract<TraceRecord,{kind:'mark'}>>();const input:number[]=[];
  for(const r of records){if(r.kind==='mark'&&r.phase==='observation'&&r.action_id&&r.stamp.domain==='windows-qpc')observations.set(r.action_id,r);if(r.kind==='mark'&&r.phase==='input_issued'&&r.action_id&&Number(r.meta.events_inserted)>0){const source=observations.get(r.action_id);if(source)try{input.push(clockDuration(source.stamp,r.stamp));}catch{}}}
  const groups:Record<string,number[]>={};for(const r of records)if(r.kind==='span'){const key=`${r.start.domain}/${r.stage}/${String(r.meta.scope??r.meta.phase??'envelope')}`;(groups[key]??=[]).push(clockDuration(r.start,r.end));}
  return{windows_observation_to_input_issued:percentiles(input),target_p50_less_than_150_ms:input.length?percentiles(input).p50_ms!<150:null,target_scope:'actual code action windows-qpc, not startup or effect confirmation',stages:Object.fromEntries(Object.entries(groups).map(([key,values])=>[key,percentiles(values)])),nested_stages_not_summed:true};
}
