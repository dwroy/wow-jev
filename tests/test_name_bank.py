"""Visible name-class calibration; no desktop access, model calls, or input."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess

from PIL import Image
import pytest

from tools.combat_calibrate import generate, glyph_distance, local_glyph_distance, feature, visible_name_signature
from tools.eye_calibrate import CalibrationError


@pytest.fixture
def bank(tmp_path):
    def source(name, pattern, present=True):
        image = Image.new('RGB', (80, 60))
        for y in range(60):
            for x in range(80):
                image.putpixel((x, y), (15, 30, 60) if (x + y) % 2 else (80, 40, 90))
        image.paste((220, 180, 0) if present else (20, 30, 180), (2, 2, 10, 10))
        image.paste((30, 25, 40), (20, 20, 40, 30))
        for x, y in pattern:
            image.putpixel((20 + x, 20 + y), (230, 185, 5))
        path = tmp_path / (name + '.png'); image.save(path)
        return str(path)

    a = [(x, y) for x in (1, 2) for y in range(10)]
    b = [(x, y) for x in (8, 9) for y in range(10)]
    rejection = [(x, y) for x in (14, 15) for y in range(10)]
    first = source('a', a)
    changed = source('a-variation', a + [(3, 4)])
    second = source('b', b)
    unknown = source('unknown', rejection)
    negative = source('no-target', [], False)
    spec = {'version': 1, 'id': 'test-name-bank', 'detectors': {'target_present': {
        'roi': {'x': 2, 'y': 2, 'width': 8, 'height': 8}, 'positive': [first], 'negative': [negative]}},
        'signature': {'roi': {'x': 20, 'y': 20, 'width': 20, 'height': 10}, 'mask': 'name-bank-v1',
                      'pixel_mode': 'yellow-glyph-v1', 'min_ink_pixels': 8, 'tile_width': 10,
                      'thresholds': {'max_distance': .12, 'max_local_distance': .25, 'min_margin': .1},
                      'names': [{'name': '鱼人', 'sources': [first]}, {'name': '鱼入', 'sources': [second]}],
                      'reject_sources': [unknown, negative]}}
    return spec, {'a': first, 'variation': changed, 'b': second, 'unknown': unknown, 'no-target': negative}


def test_bank_signatures_frozen_sources_and_sparse_glyph_metric(bank, tmp_path):
    spec, sources = bank
    bundle = generate(spec, tmp_path / 'bundle')
    signature = bundle['signature']
    assert signature['names'][0]['signature'] == visible_name_signature('鱼人')
    assert signature['names'][1]['signature'] != signature['names'][0]['signature']
    for name in signature['names']:
        for entry in name['templates']:
            assert entry['sha256'] == hashlib.sha256((tmp_path / 'bundle' / entry['file']).read_bytes()).hexdigest()
    entry = signature['names'][0]['templates'][0]
    assert entry['source_sha256'] == hashlib.sha256(Path(sources['a']).read_bytes()).hexdigest()
    assert json.loads((tmp_path / 'bundle/calibration.json').read_text()) == bundle
    blank = Image.new('RGB', (20, 10))
    ink = blank.copy(); ink.putpixel((1, 1), (255, 255, 255))
    assert glyph_distance(blank, ink) == 1
    assert glyph_distance(blank, blank) == 1  # Empty is not evidence of a name.


@pytest.mark.parametrize('change', ['extra', 'duplicate-name', 'duplicate-source', 'no-rejects', 'missing-mode',
    'nan-distance', 'loose-distance', 'loose-local-distance', 'bool-tile', 'missing-local', 'empty-name', 'untrimmed-name', 'control-name', 'short-similar-name', 'inkless-source', 'bad-size'])
def test_bank_bad_or_inseparable_sources_rejected_before_write(bank, tmp_path, change):
    spec, sources = bank; signature = spec['signature']
    if change == 'extra': signature['unexpected'] = 1
    elif change == 'duplicate-name': signature['names'][1]['name'] = signature['names'][0]['name']
    elif change == 'duplicate-source': signature['names'][1]['sources'] = [sources['a']]
    elif change == 'no-rejects': signature['reject_sources'] = []
    elif change == 'missing-mode': del signature['pixel_mode']
    elif change == 'nan-distance': signature['thresholds']['max_distance'] = float('nan')
    elif change == 'loose-distance': signature['thresholds']['max_distance'] = .26
    elif change == 'loose-local-distance': signature['thresholds']['max_local_distance'] = .26
    elif change == 'bool-tile': signature['tile_width'] = True
    elif change == 'missing-local': del signature['thresholds']['max_local_distance']
    elif change == 'empty-name': signature['names'][0]['name'] = ''
    elif change == 'untrimmed-name': signature['names'][0]['name'] = ' 鱼人'
    elif change == 'control-name': signature['names'][0]['name'] = '鱼\n人'
    elif change == 'short-similar-name': signature['names'][1]['sources'] = [sources['variation']]
    elif change == 'inkless-source':
        signature['names'][0]['sources'] = [sources['no-target']]; signature['reject_sources'] = [sources['unknown']]
    elif change == 'bad-size': Image.new('RGB', (81, 60)).save(sources['b'])
    with pytest.raises(CalibrationError): generate(spec, tmp_path / 'bundle')
    assert not (tmp_path / 'bundle').exists()


EXE = os.environ.get('WOW_COMBAT_EYE_EXE')
native = pytest.mark.skipif(not EXE or not Path(EXE).is_file(), reason='explicit Windows WinEye.exe required')


def classify(image, calibration):
    def windows(path):
        return subprocess.run(['wslpath', '-w', str(path)], check=True, capture_output=True, text=True).stdout.strip()
    result = subprocess.run([EXE, 'classify', '--image', windows(image), '--combat-calibration', windows(calibration)], capture_output=True, text=True, timeout=10)
    return result.returncode, json.loads(result.stdout.lstrip('\ufeff'))


@native
def test_native_same_name_variation_stable_switch_unknown_and_absence(bank, tmp_path):
    spec, sources = bank
    bundle = generate(spec, tmp_path / 'bundle'); path = tmp_path / 'bundle/calibration.json'
    expected = bundle['signature']['names'][0]['signature']
    for key in ('a', 'variation'):
        code, sample = classify(sources[key], path)
        assert code == 0
        assert sample['detectors']['target_name']['value'] == '鱼人'
        assert sample['detectors']['target_signature']['value'] == expected
    _, sample = classify(sources['b'], path)
    assert sample['detectors']['target_name']['value'] == '鱼入'
    assert sample['detectors']['target_signature']['value'] != expected
    for key in ('unknown', 'no-target'):
        _, sample = classify(sources[key], path)
        assert sample['detectors']['target_signature']['status'] == 'unknown'
        assert sample['detectors']['target_name']['status'] == 'unknown'
        assert sample['detectors']['target_name']['value'] is None
    # An unrepresented name uses the same ink count as a known name, but different glyphs.
    novel = tmp_path / 'novel.png'
    with Image.open(sources['a']) as image:
        image.paste((30, 25, 40), (20, 20, 40, 30)); image.paste((230, 185, 5), (25, 20, 27, 30)); image.save(novel)
    _, sample = classify(novel, path)
    assert sample['detectors']['target_name']['status'] == 'unknown'


@native
def test_native_equal_name_margin_and_capture_failure_unknown(bank, tmp_path):
    spec, sources = bank
    spec['signature']['thresholds'] = {'max_distance': .25, 'max_local_distance': .25, 'min_margin': .1}
    # Similar short names whose training masks are distinct by 20% are allowed, but midpoint abstains.
    with Image.open(sources['a']) as image:
        image.putpixel((23, 21), (230, 185, 5)); image.putpixel((23, 22), (230, 185, 5))
        image.putpixel((23, 23), (230, 185, 5)); image.putpixel((23, 24), (230, 185, 5)); image.save(sources['b'])
    generate(spec, tmp_path / 'bundle'); path = tmp_path / 'bundle/calibration.json'
    query = tmp_path / 'midpoint.png'
    with Image.open(sources['a']) as image:
        image.putpixel((23, 21), (230, 185, 5)); image.putpixel((23, 22), (230, 185, 5)); image.save(query)
    _, sample = classify(query, path)
    assert sample['detectors']['target_name']['status'] == 'unknown'
    assert sample['detectors']['target_name']['reason']['code'] == 'name_bank_margin_insufficient'
    for image in [Image.new('RGB', (80, 60)), Image.new('RGB', (81, 60), (10, 40, 60))]:
        image.save(query); _, sample = classify(query, path)
        assert sample['detectors']['target_name']['status'] in ('unknown', 'unavailable')
        assert sample['detectors']['target_name']['value'] is None


@native
@pytest.mark.parametrize('change', ['signature', 'hash', 'duplicate-file', 'traversal', 'provenance', 'inseparable-labels', 'empty-rejects', 'unknown-key'])
def test_native_name_bank_tampering_rejected(bank, tmp_path, change):
    spec, sources = bank; bundle = generate(spec, tmp_path / 'bundle')
    signature = bundle['signature']; template = signature['names'][0]['templates'][0]
    if change == 'signature': signature['names'][0]['signature'] = 'a' * 64
    elif change == 'hash': template['sha256'] = 'a' * 64
    elif change == 'duplicate-file': signature['names'][1]['templates'] = copy.deepcopy(signature['names'][0]['templates'])
    elif change == 'traversal': template['file'] = '../a.png'
    elif change == 'provenance': template['source_sha256'] = 'not-sha'
    elif change == 'inseparable-labels':
        other = signature['names'][1]['templates'][0]; other_file = tmp_path / 'bundle' / other['file']
        other_file.write_bytes((tmp_path / 'bundle' / template['file']).read_bytes()); other['sha256'] = template['sha256']
    elif change == 'empty-rejects': signature['reject_templates'] = []
    elif change == 'unknown-key': signature['names'][0]['oops'] = True
    path = tmp_path / 'bundle/calibration.json'; path.write_text(json.dumps(bundle))
    code, sample = classify(sources['a'], path)
    assert code == 2 and sample['type'] == 'error'


@native
def test_native_long_shared_prefix_does_not_dilute_an_unseen_changed_glyph(bank, tmp_path):
    spec, sources = bank
    known, absent, novel = tmp_path / 'long-known.png', tmp_path / 'long-absent.png', tmp_path / 'long-novel.png'
    for target, source in [(known, sources['a']), (absent, sources['no-target'])]:
        with Image.open(source) as original:
            image = Image.new('RGB', (160, 60), (30, 25, 40)); image.paste(original, (0, 0))
            image.paste((30, 25, 40), (20, 20, 140, 30))
            if target == known:
                image.paste((230, 185, 5), (20, 20, 120, 30))
                image.paste((230, 185, 5), (130, 20, 132, 30))
            image.save(target)
    with Image.open(known) as image:
        image.paste((30, 25, 40), (130, 20, 132, 30)); image.paste((230, 185, 5), (134, 20, 136, 30)); image.save(novel)
    roi = {'x': 20, 'y': 20, 'width': 120, 'height': 10}
    spec['detectors']['target_present']['positive'] = [str(known)]
    spec['detectors']['target_present']['negative'] = [str(absent)]
    spec['signature']['roi'] = roi
    spec['signature']['names'] = [{'name': '很长的相同前缀鱼人', 'sources': [str(known)]}]
    spec['signature']['reject_sources'] = [str(absent)]
    with Image.open(known) as image: a = feature(image.crop((20, 20, 140, 30)), 'yellow-glyph-v1')
    with Image.open(novel) as image: b = feature(image.crop((20, 20, 140, 30)), 'yellow-glyph-v1')
    assert glyph_distance(a, b) < .12
    assert local_glyph_distance(a, b, 10) == 1
    generate(spec, tmp_path / 'bundle'); path = tmp_path / 'bundle/calibration.json'
    _, sample = classify(known, path)
    assert sample['detectors']['target_name']['value'] == '很长的相同前缀鱼人'
    _, sample = classify(novel, path)
    assert sample['detectors']['target_name']['status'] == 'unknown'
