"""Real Windows .NET offline tests; no desktop capture, inputs, or model calls."""
import copy
import json
import os
from pathlib import Path
import subprocess

from PIL import Image
import pytest

from tools.npc_calibrate import generate

EXE = os.environ.get('WOW_NPC_CLASSIFY_EXE')
pytestmark = pytest.mark.skipif(not EXE or not Path(EXE).is_file(), reason='explicit built Windows NpcClassify.exe required')


def win(path):
    return subprocess.run(['wslpath', '-w', str(path)], check=True, capture_output=True, text=True).stdout.strip()


def classify(image, bundle=None, target=None):
    args = [EXE, win(image)]
    if bundle is not None: args.append(win(bundle))
    if target is not None: args.append(win(target))
    process = subprocess.run(args, capture_output=True, text=True, timeout=10)
    return process.returncode, json.loads(process.stdout.lstrip('\ufeff'))


@pytest.fixture
def fixture(tmp_path):
    pos, neg = tmp_path / 'p.png', tmp_path / 'n.png'
    for path, color in [(pos, (220, 180, 10)), (neg, (20, 10, 200))]:
        image = Image.new('RGB', (40, 30))
        for y in range(30):
            for x in range(40): image.putpixel((x, y), (80, 60, 90) if (x+y)%2 else (10, 30, 60))
        image.paste(color, (2, 3, 12, 14)); image.save(path)
    definition = {'roi': {'x': 2, 'y': 3, 'width': 10, 'height': 11}, 'positive': [str(pos)], 'negative': [str(neg)]}
    spec = {'version': 1, 'id': 'native-npc-test', 'detectors': {'npc_dialog_open': definition,
        'npc_in_interaction_range': {**copy.deepcopy(definition), 'evidence_kind': 'target-interaction-indicator',
            'target_binding': {'target_name': '测试 NPC', 'target_signature': 'name-template:npc-test'}}}}
    bundle = generate(spec, tmp_path / 'bundle'); path = tmp_path / 'bundle/calibration.json'
    target = {'target_present': {'status': 'known', 'value': True}, 'target_name': {'status': 'known', 'value': '测试 NPC'},
              'target_signature': {'status': 'known', 'value': 'name-template:npc-test'}}
    context = tmp_path / 'target.json'; context.write_text(json.dumps(target))
    return pos, neg, path, bundle, target, context


def test_known_passive_ui_and_target_binding(fixture):
    pos, neg, path, _, _, target_path = fixture
    code, result = classify(pos, path, target_path); assert code == 0
    assert result['detectors']['npc_dialog_open']['value'] is True
    assert result['detectors']['npc_in_interaction_range']['value'] is True
    _, result = classify(neg, path, target_path)
    assert result['detectors']['npc_dialog_open']['value'] is False
    assert result['detectors']['npc_in_interaction_range']['value'] is False
    _, result = classify(pos, path)
    assert result['detectors']['npc_dialog_open']['value'] is True
    assert result['detectors']['npc_in_interaction_range']['status'] == 'unknown'
    assert result['detectors']['npc_in_interaction_range']['reason']['code'] == 'npc_target_binding_unconfirmed'


@pytest.mark.parametrize('change', ['absent', 'name-changed', 'signature-changed', 'signature-unknown', 'name-unknown', 'missing', 'bad-present'])
def test_target_changes_or_unknown_never_reuse_range(fixture, change):
    pos, _, path, _, target, context = fixture
    if change == 'absent': target['target_present']['value'] = False
    elif change == 'name-changed': target['target_name']['value'] = '另一个 NPC'
    elif change == 'signature-changed': target['target_signature']['value'] = 'other-template'
    elif change == 'signature-unknown': target['target_signature']['status'] = 'unknown'
    elif change == 'name-unknown': target['target_name']['status'] = 'unknown'
    elif change == 'missing': del target['target_name']
    elif change == 'bad-present': target['target_present']['value'] = 'true'
    context.write_text(json.dumps(target))
    code, result = classify(pos, path, context); assert code == 0
    assert result['detectors']['npc_in_interaction_range']['status'] == 'unknown'
    assert result['detectors']['npc_in_interaction_range']['value'] is None


def test_changed_size_black_occlusion_and_unconfigured_are_distinct(fixture, tmp_path):
    pos, _, path, _, _, context = fixture
    changed = tmp_path / 'changed.png'; Image.new('RGB', (41, 30), (20, 60, 70)).save(changed)
    _, result = classify(changed, path, context)
    assert result['detectors']['npc_dialog_open']['status'] == 'unknown'
    assert result['detectors']['npc_dialog_open']['reason']['code'] == 'layout_size_mismatch'
    black = tmp_path / 'black.png'; Image.new('RGB', (40, 30)).save(black)
    _, result = classify(black, path, context)
    assert result['frame_status'] == 'unavailable'
    assert result['detectors']['npc_dialog_open']['status'] == 'unavailable'
    occluded = tmp_path / 'occluded.png'
    with Image.open(pos) as image:
        image.paste((160, 160, 160), (2, 3, 12, 14)); image.save(occluded)
    _, result = classify(occluded, path, context)
    assert result['detectors']['npc_dialog_open']['status'] == 'unknown'
    _, result = classify(pos)
    assert result['detectors']['npc_dialog_open']['status'] == 'unavailable'
    assert result['detectors']['npc_dialog_open']['calibration_id'] is None


def test_dialog_closed_does_not_infer_unconfigured_range(fixture):
    _, neg, path, bundle, _, _ = fixture
    del bundle['detectors']['npc_in_interaction_range']; path.write_text(json.dumps(bundle))
    _, result = classify(neg, path)
    assert result['detectors']['npc_dialog_open']['value'] is False
    assert result['detectors']['npc_in_interaction_range']['status'] == 'unavailable'
    assert result['detectors']['npc_in_interaction_range']['value'] is None


@pytest.mark.parametrize('change', ['old-kind', 'old-version', 'unknown-key', 'hash', 'traversal', 'bad-roi', 'missing-positive', 'no-binding', 'bool-threshold', 'range-error', 'inseparable', 'template-size'])
def test_strict_native_bundle_rejects(fixture, change):
    pos, _, path, bundle, _, context = fixture
    detector = bundle['detectors']['npc_dialog_open']; ranged = bundle['detectors']['npc_in_interaction_range']
    if change == 'old-kind': bundle['kind'] = 'combat-ui'
    elif change == 'old-version': bundle['version'] = 0
    elif change == 'unknown-key': detector['guess'] = 1
    elif change == 'hash': detector['templates']['positive'][0]['sha256'] = 'a'*64
    elif change == 'traversal': detector['templates']['positive'][0]['file'] = '../p.png'
    elif change == 'bad-roi': detector['roi']['width'] = 400
    elif change == 'missing-positive': detector['templates']['positive'] = []
    elif change == 'no-binding': del ranged['target_binding']
    elif change == 'bool-threshold': detector['thresholds']['max_distance'] = True
    elif change == 'range-error': ranged['evidence_kind'] = 'out-of-range-error'
    elif change == 'inseparable': detector['templates']['negative'] = detector['templates']['positive']
    elif change == 'template-size': detector['roi']['width'] = 9
    path.write_text(json.dumps(bundle))
    code, result = classify(pos, path, context)
    assert code == 2 and result['type'] == 'error'


def test_ambiguous_template_boundary_abstains(fixture, tmp_path):
    pos, _, path, bundle, _, context = fixture
    definition = bundle['detectors']['npc_dialog_open']; definition['thresholds']['max_distance'] = 1
    # Both classes are equidistant; opening/closing must not be guessed.
    boundary = tmp_path / 'boundary.png'
    with Image.open(pos) as image:
        image.paste((120, 95, 105), (2, 3, 12, 14)); image.save(boundary)
    path.write_text(json.dumps(bundle))
    _, result = classify(boundary, path, context)
    assert result['detectors']['npc_dialog_open']['status'] == 'unknown'
    assert result['detectors']['npc_dialog_open']['reason']['code'] == 'template_margin_insufficient'
