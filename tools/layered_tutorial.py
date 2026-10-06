"""Fixed layered first-conversation entry; never adds a separate input path."""
from __future__ import annotations
import argparse
from pathlib import Path
import shutil
import signal
import subprocess
import sys


def parser():
    p=argparse.ArgumentParser(description='分层教程：只读在先，第一项交谈后停止；未知证据阻塞')
    p.add_argument('command',choices=('readonly','run','bootstrap','cancel'))
    for key in ('config','run-dir','python','target-character','snapshot','image','review','output'):
        p.add_argument('--'+key)
    for key in ('finite-input-authorized','recovery-authorized','model-upload-authorized'):
        p.add_argument('--'+key,action='store_true')
    return p


def build_command(args,repo:Path,node=None):
    if args.command=='run' and (not args.finite_input_authorized or not args.recovery_authorized or args.target_character!='小啊'):
        raise ValueError('tutorial_input_recovery_and_character_authorization_required')
    required=('snapshot','image','review','output') if args.command=='bootstrap' else ('run_dir',) if args.command=='cancel' else ('config','run_dir')
    if any(not getattr(args,key) for key in required):raise ValueError('tutorial_entry_arguments_required')
    executable=node or shutil.which('node')
    if not executable:raise ValueError('tutorial_node_environment_missing')
    result=[executable,str(repo/'agent/node_modules/tsx/dist/cli.mjs'),str(repo/'agent/src/tutorial/cli.ts'),args.command]
    for key in ('config','run_dir','python','target_character','snapshot','image','review','output'):
        value=getattr(args,key)
        if value is not None:
            if '\0' in value:raise ValueError('tutorial_argument_nul')
            result.extend(['--'+key.replace('_','-'),value])
    for key in ('finite_input_authorized','recovery_authorized','model_upload_authorized'):
        if getattr(args,key):result.append('--'+key.replace('_','-'))
    return result


def main(argv=None):
    args=parser().parse_args(argv);repo=Path(__file__).resolve().parent.parent
    try:command=build_command(args,repo)
    except ValueError as error:print(str(error),file=sys.stderr);return 1
    if not Path(command[1]).is_file():print('tutorial_project_dependencies_missing',file=sys.stderr);return 1
    child=subprocess.Popen(command,cwd=repo,shell=False);previous={}
    def stop(signum,_frame):
        if child.poll() is None:child.send_signal(signum)
    for sig in (signal.SIGINT,signal.SIGTERM):previous[sig]=signal.signal(sig,stop)
    try:return child.wait()
    finally:
        for sig,handler in previous.items():signal.signal(sig,handler)


if __name__=='__main__':raise SystemExit(main())
