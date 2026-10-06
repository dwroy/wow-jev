"""Run only this project's readonly probe with a temporary least-privilege interactive task."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import signal
from pathlib import Path
import subprocess
import time
import uuid

POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
REPOSITORY = Path(__file__).resolve().parent.parent
MAIN = Path('/home/dw/Projects/wow-jev')

def winpath(path: Path) -> str:
    return subprocess.check_output(['/usr/bin/wslpath', '-w', str(path)], text=True).strip()

def run(pid: int, ticks: int, output: Path, *, diagnostic: bool = False) -> dict:
    if not 0 < pid < 2**31 or ticks <= 0:
        raise ValueError('specified_process_identity_required')
    output = output.resolve()
    if not output.is_relative_to(MAIN / 'out') or output.exists():
        raise ValueError('new_project_out_directory_required')
    output.parent.mkdir(parents=True, exist_ok=True)
    executable = REPOSITORY / 'out/interactive-readonly-tools/InteractiveReadonlyProbe.exe'
    if not executable.is_file() or executable.is_symlink():
        raise ValueError('build_specific_readonly_probe_first')
    exe_hash = hashlib.sha256(executable.read_bytes()).hexdigest()
    name = 'WowJev-FirstQuest-Readonly-' + uuid.uuid4().hex
    cancel_path = output.parent / (name + '.cancel')
    request = {'task_name': name, 'executable': winpath(executable), 'sha256': exe_hash,
               'pid': pid, 'start_ticks': str(ticks), 'out': winpath(output), 'cancel': winpath(cancel_path),
               'diagnose_desktop': diagnostic}
    encoded_request = base64.b64encode(json.dumps(request).encode()).decode()
    script = r'''
$ErrorActionPreference='Stop'
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('REQUEST_BASE64')) | ConvertFrom-Json
$record=[ordered]@{task_name=$request.task_name;principal_logon_type='TASK_LOGON_INTERACTIVE_TOKEN';run_level='least_privilege';target_session=1;registered=$false;run_requested=$false;deleted=$false;input_events=0;executable_sha256=$request.sha256;source_output=$request.out}
$folder=$null;$task=$null
try {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $game=Get-CimInstance Win32_Process -Filter ('ProcessId='+$request.pid)
  if(-not $game){throw 'specified_Wow_exited'}
  $owner=Invoke-CimMethod -InputObject $game -MethodName GetOwner
  if($owner.ReturnValue -ne 0 -or ($owner.Domain+'\'+$owner.User) -ine $identity.Name){throw 'current_interactive_principal_mismatch'}
  $proc=Get-Process -Id $request.pid
  if($proc.SessionId -ne 1 -or $proc.StartTime.ToUniversalTime().Ticks.ToString() -ne $request.start_ticks){throw 'target_session_or_start_identity_changed'}
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $request.executable).Hash.ToLowerInvariant() -ne $request.sha256){throw 'readonly_executable_changed'}
  $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\')
  $definition=$scheduler.NewTask(0);$definition.RegistrationInfo.Description='wow-jev one-shot read-only capture, no input; '+$request.sha256
  $definition.Principal.UserId=$identity.Name;$definition.Principal.LogonType=3;$definition.Principal.RunLevel=0
  $definition.Settings.Enabled=$true;$definition.Settings.Hidden=$true;$definition.Settings.AllowDemandStart=$true
  $definition.Settings.ExecutionTimeLimit='PT15S';$definition.Settings.DisallowStartIfOnBatteries=$false;$definition.Settings.StopIfGoingOnBatteries=$false
  $action=$definition.Actions.Create(0);$action.Path=$request.executable
  $action.Arguments='--pid '+$request.pid+' --expected-start-ticks '+$request.start_ticks+' --out "'+$request.out+'"'
  if($request.diagnose_desktop){$action.Arguments+=' --diagnose-desktop'}
  if(Test-Path -LiteralPath $request.cancel){throw 'user_cancel_before_registration'}
  $task=$folder.RegisterTaskDefinition($request.task_name,$definition,2,$identity.Name,$null,3)
  $record.registered=$true;$record.principal=$identity.Name;$record.task_xml=$task.Xml
  if(Test-Path -LiteralPath $request.cancel){throw 'user_cancel_before_readonly_start'}
  $instance=$task.RunEx($null,4,1,$null);$record.run_requested=$true;$record.instance_guid=$instance.InstanceGuid
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  while(-not (Test-Path -LiteralPath ($request.out+'\result.json')) -and [DateTime]::UtcNow -lt $deadline){if(Test-Path -LiteralPath $request.cancel){throw 'user_cancel_readonly'};Start-Sleep -Milliseconds 100}
  $record.result_present=Test-Path -LiteralPath ($request.out+'\result.json')
  $record.last_task_result=$task.LastTaskResult;$record.task_state=$task.State
  if(-not $record.result_present){throw 'readonly_interactive_result_timeout'}
} catch {$record.error=$_.Exception.Message;$record.exception_type=$_.Exception.GetType().FullName}
finally {
  if($folder -ne $null){
    try {$own=$folder.GetTask($request.task_name);if($own.State -eq 4){$own.Stop(0);$record.stopped_owned_task=$true};$folder.DeleteTask($request.task_name,0);$record.deleted=$true}
    catch {$record.cleanup_error=$_.Exception.Message}
  }
}
$record | ConvertTo-Json -Depth 5 -Compress
'''.replace('REQUEST_BASE64', encoded_request)
    command = [POWERSHELL, '-NoProfile', '-NonInteractive', '-EncodedCommand',
               base64.b64encode(script.encode('utf-16-le')).decode()]
    start = time.monotonic()
    # A normal cancel lets the Windows coordinator run its exact-task finally.
    # The helper owns no keys and has an independent 15s scheduled execution cap.
    def cancel(_number, _frame):
        cancel_path.touch(exist_ok=True)
    previous = {number: signal.signal(number, cancel) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        process = subprocess.run(command, capture_output=True, timeout=40)
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
    audit = output.parent / (name + '.json')
    rows = [s for s in process.stdout.decode('utf-8-sig').splitlines() if s.startswith('{')]
    result = {'request': request, 'coordinator_roundtrip_ms': (time.monotonic()-start)*1000,
              'exit_code': process.returncode, 'lifecycle': json.loads(rows[-1]) if rows else None}
    audit.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    (audit.with_suffix('.stderr')).write_bytes(process.stderr)
    if not result['lifecycle'] or not result['lifecycle'].get('deleted'):
        raise RuntimeError('owned_task_cleanup_unconfirmed:' + str(audit))
    if result['lifecycle'].get('error'):
        raise RuntimeError(result['lifecycle']['error'] + ':' + str(audit))
    evidence = json.loads((output/'result.json').read_text())
    if evidence.get('probe_session_id') != 1 or evidence.get('status') != ('diagnosed' if diagnostic else 'captured'):
        raise RuntimeError('interactive_readonly_failed:' + str(output/'result.json'))
    return {'audit': str(audit), 'output': str(output), 'task_name': name,
            'task_deleted': True, 'evidence': evidence, 'input_events': 0}

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid',type=int,required=True)
    parser.add_argument('--expected-start-ticks',type=int,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--diagnose-desktop',action='store_true',help='Only inspect desktop/session/window APIs; no capture or input.')
    args=parser.parse_args()
    try: print(json.dumps(run(args.pid,args.expected_start_ticks,args.out,diagnostic=args.diagnose_desktop),ensure_ascii=False))
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:
        print(json.dumps({'status':'blocked','error':str(error),'input_events':0},ensure_ascii=False))
        raise SystemExit(1)
