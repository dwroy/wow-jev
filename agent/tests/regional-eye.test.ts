import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertRegionBatch, freezeRegionProfile, loadRegionProfile, parseRegionProfile } from '../src/eye/regions/profile.js';
import { RegionState } from '../src/eye/regions/state.js';
import { RegionalSeedRouter } from '../src/eye/regions/seed.js';
import { VisualTracks } from '../src/eye/regions/tracks.js';
import { adoptOcr, assertOcrResult, LocalOcrClient } from '../src/eye/regions/ocr.js';
import { loadEyeValidator, assertEye } from '../src/eye/protocol.js';
import type { OcrRequest, OcrResult, RegionalBatch } from '../src/eye/regions/types.js';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const build=spawnSync('bash',['tools/region_fixture_build.sh'],{cwd:repo,encoding:'utf8'});
if(build.status!==0)throw new Error(`native_region_build:${build.stderr}${build.stdout}`);
const folder=join(repo,'out/regional-native/node-fixture');
const windows=spawnSync('wslpath',['-w',folder],{encoding:'utf8'}).stdout.trim();
const run=spawnSync(join(repo,'out/regional-native/RegionVisionFixture.exe'),[windows],{cwd:repo,encoding:'utf8'});
if(run.status!==0)throw new Error(`native_region_fixture:${run.stderr}${run.stdout}`);
const result=JSON.parse(run.stdout) as Record<string,RegionalBatch>;
const first=result.first!, cached=result.cached!;
const bracket=(at:number)=>({started_at_ms:at,received_at_ms:at+10});
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

test('real Windows raw Bitmap: same frame, fill, cache time, anchor/occlusion/version/DPI invalidation',()=>{
  for(const name of ['first','cached','dpi_mismatch','restored','hidden','occluded','build_mismatch'])assertRegionBatch(result[name]);
  assert.equal(first.regions[0]!.elements[0]!.value,0.5);
  assert.equal(cached.regions[0]!.cached,true);assert.equal(cached.regions[0]!.elements[0]!.parsed_at_qpc_ms,100);
  assert.equal(cached.regions[0]!.pixels_verified_qpc_ms,200);
  assert.equal(result.hidden!.regions[0]!.presence,'unknown');assert.equal(result.occluded!.regions[0]!.presence,'occluded');
  assert.equal(result.build_mismatch!.status,'unknown');assert.equal(result.dpi_mismatch!.status,'unknown');assert.equal(result.restored!.regions[0]!.cached,false);
  assert.equal(first.regions.find((r)=>r.id==='player')!.presence,'unknown');
  assertRegionBatch(result.critical_second);assert.equal(result.critical_second!.regions[0]!.cached,false);assert.equal(result.critical_second!.regions[0]!.elements[0]!.parsed_at_qpc_ms,900);
  assertRegionBatch(result.labeled);assert.equal(result.labeled!.regions[0]!.elements[0]!.value,'ground');
});
test('cache preserves parse source while new pixel verification uses a separate timestamp',()=>{
  const state=new RegionState(), one=state.apply(first,bracket(1000),'observation-1'), two=state.apply(cached,bracket(1100),'observation-2');
  assert.equal(one.fields['target.health_ratio']!.status,'known');
  assert.equal(two.fields['target.health_ratio']!.captured_at_ms,1000);assert.equal(two.fields['target.health_ratio']!.source_observation_id,'observation-1');
  assert.equal(two.fields['target.health_ratio']!.region_evidence!.pixels_verified_at_ms,1100);
  const stale=structuredClone(cached);stale.frame_id='late-frame';stale.captured_at_qpc_ms=900;for(const r of stale.regions)r.pixels_verified_qpc_ms=900;
  assert.equal(state.apply(stale,bracket(1900),'observation-3').fields['target.health_ratio']!.status,'unknown');
});
test('orphan cache and changed cached atoms cannot invent current observations',()=>{
  assert.throws(()=>new RegionState().apply(cached,bracket(1000),'observation-2'),/matching_source/);
  const state=new RegionState();state.apply(first,bracket(1000),'observation-1');const forged=structuredClone(cached);forged.regions[0]!.elements[0]!.value=0.9;
  assert.throws(()=>state.apply(forged,bracket(1100),'observation-2'),/matching_source/);
  const malformed=structuredClone(first);malformed.regions[0]!.elements[0]!.parsed_at_qpc_ms=900;
  assert.throws(()=>assertRegionBatch(malformed),/clock/);
});
test('scoped profile freezes PNG resources and rejects undeclared or unbounded definitions',async()=>{
  const profile=await loadRegionProfile(join(folder,'profile.json'));
  assert.equal(profile.scope.build,69933);
  const bad=structuredClone(profile);bad.regions[0]!.anchor!.search.width=128;assert.throws(()=>parseRegionProfile(bad),/bounds/);
  const root=await mkdtemp(join(tmpdir(),'region-freeze-'));try{
    const frozen=await freezeRegionProfile(join(folder,'profile.json'),join(root,'frozen'),join(folder,'context.json'));
    assert.equal(frozen.id,profile.id);assert.equal(Object.keys(frozen.files).length,3);
    assert.equal(hash(await readFile(join(root,'frozen/anchor.png'))),frozen.files['anchor.png']);
  }finally{await rm(root,{recursive:true});}
});
test('native eye schema accepts bounded same-frame regions and rejects an unrelated capture time',async()=>{
  const validator=await loadEyeValidator(join(repo,'protocol/native-eye-v1.schema.json'));
  const image=await readFile(join(folder,'mother.png'));const message={protocol:'wow-eye',version:1,type:'offline_result',image:{width:128,height:96,sha256:hash(image)},frame_status:'ok',metrics:{mean_luma:20,variance_luma:30,frame_delta:null},detectors:{inventory_open:{status:'unavailable',value:null,confidence:0,calibration_id:null}},local_clock:{domain:'windows-qpc',at_ms:1000},regions:first};
  assertEye(message,validator);
  const bad=structuredClone(message);bad.regions.captured_at_qpc_ms=2000;for(const row of bad.regions.regions) { row.pixels_verified_qpc_ms=2000; for(const atom of row.elements)atom.parsed_at_qpc_ms=2000; }
  assert.throws(()=>assertEye(bad,validator),/future_capture/);
});
test('local OCR resident worker explicitly reports unsupported when no manifest is configured',async()=>{
  const image=await readFile(join(folder,'mother.png')), row=first.regions[0]!;
  const request:OcrRequest={version:1,kind:'local-ocr-request',id:'ocr-1',frame_id:first.frame_id,source_observation_id:'observation-1',captured_at_ms:1000,image_path:join(folder,'mother.png'),image_sha256:hash(image),width:128,height:96,model_id:'unconfigured',regions:[{id:row.id,roi:row.roi!,content_sha256:row.content_sha256!}]};
  const client=new LocalOcrClient({python:'/usr/bin/python3',script:join(repo,'perception/ocr_worker.py'),projectRoot:repo,imageRoot:folder});
  try{const reply=await client.recognize(request);assert.equal(reply.status,'unsupported');assert.equal(reply.reason,'ocr_model_unconfigured');assert.equal(reply.regions.length,0);}finally{client.close();}
});
test('OCR source/box bounds, stale results and field authority are enforced',()=>{
  const row=first.regions[0]!,request:OcrRequest={version:1,kind:'local-ocr-request',id:'ocr-2',frame_id:first.frame_id,source_observation_id:'observation-1',captured_at_ms:1000,image_path:'/tmp/image.png',image_sha256:'1'.repeat(64),width:128,height:96,model_id:'fixture-model',regions:[{id:row.id,roi:row.roi!,content_sha256:row.content_sha256!}]};
  const reply:OcrResult={version:1,kind:'local-ocr-result',id:request.id,frame_id:request.frame_id,image_sha256:request.image_sha256,model_id:request.model_id,engine_version:'3.9.1',status:'ok',reason:'fixture',regions:[{...request.regions[0]!,status:'known',lines:[{text:'森德拉克斯',confidence:0.9,box:[[0,0],[20,0],[20,4],[0,4]]}]}]};
  const state=new RegionState(),original=state.apply(first,bracket(1000),'observation-1'),current=state.apply(cached,bracket(1100),'observation-2');
  const adoption=adoptOcr(reply,request,original,current,{target:'target.name'},1200);assert.equal(adoption.fields['target.name']!.source,'local_ocr');assert.equal(adoption.fields['target.name']!.captured_at_ms,1000);
  assert.equal(adoptOcr(reply,request,original,current,{target:'target.dead'},1200).rejected.length,1);
  assert.equal(adoptOcr(reply,request,original,current,{target:'target.name'},5000).rejected.length,1);
  const forged=structuredClone(reply);forged.regions[0]!.lines[0]!.box[0]![0]=21;assert.throws(()=>assertOcrResult(forged,request),/bounds/);
  const wrong=structuredClone(reply);wrong.frame_id='other';assert.throws(()=>assertOcrResult(wrong,request),/source_mismatch/);
});
test('regional Seed planner uses visible approved crops, source age and independent budgets',async()=>{
  const profile=await loadRegionProfile(join(folder,'profile.json')),state=new RegionState(),observation=state.apply(first,bracket(1000),'observation-1');
  const source={frame_id:first.frame_id,observation_id:'observation-1',captured_at_ms:1000,png_path:'/tmp/mother.png',png_sha256:'2'.repeat(64),width:128,height:96};
  const router=new RegionalSeedRouter(),ambiguity=[{region_id:'target',fields:['target.health_ratio'],reason:'uncertain'}],prompt={version:'regional-v1',sha256:'3'.repeat(64)};
  const plan=router.plan(profile,observation,source,ambiguity,1100,prompt);assert.equal(plan.length,1);assert.equal(plan[0]!.output_format,'jpeg');assert.equal(router.plan(profile,observation,source,ambiguity,1200,prompt).length,0);
  assert.equal(new RegionalSeedRouter().plan(profile,observation,source,ambiguity,5000,prompt).length,0);assert.equal(router.usage().requests,1);
});
test('visual tracks never fabricate GUIDs; same-name/occluded/layout changes invalidate identity',()=>{
  const tracker=new VisualTracks(),d={id:'a',name:'目标',roi:{x:1,y:1,width:10,height:10},appearance_sha256:'a'.repeat(64)};
  const a=tracker.update('layout-1','frame-1',[d])[0]!,b=tracker.update('layout-1','frame-2',[d])[0]!;assert.equal(a.track_id,b.track_id);assert.equal(b.entity_guid,null);
  const same=tracker.update('layout-1','frame-3',[d,{...d,id:'b',roi:{...d.roi,x:20}}]);assert.ok(same.every((t)=>t.identity_ambiguous));
  tracker.update('layout-1','frame-4',[],false);const after=tracker.update('layout-1','frame-5',[d])[0]!;assert.notEqual(after.track_id,b.track_id);
  assert.notEqual(tracker.update('layout-2','frame-6',[d])[0]!.track_id,after.track_id);
});
test('resident fake OCR worker processes multiple requests without becoming CV',async()=>{
  const image=await readFile(join(folder,'mother.png')),row=first.regions[0]!;
  const request:OcrRequest={version:1,kind:'local-ocr-request',id:'mock-1',frame_id:first.frame_id,source_observation_id:'observation-1',captured_at_ms:1000,image_path:join(folder,'mother.png'),image_sha256:hash(image),width:128,height:96,model_id:'fake-fixture',regions:[{id:row.id,roi:row.roi!,content_sha256:row.content_sha256!}]};
  const client=new LocalOcrClient({python:process.execPath,script:join(repo,'agent/tests/fixtures/mock-local-ocr.mjs'),projectRoot:repo,imageRoot:folder});
  try{assert.equal((await client.recognize(request)).regions[0]!.lines[0]!.text,'测试中文');assert.equal((await client.recognize({...request,id:'mock-2'})).reason,'mock_fixture');await assert.rejects(client.recognize({...request,id:'mock-3',image_path:join(folder,'mother.jpg')}),/png/);}finally{client.close();}
});
test('dialog composition requires current CV role, geometry and enabled; OCR cannot authorize a click',async()=>{
  const {composeDialogueElements,buildObjectViews}=await import('../src/eye/regions/objects.js');
  const field=(value:any,source:'cv'|'local_ocr'='cv')=>({status:'known' as const,value,source,captured_at_ms:1000,source_observation_id:'observation-1'});
  const fields={'ui.layout_id':field('layout-1'),'dialog.choice.a.rectangle':field({x:10,y:20,width:20,height:4}),'dialog.choice.a.role':field('accept'),'dialog.choice.a.enabled':field(true),'target.name':field('同名目标','local_ocr')};
  const result=composeDialogueElements(fields,'observation-1');assert.equal(result.status,'known');assert.equal((result.value as any[])[0].x,20);assert.equal((result.value as any[])[0].quest_id,undefined);
  assert.equal(composeDialogueElements({...fields,'dialog.choice.a.enabled':field(true,'local_ocr')},'observation-1').status,'unknown');
  assert.equal(composeDialogueElements(fields,'observation-2').status,'unknown');assert.equal(buildObjectViews(fields).units[1]!.entity_guid,null);
});
