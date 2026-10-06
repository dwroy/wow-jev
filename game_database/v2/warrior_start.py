"""Prepare reference-only Warrior start cards from one pinned, read-only pack.

No observation, model, source download, import, or game input occurs here.
The report contains local-only source excerpts and belongs under ignored out/.
"""
from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
from pathlib import Path
from typing import Any

from ..store import ValidationError, _keys, canonical, canonical_sha256, parse_json
from .model import digest
from .pack import WorldPack

DEFAULT_SCENARIO = Path(__file__).resolve().parents[2] / 'game-data/scenarios/warrior-dragon-isles-start-v1.json'
_SCENARIO_KEYS = {'schema_version', 'scenario_id', 'class_intent', 'faction_intent', 'branch_intent', 'evidence_scope',
    'automatic_action_eligible', 'world_pack_sha256', 'world_sqlite_sha256', 'world_scope',
    'reference_quest_ids', 'faction_branches', 'tutorial_branches', 'required_start_paths', 'assumptions',
    'official_research', 'required_observation_fields'}


def load_scenario(path: str | Path = DEFAULT_SCENARIO) -> dict:
    return validate_scenario(parse_json(Path(path).read_bytes()))


def validate_scenario(value: Any) -> dict:
    _keys(value, _SCENARIO_KEYS, 'warrior start scenario')
    if (value['schema_version'] != 1 or value['class_intent'] != 'Warrior'
            or value['faction_intent'] != 'Alliance'
            or value['branch_intent'] != 'retail'
            or value['evidence_scope'] != 'offline_reference_preparation'
            or value['automatic_action_eligible'] is not False):
        raise ValidationError('warrior start: reference-only retail Warrior scenario required')
    if value['required_start_paths'] != ['exiles_reach_unfinished', 'waking_shores_entered']:
        raise ValidationError('warrior start: both unfinished tutorial and Waking Shores paths required')
    digest(value['world_pack_sha256'])
    digest(value['world_sqlite_sha256'])
    ids = value['reference_quest_ids']
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 64
            or any(type(i) is not int or i <= 0 for i in ids) or len(set(ids)) != len(ids)):
        raise ValidationError('warrior start: bounded unique quest IDs required')
    _keys(value['faction_branches'], {'Alliance', 'Horde'}, 'warrior faction branches')
    for branch in value['faction_branches'].values():
        _keys(branch, {'legacy_transfer_reference', 'arrival_group', 'continuation_reference'}, 'warrior faction branch')
        if (type(branch['legacy_transfer_reference']) is not int
                or not isinstance(branch['arrival_group'], list)
                or not isinstance(branch['continuation_reference'], list)):
            raise ValidationError('warrior start: typed faction quest references required')
        refs = [branch['legacy_transfer_reference'], *branch['arrival_group'], *branch['continuation_reference']]
        if not refs or any(type(i) is not int or i not in ids for i in refs):
            raise ValidationError('warrior start: faction quest outside pinned selection')
    for name in ('assumptions', 'required_observation_fields'):
        if not isinstance(value[name], list) or not value[name] or any(not isinstance(s, str) or not s for s in value[name]):
            raise ValidationError(f'warrior start: nonempty {name} required')
    return deepcopy(value)


def _unknown() -> dict:
    return {'state': 'unknown', 'value': None, 'evidence': []}


def warrior_profile_template(scenario: dict, sqlite_sha256: str) -> dict:
    return {'schema_version': 1, 'kind': 'warrior-field-calibration-template',
        'scenario_id': scenario['scenario_id'], 'world_pack_sha256': scenario['world_pack_sha256'],
        'world_sqlite_sha256': sqlite_sha256, 'enabled': False, 'automatic_action_eligible': False,
        'class_intent': {'state': 'user_declared', 'value': 'Warrior', 'evidence': []},
        'faction_intent': {'state': 'user_declared', 'value': scenario['faction_intent'], 'evidence': []},
        'client_version': {name: None for name in ('branch', 'expansion', 'patch', 'build', 'region', 'locale')},
        'character': {name: _unknown() for name in ('identity', 'class', 'faction', 'race', 'level', 'specialization')},
        'context': {name: _unknown() for name in ('tutorial_state', 'selected_campaign', 'zone', 'phase', 'quest_progress')},
        'capabilities': [{'id': name, 'state': 'unknown', 'enabled': False,
            'spell_id': None, 'available_at_observation': None, 'input_binding': None,
            'target_requirement': None, 'duration_ms': None, 'cooldown': None, 'evidence': []}
            for name in ('interact', 'select_target', 'primary_attack', 'charge', 'loot', 'ground_movement')],
        'input_geometry': _unknown(), 'cancel_release': _unknown(),
        'typed_quest_bindings': [], 'required_start_paths': scenario['required_start_paths'],
        'required_observation_fields': scenario['required_observation_fields']}


def prepare_warrior_start(directory: str | Path, *, expected_pack_sha256: str,
        expected_sqlite_sha256: str, scenario: dict | None = None) -> dict:
    """Return bounded source cards; current applicability is never promoted.

    Caller-supplied package/database identities must both match the scenario.
    Source builds/locales stay attached to individual assertions; they are not
    merged into a made-up client version or a executable quest objective.
    """
    scenario = validate_scenario(scenario) if scenario is not None else load_scenario()
    if (digest(expected_pack_sha256) != scenario['world_pack_sha256']
            or digest(expected_sqlite_sha256) != scenario['world_sqlite_sha256']):
        raise ValidationError('warrior start: scenario/package/database pin mismatch')
    with WorldPack(directory, expected_sha256=expected_pack_sha256) as pack:
        if (pack.manifest['database_sha256'] != expected_sqlite_sha256
                or pack.manifest['scope'] != scenario['world_scope']):
            raise ValidationError('warrior start: package database/scope mismatch')
        sources = {row['sha256']: parse_json(row['payload']) for row in
            pack.connection.execute('SELECT sha256,payload FROM source_revision ORDER BY sha256')}
        if set(sources) != set(pack.manifest['sources']):
            raise ValidationError('warrior start: manifest/source revision mismatch')
        for source in sources.values():
            if source['source_version']['branch'] not in {None, 'retail'}:
                raise ValidationError('warrior start: non-retail source version rejected')
        cards, missing, by_name, graph = [], [], defaultdict(set), []
        current_count, giver_count, objective_states = 0, 0, defaultdict(int)
        requested = scenario['faction_branches'][scenario['faction_intent']]
        candidate_ids = set(requested['arrival_group'] + requested['continuation_reference'])
        for quest_id in scenario['reference_quest_ids']:
            rows = pack.connection.execute("SELECT sha256,payload FROM assertion WHERE namespace='retail' AND kind='quest' AND native_id=? ORDER BY predicate,sha256", (quest_id,)).fetchall()
            assertions = [{**parse_json(row['payload']), 'assertion_sha256': row['sha256'],
                'source_revision': sources[parse_json(row['payload'])['source_sha256']]} for row in rows]
            if not assertions:
                missing.append(quest_id)
            names, raw_objectives, conditions, fields = [], [], [], defaultdict(list)
            for assertion in assertions:
                predicate = assertion['predicate']
                fields[predicate].append(assertion)
                current_count += bool(assertion['applicability'])
                if predicate == 'name' and assertion['state'] == 'known':
                    locale = assertion['source_revision']['source_version']['locale']
                    names.append({'text': assertion['value'], 'locale': locale,
                        'assertion_sha256': assertion['assertion_sha256'],
                        'source_sha256': assertion['source_sha256'], 'source_version': assertion['source_revision']['source_version']})
                    by_name[(locale, assertion['value'])].add(quest_id)
                if predicate == 'quest.objectives':
                    objective_states[assertion['state']] += 1
                if predicate == 'quest.givers' and assertion['state'] == 'known':
                    giver_count += len(assertion['value'])
                if predicate == 'tdb.objectives' and assertion['state'] == 'known':
                    for source_ordinal, objective in enumerate(assertion['value']):
                        raw_objectives.append({'source_ordinal': source_ordinal,
                            'assertion_sha256': assertion['assertion_sha256'],
                            'raw_record': deepcopy(objective),
                            'source_version': assertion['source_revision']['source_version'],
                            'executable': False, 'automatic_action_eligible': False,
                            'semantic_confirmation': 'unknown'})
                if predicate == 'att.source_condition':
                    conditions.append(assertion)
                    if assertion['state'] == 'known' and isinstance(assertion['value'], dict):
                        for dependency in assertion['value'].get('dependencies', []):
                            graph.append({'from': dependency['quest'], 'to': assertion['entity'],
                                'assertion_sha256': assertion['assertion_sha256'],
                                'relationship': 'sourceQuests_reference',
                                'availability': 'unknown', 'required_threshold': assertion['value'].get('required_threshold'),
                                'threshold_explicit': assertion['value'].get('threshold_explicit'),
                                'dependency_metadata': deepcopy(dependency)})
            factions = sorted({a['value'] for a in fields['faction'] if a['state'] == 'known' and isinstance(a['value'], str)})
            faction_assertions = fields['faction']
            if (not faction_assertions or any(a['state'] != 'known' or a['value'] is None
                    or a['condition'] != {'op': 'true'} for a in faction_assertions)):
                faction_status = 'unknown'
            elif len(factions) != 1:
                faction_status = 'conflict'
            else:
                faction_status = 'known'
            candidate = faction_status == 'known' and factions == ['alliance'] and quest_id in candidate_ids
            exclusion = ('source_faction_unknown' if faction_status == 'unknown' else
                'source_faction_conflict' if faction_status == 'conflict' else
                'other_faction_reference' if factions != ['alliance'] else 'legacy_or_unselected_reference')
            cards.append({'quest_key': {'namespace': 'retail', 'kind': 'quest', 'native_id': quest_id},
                'status': 'reference_only' if assertions else 'missing_local_reference',
                'names': names, 'faction_references': factions,
                'faction_filter': {'intent': scenario['faction_intent'], 'intent_evidence': 'user_declared',
                    'source_status': faction_status, 'included_in_reference_candidates': candidate,
                    'reason': 'explicit_alliance_source_reference' if candidate else exclusion,
                    'assertion_ids': [a['assertion_sha256'] for a in faction_assertions]},
                'raw_objectives': raw_objectives, 'source_condition_references': conditions,
                'fields': dict(fields), 'executable': False, 'automatic_action_eligible': False,
                'blockers': ['current_client_applicability_unverified', 'offered_quest_and_progress_unobserved',
                    'starter_finisher_roles_unverified', 'target_signature_and_ordinal_credit_unverified',
                    'warrior_ability_bindings_unverified']})
        ambiguities = [{'locale': locale, 'text': text, 'quest_ids': sorted(ids),
            'identity_rule': 'quest key + faction + exact current-client proof; never text alone'}
            for (locale, text), ids in sorted(by_name.items(), key=lambda item: (str(item[0][0]), item[0][1])) if len(ids) > 1]
        # No timestamp from this preparation can be mistaken for a game observation.
        report = {'schema_version': 1, 'kind': 'warrior-dragon-isles-local-preparation',
            'scenario_id': scenario['scenario_id'], 'scenario_sha256': canonical_sha256(scenario),
            'evidence_scope': 'offline_reference_preparation', 'distribution': 'local_only',
            'game_observation': False, 'model_calls': 0, 'real_inputs': 0,
            'executable': False, 'automatic_action_eligible': False,
            'world': {'world_pack_sha256': pack.sha256, 'world_sqlite_sha256': pack.manifest['database_sha256'],
                'scope': pack.manifest['scope'], 'distribution': pack.manifest['distribution'],
                'manifest_coverage': pack.manifest['coverage'], 'client_versions': pack.manifest['client_versions']},
            'counts': {'quest_cards': len(cards), 'missing_local_references': len(missing),
                'selected_applicable_assertions': current_count, 'selected_known_giver_roles': giver_count,
                'alliance_reference_candidates': sum(card['faction_filter']['included_in_reference_candidates'] for card in cards),
                'excluded_reference_cards': sum(not card['faction_filter']['included_in_reference_candidates'] for card in cards),
                'selected_normalized_objective_states': dict(objective_states)},
            'sources': sources, 'quest_cards': cards, 'missing_quest_ids': missing,
            'candidate_quest_cards': [card for card in cards if card['faction_filter']['included_in_reference_candidates']],
            'excluded_reference_quest_keys': [card['quest_key'] for card in cards if not card['faction_filter']['included_in_reference_candidates']],
            'candidate_scope': 'explicit Alliance source references; current applicability and availability unverified',
            'name_ambiguities': ambiguities, 'reference_dependency_graph': graph,
            'stage_cards': [
                {'id': 'identify', 'mode': 'read_only', 'requires': ['desktop_readonly_authorization'],
                    'collect': ['client.version.six_dimensions', 'character.identity', 'character.class',
                        'character.faction', 'character.race', 'character.level', 'tutorial.state', 'campaign.selected'],
                    'automatic_action_eligible': False},
                {'id': 'tutorial_transfer', 'mode': 'read_only', 'requires': ['identify'],
                    'collect': ['current tutorial quest IDs', 'current transfer event', 'arrival zone and phase'],
                    'local_reference_coverage': 'specific revised tutorial IDs unavailable',
                    'automatic_action_eligible': False},
                {'id': 'arrival_candidates', 'mode': 'read_only', 'requires': ['tutorial or existing progress evidenced'],
                    'candidate_quest_keys': [card['quest_key'] for card in cards if card['faction_filter']['included_in_reference_candidates']],
                    'other_faction_references': scenario['faction_branches']['Horde'],
                    'candidate_order': 'unordered arrival group',
                    'collect': ['offered/accepted quest IDs', 'starter/finisher roles', 'ordinal objective counters'],
                    'automatic_action_eligible': False},
                {'id': 'capability_and_effect', 'mode': 'read_only', 'requires': ['arrival_candidates'],
                    'collect': ['target identity/signature', 'available Warrior abilities and observed bindings',
                        'source clocks', 'input and effect evidence channels', 'reward identity and policy'],
                    'automatic_action_eligible': False},
                {'id': 'finite_comparison', 'mode': 'requires_separate_input_authorization',
                    'requires': ['complete current-client and task proof', 'bounded cancel/release verified',
                        'comparable single-layer and layered initial state', 'explicit finite-input authorization'],
                    'automatic_action_eligible': False}],
            'dependency_graph_availability': 'unknown', 'selected_tutorial_branch': 'unknown',
            'selected_faction_branch': scenario['faction_intent'], 'faction_selection_evidence': 'user_declared',
            'observed_faction': _unknown(), 'required_start_paths': scenario['required_start_paths'],
            'start_path_cards': [
                {'id': 'exiles_reach_unfinished', 'selection': 'pending_live_evidence', 'mode': 'read_only_first',
                    'required_evidence': ['tutorial incomplete', 'current Alliance Warrior identity',
                        'current tutorial quest IDs and progress', 'current transfer and Waking Shores arrival'],
                    'exact_tutorial_ids': 'unknown_in_local_pack', 'automatic_action_eligible': False},
                {'id': 'waking_shores_entered', 'selection': 'pending_live_evidence', 'mode': 'read_only_first',
                    'required_evidence': ['current Alliance Warrior identity', 'current Waking Shores zone and phase',
                        'offered/accepted current quest IDs and ordinal progress'],
                    'skip_or_force_legacy_transfer': False, 'automatic_action_eligible': False}],
            'faction_branches': scenario['faction_branches'],
            'tutorial_branches': scenario['tutorial_branches'], 'assumptions': scenario['assumptions'],
            'official_research': scenario['official_research'],
            'required_observation_fields': scenario['required_observation_fields']}
        return {'report': report, 'profile_template': warrior_profile_template(scenario, pack.manifest['database_sha256'])}


def write_preparation(result: dict, output: str | Path) -> dict:
    """Write local-only data into a new directory, never overwrite a prior run."""
    root = Path(output)
    root.mkdir(parents=True, exist_ok=False)
    files = {}
    for name, value in [('reference-report.json', result['report']), ('field-profile.template.json', result['profile_template'])]:
        data = canonical(value).encode()
        (root / name).write_bytes(data)
        files[name] = {'sha256': canonical_sha256(value), 'bytes': len(data)}
    manifest = {'schema_version': 1, 'kind': 'warrior-start-preparation-output',
        'distribution': 'local_only', 'world_pack_sha256': result['report']['world']['world_pack_sha256'],
        'world_sqlite_sha256': result['report']['world']['world_sqlite_sha256'],
        'scenario_sha256': result['report']['scenario_sha256'], 'files': files,
        'automatic_action_eligible': False, 'game_observation': False, 'real_inputs': 0}
    (root / 'preparation-manifest.json').write_text(canonical(manifest), encoding='utf-8')
    return manifest
