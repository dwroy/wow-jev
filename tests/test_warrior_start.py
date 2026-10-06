"""Synthetic-only preparation checks; no source downloads or client activity."""
import copy
import json
from pathlib import Path
import subprocess
import sys

import pytest

from game_database.store import ValidationError, canonical_sha256
from game_database.v2.pack import build_pack, file_sha
from game_database.v2.warrior_start import load_scenario, prepare_warrior_start, write_preparation
from tests.test_world_queries import world_bundle


@pytest.fixture
def preparation_world(tmp_path):
    _, bundle = world_bundle(tmp_path, references=True)
    base = copy.deepcopy(bundle['assertions'][0])
    quest = {'namespace': 'retail', 'kind': 'quest', 'native_id': 1001}
    bundle['assertions'].extend([
        {**base, 'entity': quest, 'predicate': 'faction', 'value': 'alliance'},
        {**base, 'entity': quest, 'predicate': 'att.source_condition', 'value': {
            'status': 'unknown', 'required_threshold': 1, 'threshold_explicit': False,
            'dependencies': [{'quest': {'namespace': 'retail', 'kind': 'quest', 'native_id': 1002},
                'definition_status': 'known', 'is_breadcrumb': None}]}},
        {**base, 'entity': quest, 'predicate': 'tdb.objectives', 'value': [{
            'fields': {'ID': 777, 'Type': 0, 'Amount': 8, 'ObjectID': 195597, 'Order': 0,
                'Flags': '0', 'Flags2': '0', 'VerifiedBuild': 69933},
            'normalized_semantics': 'creature_credit_event',
            'typed_target': {'namespace': 'retail', 'kind': 'creature', 'native_id': 195597},
            'raw_sha256': 'a' * 64, 'locator': 'Synthetic Type 0 row'}]},
    ])
    built = build_pack(bundle, tmp_path / 'world', evidence_root=tmp_path)
    scenario = load_scenario()
    scenario.update(world_pack_sha256=built['world_pack_sha256'],
        world_sqlite_sha256=built['manifest']['database_sha256'], world_scope=built['manifest']['scope'],
        reference_quest_ids=[1001, 1002, 1003, 9999],
        faction_branches={faction: {'legacy_transfer_reference': 1001, 'arrival_group': [1001, 1002],
            'continuation_reference': [1003]} for faction in ('Alliance', 'Horde')})
    return built, scenario


def prepare(world, **changes):
    built, scenario = world
    return prepare_warrior_start(built['directory'], expected_pack_sha256=built['world_pack_sha256'],
        expected_sqlite_sha256=built['manifest']['database_sha256'], scenario=scenario, **changes)


def test_reference_cards_keep_raw_counts_types_source_locale_and_unknown_graph(preparation_world):
    report = prepare(preparation_world)['report']
    card = report['quest_cards'][0]
    raw = card['raw_objectives'][0]
    assert raw['raw_record']['fields']['Type'] == 0
    assert raw['raw_record']['fields']['Amount'] == 8
    assert raw['raw_record']['normalized_semantics'] == 'creature_credit_event'
    assert raw['semantic_confirmation'] == 'unknown' and raw['executable'] is False
    assert all(name['locale'] == 'zh_CN' and name['source_version']['locale'] == 'zh_CN' for name in card['names'])
    assert card['faction_references'] == ['alliance']
    assert report['reference_dependency_graph'][0]['availability'] == 'unknown'
    assert report['reference_dependency_graph'][0]['threshold_explicit'] is False
    assert report['dependency_graph_availability'] == 'unknown'
    assert report['counts']['selected_applicable_assertions'] == 0
    assert report['world']['client_versions'] == []
    assert report['game_observation'] is False and report['real_inputs'] == report['model_calls'] == 0


def test_same_name_ambiguity_and_missing_reference_never_guess_observed_branch(preparation_world):
    report = prepare(preparation_world)['report']
    assert any(a['quest_ids'] == [1001, 1002] and a['locale'] == 'zh_CN' for a in report['name_ambiguities'])
    assert report['missing_quest_ids'] == [9999]
    assert report['quest_cards'][-1]['status'] == 'missing_local_reference'
    assert report['selected_faction_branch'] == 'Alliance'
    assert report['faction_selection_evidence'] == 'user_declared'
    assert report['observed_faction']['state'] == report['selected_tutorial_branch'] == 'unknown'
    assert all(c['automatic_action_eligible'] is False for c in report['quest_cards'] + report['stage_cards'])


def test_profile_has_no_assumed_keys_spell_ids_level_or_runtime_client(preparation_world):
    template = prepare(preparation_world)['profile_template']
    assert template['enabled'] is False
    assert set(template['client_version'].values()) == {None}
    assert template['character']['class'] == {'state': 'unknown', 'value': None, 'evidence': []}
    assert template['class_intent']['state'] == 'user_declared'
    assert template['faction_intent'] == {'state': 'user_declared', 'value': 'Alliance', 'evidence': []}
    assert template['character']['faction'] == {'state': 'unknown', 'value': None, 'evidence': []}
    assert template['character']['level']['value'] is None
    for capability in template['capabilities']:
        assert capability['state'] == 'unknown' and capability['enabled'] is False
        assert capability['spell_id'] is capability['input_binding'] is capability['duration_ms'] is None


@pytest.mark.parametrize('target', ['manifest.json', 'world.sqlite'])
def test_tampered_pack_or_database_rejected_without_output(preparation_world, target):
    built, _ = preparation_world
    path = Path(built['directory']) / target
    original = path.read_bytes()
    path.unlink(missing_ok=True)
    path.write_bytes(original + b' ')
    with pytest.raises(ValidationError, match='hash mismatch'):
        prepare(preparation_world)


def test_missing_pack_rejected(preparation_world):
    built, scenario = preparation_world
    with pytest.raises(ValidationError, match='invalid manifest'):
        prepare_warrior_start(Path(built['directory']) / 'missing', expected_pack_sha256=built['world_pack_sha256'],
            expected_sqlite_sha256=scenario['world_sqlite_sha256'], scenario=scenario)


@pytest.mark.parametrize('pin', ['world_pack_sha256', 'world_sqlite_sha256'])
def test_mixing_package_or_sqlite_identities_rejected(preparation_world, pin):
    built, original = preparation_world
    scenario = copy.deepcopy(original)
    scenario[pin] = 'f' * 64
    with pytest.raises(ValidationError, match='pin mismatch'):
        prepare_warrior_start(built['directory'], expected_pack_sha256=built['world_pack_sha256'],
            expected_sqlite_sha256=built['manifest']['database_sha256'], scenario=scenario)


def test_same_package_cannot_be_relabelled_as_other_scope(preparation_world):
    built, scenario = preparation_world
    scenario = {**scenario, 'world_scope': 'classic/other-version'}
    with pytest.raises(ValidationError, match='scope mismatch'):
        prepare_warrior_start(built['directory'], expected_pack_sha256=built['world_pack_sha256'],
            expected_sqlite_sha256=built['manifest']['database_sha256'], scenario=scenario)


def test_source_artifact_tamper_rejected(preparation_world):
    built, _ = preparation_world
    artifact = Path(built['directory']) / 'artifacts' / built['manifest']['artifacts'][0]['sha256']
    artifact.unlink()
    artifact.write_bytes(b'changed')
    with pytest.raises(ValidationError, match='artifact content hash mismatch'):
        prepare(preparation_world)


def test_valid_package_with_other_product_source_is_rejected(preparation_world, tmp_path):
    _, scenario = preparation_world
    _, other_bundle = world_bundle(tmp_path, references=True)
    source = other_bundle['sources'][0]
    source['source_version']['branch'] = 'classic-era'
    for assertion in other_bundle['assertions']:
        assertion['source_sha256'] = canonical_sha256(source)
    other = build_pack(other_bundle, tmp_path / 'other-world', evidence_root=tmp_path)
    scenario = {**scenario, 'world_pack_sha256': other['world_pack_sha256'],
        'world_sqlite_sha256': other['manifest']['database_sha256'], 'world_scope': other['manifest']['scope']}
    with pytest.raises(ValidationError, match='non-retail source version'):
        prepare_warrior_start(other['directory'], expected_pack_sha256=other['world_pack_sha256'],
            expected_sqlite_sha256=other['manifest']['database_sha256'], scenario=scenario)


def test_different_reference_builds_remain_separate_without_current_applicability(preparation_world, tmp_path):
    _, scenario = preparation_world
    _, bundle = world_bundle(tmp_path, references=True)
    older = copy.deepcopy(bundle['sources'][0])
    older['revision'] = 'Synthetic-different-build'
    older['source_version']['build'] = 69497
    bundle['sources'].append(older)
    base = copy.deepcopy(bundle['assertions'][0])
    bundle['assertions'].append({**base, 'source_sha256': canonical_sha256(older),
        'entity': {'namespace': 'retail', 'kind': 'quest', 'native_id': 1001},
        'predicate': 'tdb.objectives', 'value': [{'fields': {'Type': 1, 'Amount': 12, 'VerifiedBuild': 69497},
            'locator': 'Synthetic older-build record'}]})
    built = build_pack(bundle, tmp_path / 'mixed-reference-world', evidence_root=tmp_path)
    scenario = {**scenario, 'world_pack_sha256': built['world_pack_sha256'],
        'world_sqlite_sha256': built['manifest']['database_sha256'], 'world_scope': built['manifest']['scope']}
    report = prepare_warrior_start(built['directory'], expected_pack_sha256=built['world_pack_sha256'],
        expected_sqlite_sha256=built['manifest']['database_sha256'], scenario=scenario)['report']
    assert report['quest_cards'][0]['raw_objectives'][0]['source_version']['build'] == 69497
    assert report['quest_cards'][0]['names'][0]['source_version']['build'] == 69933
    assert report['world']['client_versions'] == []
    assert report['counts']['selected_applicable_assertions'] == 0
    assert all(card['automatic_action_eligible'] is False for card in report['quest_cards'])


def test_output_manifest_is_reproducible_local_only_and_never_overwritten(preparation_world, tmp_path):
    first, second = prepare(preparation_world), prepare(preparation_world)
    assert canonical_sha256(first) == canonical_sha256(second)
    root = tmp_path / 'out' / 'warrior'
    manifest = write_preparation(first, root)
    assert manifest['distribution'] == 'local_only' and manifest['real_inputs'] == 0
    for filename, info in manifest['files'].items():
        assert file_sha(root / filename) == info['sha256']
    with pytest.raises(FileExistsError):
        write_preparation(first, root)


def test_real_prepare_cli_uses_pins_and_does_not_touch_pack(preparation_world, tmp_path):
    built, scenario = preparation_world
    source_hashes = {name: file_sha(Path(built['directory']) / name) for name in ('manifest.json', 'world.sqlite')}
    scenario_path = tmp_path / 'scenario.json'
    scenario_path.write_text(json.dumps(scenario))
    output = tmp_path / 'out' / 'prepared'
    command = [sys.executable, '-B', '-m', 'tools.warrior_start_prepare', '--world-dir', built['directory'],
        '--world-sha', built['world_pack_sha256'], '--sqlite-sha', scenario['world_sqlite_sha256'],
        '--scenario', str(scenario_path), '--output-dir', str(output)]
    proc = subprocess.run(command, cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result['ok'] is True and result['executable'] is False
    assert all(file_sha(Path(built['directory']) / name) == sha for name, sha in source_hashes.items())
    rejected = subprocess.run(command, cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
    assert rejected.returncode == 2 and json.loads(rejected.stderr)['ok'] is False


@pytest.mark.parametrize('mutation', [
    {'automatic_action_eligible': True}, {'branch_intent': 'classic-era'},
    {'reference_quest_ids': [True]}, {'reference_quest_ids': [1001, 1001]},
    {'faction_intent': 'Horde'}, {'required_start_paths': ['waking_shores_entered']},
])
def test_unverified_or_mixed_client_scenario_is_rejected(preparation_world, mutation):
    built, original = preparation_world
    with pytest.raises(ValidationError):
        prepare_warrior_start(built['directory'], expected_pack_sha256=built['world_pack_sha256'],
            expected_sqlite_sha256=built['manifest']['database_sha256'], scenario={**original, **mutation})


def test_alliance_candidates_exclude_unknown_faction_without_name_or_branch_inference(preparation_world):
    report = prepare(preparation_world)['report']
    assert [card['quest_key']['native_id'] for card in report['candidate_quest_cards']] == [1001]
    unknown = next(card for card in report['quest_cards'] if card['quest_key']['native_id'] == 1002)
    assert unknown['faction_filter']['reason'] == 'source_faction_unknown'
    assert unknown['faction_filter']['included_in_reference_candidates'] is False
    assert any(a['quest_ids'] == [1001, 1002] for a in report['name_ambiguities'])


@pytest.mark.parametrize('other_faction, expected_status', [('horde', 'known'), ('alliance', 'conflict')])
def test_horde_or_conflicting_faction_card_is_preserved_but_not_adopted(preparation_world, tmp_path, other_faction, expected_status):
    _, scenario = preparation_world
    _, bundle = world_bundle(tmp_path, references=True)
    base = copy.deepcopy(bundle['assertions'][0])
    quest = {'namespace': 'retail', 'kind': 'quest', 'native_id': 1001}
    bundle['assertions'].append({**base, 'entity': quest, 'predicate': 'faction', 'value': 'horde'})
    if other_faction == 'alliance':
        bundle['assertions'].append({**base, 'entity': quest, 'predicate': 'faction', 'value': 'alliance'})
    built = build_pack(bundle, tmp_path / 'faction-world', evidence_root=tmp_path)
    scenario = {**scenario, 'world_pack_sha256': built['world_pack_sha256'],
        'world_sqlite_sha256': built['manifest']['database_sha256'], 'world_scope': built['manifest']['scope']}
    report = prepare_warrior_start(built['directory'], expected_pack_sha256=built['world_pack_sha256'],
        expected_sqlite_sha256=built['manifest']['database_sha256'], scenario=scenario)['report']
    card = report['quest_cards'][0]
    assert card['faction_filter']['source_status'] == expected_status
    assert card['faction_filter']['included_in_reference_candidates'] is False
    assert report['candidate_quest_cards'] == []
    assert 'horde' in card['faction_references']
    assert card['fields']['faction']


def test_both_start_paths_remain_pending_until_observed(preparation_world):
    prepared = prepare(preparation_world)
    report = prepared['report']
    paths = report['start_path_cards']
    assert [card['id'] for card in paths] == ['exiles_reach_unfinished', 'waking_shores_entered']
    assert all(card['selection'] == 'pending_live_evidence' and card['automatic_action_eligible'] is False for card in paths)
    assert paths[0]['exact_tutorial_ids'] == 'unknown_in_local_pack'
    assert paths[1]['skip_or_force_legacy_transfer'] is False
    assert prepared['profile_template']['required_start_paths'] == [card['id'] for card in paths]
    assert prepared['profile_template']['context']['tutorial_state']['state'] == 'unknown'
