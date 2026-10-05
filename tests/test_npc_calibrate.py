import copy
import hashlib
import json
from pathlib import Path

from PIL import Image
import pytest

from tools.eye_calibrate import CalibrationError
from tools.npc_calibrate import generate, unique_pairs


@pytest.fixture
def spec(tmp_path):
    first, second = tmp_path / 'positive.png', tmp_path / 'negative.png'
    Image.new('RGB', (40, 30), (200, 180, 0)).save(first)
    Image.new('RGB', (40, 30), (20, 10, 90)).save(second)
    return {'version': 1, 'id': 'test-npc', 'detectors': {'npc_dialog_open': {
        'roi': {'x': 2, 'y': 3, 'width': 10, 'height': 11}, 'positive': [str(first)], 'negative': [str(second)]}}}


def range_definition(spec):
    return {**copy.deepcopy(spec['detectors']['npc_dialog_open']), 'evidence_kind': 'target-interaction-indicator',
            'target_binding': {'target_name': '测试 NPC', 'target_signature': 'name-template:npc-test'}}


def test_source_template_provenance_and_absent_range_preserved(spec, tmp_path):
    bundle = generate(spec, tmp_path / 'bundle')
    assert bundle['kind'] == 'npc-ui' and bundle['version'] == 1
    assert 'npc_in_interaction_range' not in bundle['detectors']
    entry = bundle['detectors']['npc_dialog_open']['templates']['positive'][0]
    assert entry['sha256'] == hashlib.sha256((tmp_path / 'bundle' / entry['file']).read_bytes()).hexdigest()
    assert entry['source_sha256'] == hashlib.sha256(Path(spec['detectors']['npc_dialog_open']['positive'][0]).read_bytes()).hexdigest()
    assert json.loads((tmp_path / 'bundle/calibration.json').read_text()) == bundle


def test_range_requires_explicit_indicator_and_exact_target_binding(spec, tmp_path):
    spec['detectors']['npc_in_interaction_range'] = range_definition(spec)
    bundle = generate(spec, tmp_path / 'bundle')
    assert bundle['detectors']['npc_in_interaction_range']['target_binding'] == spec['detectors']['npc_in_interaction_range']['target_binding']


@pytest.mark.parametrize('change', ['unknown', 'empty', 'bool-version', 'no-negative', 'duplicate', 'bool-roi', 'bad-roi', 'nan', 'bad-size', 'inseparable', 'range-no-binding', 'range-no-signature', 'range-model-distance', 'range-error-text', 'dialog-binding', 'symlink'])
def test_spec_errors_do_not_create_bundle(spec, tmp_path, change):
    detector = spec['detectors']['npc_dialog_open']
    if change == 'unknown': spec['guess'] = True
    elif change == 'empty': spec['detectors'] = {}
    elif change == 'bool-version': spec['version'] = True
    elif change == 'no-negative': detector['negative'] = []
    elif change == 'duplicate': detector['positive'] *= 2
    elif change == 'bool-roi': detector['roi']['x'] = False
    elif change == 'bad-roi': detector['roi']['width'] = 500
    elif change == 'nan': detector['max_distance'] = float('nan')
    elif change == 'bad-size': Image.new('RGB', (41, 30)).save(detector['negative'][0])
    elif change == 'inseparable': detector['negative'] = detector['positive']
    elif change == 'dialog-binding': detector['target_binding'] = {'target_name': 'NPC'}
    elif change == 'symlink':
        link = tmp_path / 'linked.png'; link.symlink_to(detector['positive'][0]); detector['positive'] = [str(link)]
    else:
        definition = range_definition(spec); spec['detectors']['npc_in_interaction_range'] = definition
        if change == 'range-no-binding': del definition['target_binding']
        elif change == 'range-no-signature': del definition['target_binding']['target_signature']
        elif change == 'range-model-distance': definition['evidence_kind'] = 'model-distance'
        elif change == 'range-error-text': definition['evidence_kind'] = 'out-of-range-error'
    with pytest.raises(CalibrationError): generate(spec, tmp_path / 'bundle')
    assert not (tmp_path / 'bundle').exists()


def test_preserve_existing_output_and_reject_duplicate_json(spec, tmp_path):
    out = tmp_path / 'bundle'; out.mkdir(); (out / 'keep').write_text('kept')
    with pytest.raises(FileExistsError): generate(spec, out)
    assert (out / 'keep').read_text() == 'kept'
    with pytest.raises(CalibrationError): json.loads('{"id":"npc","id":"duplicate"}', object_pairs_hook=unique_pairs)
