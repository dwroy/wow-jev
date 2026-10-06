"""Pin source/build/protocol/calibration inputs and produced fixed payload hashes."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent

def manifest(root:Path)->dict:
    # Include every C# source even if a given executable uses only a subset;
    # csc argv/source sets remain explicit in the separately hashed build scripts.
    paths=list((root/'native/windows').glob('*.cs'))
    paths += [root/'native/windows/build.sh',root/'tools/resident_build.sh',root/'tools/resident_session.py',root/'tools/resident_readonly.py',root/'tools/resident_source_manifest.py',root/'tools/RecoveryTutorialCv.cs',root/'tools/RecoveryOcr.cs',root/'tools/InteractiveSessionHost.cs',root/'tools/resident_fixture_build.sh',root/'tools/ResidentSafetyFixture.cs',root/'tools/resident_fixture_benchmark.py',root/'tools/resident_fixture_window.py']
    paths +=list((root/'agent/src/resident').glob('*.ts'))
    paths += [root/'protocol/resident-session-v1.schema.json',root/'protocol/native-input-v1.schema.json',root/'protocol/session-recovery-v1.schema.json']
    paths +=list((root/'tools/recovery-calibration').glob('*.json'))+list((root/'tools/recovery-calibration').glob('*.png'))
    sources={str(path.relative_to(root)):hashlib.sha256(path.read_bytes()).hexdigest()for path in sorted(set(paths))}
    binaries={str(path.relative_to(root)):hashlib.sha256(path.read_bytes()).hexdigest()for path in sorted((root/'out/resident-tools').glob('*'))if path.is_file()}
    return {'version':1,'source_scope':'wide_all_native_csharp_plus_explicit_host_relay_build_inputs','sources_sha256':sources,'fixed_payload_sha256':binaries,
            'capture_calls':0,'game_inputs':0,'credentials_read':False,'includes_legacy_unused_native_sources':True}

def main()->int:
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
    with args.out.open('x')as file:json.dump(manifest(ROOT),file,ensure_ascii=False,indent=2);file.write('\n')
    return 0
if __name__=='__main__':raise SystemExit(main())
