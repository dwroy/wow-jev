"""Optional Windows .NET offline classifier tests. These never open a window or send input."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

from PIL import Image
import pytest

from tools.combat_calibrate import generate

EXE = os.environ.get('WOW_COMBAT_EYE_EXE')
pytestmark = pytest.mark.skipif(not EXE or not Path(EXE).is_file(), reason='explicit built Windows WinEye.exe required')


def win(path):
    return subprocess.run(['wslpath', '-w', str(path)], check=True, capture_output=True, text=True).stdout.strip()


def classify(path, bundle=None):
    args = [EXE, 'classify', '--image', win(path)]
    if bundle is not None: args += ['--combat-calibration', win(bundle)]
    process = subprocess.run(args, capture_output=True, text=True, timeout=10)
    return process.returncode, json.loads(process.stdout.lstrip('\ufeff'))


@pytest.fixture
def native_bundle(tmp_path):
    pos, neg = tmp_path / 'p.png', tmp_path / 'n.png'
    for path, present, dead in [(pos, (220, 180, 10), (20, 180, 20)), (neg, (20, 10, 200), (200, 20, 20))]:
        image = Image.new('RGB', (40, 30))
        for y in range(30):
            for x in range(40): image.putpixel((x, y), (80, 60, 90) if (x+y)%2 else (10, 30, 60))
        image.paste(present, (2, 3, 12, 14)); image.paste(dead, (15, 4, 23, 12)); image.save(path)
    spec = {'version': 1, 'id': 'native-combat-test', 'detectors': {
        'target_present': {'roi': {'x': 2, 'y': 3, 'width': 10, 'height': 11}, 'positive': [str(pos)], 'negative': [str(neg)]},
        'target_dead': {'roi': {'x': 15, 'y': 4, 'width': 8, 'height': 8}, 'positive': [str(neg)], 'negative': [str(pos)]},
        'player_in_combat': {'roi': {'x': 2, 'y': 3, 'width': 10, 'height': 11}, 'positive': [str(pos)], 'negative': [str(neg)]}},
        'signature': {'roi': {'x': 2, 'y': 3, 'width': 10, 'height': 11}, 'mask': 'yellow-mask-v1', 'min_ink_pixels': 8}}
    bundle = generate(spec, tmp_path / 'bundle')
    return pos, neg, tmp_path / 'bundle/calibration.json', bundle


def test_native_known_dependency_signature_and_unconfigured_compatibility(native_bundle):
    pos, neg, path, _ = native_bundle
    code, result = classify(pos, path); assert code == 0
    assert result['detectors']['target_present']['value'] is True
    assert result['detectors']['target_dead']['value'] is False
    assert result['detectors']['player_in_combat']['value'] is True
    assert result['detectors']['target_signature']['value'] == hashlib.sha256(bytes([1]*110)).hexdigest()
    _, result = classify(neg, path)
    assert result['detectors']['target_present']['value'] is False
    assert result['detectors']['target_dead']['status'] == 'unknown'
    assert result['detectors']['target_signature']['status'] == 'unknown'
    code, result = classify(pos); assert code == 0
    assert result['detectors']['target_present']['status'] == 'unavailable'
    assert result['detectors']['target_present']['calibration_id'] is None


def test_native_size_black_and_unmatched_abstain_with_active_calibration(native_bundle, tmp_path):
    pos, _, path, _ = native_bundle
    changed = tmp_path / 'size.png'; Image.new('RGB', (41, 30), (20, 60, 70)).save(changed)
    _, result = classify(changed, path)
    assert result['detectors']['target_present']['value'] is None
    assert result['detectors']['target_present']['calibration_id'] == 'native-combat-test'
    black = tmp_path / 'black.png'; Image.new('RGB', (40, 30)).save(black)
    _, result = classify(black, path)
    assert result['frame_status'] == 'unavailable'
    assert result['detectors']['target_present']['status'] == 'unavailable'
    assert result['detectors']['target_present']['calibration_id'] == 'native-combat-test'
    occluded = tmp_path / 'occluded.png'
    with Image.open(pos) as image:
        image.paste((160, 160, 160), (2, 3, 12, 14)); image.save(occluded)
    _, result = classify(occluded, path)
    assert result['detectors']['target_present']['status'] == 'unknown'


@pytest.mark.parametrize('change', ['unknown-key', 'hash', 'traversal', 'bad-roi', 'missing-positive', 'no-present', 'inseparable'])
def test_native_strict_bundle_rejects(native_bundle, change):
    pos, _, path, bundle = native_bundle
    detector = bundle['detectors']['target_present']
    if change == 'unknown-key': bundle['oops'] = 1
    elif change == 'hash': detector['templates']['positive'][0]['sha256'] = 'a'*64
    elif change == 'traversal': detector['templates']['positive'][0]['file'] = '../p.png'
    elif change == 'bad-roi': detector['roi']['width'] = 400
    elif change == 'missing-positive': detector['templates']['positive'] = []
    elif change == 'no-present': del bundle['detectors']['target_present']
    elif change == 'inseparable': detector['templates']['negative'] = detector['templates']['positive']
    path.write_text(json.dumps(bundle))
    code, result = classify(pos, path)
    assert code == 2 and result['type'] == 'error'
