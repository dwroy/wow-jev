"""One owned /IT task; a fixed session-0 stdio relay; no TCP or shell input.

The task registration is removed and independently checked after the relay exits.
Deleting a task is never release evidence; the host/guardian records provide it.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
from pathlib import Path,PureWindowsPath
import shutil
import signal
import subprocess
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parent.parent
MAIN=Path('/home/dw/Projects/wow-jev')
POWERSHELL='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

def sha(path:Path)->str:return hashlib.sha256(path.read_bytes()).hexdigest()
def winpath(path:Path)->str:return subprocess.check_output(['/usr/bin/wslpath','-w',str(path)],text=True).strip()
def unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise ValueError('duplicate_json_member')
        result[key]=value
    return result
def read_json(path:Path):return json.loads(path.read_text(),object_pairs_hook=unique)
def validate_config(config:dict)->None:
    required={'version','target','authorized_input','focus_recovery_authorized','max_actions','duration_ms'}
    if not isinstance(config,dict)or not required<=config.keys()or config.keys()-required-{'dialog_absence_calibration','target_scope','fixture_executable'}:raise ValueError('resident_config_exact_fields')
    if type(config['version'])is not int or config['version']!=1:raise ValueError('resident_config_version')
    target=config['target']
    if not isinstance(target,dict)or target.keys()!={'pid','start_ticks','hwnd','class','executable','windows_session_id'}:raise ValueError('resident_target_exact_fields')
    import re
    if type(target['pid'])is not int or not 0<target['pid']<2**31 or target['windows_session_id']!=1 or type(target['windows_session_id'])is not int:raise ValueError('resident_target_session_pid')
    if not isinstance(target['start_ticks'],str)or not re.fullmatch('[1-9][0-9]{0,18}',target['start_ticks']):raise ValueError('resident_target_start_ticks')
    if not isinstance(target['hwnd'],str)or not re.fullmatch('0x[0-9a-fA-F]{1,16}',target['hwnd'])or int(target['hwnd'],16)==0:raise ValueError('resident_target_hwnd')
    scope=config.get('target_scope','retail_wow')
    if scope=='retail_wow':
        if target['class']not in {'GxWindowClass','GxWindowClassD3d','waApplication Window'}:raise ValueError('resident_target_wow_class')
        if not isinstance(target['executable'],str)or not target['executable'].lower().endswith('\\_retail_\\wow.exe')or config.get('fixture_executable')is not None:raise ValueError('resident_target_retail_path')
    elif scope=='recording_fixture':
        if target['class']!='WowJevResidentRecordingWindowV1'or not isinstance(target['executable'],str)or PureWindowsPath(target['executable']).name!='ResidentRecordingWindow.exe'or config.get('fixture_executable')!=target['executable']or config['focus_recovery_authorized']or config.get('dialog_absence_calibration')is not None:raise ValueError('resident_fixed_fixture_target_required')
    else:raise ValueError('resident_unknown_target_scope')
    if any(type(config[key])is not bool for key in ['authorized_input','focus_recovery_authorized']):raise ValueError('resident_authorization_boolean')
    if type(config['max_actions'])is not int or not 0<=config['max_actions']<=(64 if scope=='recording_fixture'else 8)or type(config['duration_ms'])is not int or not 1000<=config['duration_ms']<=300000:raise ValueError('resident_budget_bounds')
    if not config['authorized_input']and(config['max_actions']!=0 or config['focus_recovery_authorized']):raise ValueError('readonly_resident_must_not_enable_input')
    if config.get('dialog_absence_calibration')is not None and not isinstance(config['dialog_absence_calibration'],str):raise ValueError('resident_absence_path')

START=r'''
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('REQUEST_BASE64'))|ConvertFrom-Json
$record=[ordered]@{task_name=$request.task_name;registered=$false;run_requested=$false;target_session=1;logon_type='TASK_LOGON_INTERACTIVE_TOKEN';run_level='least_privilege';hard_termination_used=$false}
try{
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent();$owners=@(Get-CimInstance Win32_Process -Filter 'SessionId=1'|Where-Object {$_.Name -ieq 'explorer.exe'});$match=$false
 foreach($item in $owners){$owner=Invoke-CimMethod -InputObject $item -MethodName GetOwner;if($owner.ReturnValue -eq 0 -and ($owner.Domain+'\'+$owner.User) -ieq $identity.Name){$match=$true}}
 if(-not $match){throw 'current_interactive_principal_mismatch'}
 if((Get-FileHash -Algorithm SHA256 -LiteralPath $request.executable).Hash.ToLowerInvariant() -ne $request.sha256){throw 'fixed_executable_changed'}
 if((Get-FileHash -Algorithm SHA256 -LiteralPath $request.config).Hash.ToLowerInvariant() -ne $request.config_sha256){throw 'config_changed'}
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\');$definition=$scheduler.NewTask(0)
 $definition.RegistrationInfo.Description='wow-jev bounded resident WGC session '+$request.sha256
 $definition.Principal.UserId=$identity.Name;$definition.Principal.LogonType=3;$definition.Principal.RunLevel=0
 $definition.Settings.Enabled=$true;$definition.Settings.Hidden=$true;$definition.Settings.AllowDemandStart=$true;$definition.Settings.ExecutionTimeLimit='PT6M';$definition.Settings.AllowHardTerminate=$false
 $definition.Settings.DisallowStartIfOnBatteries=$false;$definition.Settings.StopIfGoingOnBatteries=$false
 $action=$definition.Actions.Create(0);$action.Path=$request.executable;$action.Arguments='--config "'+$request.config+'" --config-sha256 '+$request.config_sha256
 $task=$folder.RegisterTaskDefinition($request.task_name,$definition,2,$identity.Name,$null,3);$record.registered=$true;$record.principal=$identity.Name;$record.task_xml=$task.Xml
 $instance=$task.RunEx($null,4,1,$null);$record.run_requested=$true;$record.instance_guid=$instance.InstanceGuid
 $deadline=[DateTime]::UtcNow.AddSeconds(25)
 while(-not(Test-Path -LiteralPath ($request.output+'\host-ready.json')) -and -not(Test-Path -LiteralPath ($request.output+'\host-error.json')) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
 $record.ready_present=Test-Path -LiteralPath ($request.output+'\host-ready.json');$record.error_present=Test-Path -LiteralPath ($request.output+'\host-error.json')
 $record.last_task_result=$task.LastTaskResult;$record.task_state=$task.State
 if(-not $record.ready_present){throw 'resident_startup_failed_or_timeout'}
}catch{$record.error=$_.Exception.Message;$record.exception_type=$_.Exception.GetType().FullName}
$record|ConvertTo-Json -Depth 5 -Compress
'''
CLEANUP=r'''
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('REQUEST_BASE64'))|ConvertFrom-Json
$record=[ordered]@{task_name=$request.task_name;deleted=$false;deletion_rechecked=$false;hard_termination_used=$false}
try{
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\')
 try{$task=$folder.GetTask($request.task_name);$record.last_task_result=$task.LastTaskResult;$record.final_state=$task.State}catch{if($_.Exception.HResult -eq -2147024894){$record.deleted=$true;$record.deletion_rechecked=$true;$record.deletion_hresult=$_.Exception.HResult}else{throw}}
 if(-not $record.deleted){$folder.DeleteTask($request.task_name,0);$record.deleted=$true;try{$null=$folder.GetTask($request.task_name);throw 'owned_task_still_present'}catch{if($_.Exception.HResult -eq -2147024894){$record.deletion_rechecked=$true;$record.deletion_hresult=$_.Exception.HResult}else{throw}}}
}catch{$record.error=$_.Exception.Message}
$record|ConvertTo-Json -Depth 5 -Compress
'''

def powershell(script:str,data:dict)->dict:
    encoded=base64.b64encode(json.dumps(data).encode()).decode()
    script=script.replace('REQUEST_BASE64',encoded)
    process=subprocess.run([POWERSHELL,'-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(script.encode('utf-16-le')).decode()],capture_output=True,timeout=35)
    rows=[row for row in process.stdout.decode('utf-8-sig').splitlines()if row.startswith('{')]
    if process.returncode or not rows:raise RuntimeError('resident_task_control_failed')
    return json.loads(rows[-1])

def serve(config_path:Path,run_dir:Path)->int:
    user=read_json(config_path);validate_config(user)
    if run_dir.is_symlink()or not run_dir.resolve().is_relative_to((MAIN/'out').resolve())or run_dir.exists():raise ValueError('new_main_out_directory_required')
    run_dir=run_dir.resolve();run_dir.mkdir(parents=True,exist_ok=False)
    session=str(uuid.uuid4());generation=str(uuid.uuid4());task_name='WowJev-Resident-'+uuid.uuid4().hex
    payload=run_dir/'payload';payload.mkdir()
    build=ROOT/'out/resident-tools';names=['ResidentSessionHost.exe','ResidentRelay.exe','ResidentRecordingWindow.exe','WinInput.exe','WinInputWatchdog.exe','resident-session-v1.schema.json','native-input-v1.schema.json','session-recovery-v1.schema.json']
    if user.get('target_scope')=='recording_fixture'and user['fixture_executable'].lower()!=winpath(build/'ResidentRecordingWindow.exe').lower():raise ValueError('fixture_must_use_fixed_project_executable')
    names+=sorted(path.name for path in (ROOT/'tools/recovery-calibration').glob('*.json'))+sorted(path.name for path in (ROOT/'tools/recovery-calibration').glob('*.png'))
    hashes={}
    for name in names:
        original=build/name
        if original.is_symlink()or not original.is_file():raise ValueError('build_resident_fixed_payload_first')
        if name.endswith('.schema.json')and sha(original)!=sha(ROOT/'protocol'/name):raise ValueError('resident_schema_rebuild_required')
        if(ROOT/'tools/recovery-calibration'/name).is_file()and sha(original)!=sha(ROOT/'tools/recovery-calibration'/name):raise ValueError('resident_calibration_rebuild_required')
        shutil.copy2(original,payload/name);hashes[name]=sha(payload/name)
    absence_path=None
    if user.get('dialog_absence_calibration')is not None:
        supplied=Path(user['dialog_absence_calibration']);supplied=supplied if supplied.is_absolute()else config_path.parent/supplied
        if supplied.is_symlink()or not supplied.resolve().is_relative_to((MAIN/'out').resolve()):raise ValueError('owned_main_out_absence_calibration_required')
        read_json(supplied);destination=payload/'dialog-absence-calibration.json';shutil.copy2(supplied,destination);hashes[destination.name]=sha(destination);absence_path=winpath(destination)
    environment=subprocess.run([POWERSHELL,'-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Environment]::GetFolderPath('LocalApplicationData')"],capture_output=True,text=True,timeout=10)
    local=environment.stdout.strip()
    if environment.returncode or not local or local.startswith('\\\\')or'\n'in local:raise RuntimeError('native_local_artifact_root_unknown')
    full={**user,'target_scope':user.get('target_scope','retail_wow'),'fixture_executable':user.get('fixture_executable'),'session_id':session,'channel_generation':generation,'pipe_name':'WowJevResident-'+uuid.uuid4().hex,'nonce':uuid.uuid4().hex+uuid.uuid4().hex,
          'output':winpath(run_dir),'local_output':local+'\\WowJevResident\\'+session,'payload_hashes':hashes,'dialog_absence_calibration':absence_path}
    full_path=run_dir/'launch-config.json';full_path.write_text(json.dumps(full,ensure_ascii=False,separators=(',',':'))+'\n')
    launch={'task_name':task_name,'executable':winpath(payload/'ResidentSessionHost.exe'),'sha256':hashes['ResidentSessionHost.exe'],'config':winpath(full_path),'config_sha256':sha(full_path),'output':winpath(run_dir)}
    lifecycle={'task_name':task_name,'session_id':session,'generation':generation,'payload_hashes':hashes,'configuration_sha256':sha(full_path),'start':None,'cleanup':None,'relay_exit_code':None}
    relay=None;previous={}
    def cancelled(_signal,_frame):
        # Only the transport relay is stopped. The session-1 executor and its
        # independent guardian are neither killed nor placed in this group.
        if relay is not None and relay.poll()is None:relay.terminate()
        raise KeyboardInterrupt('resident_coordinator_cancelled')
    for number in(signal.SIGINT,signal.SIGTERM,signal.SIGHUP):previous[number]=signal.signal(number,cancelled)
    try:
        lifecycle['start']=powershell(START,launch)
        (run_dir/'task-start.json').write_text(json.dumps(lifecycle['start'],ensure_ascii=False,indent=2)+'\n')
        if lifecycle['start'].get('error'):raise RuntimeError(lifecycle['start']['error'])
        relay=subprocess.Popen([str(payload/'ResidentRelay.exe'),'serve','--config',winpath(full_path),'--config-sha256',sha(full_path)],stdin=None,stdout=None,stderr=None)
        lifecycle['relay_exit_code']=relay.wait();return lifecycle['relay_exit_code']
    finally:
        # Never terminate the native executor/guardian group. Relay EOF or its
        # own death closes the local pipe; native lease release is independent.
        for number,handler in previous.items():signal.signal(number,handler)
        if relay is not None and relay.poll()is None:
            relay.terminate()
            try:relay.wait(timeout=5)
            except subprocess.TimeoutExpired:pass
        # Host writes stopped locally before bounded UNC export. Give its
        # finite shutdown time to return the separate release proof.
        deadline=time.monotonic()+10
        while lifecycle['start']and lifecycle['start'].get('ready_present')and not(run_dir/'stopped.json').exists()and time.monotonic()<deadline:time.sleep(.05)
        lifecycle['cleanup']=powershell(CLEANUP,launch)
        (run_dir/'task-lifecycle.json').write_text(json.dumps(lifecycle,ensure_ascii=False,indent=2)+'\n')
        if not lifecycle['cleanup'].get('deleted')or not lifecycle['cleanup'].get('deletion_rechecked')or lifecycle['cleanup'].get('error'):raise RuntimeError('owned_resident_task_cleanup_unconfirmed')

def main()->int:
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='op',required=True)
    serve_parser=sub.add_parser('serve');serve_parser.add_argument('--config',type=Path,required=True);serve_parser.add_argument('--run-dir',type=Path,required=True)
    args=parser.parse_args()
    try:return serve(args.config.resolve(),args.run_dir)
    except(Exception,KeyboardInterrupt)as error:print(str(error),file=sys.stderr);return 2
if __name__=='__main__':raise SystemExit(main())
