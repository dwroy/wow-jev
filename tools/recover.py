"""Fixed project entry: each recovery command is separately authorized and finite."""
from __future__ import annotations
import argparse
from pathlib import Path
import shutil
import signal
import subprocess
import sys

def parser():
    p=argparse.ArgumentParser(description='有限恢复/启动；认证、验证码、协议、安装与更新一律停止')
    p.add_argument('command',choices=('recover','launch'))
    p.add_argument('--run-dir',required=True)
    p.add_argument('--recovery-authorized',action='store_true')
    p.add_argument('--target-character',required=True)
    for field in ('max-duration-ms','stage-timeout-ms','max-actions'):
        p.add_argument('--'+field,type=int)
    p.add_argument('--review-file')
    return p

def build_command(args,repo:Path,node:str|None=None):
    if not args.recovery_authorized or args.target_character!='小呵':raise ValueError('recovery_explicit_authorization_and_selected_target_required')
    for name,limit in (('max_duration_ms',180000),('stage_timeout_ms',30000),('max_actions',8)):
        value=getattr(args,name)
        if value is not None and not 1<=value<=limit:raise ValueError('recovery_finite_budget')
    executable=node or shutil.which('node')
    if not executable:raise ValueError('recovery_node_environment_missing')
    result=[executable,str(repo/'agent/node_modules/tsx/dist/cli.mjs'),str(repo/'agent/src/recovery/cli.ts'),args.command,'--run-dir',args.run_dir,'--recovery-authorized','--target-character',args.target_character]
    for name in ('max_duration_ms','stage_timeout_ms','max_actions','review_file'):
        value=getattr(args,name)
        if value is not None:
            if '\0' in str(value):raise ValueError('recovery_argument_nul')
            result.extend(['--'+name.replace('_','-'),str(value)])
    return result

def main(argv=None):
    args=parser().parse_args(argv);repo=Path(__file__).resolve().parent.parent
    try:command=build_command(args,repo)
    except ValueError as error:print(str(error),file=sys.stderr);return 1
    if not Path(command[1]).is_file():print('recovery_project_dependencies_missing',file=sys.stderr);return 1
    child=subprocess.Popen(command,cwd=repo,shell=False)
    previous={}
    def stop(signum,_frame):
        if child.poll() is None:child.send_signal(signum)
    for sig in (signal.SIGINT,signal.SIGTERM):previous[sig]=signal.signal(sig,stop)
    try:return child.wait()
    finally:
        for sig,handler in previous.items():signal.signal(sig,handler)
if __name__=='__main__':raise SystemExit(main())
