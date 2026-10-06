import {createHash} from 'node:crypto';
import {readFile,readdir,lstat,mkdir,writeFile} from 'node:fs/promises';
import {join,dirname,relative,resolve} from 'node:path';
import {canonical} from '../behavior/validation.js';
/** Fixed source/calibration allowlist; credentials, arbitrary images and user chat are excluded. */
export async function freezeRecoverySources(repository:string,directory:string,options:unknown){
  const initial=['agent/src/recovery','agent/package-lock.json','protocol','perception/schemas','perception/prompts','protocol/session-recovery-v1.schema.json','protocol/native-input-v1.schema.json','native/windows/InputCommon.cs','native/windows/WinInput.cs','native/windows/WinInputWatchdog.cs','tools/recover.py','tools/session_recovery_once.py','tools/session_recovery_build.sh','tools/InteractiveSessionHost.cs','tools/RecoveryOcr.cs','tools/RecoveryCalibration.cs','tools/RecoveryTutorialCv.cs','tools/recovery-calibration'];
  const hashes:Record<string,string>={},queue=[...initial];let size=0;
  while(queue.length){const name=queue.shift()!;if(name in hashes)continue;const file=resolve(repository,name);if(relative(repository,file).startsWith('..'))throw new Error('recovery_source_path');let info;try{info=await lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}if(info.isSymbolicLink())throw new Error('recovery_source_symlink');if(info.isDirectory()){for(const child of(await readdir(file)).sort())queue.push(`${name}/${child}`);continue;}if(!info.isFile()||!/[.](?:ts|py|cs|sh|json|png|txt)$/.test(name))continue;
    const bytes=await readFile(file);size+=bytes.length;if(size>32*1024*1024||Object.keys(hashes).length>=300)throw new Error('recovery_source_budget');hashes[name]=createHash('sha256').update(bytes).digest('hex');const target=join(directory,'source',name);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx',mode:0o400});
    if(name.endsWith('.ts'))for(const match of bytes.toString('utf8').matchAll(/(?:from\s+|import\s*\()?['"](\.[^'"]+\.js)['"]/g)){const dependency=relative(repository,resolve(dirname(file),match[1]!.replace(/\.js$/,'.ts')));if(!(dependency in hashes)&&!queue.includes(dependency))queue.push(dependency);}
  }
  const manifest={protocol:'wow-session-recovery-source',version:1,options,files:Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b))),source_sha256:createHash('sha256').update(canonical(hashes)).digest('hex'),models_enabled:false,decision_owner:'code_state_machine_root_supervised'};
  await writeFile(join(directory,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`,{flag:'wx',mode:0o400});return manifest;
}
