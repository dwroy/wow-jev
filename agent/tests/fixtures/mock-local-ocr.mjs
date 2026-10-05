// Explicit fake OCR fixture: validates transport/adoption, never tests recognition quality.
import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})){
 const q=JSON.parse(line);
 process.stdout.write(JSON.stringify({version:1,kind:'local-ocr-result',id:q.id,frame_id:q.frame_id,image_sha256:q.image_sha256,model_id:q.model_id,engine_version:'3.9.1',status:'ok',reason:'mock_fixture',regions:q.regions.map(r=>({...r,status:'known',lines:[{text:'测试中文',confidence:0.9,box:[[0,0],[r.roi.width,0],[r.roi.width,r.roi.height],[0,r.roi.height]]}]}))})+'\n');
}
