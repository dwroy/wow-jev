// Explicit fake OCR fixture: validates transport/adoption, never recognition quality.
import readline from 'node:readline';
const cache=new Map();
for await(const line of readline.createInterface({input:process.stdin})){
 const q=JSON.parse(line);
 const regions=q.regions.map(r=>{const key=q.model_id+'/'+r.content_sha256;const prior=cache.get(key);const parsed_source=prior??{request_id:q.id,frame_id:q.frame_id,source_observation_id:q.source_observation_id,captured_at_ms:q.captured_at_ms};cache.set(key,parsed_source);return{...r,status:'known',cache_hit:!!prior,parsed_source,lines:[{text:'测试中文',confidence:0.9,box:[[0,0],[r.roi.width,0],[r.roi.width,r.roi.height],[0,r.roi.height]]}]};});
 process.stdout.write(JSON.stringify({version:1,kind:'local-ocr-result',id:q.id,frame_id:q.frame_id,image_sha256:q.image_sha256,model_id:q.model_id,engine_version:'3.9.1',status:'ok',reason:'mock_fixture',regions})+'\n');
}
