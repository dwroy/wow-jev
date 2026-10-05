import hashlib
import json

from PIL import Image
import pytest

from tools.combat_calibrate import generate, unique_pairs
from tools.eye_calibrate import CalibrationError


@pytest.fixture
def spec(tmp_path):
    first, second = tmp_path / 'positive.png', tmp_path / 'negative.png'
    Image.new('RGB', (40, 30), (200, 180, 0)).save(first)
    Image.new('RGB', (40, 30), (20, 10, 90)).save(second)
    return {'version': 1, 'id': 'test-combat', 'detectors': {'target_present': {
        'roi': {'x': 2, 'y': 3, 'width': 10, 'height': 11}, 'positive': [str(first)], 'negative': [str(second)]}},
        'signature': {'roi': {'x': 1, 'y': 1, 'width': 8, 'height': 8}, 'mask': 'yellow-mask-v1', 'min_ink_pixels': 8}}


def test_bundle_frozen_sources_and_templates(spec, tmp_path):
    out = tmp_path / 'bundle'
    bundle = generate(spec, out)
    assert bundle['version'] == 1 and bundle['kind'] == 'combat-ui'
    assert bundle['client_width'] == 40 and bundle['client_height'] == 30
    entry = bundle['detectors']['target_present']['templates']['positive'][0]
    assert entry['sha256'] == hashlib.sha256((out / entry['file']).read_bytes()).hexdigest()
    assert entry['source_sha256'] == hashlib.sha256(open(spec['detectors']['target_present']['positive'][0], 'rb').read()).hexdigest()
    assert json.loads((out / 'calibration.json').read_text()) == bundle


@pytest.mark.parametrize('change', ['unknown', 'empty', 'no-negative', 'bool-roi', 'duplicate', 'bad-mask', 'bad-size', 'dead-dependency', 'threshold', 'signature-large'])
def test_bad_spec_rejects_before_writing(spec, tmp_path, change):
    detector = spec['detectors']['target_present']
    if change == 'unknown': spec['surprise'] = True
    elif change == 'empty': spec['detectors'] = {}
    elif change == 'no-negative': detector['negative'] = []
    elif change == 'bool-roi': detector['roi']['x'] = True
    elif change == 'duplicate': detector['positive'] *= 2
    elif change == 'bad-mask': spec['signature']['mask'] = 'guess'
    elif change == 'bad-size': Image.new('RGB', (41, 30)).save(detector['negative'][0])
    elif change == 'dead-dependency': spec['detectors'] = {'target_dead': detector}
    elif change == 'threshold': detector['max_distance'] = float('nan')
    elif change == 'signature-large': spec['signature']['min_ink_pixels'] = 65
    with pytest.raises(CalibrationError): generate(spec, tmp_path / 'bundle')
    assert not (tmp_path / 'bundle').exists()


def test_existing_output_and_duplicate_json_preserved(spec, tmp_path):
    out = tmp_path / 'bundle'; out.mkdir(); (out / 'keep').write_text('kept')
    with pytest.raises(FileExistsError): generate(spec, out)
    assert (out / 'keep').read_text() == 'kept'
    with pytest.raises(CalibrationError): json.loads('{"version":1,"version":1}', object_pairs_hook=unique_pairs)
