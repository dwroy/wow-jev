"""Low-level index adapter for hashes already audited by the TypeScript learner.

Original JSONL/SQLite/knowledge files remain authority. SQL events contain small
references, not copied observations or inferred character progress. Recheck every
input byte hash before committing the single-writer transaction.
"""
from datetime import datetime, timedelta
from pathlib import Path
import hashlib
import sys

from ..runtime import RuntimeDatabase
from ..store import ValidationError, _keys, canonical, canonical_sha256, parse_json


def read(path, maximum=64 * 1024 * 1024):
    p = Path(path).absolute()
    if p.resolve(strict=True) != p or not p.is_file() or p.stat().st_size > maximum:
        raise ValidationError('layer index: ordinary bounded file without symlinks required')
    data = p.read_bytes()
    if len(data) > maximum:
        raise ValidationError('layer index: bytes limit')
    return data


def sha(data):
    return hashlib.sha256(data).hexdigest()


def dependencies(directory, manifest):
    """Only frozen evidence folders; never walk a registry or signing key."""
    paths = set()
    def folder(root):
        if root.resolve(strict=True) != root or not root.is_dir():
            raise ValidationError('layer index: dependency directory symlink')
        for p in root.rglob('*'):
            if p.is_symlink():
                raise ValidationError('layer index: dependency symlink')
            if p.is_file():
                paths.add(p)
    for name in ('code', 'prompts', 'world'):
        p = directory / name
        if p.exists(): folder(p)
    for name in ('runtime-version.json', 'knowledge.json', 'world-task-plan.json'):
        p = directory/name
        if p.exists(): paths.add(p)
    eye = manifest.get('supporting_eye')
    if eye:
        root = (directory/eye['directory']).resolve(strict=True)
        for name in ('manifest.json', 'events.jsonl', 'knowledge.json', 'runtime-version.json', 'client-profile.json', 'native-build.json',
                     'native-build-cache-proof.json', 'native-build.stdout.txt', 'native-build.stderr.txt'):
            p=root/name
            if p.exists(): paths.add(p)
        for name in ('artifacts', 'schemas', 'calibration', 'combat-calibration', 'npc-calibration', 'prompts', 'native-proof'):
            p=root/name
            if p.exists(): folder(p)
    if len(paths) > 8192:
        raise ValidationError('layer index: dependency file limit')
    return sorted(paths)


def index(request):
    _keys(request, {'schema_version', 'database', 'knowledge_file', 'knowledge_sha256', 'sources', 'evaluator_code_sha256'}, 'layers index request')
    if type(request['schema_version']) is not int or request['schema_version'] != 1:
        raise ValidationError('layer index: unsupported schema')
    knowledge_bytes = read(request['knowledge_file'])
    if sha(knowledge_bytes) != request['knowledge_sha256']:
        raise ValidationError('layer index: knowledge bytes changed')
    knowledge = parse_json(knowledge_bytes)
    if knowledge['schema_version'] != 2 or not knowledge['sources'] or any(s['kind'] != 'layers' for s in knowledge['sources']):
        raise ValidationError('layer index: nonempty v2 layers-only snapshot required')
    if type(request['sources']) is not dict or set(request['sources']) != {s['id'] for s in knowledge['sources']}:
        raise ValidationError('layer index: exact source directory mapping required')
    inputs = [(request['knowledge_file'], request['knowledge_sha256'])]
    if len(knowledge['sources']) > 256:
        raise ValidationError('layer index: source batch limit 256')
    indexed, references, manifests, source_rows = [], {}, {}, {}
    total_source_bytes = 0
    total_dependency_bytes = 0
    with RuntimeDatabase(request['database']) as db, db._transaction():
        db.register_artifact(request['knowledge_file'], media_type='application/json', expected_sha256=request['knowledge_sha256'])
        for source in knowledge['sources']:
            directory = Path(request['sources'][source['id']]).absolute()
            manifest_path, events_path = directory / 'manifest.json', directory / 'layers.jsonl'
            manifest_bytes, events_bytes = read(manifest_path, 2*1024*1024), read(events_path)
            total_source_bytes += len(manifest_bytes) + len(events_bytes)
            if total_source_bytes > 64 * 1024 * 1024:
                raise ValidationError('layer index: aggregate raw source limit')
            if sha(manifest_bytes) != source['manifest_sha256'] or sha(events_bytes) != source['events_sha256']:
                raise ValidationError('layer index: original source changed after strict replay')
            m = parse_json(manifest_bytes)
            if m['schema_version'] != 2 or m['mode'] != source['mode'] or m['world']['manifest_sha256'] != source['world']['manifest_sha256'] or m['client_version'] != source['client_version']:
                raise ValidationError('layer index: manifest/source binding mismatch')
            manifests[source['id']] = m
            if not events_bytes.endswith(b'\n'):
                raise ValidationError('layer index: incomplete raw log')
            lines = events_bytes[:-1].split(b'\n')
            if not 1 <= len(lines) <= 50000:
                raise ValidationError('layer index: raw line limit')
            rows = [parse_json(line) for line in lines]
            source_rows[source['id']] = rows
            if rows[0]['run_id'] != source['run_id'] or any(r['seq'] != i or r['run_id'] != source['run_id'] for i, r in enumerate(rows)):
                raise ValidationError('layer index: raw sequence/identity mismatch')
            artifacts = []
            for path, expected, media in [(manifest_path, source['manifest_sha256'], 'application/json'), (events_path, source['events_sha256'], 'application/x-ndjson'),
                (directory/'world/manifest.json', source['world']['manifest_sha256'], 'application/json'), (directory/'world/world.sqlite', source['world']['sqlite_sha256'], 'application/vnd.sqlite3')]:
                if sha(read(path)) != expected:
                    raise ValidationError('layer index: frozen artifact changed')
                db.register_artifact(path, media_type=media, expected_sha256=expected)
                artifacts.append(expected); inputs.append((str(path), expected))
            calibration = m['calibration_sha256'] or canonical_sha256(None)
            actor = m['actor']; namespace = m['quest_episode']['quest_key']['namespace']
            db.register_account(actor['account_id'], namespace=namespace)
            db.register_character(actor['character_id'], account_id=actor['account_id'], namespace=namespace)
            db.create_run({'run_id': source['run_id'], 'client_version': m['client_version'], 'world_pack_sha256': m['world']['manifest_sha256'], 'world_sqlite_sha256': m['world']['sqlite_sha256'],
                'code_sha256': m['code_sha256'], 'prompt_sha256': m['prompts_sha256'], 'knowledge_sha256': m['knowledge']['sha256'], 'bindings_sha256': m['bindings_sha256'],
                'calibration_sha256': calibration, 'actor_id': actor['character_id'], 'task_id': m['task']['id'], 'revision': m['task']['revision'], 'epoch': m['run_epoch'],
                'mode': m['mode'], 'input_count_scope': 'simulated' if m['mode'] == 'simulated' else 'physical', 'started_at': m['started_at']})
            events = []; start = datetime.fromisoformat(m['started_at'].replace('Z', '+00:00'))
            for i, row in enumerate(rows):
                clock = {'domain': m['clock']['domain'], 'clock_id': m['clock']['id'], 'ticks': row['at_ms'], 'unit': 'ms'}
                e = {'seq': i+1, 'event_id': f"layers:{source['run_id']}:{i}", 'kind': row['kind'], 'source_clock': clock, 'received_clock': clock,
                    'observed_at': (start + timedelta(milliseconds=row['at_ms']-rows[0]['at_ms'])).isoformat(),
                    'payload': {'source_format': 'strict_layers', 'source_id': source['id'], 'raw_record_seq': i, 'raw_record_sha256': row['sha256'], 'raw_line_sha256': sha(lines[i]),
                        'quest_episode_id': m['quest_episode']['id'], 'quest_phase': m['quest_episode']['phase']}, 'artifact_sha256s': artifacts}
                event_sha = canonical_sha256(e)
                events.append({**e, 'event_sha256': event_sha}); references[(source['id'], i)] = {'run_id': source['run_id'], 'seq': i+1, 'event_sha256': event_sha}
            deps = []
            for path in dependencies(directory, m):
                content = read(path); expected = sha(content); total_dependency_bytes += len(content)
                if total_dependency_bytes > 256 * 1024 * 1024:
                    raise ValidationError('layer index: aggregate dependency limit')
                existing = list(db.connection.execute('SELECT media_type FROM artifact WHERE sha256=?', (expected,)))
                db.register_artifact(path, media_type=existing[0][0] if existing else 'application/octet-stream', expected_sha256=expected)
                inputs.append((str(path), expected)); deps.append({'path': str(path), 'sha256': expected})
            for n in range(0, len(deps), 64):
                part = deps[n:n+64]; last = events[-1]
                e = {'seq': len(events)+1, 'event_id': f"layers-dependencies:{source['run_id']}:{n//64}", 'kind': 'layer_dependencies',
                     'source_clock': last['source_clock'], 'received_clock': last['received_clock'], 'observed_at': last['observed_at'],
                     'payload': {'source_format': 'strict_layers_dependencies', 'source_id': source['id'], 'dependencies': part}, 'artifact_sha256s': sorted({p['sha256'] for p in part})}
                events.append({**e, 'event_sha256': canonical_sha256(e)})
            parts = [db.index_events(source['run_id'], events[i:i+10000], world_pack_sha256=m['world']['manifest_sha256'], client_version=m['client_version']) for i in range(0, len(events), 10000)]
            db.declare_run_end(source['run_id'], len(events))
            indexed.append({'source_id': source['id'], 'events': len(events), 'raw_events': len(rows), 'dependency_events': len(events)-len(rows),
                'inserted': sum(p['inserted'] for p in parts), 'duplicates': sum(p['duplicates'] for p in parts)})
        candidates, skipped = [], []
        for fact in knowledge['facts']:
            positive, negative = [], []
            for ref in fact['evidence']:
                source = next(s for s in knowledge['sources'] if s['id'] == ref['source_id'])
                rows = source_rows[source['id']]
                result = rows[ref['record_seq']]['data']
                is_bad = result['status'] != 'completed' or result['release'] != 'confirmed' or result['input_count_scope'] != 'known' or result['scenario_effect' if source['mode'] == 'simulated' else 'game_effect'] != 'confirmed'
                (negative if is_bad else positive).append(references[(ref['source_id'], ref['record_seq'])])
            if not positive:
                skipped.append({'fact_id': fact['id'], 'reason': 'counterexample_only_no_positive_samples'}); continue
            m = manifests[fact['evidence'][0]['source_id']]; scope = fact['scope']; level = m['actor']['level']
            candidate = db.create_candidate({'candidate_id': 'layers-'+canonical_sha256([fact['id'], request['knowledge_sha256']]), 'revision': 1, 'world_pack_sha256': m['world']['manifest_sha256'], 'client_version': m['client_version'],
                'content': {'fact_id': fact['id'], 'knowledge_sha256': request['knowledge_sha256'], 'evidence_kind': 'strict_layers', 'scope': scope},
                'applicability': {'class': m['actor']['class'], 'specialization': m['actor']['spec'], 'level_min': level, 'level_max': level, 'capabilities': m['actor']['capabilities'],
                    'bindings_sha256': m['bindings_sha256'], 'calibration_sha256': m['calibration_sha256'] or canonical_sha256(None), 'task_revision': str(m['task']['revision']), 'route_revision': m['route_revision']},
                'samples': positive, 'counterexamples': negative})
            counts = {'live': 0, 'simulated': 0, 'readonly': 0}
            for ref in positive: counts[db.get_run(ref['run_id'])['mode']] += 1
            evaluation = db.register_evaluation({'evaluation_id': 'layers-'+candidate['candidate_sha256'], 'candidate_sha256': candidate['candidate_sha256'],
                'evaluator_code_sha256': request['evaluator_code_sha256'], 'outcome': 'accepted', 'metrics': {'scope': 'strict_evidence_index_only', 'game_benefit_verified': False,
                    'actual_game_sample_count': counts['live'], 'simulated_sample_count': counts['simulated']}, 'evaluated_at': knowledge['created_at'], 'sample_counts': counts})
            candidates.append({'candidate_sha256': candidate['candidate_sha256'], 'evaluation_sha256': evaluation['evaluation_sha256']})
        release = db.publish_knowledge({'release_id': knowledge['id'], 'content_sha256': request['knowledge_sha256'], 'code_sha256': request['evaluator_code_sha256'],
            'prompt_sha256': canonical_sha256(sorted({m['prompts_sha256'] for m in manifests.values()})), 'published_at': knowledge['created_at'], 'candidates': candidates}) if candidates else None
        if any(sha(read(path)) != expected for path, expected in inputs):
            raise ValidationError('layer index: source changed before commit')
        return {'runs': indexed, 'candidates': candidates, 'skipped_facts': skipped, 'release': release, 'protected_world_packs': db.protected_world_packs(),
            'protected_artifacts': db.protected_artifacts(), 'actual_game_samples': sum(db.get_evaluation(c['evaluation_sha256'])['sample_counts']['live'] for c in candidates),
            'simulated_samples': sum(db.get_evaluation(c['evaluation_sha256'])['sample_counts']['simulated'] for c in candidates)}


def main():
    try:
        raw = sys.stdin.buffer.read(1024*1024+1)
        if len(raw) > 1024*1024:
            raise ValidationError('layer index request limit')
        print(canonical({'ok': True, 'result': index(parse_json(raw))})); return 0
    except Exception as exc:
        print(canonical({'ok': False, 'error': str(exc) if isinstance(exc, (ValueError, OSError, RuntimeError)) else type(exc).__name__})); return 2


if __name__ == '__main__':
    raise SystemExit(main())
