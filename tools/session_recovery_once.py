"""Fixed session-1 recovery host via an ephemeral least-privilege /IT task.

This coordinator never sends input itself. SIGINT/SIGTERM creates an owned cancel
file; Windows performs cancellation/release. No arbitrary payload, shell, launch
argument or credentials are accepted.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
from pathlib import Path
import signal
import subprocess
import time
import uuid

POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
REPOSITORY = Path(__file__).resolve().parent.parent
MAIN = Path('/home/dw/Projects/wow-jev')
OPS = {'discover', 'observe', 'input', 'launch_battlenet', 'launch_wow'}

def schema_validate(value, definition: str) -> str:
    """Validate the shared draft-07 subset without installing Python packages.

    Bounds and wire shapes come from the schema; filesystem/native identity and
    cross-field coordinate checks remain semantic checks below.
    """
    import re
    schema_path = REPOSITORY/'protocol/session-recovery-v1.schema.json'
    data=schema_path.read_bytes();root=json.loads(data)
    def check(instance, schema):
        if '$ref' in schema:
            target=root
            for part in schema['$ref'].removeprefix('#/').split('/'):target=target[part]
            return check(instance,target)
        if 'oneOf' in schema:
            successes=0
            for branch in schema['oneOf']:
                try:check(instance,branch);successes+=1
                except ValueError:pass
            if successes!=1:raise ValueError('recovery_schema_oneOf')
        kind=schema.get('type')
        types={'object':lambda x:isinstance(x,dict),'array':lambda x:isinstance(x,list),'string':lambda x:isinstance(x,str),
               'integer':lambda x:type(x)is int,'number':lambda x:type(x)in(int,float),'boolean':lambda x:type(x)is bool}
        if kind and not types[kind](instance):raise ValueError('recovery_schema_type')
        if 'const' in schema and (type(instance)is not type(schema['const']) or instance!=schema['const']):raise ValueError('recovery_schema_const')
        if 'enum' in schema and instance not in schema['enum']:raise ValueError('recovery_schema_enum')
        if isinstance(instance,dict):
            if any(key not in instance for key in schema.get('required',())):raise ValueError('recovery_schema_required')
            properties=schema.get('properties',{})
            if schema.get('additionalProperties') is False and instance.keys()-properties.keys():raise ValueError('recovery_schema_extra_fields')
            for key,child in properties.items():
                if key in instance:check(instance[key],child)
        if isinstance(instance,list):
            if len(instance)<schema.get('minItems',0) or len(instance)>schema.get('maxItems',2**63):raise ValueError('recovery_schema_array_bounds')
            if schema.get('uniqueItems') and len({json.dumps(x,sort_keys=True)for x in instance})!=len(instance):raise ValueError('recovery_schema_unique_items')
            if 'items'in schema:
                for item in instance:check(item,schema['items'])
        if isinstance(instance,str):
            if len(instance)<schema.get('minLength',0)or len(instance)>schema.get('maxLength',2**63):raise ValueError('recovery_schema_string_bounds')
            if 'pattern'in schema and not re.search(schema['pattern'],instance):raise ValueError('recovery_schema_pattern')
        if type(instance)in(int,float):
            if instance<schema.get('minimum',float('-inf'))or instance>schema.get('maximum',float('inf')):raise ValueError('recovery_schema_number_bounds')
    check(value,root['definitions'][definition])
    return hashlib.sha256(data).hexdigest()

def winpath(path: Path) -> str:
    return subprocess.check_output(['/usr/bin/wslpath', '-w', str(path)], text=True).strip()

def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_json_member')
        result[key] = value
    return result

def exact(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        raise ValueError('request_exact_fields_required')

def validate(request: dict) -> None:
    schema_validate(request,'request')
    exact(request, ('version', 'op'), ('target', 'action', 'source', 'post_click_observations'))
    if type(request['version']) is not int or request['version'] != 1 or request['op'] not in OPS:
        raise ValueError('unsupported_recovery_request')
    op = request['op']
    if op in {'observe', 'input', 'launch_wow'}:
        exact(request.get('target'), ('pid', 'start_ticks', 'hwnd', 'class', 'executable'))
        target = request['target']
        if type(target['pid']) is not int or not 0 < target['pid'] < 2**31:
            raise ValueError('invalid_target_pid')
        if not isinstance(target['start_ticks'], str) or not target['start_ticks'].isdigit() or int(target['start_ticks']) <= 0:
            raise ValueError('invalid_target_start_ticks')
        import re
        if not isinstance(target['hwnd'], str) or not re.fullmatch(r'0x[0-9a-fA-F]{1,16}', target['hwnd']) or int(target['hwnd'], 16) == 0:
            raise ValueError('invalid_target_hwnd')
        if any(not isinstance(target[key], str) or not target[key] or len(target[key]) > 1024 for key in ('class', 'executable')):
            raise ValueError('invalid_target_identity')
    elif 'target' in request:
        raise ValueError('target_not_permitted')
    if op in {'input', 'launch_wow'}:
        exact(request.get('source'), ('observation_id', 'capture_sha256', 'width', 'height', 'observation_path'))
        source = request['source']
        import re
        if not isinstance(source['observation_id'], str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', source['observation_id']):
            raise ValueError('invalid_observation_id')
        if not isinstance(source['capture_sha256'], str) or not re.fullmatch('[0-9a-f]{64}', source['capture_sha256']):
            raise ValueError('invalid_capture_hash')
        if any(type(source[key]) is not int or not 0 < source[key] <= 65536 for key in ('width', 'height')):
            raise ValueError('invalid_source_dimensions')
        if not isinstance(source['observation_path'], str):
            raise ValueError('source_main_out_required')
        source_path = Path(source['observation_path'])
        if source_path.is_symlink() or not source_path.resolve().is_relative_to((MAIN/'out').resolve()) or not source_path.is_dir():
            raise ValueError('source_main_out_required')
    elif 'source' in request:
        raise ValueError('source_not_permitted')
    if op == 'input':
        action = request.get('action')
        if not isinstance(action, dict): raise ValueError('finite_action_required')
        kind = action.get('kind')
        fields = {'key': ('kind','keys','duration_ms'), 'mouse_click': ('kind','button','x','y','duration_ms'),
                  'focus_click': ('kind','x','y','duration_ms')}
        if kind not in fields: raise ValueError('one_finite_action_required')
        exact(action, fields[kind], ('visibility_mode',) if kind == 'focus_click' else ())
        if 'post_click_observations' in request and kind not in {'mouse_click','focus_click'}:
            raise ValueError('post_click_requires_click')
        if type(action['duration_ms']) is not int or not 1 <= action['duration_ms'] <= 150:
            raise ValueError('action_duration_1_to_150ms_required')
        if kind == 'key':
            keys = action['keys']
            allowed = set('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') | {f'F{i}' for i in range(1,13)} | {'SPACE','SHIFT','CTRL','ALT','ESC','TAB','ENTER','BACKSPACE','UP','DOWN','LEFT','RIGHT'}
            if not isinstance(keys, list) or not keys or any(not isinstance(k,str) or k not in allowed for k in keys) or len(set(keys)) != len(keys):
                raise ValueError('canonical_keys_required')
        else:
            if any(type(action[key]) is not int or not 0 <= action[key] < request['source']['width' if key == 'x' else 'height'] for key in ('x','y')):
                raise ValueError('client_coordinate_required')
            if kind == 'mouse_click' and action['button'] not in {'left','right','middle'}: raise ValueError('invalid_mouse_button')
    elif 'post_click_observations' in request:
        raise ValueError('post_click_requires_click')
    elif 'action' in request:
        raise ValueError('action_not_permitted')

SCRIPT = r'''
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('REQUEST_BASE64')) | ConvertFrom-Json
$record=[ordered]@{task_name=$request.task_name;principal_logon_type='TASK_LOGON_INTERACTIVE_TOKEN';run_level='least_privilege';target_session=1;registered=$false;run_requested=$false;deleted=$false;deletion_rechecked=$false;hard_termination_used=$false;executable_sha256=$request.sha256;operation=$request.operation}
$folder=$null;$task=$null
try {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $owners=@(Get-CimInstance Win32_Process -Filter 'SessionId=1' | Where-Object {$_.Name -ieq 'explorer.exe'})
  $match=$false
  foreach($item in $owners){$owner=Invoke-CimMethod -InputObject $item -MethodName GetOwner;if($owner.ReturnValue -eq 0 -and ($owner.Domain+'\'+$owner.User) -ieq $identity.Name){$match=$true}}
  if(-not $match){throw 'current_interactive_principal_mismatch'}
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $request.executable).Hash.ToLowerInvariant() -ne $request.sha256){throw 'fixed_executable_changed'}
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $request.request_file).Hash.ToLowerInvariant() -ne $request.request_sha256){throw 'request_file_changed'}
  $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\')
  $definition=$scheduler.NewTask(0);$definition.RegistrationInfo.Description='wow-jev bounded session recovery '+$request.operation+'; '+$request.sha256
  $definition.Principal.UserId=$identity.Name;$definition.Principal.LogonType=3;$definition.Principal.RunLevel=0
  $definition.Settings.Enabled=$true;$definition.Settings.Hidden=$true;$definition.Settings.AllowDemandStart=$true
  $definition.Settings.ExecutionTimeLimit='PT30S';$definition.Settings.AllowHardTerminate=$false
  $definition.Settings.DisallowStartIfOnBatteries=$false;$definition.Settings.StopIfGoingOnBatteries=$false
  $action=$definition.Actions.Create(0);$action.Path=$request.executable
  $action.Arguments='--request "'+$request.request_file+'" --request-sha256 '+$request.request_sha256+' --out "'+$request.out+'" --cancel "'+$request.cancel+'"'
  if(Test-Path -LiteralPath $request.cancel){throw 'cancel_before_registration'}
  $task=$folder.RegisterTaskDefinition($request.task_name,$definition,2,$identity.Name,$null,3)
  $record.registered=$true;$record.principal=$identity.Name;$record.task_xml=$task.Xml
  if(Test-Path -LiteralPath $request.cancel){throw 'cancel_before_start'}
  $instance=$task.RunEx($null,4,1,$null);$record.run_requested=$true;$record.instance_guid=$instance.InstanceGuid
  $deadline=[DateTime]::UtcNow.AddSeconds(32)
  while(-not (Test-Path -LiteralPath ($request.out+'\result.json')) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
  $record.result_present=Test-Path -LiteralPath ($request.out+'\result.json')
  $record.last_task_result=$task.LastTaskResult;$record.task_state=$task.State
  if(-not $record.result_present){throw 'interactive_host_result_timeout'}
} catch {$record.error=$_.Exception.Message;$record.exception_type=$_.Exception.GetType().FullName}
finally {
  if($folder -ne $null -and $record.registered){
    try {
      if(-not (Test-Path -LiteralPath ($request.out+'\result.json'))){[IO.File]::WriteAllText($request.cancel,'cancel');$releaseDeadline=[DateTime]::UtcNow.AddSeconds(4);while(-not (Test-Path -LiteralPath ($request.out+'\result.json')) -and [DateTime]::UtcNow -lt $releaseDeadline){Start-Sleep -Milliseconds 100}}
      # Never force-stop the executor/guardian tree. Deleting the owned registration
      # does not substitute for release confirmation in the host result.
      $folder.DeleteTask($request.task_name,0);$record.deleted=$true
      try{$null=$folder.GetTask($request.task_name);$record.cleanup_error='owned_task_still_present'}catch{if($_.Exception.HResult -eq -2147024894){$record.deletion_rechecked=$true;$record.deletion_hresult=$_.Exception.HResult}else{throw}}
    } catch {$record.cleanup_error=$_.Exception.Message}
  }
}
$record | ConvertTo-Json -Depth 5 -Compress
'''

def run(request: dict, output: Path) -> dict:
    validate(request)
    output = output.resolve()
    if not output.is_relative_to((MAIN/'out').resolve()) or output.exists(): raise ValueError('new_project_out_directory_required')
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = REPOSITORY/'out/session-recovery-tools'
    names = ('InteractiveSessionHost.exe','WinInput.exe','WinInputWatchdog.exe','session-recovery-v1.schema.json')
    calibration=sorted((REPOSITORY/'tools/recovery-calibration').glob('*.json'))+sorted((REPOSITORY/'tools/recovery-calibration').glob('*.png'))
    if not calibration:raise ValueError('fixed_calibration_missing')
    names += tuple(path.name for path in calibration)
    hashes = {}
    for name in names:
        path = payload/name
        if not path.is_file() or path.is_symlink(): raise ValueError('build_fixed_recovery_payload_first')
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    for path in calibration:
        if path.is_symlink() or hashes[path.name]!=hashlib.sha256(path.read_bytes()).hexdigest():raise ValueError('rebuilt_calibration_required')
    if hashes['session-recovery-v1.schema.json']!=hashlib.sha256((REPOSITORY/'protocol/session-recovery-v1.schema.json').read_bytes()).hexdigest():raise ValueError('rebuilt_protocol_required')
    task_name = 'WowJev-SessionRecovery-'+uuid.uuid4().hex
    cancel_path = output.parent/(task_name+'.cancel')
    request_path = output.parent/(task_name+'.request.json')
    canonical = json.loads(json.dumps(request))
    if 'source' in canonical: canonical['source']['observation_path'] = winpath(Path(canonical['source']['observation_path']).resolve())
    envelope = {'request': canonical,'payload_hashes': hashes}
    encoded = (json.dumps(envelope,ensure_ascii=False,separators=(',',':'))+'\n').encode()
    with request_path.open('xb') as file: file.write(encoded)
    launch = {'task_name':task_name,'executable':winpath(payload/names[0]),'sha256':hashes[names[0]],
              'request_file':winpath(request_path),'request_sha256':hashlib.sha256(encoded).hexdigest(),
              'operation':request['op'],'out':winpath(output),'cancel':winpath(cancel_path)}
    script = SCRIPT.replace('REQUEST_BASE64',base64.b64encode(json.dumps(launch).encode()).decode())
    command = [POWERSHELL,'-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(script.encode('utf-16-le')).decode()]
    start=time.monotonic()
    def cancel(_number,_frame): cancel_path.touch(exist_ok=True)
    previous={number:signal.signal(number,cancel) for number in (signal.SIGINT,signal.SIGTERM)}
    try:
        process=subprocess.run(command,capture_output=True,timeout=48)
    finally:
        for number,handler in previous.items():signal.signal(number,handler)
    rows=[row for row in process.stdout.decode('utf-8-sig').splitlines() if row.startswith('{')]
    lifecycle=json.loads(rows[-1]) if rows else None
    audit=output.parent/(task_name+'.json')
    record={'request':launch,'coordinator_roundtrip_ms':(time.monotonic()-start)*1000,'exit_code':process.returncode,'lifecycle':lifecycle}
    audit.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
    audit.with_suffix('.stderr').write_bytes(process.stderr)
    if not lifecycle or not lifecycle.get('deleted') or not lifecycle.get('deletion_rechecked') or lifecycle.get('cleanup_error'):
        raise RuntimeError('owned_task_cleanup_unconfirmed:'+str(audit))
    if lifecycle.get('error'):raise RuntimeError(str(lifecycle['error'])+':'+str(audit))
    evidence=json.loads((output/'result.json').read_text())
    schema_validate(evidence,'result')
    if evidence.get('session_id') != 1:raise RuntimeError('interactive_session_unconfirmed:'+str(output/'result.json'))
    if request['op']=='input' and evidence.get('input_sent') and not evidence.get('release_confirmed'):
        raise RuntimeError('input_release_unconfirmed:'+str(output/'result.json'))
    return {'audit':str(audit),'output':str(output),'task_name':task_name,'task_deleted':True,'evidence':evidence}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request',type=Path,required=True);parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    try:
        request=json.loads(args.request.read_text(),object_pairs_hook=unique_pairs)
        print(json.dumps(run(request,args.out),ensure_ascii=False))
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:
        print(json.dumps({'status':'blocked','reason':str(error)},ensure_ascii=False));raise SystemExit(1)
