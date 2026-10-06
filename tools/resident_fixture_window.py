"""Create only the fixed owned recording surface via one temporary /IT task.

It shows without activation, sends no input, closes on ESC or its own deadline.
Do not run until the user authorizes an interactive recording-window test.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid
import resident_session as resident

SCRIPT=r'''
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('REQUEST_BASE64'))|ConvertFrom-Json
$record=[ordered]@{task_name=$request.task_name;registered=$false;run_requested=$false;deleted=$false;deletion_rechecked=$false;hard_termination_used=$false;game_inputs=0;target_session=1;foreground_requested=$false}
$folder=$null
try{
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent();$match=$false
 foreach($item in @(Get-CimInstance Win32_Process -Filter 'SessionId=1'|Where-Object {$_.Name -ieq 'explorer.exe'})){$owner=Invoke-CimMethod -InputObject $item -MethodName GetOwner;if($owner.ReturnValue -eq 0 -and ($owner.Domain+'\'+$owner.User) -ieq $identity.Name){$match=$true}}
 if(-not $match){throw 'current_interactive_principal_mismatch'}
 if((Get-FileHash -Algorithm SHA256 -LiteralPath $request.executable).Hash.ToLowerInvariant() -ne $request.sha256){throw 'fixed_recording_executable_changed'}
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\');$definition=$scheduler.NewTask(0)
 $definition.Principal.UserId=$identity.Name;$definition.Principal.LogonType=3;$definition.Principal.RunLevel=0
 $definition.Settings.Enabled=$true;$definition.Settings.Hidden=$true;$definition.Settings.AllowDemandStart=$true;$definition.Settings.ExecutionTimeLimit='PT6M';$definition.Settings.AllowHardTerminate=$false
 $definition.Settings.DisallowStartIfOnBatteries=$false;$definition.Settings.StopIfGoingOnBatteries=$false
 $action=$definition.Actions.Create(0);$action.Path=$request.executable;$action.Arguments='--out "'+$request.local_output+'" --duration-ms '+$request.duration_ms
 $task=$folder.RegisterTaskDefinition($request.task_name,$definition,2,$identity.Name,$null,3);$record.registered=$true;$record.task_xml=$task.Xml
 $instance=$task.RunEx($null,4,1,$null);$record.run_requested=$true;$record.instance_guid=$instance.InstanceGuid
 $deadline=[DateTime]::UtcNow.AddSeconds(10);$ready=$request.local_output+'\recording-ready.json'
 while(-not(Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
 if(-not(Test-Path -LiteralPath $ready)){throw 'recording_window_ready_timeout'}
 $record.target=(Get-Content -Raw -LiteralPath $ready|ConvertFrom-Json);$record.local_output=$request.local_output;$record.last_task_result=$task.LastTaskResult
}catch{$record.error=$_.Exception.Message}
finally{
 if($folder -ne $null -and $record.registered){try{$folder.DeleteTask($request.task_name,0);$record.deleted=$true;try{$null=$folder.GetTask($request.task_name);throw 'owned_recording_task_still_present'}catch{if($_.Exception.HResult -eq -2147024894){$record.deletion_rechecked=$true;$record.deletion_hresult=$_.Exception.HResult}else{throw}}}catch{$record.cleanup_error=$_.Exception.Message}}
}
$record|ConvertTo-Json -Depth 8 -Compress
'''
def main()->int:
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out',type=Path,required=True);parser.add_argument('--duration-ms',type=int,default=180000);parser.add_argument('--recording-window-authorized',action='store_true');args=parser.parse_args()
    if not args.recording_window_authorized or not 1000<=args.duration_ms<=300000:raise ValueError('recording_authorization_and_budget_required')
    path=args.out.resolve()
    if not path.is_relative_to((resident.MAIN/'out').resolve())or path.exists():raise ValueError('new_main_out_recording_result_required')
    executable=resident.ROOT/'out/resident-tools/ResidentRecordingWindow.exe'
    if executable.is_symlink()or not executable.is_file():raise ValueError('build_fixed_recording_window_first')
    environment=subprocess.run([resident.POWERSHELL,'-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Environment]::GetFolderPath('LocalApplicationData')"],capture_output=True,text=True,timeout=10)
    local=environment.stdout.strip()
    if environment.returncode or not local or local.startswith('\\\\')or'\n'in local:raise RuntimeError('native_local_artifact_root_unknown')
    data={'task_name':'WowJev-Recording-'+uuid.uuid4().hex,'executable':resident.winpath(executable),'sha256':hashlib.sha256(executable.read_bytes()).hexdigest(),'local_output':local+'\\WowJevResidentRecording\\'+uuid.uuid4().hex,'duration_ms':args.duration_ms}
    result=resident.powershell(SCRIPT,data);path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x')as file:json.dump(result,file,ensure_ascii=False,indent=2);file.write('\n')
    if result.get('error')or result.get('cleanup_error')or not result.get('deleted')or not result.get('deletion_rechecked'):return 2
    # The recording window is still bounded by its native timer after this
    # registration is deleted. DeleteTask is not a claim that the GUI exited.
    target=result['target'];config={'version':1,'target_scope':'recording_fixture','target':{k:target[k]for k in('pid','start_ticks','hwnd','class','executable','windows_session_id')},'fixture_executable':data['executable'],'authorized_input':True,'focus_recovery_authorized':False,'max_actions':64,'duration_ms':180000}
    with path.with_suffix('.config.json').open('x')as file:json.dump(config,file,ensure_ascii=False,indent=2);file.write('\n')
    return 0
if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:print(str(error),file=__import__('sys').stderr);raise SystemExit(2)
