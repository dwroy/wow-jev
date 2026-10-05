"""Fixed Dragon Isles selection: reference evidence, not current game facts."""
from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import Path
import re

from ..store import ValidationError, _keys, canonical, canonical_sha256, parse_json
from . import att, tdb
from .sources import PARSER_VERSION, SeedBuilder, fingerprint, key, verify_sources

DEFAULT_LOCK = Path(__file__).resolve().parents[2] / 'game-data/source-locks/dragon-isles-v2.json'
LOCALES = {'zhCN': 'zh_CN', 'zhTW': 'zh_TW', 'enUS': 'en_US', 'deDE': 'de_DE',
           'esES': 'es_ES', 'esMX': 'es_MX', 'frFR': 'fr_FR', 'itIT': 'it_IT',
           'koKR': 'ko_KR', 'ptBR': 'pt_BR', 'ruRU': 'ru_RU'}


def _selection(selection: dict) -> dict:
    _keys(selection, {'schema_version', 'scope', 'quest_ids', 'dependency_quest_ids', 'ui_maps', 'locale'}, 'seed selection')
    if selection['schema_version'] != 2 or selection['locale'] not in LOCALES.values():
        raise ValidationError('seed: unsupported selection schema/locale')
    for name in ('quest_ids', 'dependency_quest_ids'):
        ids = selection[name]
        if not isinstance(ids, list) or not ids or len(ids) > 64 or len(set(ids)) != len(ids):
            raise ValidationError('seed: unique bounded quest IDs required')
        for native_id in ids:
            key('quest', native_id)
    if set(selection['quest_ids']) & set(selection['dependency_quest_ids']):
        raise ValidationError('seed: selected/dependency identities overlap')
    if not isinstance(selection['ui_maps'], list) or not 1 <= len(selection['ui_maps']) <= 16:
        raise ValidationError('seed: bounded typed UI maps required')
    for m in selection['ui_maps']:
        _keys(m, {'constant', 'native_id', 'parent_id'}, 'seed map')
        key('ui_map', m['native_id'])
        if m['parent_id'] is not None:
            key('ui_map', m['parent_id'])
    return selection


def _faction(record: dict) -> str | None:
    races = record['fields'].get('races')
    if isinstance(races, dict):
        return {'ALLIANCE_ONLY': 'alliance', 'HORDE_ONLY': 'horde'}.get(races.get('symbol'))
    return None


def _associated_nodes(value):
    if isinstance(value, dict):
        if value.get('constructor') in {'o', 'i', 'n'} and value.get('args') and type(value['args'][0]) is int:
            yield value
        for child in value.values():
            yield from _associated_nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from _associated_nodes(child)


def _att_fields(builder: SeedBuilder, selected: set[int], dependencies: set[int], paths: dict,
                lock: dict, definitions: dict, constants: dict) -> None:
    artifact = builder.artifact(paths['att_quests'], media_type='text/x-lua')
    source = builder.source('att', role='author quest structure', note='No verified CN applicability; sourceQuests are not flattened.')
    rules_sha = lock['files']['att_rules']['sha256']
    for quest_id in sorted(selected | dependencies):
        entity = builder.entity('quest', quest_id)
        role = 'selected' if quest_id in selected else 'dependency_reference'
        records = definitions.get(quest_id, [])
        locator = f"{lock['files']['att_quests']['locator']}#q({quest_id})"
        builder.field(entity, 'seed.role', role, source=source, artifact=artifact, locator=locator)
        if not records:
            builder.field(entity, 'source.definition', None, source=source, artifact=artifact, locator=locator)
            builder.field(entity, 'quest.condition', {'op': 'unknown'}, source=source, artifact=artifact, locator=locator)
            continue
        for record in records:
            fields = record['fields']
            locator = f"{lock['files']['att_quests']['locator']}:line={record['line']}:q={quest_id}"
            builder.field(entity, 'att.record', {k: v for k, v in record.items() if k != 'name_comment'}, source=source, artifact=artifact, locator=locator)
            builder.field(entity, 'source.definition', 'author_record', source=source, artifact=artifact, locator=locator)
            builder.field(entity, 'att.name_comment', record['name_comment'], source=source, artifact=artifact, locator=locator)
            if record['name_comment']:
                english_source = builder.source('att', locale='en_US', role='author quest name comment',
                    note='Author English label; [A]/[H] annotation removed explicitly; original comment retained; no current client verification.')
                label = re.sub(r'\s*\[(?:A|H)\]$', '', record['name_comment'])
                builder.field(entity, 'name', label, source=english_source, artifact=artifact, locator=locator)
            builder.field(entity, 'faction', _faction(record), source=source, artifact=artifact, locator=locator)
            builder.field(entity, 'att.timeline', fields.get('timeline'), source=source, artifact=artifact, locator=locator)
            condition = att.source_condition(record, definitions, rules_sha)
            for dep in condition.get('dependencies', []):
                builder.entity('quest', dep['quest']['native_id'])
            builder.field(entity, 'att.source_condition', condition, source=source, artifact=artifact, locator=locator)
            builder.field(entity, 'quest.condition', {'op': 'unknown'}, source=source, artifact=artifact, locator=locator)
            provider = fields.get('provider')
            giver = None
            if isinstance(provider, list) and len(provider) == 2 and provider[0] in {'n', 'o', 'i'} and type(provider[1]) is int:
                target = builder.entity({'n': 'creature', 'o': 'game_object', 'i': 'item'}[provider[0]], provider[1])
                giver = [{'role': 'unknown', 'entity': target,
                          'source_rule': 'Framework.Processing.cs:2415 provider(n) to qgs; qgs does not independently prove starter/finisher role'}]
            builder.field(entity, 'quest.providers', giver, source=source, artifact=artifact, locator=locator)
            builder.field(entity, 'quest.givers', None, source=source, artifact=artifact, locator=locator)
            builder.field(entity, 'quest.finisher', None, source=source, artifact=artifact, locator=locator)
            coords = fields.get('coord')
            locations = None
            if isinstance(coords, list) and len(coords) == 3 and type(coords[2]) is int:
                map_entity = builder.entity('ui_map', coords[2])
                locations = [{'coordinate_space': 'ui_percent', 'map': map_entity, 'floor': None,
                              'x': coords[0], 'y': coords[1], 'z': None, 'accuracy': None,
                              'transform_revision': None, 'phase': {'op': 'unknown'}}]
            builder.field(entity, 'locations', locations, source=source, artifact=artifact, locator=locator)
            for node in _associated_nodes(fields.get('groups')):
                kind = {'o': 'game_object', 'i': 'item', 'n': 'creature'}[node['constructor']]
                associated = builder.entity(kind, node['args'][0])
                child_locator = locator + f":{node['constructor']}={node['args'][0]}"
                builder.field(associated, 'att.association', {'quest': entity, 'source_constructor': node['constructor'],
                              'meaning': 'source association only; not an objective/giver/required count'},
                              source=source, artifact=artifact, locator=child_locator)
                data = node['args'][1].get('fields', {}) if len(node['args']) > 1 and isinstance(node['args'][1], dict) else {}
                coords = data.get('coord')
                if isinstance(coords, list) and len(coords) == 3 and type(coords[2]) is int:
                    builder.field(associated, 'locations', [{'coordinate_space': 'ui_percent', 'map': builder.entity('ui_map', coords[2]),
                                  'floor': None, 'x': coords[0], 'y': coords[1], 'z': None, 'accuracy': None,
                                  'transform_revision': None, 'phase': {'op': 'unknown'}}],
                                  source=source, artifact=artifact, locator=child_locator)


def _maps(builder: SeedBuilder, selection: dict, paths: dict, lock: dict, constants: dict):
    evidence = att.read_map_hierarchy(paths['att_metadata_root'].read_text(), constants)
    artifact = builder.artifact(paths['att_metadata_root'], media_type='text/x-lua')
    source = builder.source('att', role='author UI-map hierarchy', note='UI maps are not world MapIDs or traversability evidence.')
    for m in selection['ui_maps']:
        if constants.get(m['constant']) != m['native_id']:
            raise ValidationError('seed: UI-map constant does not match fixed source')
        matching = [x for x in evidence if x['native_id'] == m['native_id'] and x['parent_id'] == m['parent_id']]
        if not matching:
            raise ValidationError('seed: map hierarchy not present in author source')
        entity = builder.entity('ui_map', m['native_id'])
        parent = builder.entity('ui_map', m['parent_id']) if m['parent_id'] is not None else None
        locator = f"{lock['files']['att_metadata_root']['locator']}:line={matching[0]['line']}"
        builder.field(entity, 'map.parent', parent, source=source, artifact=artifact, locator=locator)
        builder.field(entity, 'map.transform', None, source=source, artifact=artifact, locator=locator)
        builder.field(entity, 'map.floor', None, source=source, artifact=artifact, locator=locator)


def _tdb_snapshots(paths: dict, lock: dict, selected: set[int], definitions: dict, map_ids: set[int]):
    primary = tdb.read_dump(paths['tdb_world'], lock['files']['tdb_world']['sha256'], {
        'quest_template': {'ID': selected}, 'quest_template_locale': {'ID': selected},
        'quest_template_addon': {'ID': selected}, 'quest_objectives': {'QuestID': selected},
        'creature_queststarter': {'quest': selected}, 'creature_questender': {'quest': selected},
        'gameobject_queststarter': {'quest': selected}, 'gameobject_questender': {'quest': selected},
        'quest_poi': {'QuestID': selected}, 'quest_poi_points': {'QuestID': selected},
        'conditions': {'SourceEntry': selected, 'ConditionValue1': selected},
    })
    creatures, objects = set(), set()
    for records in definitions.values():
        for record in records:
            if record['quest_id'] not in selected:
                continue
            p = record['fields'].get('provider')
            if isinstance(p, list) and len(p) == 2 and p[0] in {'n', 'o'} and type(p[1]) is int:
                (creatures if p[0] == 'n' else objects).add(p[1])
            for node in _associated_nodes(record['fields'].get('groups')):
                if node['constructor'] in {'n', 'o'}:
                    (creatures if node['constructor'] == 'n' else objects).add(node['args'][0])
    objective_ids = set()
    for row in primary['rows']['quest_objectives']:
        r = row.values
        objective_ids.add(r['ID'])
        if r['Type'] in {0, 3} and r['ObjectID'] > 0:
            creatures.add(r['ObjectID'])
        elif r['Type'] == 2 and r['ObjectID'] > 0:
            objects.add(r['ObjectID'])
    for table in ('creature_queststarter', 'creature_questender'):
        creatures.update(r.values['id'] for r in primary['rows'][table])
    for table in ('gameobject_queststarter', 'gameobject_questender'):
        objects.update(r.values['id'] for r in primary['rows'][table])
    related = tdb.read_dump(paths['tdb_world'], lock['files']['tdb_world']['sha256'], {
        'creature_template': {'entry': creatures}, 'creature_template_locale': {'entry': creatures},
        'creature': {'id': creatures}, 'gameobject_template': {'entry': objects},
        'gameobject': {'id': objects}, 'quest_objectives_locale': {'ID': objective_ids},
    })
    tuning = {r.values['ContentTuningID'] for r in primary['rows']['quest_template']}
    hotfix = tdb.read_dump(paths['tdb_hotfix'], lock['files']['tdb_hotfix']['sha256'], {
        'ui_map': {'ID': map_ids}, 'ui_map_assignment': {'UiMapID': map_ids},
        'content_tuning': {'ID': tuning},
    })
    return primary, related, hotfix


def _tdb_fields(builder: SeedBuilder, selected: set[int], snapshots: tuple, artifact: str, selection: dict):
    primary, related, hotfix = snapshots
    rows = primary['rows']
    source_cache = {}
    def source(row, locale=None):
        build = row.values.get('VerifiedBuild')
        build = build if type(build) is int and build > 0 else None
        label = (build, locale, row.table)
        if label not in source_cache:
            source_cache[label] = builder.source('tdb', build=build, locale=locale, role=row.table,
                note='Derived evidence container holds exact original SQL byte ranges; archive/dump parents were hashed. Row VerifiedBuild is source provenance, not CN applicability.')
        return source_cache[label]
    def aggregate_source(records):
        # A single row's build cannot certify an array from multiple source builds.
        builds = {r.values.get('VerifiedBuild') if type(r.values.get('VerifiedBuild')) is int and r.values.get('VerifiedBuild') > 0 else None for r in records}
        common = next(iter(builds)) if len(builds) == 1 else None
        tables = '+'.join(sorted({r.table for r in records}))
        return builder.source('tdb', build=common, role=tables + ' aggregate',
            note='Aggregate source build is known only when every constituent row has the same VerifiedBuild. Individual row/point builds and byte locators remain in the value; no CN applicability.')
    fallback = builder.source('tdb', role='missing source rows', note='An absent source row is unknown, not proof of absent game content.')
    for qid in sorted(selected):
        entity = builder.entity('quest', qid)
        templates = [r for r in rows['quest_template'] if r.values['ID'] == qid]
        objectives = [r for r in rows['quest_objectives'] if r.values['QuestID'] == qid]
        pois = [r for r in rows['quest_poi'] if r.values['QuestID'] == qid]
        points = [r for r in rows['quest_poi_points'] if r.values['QuestID'] == qid]
        loc = f"TDB:{qid}:missing-source-row"
        if not templates:
            builder.field(entity, 'tdb.template', None, source=fallback, artifact=artifact, locator=loc)
        for row in templates:
            src = source(row)
            builder.field(entity, 'tdb.template', row.export(), source=src, artifact=artifact, locator=row.evidence['locator'])
            builder.field(entity, 'name', row.values.get('LogTitle'), source=source(row, 'en_US'), artifact=artifact, locator=row.evidence['locator'])
            builder.field(entity, 'tdb.race_mask', {'value': str(row.values['AllowableRaces']),
                          'sql_type': row.sql_types['AllowableRaces'], 'encoding': 'decimal_string'},
                          source=src, artifact=artifact, locator=row.evidence['locator'])
        for row in rows['quest_template_locale']:
            if row.values['ID'] != qid or LOCALES.get(row.values['locale']) != selection['locale']:
                continue
            builder.field(entity, 'name', row.values['LogTitle'], source=source(row, selection['locale']),
                          artifact=artifact, locator=row.evidence['locator'])
        parsed = []
        for row in sorted(objectives, key=lambda r: (r.values['Order'], r.values['ID'])):
            record = row.export()
            r = row.values
            target_kind = {0: 'creature', 1: 'item', 2: 'game_object', 3: 'creature', 5: 'spell', 10: 'area_trigger'}.get(r['Type'])
            target = builder.entity(target_kind, r['ObjectID']) if target_kind and r['ObjectID'] > 0 else None
            record.update(typed_target=target, normalized_semantics='creature_credit_event' if r['Type'] == 0 else 'item_count' if r['Type'] == 1 else 'unsupported',
                          optional=bool(r['Flags'] & 4), hidden=bool(r['Flags'] & 8), sequenced=bool(r['Flags'] & 2))
            parsed.append(record)
        src = aggregate_source(objectives) if objectives else fallback
        builder.field(entity, 'tdb.objectives', parsed or None, source=src, artifact=artifact,
                      locator=objectives[0].evidence['locator'] if objectives else loc)
        # The current core relation omits ID/order/flags and action semantics. Do not
        # lose these by mapping all creature-credit rows to combat or adding counts.
        builder.field(entity, 'quest.objectives', None, source=src, artifact=artifact, locator=loc,
                      state='unsupported' if objectives else 'unknown')
        addons = [r.export() for r in rows['quest_template_addon'] if r.values['ID'] == qid]
        builder.field(entity, 'tdb.quest_chain', addons or None, source=fallback, artifact=artifact, locator=loc)
        givers = []
        for table, kind, role in [('creature_queststarter', 'creature', 'starter'), ('creature_questender', 'creature', 'finisher'),
                                  ('gameobject_queststarter', 'game_object', 'starter'), ('gameobject_questender', 'game_object', 'finisher')]:
            for row in rows[table]:
                if row.values['quest'] == qid:
                    givers.append({'role': role, 'entity': builder.entity(kind, row.values['id']), 'original': row.export()})
        builder.field(entity, 'tdb.givers', givers or None, source=fallback, artifact=artifact, locator=loc)
        poi_records = []
        for row in pois:
            record = row.export()
            r = row.values
            world_map = builder.entity('world_map', r['MapID']) if r['MapID'] > 0 else None
            ui_map = builder.entity('ui_map', r['UiMapID']) if r['UiMapID'] > 0 else None
            coordinates = []
            for point in points:
                p = point.values
                if p['Idx1'] != r['Idx1']:
                    continue
                coordinates.append({'coordinate_space': 'world', 'map': world_map, 'floor': None,
                    'x': p['X'], 'y': p['Y'], 'z': p['Z'], 'accuracy': None, 'transform_revision': None,
                    'phase': {'op': 'unknown'}, 'original': point.export()})
            record.update(world_map=world_map, ui_map=ui_map, points=coordinates,
                          coordinate_warning='World coordinates are not UI percent; POI does not prove a giver, path or navigable area.')
            poi_records.append(record)
        builder.field(entity, 'tdb.poi', poi_records or None, source=aggregate_source([*pois,*points]) if pois else fallback,
                      artifact=artifact, locator=pois[0].evidence['locator'] if pois else loc)
        conditions = [r.export() for r in rows['conditions'] if r.values['SourceEntry'] == qid or r.values['ConditionValue1'] == qid]
        builder.field(entity, 'tdb.conditions', conditions or None, source=fallback, artifact=artifact, locator=loc)
    for table, kind in [('creature_template', 'creature'), ('gameobject_template', 'game_object')]:
        for row in related['rows'][table]:
            entity = builder.entity(kind, row.values['entry'])
            builder.field(entity, 'tdb.template', row.export(), source=source(row), artifact=artifact, locator=row.evidence['locator'])
    for row in related['rows']['creature_template_locale']:
        if LOCALES.get(row.values['locale']) == selection['locale']:
            entity = builder.entity('creature', row.values['entry'])
            builder.field(entity, 'name', row.values['Name'], source=source(row, selection['locale']), artifact=artifact, locator=row.evidence['locator'])
    for table, kind in [('creature', 'creature'), ('gameobject', 'game_object')]:
        for row in related['rows'][table]:
            entity = builder.entity(kind, row.values['id'])
            builder.field(entity, 'tdb.spawn', row.export(), source=source(row), artifact=artifact, locator=row.evidence['locator'])
    for table in ('ui_map', 'ui_map_assignment', 'content_tuning'):
        # Preserve empty-table coverage and raw rows. They supply no transform in this snapshot.
        if hotfix['rows'][table]:
            entity = builder.entity('ui_map', selection['ui_maps'][0]['native_id'])
            builder.field(entity, 'tdb.' + table, [r.export() for r in hotfix['rows'][table]],
                          source=fallback, artifact=artifact, locator='TDB:hotfix:' + table)


def _coverage(bundle: dict, selection: dict, definitions: dict, snapshots: tuple, lock: dict) -> dict:
    sources = {canonical_sha256(s): s for s in bundle['sources']}
    by_entity = defaultdict(lambda: defaultdict(list))
    for a in bundle['assertions']:
        if a['entity']['kind'] == 'quest':
            by_entity[a['entity']['native_id']][a['predicate']].append(a)
    def field(fields, predicate):
        values = fields.get(predicate, [])
        if predicate in {'name', 'alias', 'description'}:
            values = [a for a in values if sources[a['source_sha256']]['source_version']['locale'] == selection['locale']]
        known = [a for a in values if a['state'] == 'known']
        distinct = {canonical(a['value']) for a in known}
        states = {a['state'] for a in values}
        state = 'conflict' if len(distinct) > 1 else 'known' if known else 'unsupported' if states == {'unsupported'} else 'not_present' if states == {'not_present'} else 'unknown'
        return {'state': state, 'assertion_ids': sorted(canonical_sha256(a) for a in values),
                'reference_only': True, 'applicable_to_current_client': False}
    reports = []
    for qid in sorted(selection['quest_ids']):
        fields = by_entity[qid]
        report = {'quest_id': qid, 'name': field(fields, 'name'), 'faction': field(fields, 'faction'),
                  'source_condition': {**field(fields, 'att.source_condition'), 'evaluation': 'unknown'},
                  'author_provider': field(fields, 'quest.providers'), 'giver': field(fields, 'quest.givers'), 'finisher': field(fields, 'quest.finisher'),
                  'objective': {**field(fields, 'tdb.objectives'), 'scope':'raw_source_record'}, 'count': {**field(fields, 'tdb.objectives'), 'scope':'raw_source_record'},
                  'normalized_objective': {**field(fields, 'quest.objectives'), 'scope':'normalized_action', 'automatic_action_eligible':False},
                  'locations': field(fields, 'locations'), 'conflicts': [],
                  'current_69933_verified': False, 'automatic_action_eligible': False}
        for predicate, assertions in fields.items():
            groups = defaultdict(list)
            for a in assertions:
                if a['state'] == 'known':
                    locale = sources[a['source_sha256']]['source_version']['locale'] if predicate in {'name', 'alias', 'description'} else None
                    groups[canonical({'locale': locale, 'condition': a['condition']})].append(a)
            for context, known in groups.items():
                if len({canonical(a['value']) for a in known}) > 1:
                    report['conflicts'].append({'predicate': predicate, 'context': parse_json(context),
                                               'assertion_ids': sorted(canonical_sha256(a) for a in known)})
        objectives = next((a['value'] for a in fields.get('tdb.objectives', []) if a['state'] == 'known'), [])
        report['objective_records'] = len(objectives)
        report['count']['records'] = [{'objective_id': o['fields']['ID'], 'count': o['fields']['Amount'],
                                      'optional': o['optional'], 'hidden': o['hidden']} for o in objectives]
        report['count']['total'] = None
        report['missing'] = ['normalized_objective_action', 'verified_availability', 'finisher', 'live_spawn', 'floor', 'phase', 'map_transform', 'accuracy', 'current_client_applicability']
        report['missing'] += [name for name in ('name', 'faction', 'giver', 'objective', 'locations') if report[name]['state'] == 'unknown']
        if not fields.get('tdb.conditions') or all(a['state'] != 'known' for a in fields['tdb.conditions']):
            report['missing'].append('tdb_condition_rows')
        reports.append(report)
    return {'schema_version': 2, 'scope': selection['scope'], 'parser_version': PARSER_VERSION,
            'source_lock_sha256': canonical_sha256(lock), 'selection_sha256': canonical_sha256(selection),
            'quests': reports, 'selected_quests': len(reports), 'dependency_quests': len(selection['dependency_quest_ids']),
            'coverage': {name: dict(Counter(r[name]['state'] for r in reports)) for name in ('name', 'faction', 'source_condition', 'author_provider', 'giver', 'objective', 'count', 'normalized_objective', 'locations')},
            'confirmed_starter_quests': 0, 'confirmed_finisher_quests': 0,
            'source_tables': [{'row_counts': s['row_counts'], 'selected_rows': {k: len(v) for k, v in s['rows'].items()}} for s in snapshots],
            'current_69933_verified': 0, 'reference_only_assertions': len(bundle['assertions']),
            'distribution': 'local_only', 'license': {'ATT': lock['att']['license'], 'TDB': lock['tdb']['license'],
            'boundary': 'TDB archive has no embedded license; source/code licensing does not independently license Blizzard game data.'},
            'incremental_semantics': 'added/changed/removed/withdrawn describe source evidence; source deletion never proves game nonexistence',
            'automatic_action_eligible': False}


def build_dragon_isles_seed(source_root: str | Path, selection_path: str | Path, *,
                           source_lock_path: str | Path | None = None) -> dict:
    """Return bundle/coverage/evidence_root; no database, model, network or input call.

    Default source names/hashes are fixed in game-data/source-locks. The optional
    explicit lock is useful for independently labelled synthetic test sources.
    Parents are completely hashed for every import; WorldPack reads only small
    immutable SQL byte-range evidence containers and ATT originals thereafter.
    """
    source_root = Path(source_root).resolve()
    selection = _selection(parse_json(Path(selection_path).read_bytes()))
    lock = parse_json(Path(source_lock_path or DEFAULT_LOCK).read_bytes())
    paths = verify_sources(source_root, lock)
    before = {role: fingerprint(p) for role, p in paths.items()}
    constants = {**att.constant_assignments(paths['att_maps'].read_text()),
                 **att.constant_assignments(paths['att_timeline'].read_text())}
    race_text = paths['att_races'].read_text()
    if not all(re.search(r'^' + symbol + r'\s*=\s*\{', race_text, re.M) for symbol in ('ALLIANCE_ONLY', 'HORDE_ONLY')):
        raise ValidationError('ATT: faction symbol definitions missing')
    definitions = att.read_quests(paths['att_quests'].read_text(), constants)
    selected, dependencies = set(selection['quest_ids']), set(selection['dependency_quest_ids'])
    builder = SeedBuilder(source_root, selection['scope'], lock)
    # Evidence of the fixed parsing rules/licensing is included, not executed.
    for role in ('att_maps', 'att_timeline', 'att_races', 'att_rules', 'att_compiler', 'att_shortcuts', 'att_license', 'tdb_license'):
        builder.artifact(paths[role], media_type='text/plain')
    _maps(builder, selection, paths, lock, constants)
    _att_fields(builder, selected, dependencies, paths, lock, definitions, constants)
    snapshots = _tdb_snapshots(paths, lock, selected, definitions, {m['native_id'] for m in selection['ui_maps']})
    identity = {'parser_version': PARSER_VERSION, 'source_lock_sha256': canonical_sha256(lock),
                'selection_sha256': canonical_sha256(selection), 'archive_sha256': lock['files']['tdb_archive']['sha256']}
    parent_paths = {paths[role].name: paths[role] for role in ('tdb_world', 'tdb_hotfix')}
    parent_hashes = {paths[role].name: lock['files'][role]['sha256'] for role in ('tdb_world', 'tdb_hotfix')}
    name = '.derived/dragon-isles-' + canonical_sha256(identity) + '.source-ranges.jsonl'
    evidence_path, _ = tdb.write_slices(source_root, name, list(snapshots), parent_paths, parent_hashes, identity)
    artifact = builder.artifact(evidence_path, media_type='application/vnd.wow-jev.source-ranges+jsonl')
    _tdb_fields(builder, selected, snapshots, artifact, selection)
    if any(fingerprint(p) != before[role] for role, p in paths.items()):
        raise ValidationError('source: parent changed during import')
    verify_sources(source_root, lock)
    bundle = builder.finish()
    return {'bundle': bundle, 'coverage': _coverage(bundle, selection, definitions, snapshots, lock),
            'evidence_root': str(source_root)}
