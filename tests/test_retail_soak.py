import json
from pathlib import Path

import pytest

from tools import retail_soak as soak

VERSION = {'branch': 'retail', 'expansion': 'midnight', 'patch': '12.1.0', 'build': 69933, 'region': 'cn', 'locale': 'zh_CN'}


def metadata(**change):
    return {'proc': 'Wow', 'pid': 42, 'hwnd': '0x123', 'file_version': '12.1.0.69933', 'branch': 'retail', 'region': 'CN', 'text_locale': 'zhCN',
            'start_ticks': '638899909123456789', 'client_width': 3840, 'client_height': 2160, **change}


def fixture(tmp_path, exits=(0, 0)):
    root = tmp_path / 'recording'; root.mkdir()
    meta = {'window': '0x123', 'pid': 42, 'proc': 'Wow', 'input_enabled': False, 'seed_enabled': False, 'complete': True, 'sealed': True, 'active': False,
            'duration_requested_ms': 100000, 'segments': []}
    for number, exit_code in enumerate(exits, 1):
        directory = root / f'segment-{number:02d}'; directory.mkdir(); (directory / 'artifacts').mkdir()
        image = directory / 'artifacts/image.jpg'; image.write_bytes(b'image-fixture' + bytes([number]))
        run_id, image_id = f'run-{number}', f'image-{number}'
        manifest = {'run_id': run_id, 'config': {'mode': 'observe', 'window': '0x123', 'expected_pid': 42, 'seed_enabled': False, 'action': None, 'save': True, 'duration_ms': 90000 if number == 1 else 10000}}
        (directory / 'manifest.json').write_text(json.dumps(manifest))
        meta['segments'].append({'name': directory.name, 'exit_code': exit_code, 'started_at': '2026-10-05T00:00:00Z', 'wall_elapsed_ms': 90000})
        window = {'pid': 42, 'hwnd': '0x123'}
        sample = {'type': 'sample', 'window': window, 'local_clock': {'domain': 'windows-qpc'}, 'capture': {'status': 'ok', 'started_qpc_ms': number*90000, 'finished_qpc_ms': number*90000+200}, 'artifact': {'id': image_id, 'sha256': soak.sha(image)}}
        rows = [{'kind': 'manifest', 'data': manifest}, {'kind': 'native_eye', 'data': {'direction': 'in', 'message': {'type': 'ready', 'window': window}}},
                {'kind': 'native_eye', 'data': {'direction': 'in', 'message': sample}}, {'kind': 'artifact', 'data': {'id': image_id, 'path': 'artifacts/image.jpg', 'sha256': soak.sha(image)}}]
        (directory / 'events.jsonl').write_text(''.join(json.dumps({'run_id': run_id, 'seq': i, 'at_ms': i*100, **row}) + '\n' for i, row in enumerate(rows)))
    (root / 'recording.json').write_text(json.dumps(meta))
    return root


def rewrite_events(root, mutate, segment=1):
    path = root / f'segment-{segment:02d}/events.jsonl'
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    mutate(rows)
    path.write_text(''.join(json.dumps(row) + '\n' for row in rows))


def test_version_profile_and_process_instance_binding(tmp_path):
    path = tmp_path / 'profile.json'; path.write_text(json.dumps(VERSION))
    assert soak.profile(path) == VERSION
    assert soak.check_client(metadata(), VERSION, '0x123', 42)['start_ticks'] == '638899909123456789'
    for change in ({'file_version': '11.0.1.1'}, {'branch': 'classic-era'}, {'region': 'US'}, {'text_locale': 'enUS'}, {'pid': 43}, {'hwnd': '0x124'}, {'start_ticks': 'unknown'}):
        with pytest.raises(ValueError): soak.check_client(metadata(**change), VERSION, '0x123', 42)
    for change in ({'build': None}, {'build': True}, {'branch': 'unknown'}, {'patch': None}, {'locale': 'zhCN'}):
        path.write_text(json.dumps({**VERSION, **change}))
        with pytest.raises(ValueError): soak.profile(path)


def test_success_retains_boundary_gap_and_every_source_hash(tmp_path):
    root = fixture(tmp_path)
    result = soak.analyze(root, '0x123', 42, replay=lambda _: {'exit_code': 0})
    assert result['accepted'] is True and result['screenshot_count'] == 2 and result['sample_count'] == 2
    assert result['native_input_commands'] == 0 and result['continuous_capture_claimed'] is False
    assert result['segment_boundary_gaps'][0]['gap_ms'] == 89800
    assert result['segments'][0]['artifacts'][0]['sha256'] == soak.sha(root / 'segment-01/artifacts/image.jpg')


def test_partial_failure_and_no_replay_never_claim_acceptance(tmp_path):
    root = fixture(tmp_path, exits=(0, 1))
    meta = soak.load(root / 'recording.json'); meta['complete'] = False; (root / 'recording.json').write_text(json.dumps(meta))
    result = soak.analyze(root, '0x123', 42, replay=lambda _: {'exit_code': 0})
    assert result['accepted'] is False and result['recording_complete'] is False
    assert result['screenshot_count'] == 2 and 'segment-02:nonzero_or_unknown_exit' in result['errors']
    assert soak.analyze(root, '0x123', 42)['accepted'] is False


@pytest.mark.parametrize('change', ['pid', 'hwnd', 'clock-domain', 'clock-backwards', 'source-hash', 'traversal', 'sequence', 'action-config'])
def test_bad_sources_bindings_and_clocks_reject(tmp_path, change):
    root = fixture(tmp_path)
    def modify(rows):
        sample = rows[2]['data']['message']
        if change == 'pid': sample['window']['pid'] = 43
        elif change == 'hwnd': sample['window']['hwnd'] = '0x124'
        elif change == 'clock-domain': sample['local_clock']['domain'] = 'wsl-monotonic'
        elif change == 'clock-backwards': sample['capture']['finished_qpc_ms'] = sample['capture']['started_qpc_ms'] - 1
        elif change == 'source-hash': rows[3]['data']['sha256'] = 'a'*64
        elif change == 'traversal': rows[3]['data']['path'] = '../secret.jpg'
        elif change == 'sequence': rows[3]['seq'] = 400
    if change == 'action-config':
        path = root / 'segment-01/manifest.json'; manifest = soak.load(path); manifest['config']['action'] = {'key': 'W'}; path.write_text(json.dumps(manifest))
    else: rewrite_events(root, modify)
    with pytest.raises(ValueError): soak.analyze(root, '0x123', 42)


def test_input_attempt_and_failed_replay_not_accepted(tmp_path):
    root = fixture(tmp_path)
    def modify(rows):
        rows.append({'run_id': 'run-1', 'seq': len(rows), 'at_ms': 900, 'kind': 'native_hand', 'data': {'direction': 'out', 'message': {'op': 'execute'}}})
    rewrite_events(root, modify)
    result = soak.analyze(root, '0x123', 42, replay=lambda _: {'exit_code': 0})
    assert result['accepted'] is False and result['native_input_commands'] == 1
    assert 'native_input_command_present' in result['errors']
    result = soak.analyze(root, '0x123', 42, replay=lambda _: {'exit_code': 1})
    assert 'segment-01:strict_replay_failed' in result['errors']


def test_missing_partial_segment_kept_and_unknown_exit_failure(tmp_path):
    root = fixture(tmp_path)
    (root / 'segment-02/manifest.json').unlink()
    result = soak.analyze(root, '0x123', 42, replay=lambda _: {'exit_code': 0})
    assert result['accepted'] is False
    assert result['segments'][1]['failure'] == 'segment_evidence_missing'
    assert result['screenshot_count'] == 1


def test_duplicate_json_never_overwrites_source_binding(tmp_path):
    path = tmp_path / 'profile.json'; path.write_text('{"branch":"retail","branch":"classic-era"}')
    with pytest.raises(ValueError): soak.load(path)


@pytest.mark.parametrize('mode,expected', [('done', 0), ('timeout', 124), ('cancel', 130)])
def test_external_driver_deadline_cancel_and_own_process_group_cleanup(tmp_path, monkeypatch, mode, expected):
    from types import SimpleNamespace
    import signal
    import subprocess
    repo = tmp_path / 'repo'; (repo / 'tools').mkdir(parents=True); (repo / 'tools/vision_record.py').write_text('# frozen recorder source')
    profile_path = tmp_path / 'profile.json'; profile_path.write_text(json.dumps(VERSION))
    out = tmp_path / 'soak'; clock = SimpleNamespace(seconds=0, killed=False, first=True); kills = []
    class Child:
        pid = 10042
        def poll(self):
            if mode == 'cancel' and clock.first:
                clock.first = False; raise KeyboardInterrupt
            return 0 if mode == 'done' or clock.killed else None
        def wait(self, timeout=None):
            if mode == 'done' or clock.killed: return 0
            raise subprocess.TimeoutExpired('own-child', timeout)
    def kill(pid, sig):
        kills.append((pid, sig)); clock.killed = True
    def start(command, **kwargs):
        assert command[1:3] == ['-m', 'tools.vision_record'] and kwargs['start_new_session'] is True
        return Child()
    monkeypatch.setattr(soak, 'probe_client', lambda *a: metadata())
    monkeypatch.setattr(soak.subprocess, 'Popen', start)
    monkeypatch.setattr(soak.time, 'monotonic', lambda: clock.seconds)
    monkeypatch.setattr(soak.time, 'sleep', lambda seconds: setattr(clock, 'seconds', clock.seconds + seconds))
    monkeypatch.setattr(soak.os, 'killpg', kill)
    monkeypatch.setattr(soak, 'analyze', lambda *a, **k: {'accepted': True})
    args = SimpleNamespace(repo=repo, out=out, window='0x123', pid=42, client_profile=profile_path, duration_ms=1000)
    previous = signal.getsignal(signal.SIGTERM)
    assert soak.run(args) == expected
    record = soak.load(out / 'driver.json')
    assert record['sealed'] is True and record['exit_code'] == expected
    assert record['accepted'] is (mode == 'done')
    assert kills == ([] if mode == 'done' else [(10042, signal.SIGTERM)])
    assert signal.getsignal(signal.SIGTERM) == previous
