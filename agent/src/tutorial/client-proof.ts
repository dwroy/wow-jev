import type {GameVersion} from '../game-data/types.js';
import type {ResidentMemorySample,ResidentTarget} from '../resident/protocol.js';
import {canonical} from '../behavior/validation.js';
export interface TutorialClientProof {
  protocol:'wow-tutorial-client-probe';version:1;evidence_scope:'readonly_current_client';
  target:ResidentTarget;client_version:GameVersion;
  metadata:{pid:number;proc:string;exe:string;start_ticks:string;file_version:string;branch:string;region:string;text_locale:string};
  metadata_source:{path:string;sha256:string;scope:'session0_readonly_process_file_metadata';captured_at:string};
  window_source:{target_scope:'retail_wow';frame_id:string;seq:number;windows_clock_id:string;source_qpc_ms:number;client_width:number;client_height:number;dpi:number};
  review:{reviewer:'root';reviewed_at:string;expansion_verified:true};
}
export function knownClientVersion(value:unknown):asserts value is GameVersion {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('tutorial_client_six_dimensions_unknown');
  const v=value as GameVersion;
  if(Object.keys(v).sort().join(',')!=='branch,build,expansion,locale,patch,region'||v.branch!=='retail'||typeof v.expansion!=='string'||!v.expansion||typeof v.patch!=='string'||!/^\d+\.\d+\.\d+$/.test(v.patch)||!Number.isSafeInteger(v.build)||Number(v.build)<1||!['cn','us','eu','kr','tw'].includes(v.region??'')||!['zh_CN','en_US','en_GB','zh_TW','ko_KR'].includes(v.locale??''))throw new Error('tutorial_client_six_dimensions_unknown');
}
/** Explicit root-approved probe SHA is supplied at the entry. No version is
 * inferred from a path, old profile, filename or selected character. */
export function verifyTutorialClientProof(proof:unknown,version:GameVersion,target:ResidentTarget,window?:{client_width:number;client_height:number}):asserts proof is TutorialClientProof {
  knownClientVersion(version);const p=proof as TutorialClientProof;
  if(!p||p.protocol!=='wow-tutorial-client-probe'||p.version!==1||p.evidence_scope!=='readonly_current_client'||canonical(p.target)!==canonical(target)||canonical(p.client_version)!==canonical(version)||p.review?.reviewer!=='root'||p.review.expansion_verified!==true||!Number.isFinite(Date.parse(p.review.reviewed_at)))throw new Error('tutorial_current_client_probe_unapproved_or_wrong_instance');
  const m=p.metadata;const locales:Record<string,string>={zhCN:'zh_CN',enUS:'en_US',enGB:'en_GB',zhTW:'zh_TW',koKR:'ko_KR'};
  const w=p.window_source,source=p.metadata_source;
  if(!m||Object.keys(m).sort().join(',')!=='branch,exe,file_version,pid,proc,region,start_ticks,text_locale')throw new Error('tutorial_client_probe_metadata_allowlist');
  if(!source||source.scope!=='session0_readonly_process_file_metadata'||!/^([a-f0-9]{64})$/.test(source.sha256)||!Number.isFinite(Date.parse(source.captured_at))||!w||w.target_scope!=='retail_wow'||!w.frame_id||!w.windows_clock_id||!Number.isSafeInteger(w.seq)||w.seq<1||!Number.isFinite(w.source_qpc_ms)||w.source_qpc_ms<0||!m||m.pid!==target.pid||m.proc.toLowerCase()!=='wow'||m.exe!==target.executable||m.start_ticks!==target.start_ticks||m.file_version!==`${version.patch}.${version.build}`||m.branch!==version.branch||m.region.toLowerCase()!==version.region||locales[m.text_locale]!==version.locale||!Number.isSafeInteger(w.client_width)||!Number.isSafeInteger(w.client_height)||w.client_width<1||w.client_height<1||window&&(window.client_width!==w.client_width||window.client_height!==w.client_height))throw new Error('tutorial_current_client_probe_version_or_window_mismatch');
}
export function verifyResidentClientProof(proof:unknown,version:GameVersion,sample:ResidentMemorySample):void {
  if((sample.memory_frame as unknown as {target_scope?:string}).target_scope!=='retail_wow')throw new Error('tutorial_current_client_non_wow_scope');
  verifyTutorialClientProof(proof,version,sample.memory_frame.target,sample.window);
  const p=proof as TutorialClientProof,f=sample.memory_frame;
  if(p.window_source.windows_clock_id!==f.windows_clock_id||p.window_source.source_qpc_ms>f.source_qpc_ms||f.source_qpc_ms-p.window_source.source_qpc_ms>300000||p.window_source.dpi!==f.dpi)throw new Error('tutorial_client_probe_window_source_stale_or_unmapped');
}
