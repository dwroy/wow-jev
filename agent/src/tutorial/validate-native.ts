import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {strictJson} from '../brain/execution/planner.js';
import {assertResident,loadResidentValidator} from '../resident/protocol.js';
/** Fixed offline Python boundary. No Windows, model, Body or hand capability. */
export async function validateResidentArchive(value:unknown){const repository=resolve(fileURLToPath(new URL('../../..',import.meta.url))),validate=await loadResidentValidator(join(repository,'protocol/resident-session-v1.schema.json'),join(repository,'protocol/native-input-v1.schema.json'));assertResident(value,validate);if(value.type!=='evidence')throw new Error('tutorial_native_archive_evidence_required');return true;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let bytes=0,parts:Buffer[]=[];for await(const part of process.stdin){const b=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=b.length;if(bytes>2*1024*1024)throw new Error('tutorial_native_archive_bounded');parts.push(b);}
  try{await validateResidentArchive(strictJson(Buffer.concat(parts).toString('utf8')));process.stdout.write('{"ok":true}\n');}catch{process.stdout.write('{"ok":false}\n');process.exitCode=1;}
}
