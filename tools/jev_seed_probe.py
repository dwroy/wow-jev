"""Three offline Seed candidate probes on authorized WoW images; no native input code."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import select
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from perception import jev_worker as jw
from perception import seed_worker as sw


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def candidate(identity, summary, step, signature=None):
    conditions = [] if identity == 'wait' else [
        {'field': 'capture.available', 'op': 'eq', 'value': True, 'max_age_ms': 750},
        {'field': 'window.focused', 'op': 'eq', 'value': True, 'max_age_ms': 750},
        {'field': 'target.present', 'op': 'eq', 'value': True, 'max_age_ms': 750},
        {'field': 'target.dead', 'op': 'eq', 'value': False, 'max_age_ms': 750},
        {'field': 'target.signature', 'op': 'eq', 'value': signature, 'max_age_ms': 750},
        {'field': 'player.in_combat', 'op': 'eq', 'value': False, 'max_age_ms': 750},
    ]
    return {'id': identity, 'summary': summary, 'step': {'id': identity, **step},
            'conditions': conditions, 'target_signature': signature}


def cases():
    wait = candidate('wait', '等待250毫秒，不输入。', {'name': 'wait', 'duration_ms': 250})
    signature = 'artificial-offline-visible-target'
    move = candidate('move-forward', '使用已配置前进键100毫秒；本工具不会执行该动作。',
                     {'name': 'move_for', 'duration_ms': 100}, signature)
    left = candidate('turn-left', '向左转40像素200毫秒；本工具不会执行该动作。',
                     {'name': 'turn_for', 'dx': -40, 'duration_ms': 200}, signature)
    right = candidate('turn-right', '向右转40像素200毫秒；本工具不会执行该动作。',
                      {'name': 'turn_for', 'dx': 40, 'duration_ms': 200}, signature)
    return [
        {'id': 'no-target-wait', 'image_id': 'segment-01-0006', 'mode': 'observe', 'candidates': [wait],
         'description': '离线协议测试：当前仅允许等待，请选择 wait。', 'expected_candidate': 'wait'},
        {'id': 'living-target-move', 'image_id': 'segment-01-0018', 'mode': 'practice', 'candidates': [move, wait],
         'description': '离线候选测试：若截图明确显示活着的选中目标，选择向前短移100毫秒；否则等待。不要推测敌友、距离或技能就绪。',
         'expected_candidate': 'move-forward'},
        {'id': 'dead-target-turn-or-wait', 'image_id': 'segment-01-0046', 'mode': 'practice', 'candidates': [left, right, wait],
         'description': '离线候选测试：只在截图明确显示目标活着时选择向右转；目标已死亡或状态不清楚时必须等待。',
         'expected_candidate': 'wait'},
    ]


def build_request(case, index, now):
    goal = {'id': case['id'], 'revision': 1, 'description': case['description'], 'mode': case['mode'],
            'allow_movement': case['mode'] == 'practice', 'allowed_action_slots': [],
            'target_signature': None if case['mode'] == 'observe' else 'artificial-offline-visible-target'}
    candidates = case['candidates']
    return {'protocol': 'wow-jev', 'version': 1, 'type': 'selection_request', 'id': 'offline-probe-' + str(index),
            'plan': {'id': 'offline-model-probe', 'revision': 1}, 'goal': goal,
            'based_on_observation_id': 'artificial-observation-' + str(index), 'window_token': 'artificial-offline-window',
            'at_ms': now, 'deadline_ms': now + 15000,
            'candidates_sha256': hashlib.sha256(jw.canonical(candidates).encode()).hexdigest(), 'candidates': candidates}


def artificial_observation(request):
    # These manual fields deliberately cannot satisfy the live CV execution gate.
    values = {condition['field']: condition['value'] for item in request['candidates'] for condition in item['conditions']}
    return {'id': request['based_on_observation_id'], 'window': None, 'construction': 'manual_test_fixture_not_online_cv',
            'fields': {field: {'source': 'manual', 'status': 'known', 'value': value,
                               'source_observation_id': request['based_on_observation_id'], 'captured_at_ms': request['at_ms'],
                               'reason': {'code': 'constructed_for_offline_model_probe'}} for field, value in values.items()}}


def validate_worker_result(result, request, prompt_hash):
    if not jw.matches(result, jw.CHOICE_SCHEMA, jw.CHOICE_SCHEMA):
        raise sw.Failure('probe_result_schema')
    if result['id'] != request['id'] or result['prompt_version'] != jw.PROMPT_VERSION or result['prompt_sha256'] != prompt_hash:
        raise sw.Failure('probe_result_binding')
    if result['status'] == 'ok':
        reply = jw.validate_model(result['raw_text'], request)
        if reply['candidate_id'] != result['candidate_id'] or result['model'] != sw.MODEL:
            raise sw.Failure('probe_model_binding')
        return reply
    if result['candidate_id'] is not None:
        raise sw.Failure('probe_failed_result_candidate')
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-game-image-upload', action='store_true')
    parser.add_argument('--corpus', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--python', default=sys.executable)
    parser.add_argument('--env-file', type=Path, default=sw.ENV_PATH)
    args = parser.parse_args(argv)
    if not args.allow_game_image_upload:
        parser.error('需要已授权 WoW 图像上传的显式参数。')
    corpus = sw.strict_json(args.corpus.read_text())
    if corpus.get('source_binding', {}).get('process_name') != 'Wow':
        parser.error('只支持具有 WoW 来源证明的 corpus。')
    sources = {image['id']: image for image in corpus['images']}
    planned = cases()
    for case in planned:
        item = sources[case['image_id']]
        if item.get('source', {}).get('source') != 'WinEye' or item.get('source', {}).get('process_name') != 'Wow' or digest(item['path']) != item['sha256']:
            parser.error('图像来源或 SHA256 不匹配。')
    args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
    source_hashes = {}
    for path in (ROOT / 'perception/jev_worker.py', ROOT / 'perception/seed_worker.py', Path(__file__),
                 jw.PROMPT_PATH, jw.ROOT / 'schemas/jev-choice-v1.schema.json', jw.ROOT / 'schemas/model-jev-retail-v1.schema.json'):
        source_hashes[path.name] = digest(path)
        shutil.copyfile(path, args.out / path.name)
    started = time.monotonic()
    clock = lambda: int((time.monotonic() - started) * 1000)
    worker = subprocess.Popen([args.python, str(jw.ROOT / 'jev_worker.py'), '--serve', '--allow-game-image-upload',
                               '--timeout', '15', '--env-file', str(args.env_file)], cwd=ROOT,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    rows = []
    try:
        with (args.out / 'results.jsonl').open('x', encoding='utf-8') as log:
            for index, case in enumerate(planned, 1):
                request = build_request(case, index, clock())
                jw.validate_request(request)
                source = sources[case['image_id']]
                command = {'id': request['id'], 'op': 'choose', 'prompt_version': jw.PROMPT_VERSION,
                           'image_path': source['path'], 'request': request}
                row = {'scope': 'offline_model_probe', 'case': case['id'], 'source_image': source,
                       'observation': artificial_observation(request), 'command': command,
                       'expected_candidate': case['expected_candidate'], 'input_events': 0, 'online_cv_evidence': False}
                sent = clock()
                worker.stdin.write(json.dumps(command, ensure_ascii=False) + '\n')
                worker.stdin.flush()
                remaining = max(0, (request['deadline_ms'] - clock()) / 1000)
                if not select.select([worker.stdout], [], [], remaining)[0]:
                    row.update(status='failed', reason='probe_deadline_timeout', received_at_ms=clock(), request_sent_at_ms=sent)
                else:
                    line = worker.stdout.readline(sw.MAX_OUTPUT + 1)
                    received = clock()
                    row.update(request_sent_at_ms=sent, received_at_ms=received, measured_latency_ms=received - sent)
                    result = sw.strict_json(line)
                    reply = validate_worker_result(result, request, source_hashes['jev-retail-v1.txt'])
                    row['worker_result'] = result
                    if result.get('status') == 'ok':
                        row.update(status='ok' if received < request['deadline_ms'] else 'failed',
                                   deadline_met=received < request['deadline_ms'], validated_reply=reply,
                                   expected_selection_matched=reply['candidate_id'] == case['expected_candidate'])
                    else:
                        row.update(status='failed', reason=result.get('reason', {}).get('code', 'worker_failed'))
                rows.append(row)
                log.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n'); log.flush()
                print(json.dumps({'case': case['id'], 'status': row['status'], 'latency_ms': row.get('measured_latency_ms'),
                                  'candidate_id': row.get('validated_reply', {}).get('candidate_id'),
                                  'usage': row.get('worker_result', {}).get('usage')}, ensure_ascii=False), flush=True)
                if row['status'] != 'ok':
                    break
    finally:
        worker.stdin.close()
        try:
            worker.wait(timeout=2)
        except subprocess.TimeoutExpired:
            worker.terminate()
            try:
                worker.wait(timeout=2)
            except subprocess.TimeoutExpired:
                worker.kill(); worker.wait()
    summary = {'scope': 'offline_model_probe', 'model': sw.MODEL, 'prompt_version': jw.PROMPT_VERSION,
               'source_hashes': source_hashes, 'corpus_sha256': digest(args.corpus), 'planned_cases': len(planned),
               'completed_cases': len(rows), 'valid_replies': sum(row['status'] == 'ok' for row in rows),
               'expected_selections_matched': sum(row.get('expected_selection_matched', False) for row in rows),
               'input_events': 0, 'native_hand_calls': 0, 'online_cv_evidence': False,
               'request_latency_ms': [row.get('measured_latency_ms') for row in rows],
               'usage': {'input_tokens': sum(row.get('worker_result', {}).get('usage', {}).get('input_tokens') or 0 for row in rows),
                         'output_tokens': sum(row.get('worker_result', {}).get('usage', {}).get('output_tokens') or 0 for row in rows)},
               'limitations': '观察和候选由人为构造；只测试真实 Seed 的选择协议与画面判断，不证明在线 CV、实时执行或动作效果。'}
    (args.out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    return 0 if summary['valid_replies'] == len(planned) else 1


if __name__ == '__main__':
    raise SystemExit(main())
