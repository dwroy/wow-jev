"""Register a same-capture Claude tutorial review in session-local world data.

No desktop/input/model/credential capability. An old review remains an old
knowledge reference; it is never a fresh CV result or input authorization.
"""
from __future__ import annotations
import argparse
from copy import deepcopy
import hashlib
from pathlib import Path
import sys

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from game_database.local_assertions import LocalAssertions, validate_assertion
from game_database.runtime import RuntimeDatabase, _time, validate_version
from game_database.store import ValidationError, canonical, canonical_sha256, parse_json
from game_database.ui_skills import _validate, AGENT, RESIDENT, SCHEMA
from game_database.v2.pack import WorldPack

WORLD_SHA = '5f762a251e9fb301ee3c8e50d9bbbc31fefc8bf2a67b686a60ef8360bb1c2774'
SQLITE_SHA = 'a6bce3f92b7566824cd2267da90acae7d1048b805a6fb13b5e6f47700d185391'
CLIENT = {'branch': 'retail', 'expansion': 'midnight', 'patch': '12.1.0', 'build': 69933, 'region': 'cn', 'locale': 'zh_CN'}
CHARACTER = {'name': '小呵', 'class': 'warrior', 'faction': 'alliance'}
NPC = '吉安娜·普罗德摩尔'
INSTRUCTION = '与吉安娜·普罗德摩尔交谈'


def read(path: Path, maximum: int = 4 * 1024 * 1024) -> tuple[bytes, str]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise ValidationError('tutorial review: regular bounded artifact required')
    raw = path.read_bytes()
    return raw, hashlib.sha256(raw).hexdigest()


def rect(value: object, width: int, height: int) -> dict:
    if type(value) is not dict or set(value) != {'x', 'y', 'width', 'height'} or any(type(v) is not int for v in value.values()) or \
            value['x'] < 0 or value['y'] < 0 or value['width'] < 1 or value['height'] < 1 or \
            value['x'] + value['width'] > width or value['y'] + value['height'] > height:
        raise ValidationError('tutorial review: physical client rect invalid')
    return value


def validate_sources(review: dict, snapshot: dict, snapshot_sha: str) -> dict:
    keys = {'protocol', 'version', 'reviewer', 'reviewed_at', 'source', 'snapshot_sha256', 'character', 'client_version',
            'state', 'npc_name', 'instruction', 'current_point', 'body_rect', 'name_rect', 'hint_rect'}
    if type(review) is not dict or set(review) != keys or review['protocol'] != 'wow-ui-tutorial-review' or review['version'] != 1 or \
            review['reviewer'] != 'claude' or review['state'] != 'tutorial_talk_jaina' or review['npc_name'] != NPC or review['instruction'] != INSTRUCTION:
        raise ValidationError('tutorial review: exact same-capture Claude review required')
    _time(review['reviewed_at'], 'tutorial review UTC annotation')
    validate_version(review['client_version'])
    if review['client_version'] != CLIENT or review['character'] != CHARACTER:
        raise ValidationError('tutorial review: six-dimensional client or character mismatch')
    if type(snapshot) is not dict or set(snapshot) != {'source', 'native', 'observation'} or review['snapshot_sha256'] != snapshot_sha or review['source'] != snapshot['source']:
        raise ValidationError('tutorial review: snapshot SHA or same-source binding mismatch')
    source, native, observation = (snapshot[k] for k in ('source', 'native', 'observation'))
    _validate(source, SCHEMA['definitions']['frame'])
    _validate(native, RESIDENT['definitions']['sample'], RESIDENT)
    _validate(observation, AGENT['definitions']['observation'], AGENT)
    frame, window = native['memory_frame'], native['window']
    target = {**frame['target']}; target['session_id'] = target.pop('windows_session_id')
    if source['producer'] != 'resident_wgc' or source['capture'] is None or source['target'] != target or frame['target_scope'] != 'retail_wow' or \
            target['session_id'] != 1 or not target['executable'].lower().endswith('\\_retail_\\wow.exe') or \
            target['class'] not in {'GxWindowClass', 'GxWindowClassD3d', 'waApplication Window'} or int(target['hwnd'], 16) == 0:
        raise ValidationError('tutorial review: original retail WoW source required')
    if source['observation_id'] != observation['id'] or source['observation_id'] != f'ui-{native["session_id"]}-{native["seq"]}' or \
            source['seq'] != native['seq'] or observation['observation_seq'] != native['seq'] or frame['seq'] != native['seq'] or \
            source['frame_id'] != frame['frame_id'] or source['layout_id'] != frame['layout_id'] or \
            source['width'] != frame['client_width'] or source['height'] != frame['client_height'] or \
            source.get('roi_sha256') != frame['roi_sha256'] or source['clock'] != {'domain': 'windows-qpc', 'clock_id': frame['windows_clock_id'], 'ticks': frame['source_qpc_ms'], 'unit': 'ms'}:
        raise ValidationError('tutorial review: original native frame/clock binding mismatch')
    if native['capture']['status'] != 'ok' or native['capture']['method'] != 'wgc' or native['artifact'] is not None or frame['full_frame_sha256'] is not None or \
            frame['source_qpc_ms'] != native['capture']['started_qpc_ms'] or frame['source_qpc_ms'] < native['capture']['request_received_qpc_ms'] or \
            native['local_clock']['at_ms'] < frame['source_qpc_ms']:
        raise ValidationError('tutorial review: original memory frame capture invalid')
    obs_window = observation['window']
    if not window['visible'] or window['minimized'] or not window['focused'] or obs_window is None or \
            any(window[key] != target[key] for key in ('pid', 'hwnd', 'class', 'executable', 'start_ticks')) or \
            obs_window['token'] != f'resident-ui-{target["pid"]}-{frame["channel_generation"]}' or \
            obs_window['hwnd'] != target['hwnd'] or obs_window['pid'] != target['pid'] or not obs_window['focused'] or \
            (window['client_width'], window['client_height']) != (source['width'], source['height']) or \
            (obs_window['client_width'], obs_window['client_height']) != (source['width'], source['height']):
        raise ValidationError('tutorial review: original client/window binding invalid')
    capture = observation['fields'].get('capture.available')
    if not capture or capture['status'] != 'known' or capture['value'] is not True or capture['source'] != 'cv' or \
            capture['source_observation_id'] != observation['id'] or capture.get('source_clock') != {'domain': 'windows-qpc', 'value_ms': frame['source_qpc_ms']} or \
            capture.get('capture_window', {}).get('earliest_ms') != capture['captured_at_ms'] or \
            capture.get('capture_window', {}).get('latest_ms') != observation['at_ms']:
        raise ValidationError('tutorial review: original observation source bracket invalid')
    from PIL import Image
    image_path = Path(source['capture']['path']); _, image_sha = read(image_path, 32 * 1024 * 1024)
    if image_sha != source['capture']['sha256']:
        raise ValidationError('tutorial review: original PNG SHA mismatch')
    with Image.open(image_path) as image:
        if image.format != 'PNG' or image.size != (source['width'], source['height']):
            raise ValidationError('tutorial review: original full PNG geometry invalid')
        image.load()
    body = rect(review['body_rect'], source['width'], source['height'])
    rect(review['name_rect'], source['width'], source['height']); rect(review['hint_rect'], source['width'], source['height'])
    point = review['current_point']
    if type(point) is not dict or set(point) != {'x', 'y'} or any(type(v) is not int for v in point.values()) or \
            not body['x'] <= point['x'] < body['x'] + body['width'] or not body['y'] <= point['y'] < body['y'] + body['height']:
        raise ValidationError('tutorial review: reviewed point outside same-source NPC body')
    return source


def register(database: Path, review_path: Path, snapshot_path: Path, world_directory: Path, output: Path,
             *, world_sha: str = WORLD_SHA, sqlite_sha: str = SQLITE_SHA) -> dict:
    review_bytes, review_sha = read(review_path); snapshot_bytes, snapshot_sha = read(snapshot_path)
    review, snapshot = parse_json(review_bytes), parse_json(snapshot_bytes)
    source = validate_sources(review, snapshot, snapshot_sha)
    with WorldPack(world_directory, expected_sha256=world_sha) as pack:
        if pack.manifest['database_sha256'] != sqlite_sha:
            raise ValidationError('tutorial review: frozen world SQLite binding mismatch')
        world_info = {'scope': pack.manifest['scope'], 'client_versions': pack.manifest['client_versions'], 'coverage': pack.manifest['coverage']}
    # Version descriptors represent what was actually used; no model/prompt or
    # learned snapshot is claimed merely to fill the runtime version fields.
    output.mkdir(parents=True, exist_ok=True)
    def descriptor(name, value):
        path = output / name; raw = (canonical(value) + '\n').encode()
        if path.exists() and path.read_bytes() != raw:
            raise ValidationError('tutorial review: immutable descriptor changed')
        if not path.exists():
            with path.open('xb') as f: f.write(raw)
        return path, hashlib.sha256(raw).hexdigest()
    code = descriptor('code-version.json', {'tool_sha256': read(Path(__file__))[1], 'resident_schema_sha256': read(Path(__file__).resolve().parent.parent / 'protocol/resident-session-v1.schema.json')[1]})
    no_prompt = descriptor('no-prompt.json', {'model_calls': 0, 'prompt': None, 'scope': 'same-capture reviewer adoption'})
    knowledge = descriptor('knowledge-reference.json', {'world_pack_sha256': world_sha, 'world_sqlite_sha256': sqlite_sha,
                            'review_sha256': review_sha, 'scope': 'frozen world reference and session-local same-capture fact; no learned release'})
    no_input = descriptor('no-input.json', {'input_count': 0, 'bindings': None, 'automatic_action_eligible': False})
    actor = f'session-local-alliance-warrior-xiao-he-{source["target"]["pid"]}-{source["target"]["start_ticks"]}'
    account = f'session-local-account-{source["target"]["pid"]}-{source["target"]["start_ticks"]}'
    run_id = f'tutorial-reviewed-{canonical_sha256({"review_sha256": review_sha, "snapshot_sha256": snapshot_sha})[:32]}'
    clock = deepcopy(source['clock']); session = deepcopy(source['target'])
    fact = {'local_key': 'exiles-reach.talk-jaina', 'kind': 'tutorial_step', 'predicate': 'interaction_instruction', 'state': 'known',
            'value': {'npc_name': NPC, 'instruction': INSTRUCTION, 'target_signature': f'visible-name:{NPC}'}}
    artifacts = [(Path(source['capture']['path']), 'image/png', source['capture']['sha256']), (review_path, 'application/json', review_sha),
                 (snapshot_path, 'application/json', snapshot_sha), *((path, 'application/json', sha) for path, sha in (code, no_prompt, knowledge, no_input))]
    run = {'run_id': run_id, 'client_version': CLIENT, 'world_pack_sha256': world_sha, 'world_sqlite_sha256': sqlite_sha,
           'code_sha256': code[1], 'prompt_sha256': no_prompt[1], 'knowledge_sha256': knowledge[1], 'bindings_sha256': no_input[1],
           'calibration_sha256': review_sha, 'actor_id': actor, 'task_id': 'tutorial-reviewed-knowledge-reference', 'revision': 1, 'epoch': 1,
           'mode': 'readonly', 'input_count_scope': 'none', 'started_at': review['reviewed_at']}
    with RuntimeDatabase(database) as runtime:
        with runtime._transaction():
            runtime.register_account(account, namespace='retail'); runtime.register_character(actor, account_id=account, namespace='retail'); runtime.create_run(run)
            for path, media, sha in artifacts:
                runtime.register_artifact(path, media_type=media, expected_sha256=sha)
            event = {'seq': 1, 'event_id': source['observation_id'], 'kind': 'observation', 'source_clock': clock,
                     'received_clock': {'domain': 'coordinator-monotonic', 'clock_id': snapshot['observation']['run_id'], 'ticks': snapshot['observation']['at_ms'], 'unit': 'ms'},
                     'observed_at': review['reviewed_at'], 'payload': {'evidence_scope': 'live_field', 'observation_id': source['observation_id'], 'session': session,
                         'capture_sha256': source['capture']['sha256'], 'calibration_sha256': review_sha, 'producer': 'root_reviewed_same_capture', 'local_assertions': [fact],
                         'snapshot_sha256': snapshot_sha, 'review_sha256': review_sha, 'reviewer': review['reviewer'], 'character': CHARACTER,
                         'actor_scope': 'session-local user-specified Alliance warrior; no account or character GUID asserted',
                         'reviewed_geometry': {k: review[k] for k in ('current_point', 'body_rect', 'name_rect', 'hint_rect')},
                         'native_frame_id': source['frame_id'], 'native_frame_seq': source['seq'], 'native_roi_sha256': source['roi_sha256'],
                         'source_time_scope': 'original Native source clock; review UTC is annotation, not capture time',
                         'calibration_scope': 'review artifact digest; no calibrated_cv or image template asserted', 'world_reference': world_info},
                     'artifact_sha256s': list(dict.fromkeys(sha for _, _, sha in artifacts))}
            event['event_sha256'] = canonical_sha256(event); runtime.index_events(run_id, [event])
            assertion = {'schema_version': 1, 'world_pack_sha256': world_sha, 'world_sqlite_sha256': sqlite_sha, 'client_version': CLIENT,
                         'actor_id': actor, 'session': session, 'fact': fact, 'observation_id': source['observation_id'], 'source_event': {'run_id': run_id, 'seq': 1, 'event_sha256': event['event_sha256']},
                         'source_clock': clock, 'observed_at': review['reviewed_at'], 'capture_sha256': source['capture']['sha256'], 'calibration_sha256': review_sha,
                         'producer': 'root_reviewed_same_capture', 'rule_version': 'local-field-evidence-v1'}
            validate_assertion(assertion); result = LocalAssertions(runtime, create=True).put(assertion)
    query = {'world_pack_sha256': world_sha, 'client_version': CLIENT, 'actor_id': actor, 'session': session, 'local_key': fact['local_key'],
             'predicate': fact['predicate'], 'as_of_clock': clock, 'maximum_age': 600000}
    return {'registered': True, **result, 'local_query': query, 'world_sqlite_sha256': sqlite_sha, 'original_source_clock': clock,
            'world_reference': world_info, 'world_current_client_applicability': 'reference_only' if CLIENT not in world_info['client_versions'] else 'manifest_lists_current_client',
            'source_observation_id': source['observation_id'], 'review_sha256': review_sha, 'snapshot_sha256': snapshot_sha,
            'input_count': 0, 'pngs_generated': 0, 'model_calls': 0, 'scope': 'low-frequency knowledge reference; fresh Native revalidation still required for input'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('database', 'review', 'snapshot', 'world-directory', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    try:
        result = register(args.database, args.review, args.snapshot, args.world_directory, args.out)
        print(canonical({'ok': True, 'result': result}))
    except Exception as error:
        print(canonical({'ok': False, 'error': str(error) if isinstance(error, ValidationError) else type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == '__main__': main()
