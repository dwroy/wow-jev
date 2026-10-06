import { assertClock, assertTrace, clockDuration, sameClock, type ClockStamp, type TraceRecord, type TraceSpan } from './trace.js';
export interface ClockCalibration {
  source: { domain: ClockStamp['domain']; id: string }; target: { domain: ClockStamp['domain']; id: string };
  offset_min_ms: number; offset_max_ms: number; valid_from_ms: number; valid_until_ms: number; drift_bound_ms_per_ms: number;
}
export interface ClockRoundTrip { sent: ClockStamp; remote: ClockStamp; received: ClockStamp }
/** Cristian bounds, rather than assuming symmetric transport or a zero offset. */
export function calibrateClock(samples: ClockRoundTrip[], validityMs = 1000, driftBound = 0.001): ClockCalibration {
  if (!samples.length || samples.length > 1000 || !Number.isFinite(validityMs) || validityMs <= 0 || validityMs > 60000 || !Number.isFinite(driftBound) || driftBound < 0 || driftBound > 0.01) throw new Error('latency_calibration_bounds');
  const first = samples[0]!; samples.forEach(s => {
    clockDuration(s.sent, s.received); assertClock(s.remote);
    if (sameClock(s.sent, s.remote) || !sameClock(s.sent, first.sent) || !sameClock(s.remote, first.remote)) throw new Error('latency_calibration_identity');
  });
  const selected = [...samples].sort((a,b) => clockDuration(a.sent,a.received) - clockDuration(b.sent,b.received))[0]!;
  return { source: { domain: selected.remote.domain, id: selected.remote.id }, target: { domain: selected.sent.domain, id: selected.sent.id },
    offset_min_ms: selected.sent.ms - selected.remote.ms, offset_max_ms: selected.received.ms - selected.remote.ms,
    valid_from_ms: selected.remote.ms, valid_until_ms: selected.remote.ms + validityMs, drift_bound_ms_per_ms: driftBound };
}
export type LatencyInterval = { status: 'known' | 'bounded'; lower_ms: number; upper_ms: number } | { status: 'unknown'; reason: string };
export function latencyInterval(start: ClockStamp, end: ClockStamp, calibration?: ClockCalibration): LatencyInterval {
  assertClock(start); assertClock(end);
  if (sameClock(start,end)) { const ms=clockDuration(start,end); return {status:'known',lower_ms:ms,upper_ms:ms}; }
  if (!calibration) return {status:'unknown',reason:'clocks_not_calibrated'};
  const c=calibration;
  if (![c.offset_min_ms,c.offset_max_ms,c.valid_from_ms,c.valid_until_ms,c.drift_bound_ms_per_ms].every(Number.isFinite) ||
    c.offset_min_ms>c.offset_max_ms || c.valid_until_ms<c.valid_from_ms || c.drift_bound_ms_per_ms<0 || c.drift_bound_ms_per_ms>0.01) throw new Error('latency_calibration_invalid');
  const source = start.domain===c.source.domain&&start.id===c.source.id ? start : end.domain===c.source.domain&&end.id===c.source.id ? end : null;
  const target = source===start ? end : start;
  if (!source || target.domain!==c.target.domain || target.id!==c.target.id) return {status:'unknown',reason:'calibration_clock_identity_mismatch'};
  if (source.ms<c.valid_from_ms || source.ms>c.valid_until_ms) return {status:'unknown',reason:'calibration_expired'};
  const drift=(source.ms-c.valid_from_ms)*c.drift_bound_ms_per_ms;
  const lo=source.ms+c.offset_min_ms-drift, hi=source.ms+c.offset_max_ms+drift;
  const lower=source===start ? target.ms-hi : lo-target.ms, upper=source===start ? target.ms-lo : hi-target.ms;
  if (upper<0) return {status:'unknown',reason:'causal_clock_order_invalid'};
  return {status:'bounded',lower_ms:Math.max(0,lower),upper_ms:upper};
}
export function distribution(values: number[]) {
  if(values.some(v=>!Number.isFinite(v)||v<0))throw new Error('latency_distribution_invalid');
  const a=[...values].sort((x,y)=>x-y), pick=(p:number)=>a.length ? a[Math.max(0,Math.ceil(p*a.length)-1)]! : null;
  return {count:a.length,min_ms:a[0]??null,p50_ms:pick(.5),p95_ms:pick(.95),max_ms:a.at(-1)??null,total_ms:a.reduce((x,y)=>x+y,0)};
}
/** Overlapping spans are reported separately, never summed as end-to-end time. */
export function summarizeSpans(records: TraceRecord[]) {
  records.forEach(assertTrace);
  const groups=new Map<string,number[]>();
  for(const r of records)if(r.kind==='span'){
    const key=`${r.timing_kind}/${r.start.domain}/${r.start.id}/${r.stage}/${r.outcome}`;
    const list=groups.get(key)??[];list.push(clockDuration(r.start,r.end));groups.set(key,list);
  }
  return Object.fromEntries([...groups].map(([key,values])=>[key,distribution(values)]));
}
export function nativeInputSpan(traceId:string,actionId:string,clockId:string,firstStart:number,firstEnd:number):TraceSpan {
  const span:TraceSpan={kind:'span',trace_id:traceId,action_id:actionId,stage:'native_input',timing_kind:'measured',outcome:'ok',
    start:{domain:'windows-qpc',id:clockId,ms:firstStart},end:{domain:'windows-qpc',id:clockId,ms:firstEnd},meta:{boundary:'first_successful_SendInput_call',effect_confirmed:false}};
  assertTrace(span);return span;
}
