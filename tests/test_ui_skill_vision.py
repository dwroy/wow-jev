"""Synthetic PNG and injected fake provider only: no keys, desktop or network."""
import copy
import hashlib
import json
from pathlib import Path
import time

from PIL import Image
import pytest

from perception import ui_skill_vision as uv


def unknown():
    return {"status": "unknown", "value": None, "confidence": 0}


def model(scene="world", confidence=.98):
    return {"schema_version": 4, "coordinate_convention": "wow_client_xyxy_0_1000", "scene": scene, "confidence": confidence, "stop_reason": None,
            "controls": [{"id": name, "status": "unknown", "bbox": None, "label": None, "confidence": 0}
                         for name in uv.CONTROLS],
            "anchors": [{"label": "实际场景独立标识", "bbox": {"x1": 820, "y1": 80, "x2": 940, "y2": 120}, "confidence": .99}],
            "selected_character": unknown(), "tutorial": {k: unknown() for k in ("instruction", "npc_name", "dialog_state")}}


def provider(value):
    return {"choices": [{"message": {"role": "assistant", "content": json.dumps(value, ensure_ascii=False)}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 34}}


@pytest.fixture
def sample(tmp_path):
    png = tmp_path / "synthetic.png"
    Image.new("RGB", (64, 48), (30, 50, 80)).save(png)
    sha = hashlib.sha256(png.read_bytes()).hexdigest()
    return {"png_path": png, "png_sha256": sha, "output_dir": tmp_path / "output",
            "source": {"observation_id": "effect-native-1", "capture_sha256": sha, "width": 64, "height": 48,
                       "source_qpc_ms": 987.25, "observed_windows_qpc_ms": 987.25, "clock_id": "native-clock-1",
                       "target": {"pid": 99, "start_ticks": "12345", "hwnd": "0xabc", "class": "waApplication Window", "session_id": 1,
                                  "executable": "C:\\Games\\World of Warcraft\\_retail_\\Wow.exe"}}}


def worker(value, calls=None, **kwargs):
    def transport(payload, *_):
        if calls is not None:
            calls.append(payload)
        return provider(value)
    return uv.UiSkillVision(allow_upload=True, transport=transport,
                            credential_loader=lambda _: ("unit-test-fake-secret", uv.recovery.MODEL), **kwargs)


def test_v4_versions_coordinates_while_preserving_old_v3_contract():
    assert uv.PROMPT_VERSION == "ui-skill-retail-v6"
    assert (uv.ROOT / "schemas/ui-skill-vision-v3.schema.json").read_bytes() == (uv.ROOT / "schemas/ui-skill-vision-v2.schema.json").read_bytes()
    prompt = (uv.ROOT / "prompts/ui-skill-retail-v3.txt").read_text()
    assert prompt.startswith((uv.ROOT / "prompts/ui-skill-retail-v2.txt").read_text())
    assert "width=(R-L)/W" in prompt and "height=(B-T)/H" in prompt
    assert '"width":0.12,"height":0.04' in prompt
    assert uv.validate_model_output(json.dumps(model()))["anchors"][0]["rect"]["width"] == .12
    schema = json.loads(uv.SCHEMA_PATH.read_text())
    assert schema["properties"]["schema_version"]["const"] == 4
    assert schema["properties"]["coordinate_convention"]["const"] == "wow_client_xyxy_0_1000"
    assert set(schema["definitions"]["bbox"]["required"]) == {"x1", "y1", "x2", "y2"}


@pytest.mark.parametrize("rect", [
    {"x": .82, "y": .08, "width": .94, "height": .12},
    {"x": .8, "y": .8, "width": .9, "height": .9},
    {"x": .82, "y": .08, "right": .94, "bottom": .12},
])
def test_bad_anchor_geometry_is_rejected_preserved_and_never_silently_repaired(sample, rect):
    value = model(); value["anchors"][0]["rect"] = rect
    before = copy.deepcopy(value); calls = []
    result = worker(value, calls).analyze_effect(expected_state="in_world", **sample)
    assert result["status"] == "unknown" and result["model_result"] is None
    assert result["visual_effect"]["status"] == "unknown" and not result["candidate_controls"]
    assert len(calls) == 2 and result["api_calls"]["attempted"] == 2
    raw = sample["output_dir"] / "model-output-unvalidated.txt"
    assert json.loads(raw.read_text()) == before == value
    assert result["model_output_artifact"]["sha256"] == hashlib.sha256(raw.read_bytes()).hexdigest()


@pytest.mark.parametrize("expected,scene", [("in_world", "world"), ("game_menu", "game_menu"), ("char_select", "character_select")])
def test_readonly_effect_reuses_exact_original_source_and_records_scene_only(sample, expected, scene):
    before = copy.deepcopy(sample["source"]); calls = []
    result = worker(model(scene), calls).analyze_effect(expected_state=expected, **sample)
    effect = result["visual_effect"]
    assert result["status"] == "ok" and effect["status"] == "recognized"
    assert effect["state_id"] == expected and effect["scene"] == scene
    assert effect["source"] == result["source"] == sample["source"] == before
    assert effect["source_observation_id"] == before["observation_id"] and effect["capture_sha256"] == before["capture_sha256"]
    assert effect["source"]["source_qpc_ms"] == 987.25
    assert effect["game_effect"] == "unverified" and effect["input_authority"] is False
    assert effect["requires_independent_post_input_source_check"] is True
    assert result["prompt_version"] == "ui-skill-retail-v6" and len(calls) == 1
    out = sample["output_dir"]
    assert json.loads((out / "result.json").read_text()) == result
    assert json.loads((out / "effect-result.json").read_text()) == effect
    analysis = (out / "analysis-result.json").read_bytes()
    assert effect["analysis_artifact"]["sha256"] == hashlib.sha256(analysis).hexdigest()
    assert "visual_effect" not in json.loads(analysis)
    assert (out / "original.png").read_bytes() == sample["png_path"].read_bytes()
    effect["source"]["source_qpc_ms"] = 1000000
    assert sample["source"] == before and result["source"] == before


@pytest.mark.parametrize("scene", ["loading", "queue", "tutorial_controls_intro", "game_menu", "character_select"])
def test_expected_world_never_turns_loading_overlay_or_other_scene_into_world(sample, scene):
    result = worker(model(scene)).analyze_effect(expected_state="in_world", **sample)
    assert result["status"] == "ok" and result["visual_effect"]["status"] == "unknown"
    assert result["visual_effect"]["state_id"] is None and result["visual_effect"]["game_effect"] == "unverified"


@pytest.mark.parametrize("kind", ["scene", "anchor", "missing_anchor"])
def test_effect_requires_scene_and_independent_anchor_confidence_at_least_095(sample, kind):
    value = model()
    if kind == "scene": value["confidence"] = .949
    elif kind == "anchor": value["anchors"][0]["confidence"] = .949
    else: value["anchors"] = []
    result = worker(value).analyze_effect(expected_state="in_world", **sample)
    assert result["visual_effect"]["status"] == "unknown"


@pytest.mark.parametrize("scene,reason,stop", [("blocked_auth", "auth", "credentials"), ("blocked_auth", "verification", "two_factor"),
                                              ("blocked_terms", "terms", "terms"), ("blocked_update", "update", "update")])
def test_effect_keeps_hard_stops_ahead_of_expected_state(sample, scene, reason, stop):
    value = model(scene); value["stop_reason"] = reason
    result = worker(value).analyze_effect(expected_state="in_world", **sample)
    assert result["status"] == "ok" and result["visual_effect"]["status"] == "blocked"
    assert result["visual_effect"]["hard_stop"] == stop and result["visual_effect"]["state_id"] is None
    assert result["input_authority"] is False and not result["candidate_controls"]


def test_pure_classifier_revalidates_geometry_and_mapping_instead_of_trusting_summary(sample):
    result = worker(model()).analyze(**sample)
    assert uv.classify_effect(result, "in_world")["status"] == "recognized"
    forged = copy.deepcopy(result); forged["model_result"]["anchors"][0]["rect"]["width"] = .94
    assert uv.classify_effect(forged, "in_world")["status"] == "unknown"
    forged = copy.deepcopy(result); forged["image_mapping"]["original_sha256"] = "f" * 64
    assert uv.classify_effect(forged, "in_world")["status"] == "unknown"
    with pytest.raises(uv.seed.Failure, match="unsupported_effect_state"):
        uv.classify_effect(result, "world")


def test_effect_output_does_not_overwrite_prior_invocation(sample):
    instance = worker(model())
    instance.analyze_effect(expected_state="in_world", **sample)
    before = {p.name: p.read_bytes() for p in sample["output_dir"].iterdir()}
    result = instance.analyze_effect(expected_state="game_menu", **sample)
    assert result["reason"]["code"] == "output_already_exists" and result["visual_effect"]["status"] == "unknown"
    assert before == {p.name: p.read_bytes() for p in sample["output_dir"].iterdir()}


def test_cli_expected_state_writes_readonly_effect_summary(sample, monkeypatch, capsys):
    instance = worker(model("game_menu"))
    monkeypatch.setattr(uv, "UiSkillVision", lambda **_: instance)
    source_file = sample["png_path"].with_suffix(".json"); source_file.write_text(json.dumps(sample["source"]))
    code = uv.main(["--png", str(sample["png_path"]), "--png-sha256", sample["png_sha256"], "--source", str(source_file),
                    "--out", str(sample["output_dir"]), "--allow-game-image-upload", "--expected-state", "game_menu"])
    result = json.loads(capsys.readouterr().out)
    assert code == 0 and result["visual_effect"]["state_id"] == "game_menu"
    assert result == json.loads((sample["output_dir"] / "result.json").read_text())


def test_disabled_effect_cli_reads_no_source_image_credentials_or_network(tmp_path, monkeypatch, capsys):
    def forbidden(*_): raise AssertionError("unauthorized IO")
    monkeypatch.setattr(uv.recovery, "png_to_jpeg", forbidden)
    instance = uv.UiSkillVision(credential_loader=forbidden, transport=forbidden)
    monkeypatch.setattr(uv, "UiSkillVision", lambda **_: instance)
    code = uv.main(["--png", "/absent.png", "--png-sha256", "invalid", "--source", "/absent.json", "--out", str(tmp_path / "disabled"),
                    "--expected-state", "in_world"])
    result = json.loads(capsys.readouterr().out)
    assert code == 1 and result["status"] == "disabled" and result["api_calls"]["attempted"] == 0
    assert result["visual_effect"]["status"] == "unknown" and result["visual_effect"]["source"] is None


def test_timeout_is_one_request_and_never_a_post_input_confirmation(sample):
    def slow(*_): time.sleep(.1); return provider(model())
    instance = uv.UiSkillVision(allow_upload=True, timeout=.01, transport=slow,
                              credential_loader=lambda _: ("unit-test-fake-secret", uv.recovery.MODEL))
    result = instance.analyze_effect(expected_state="in_world", **sample)
    assert result["reason"]["code"] == "timeout" and result["api_calls"]["attempted"] == 1
    assert result["visual_effect"]["status"] == "unknown" and result["visual_effect"]["game_effect"] == "unverified"


@pytest.mark.parametrize("bbox", [
    {"x1": -1, "y1": 0, "x2": 1000, "y2": 1000},
    {"x1": 0, "y1": 0, "x2": 1001, "y2": 1000},
    {"x1": 900, "y1": 0, "x2": 800, "y2": 1000},
    {"x1": 800, "y1": 0, "x2": 800, "y2": 1000},
    {"x1": 0, "y1": 900, "x2": 1000, "y2": 800},
    {"x1": 0.82, "y1": .08, "x2": .94, "y2": .12},
    {"x1": True, "y1": 0, "x2": 1000, "y2": 1000},
    {"x": .82, "y": .08, "width": .12, "height": .04},
])
def test_v4_does_not_guess_scale_order_or_width_height(bbox):
    value = model(); value["anchors"][0]["bbox"] = bbox
    before = copy.deepcopy(value)
    with pytest.raises(uv.seed.Failure): uv.validate_model_output(json.dumps(value))
    assert value == before


def test_v4_legacy_schema_and_missing_coordinate_convention_are_not_repaired():
    normalized = uv.validate_model_output(json.dumps(model()))
    with pytest.raises(uv.seed.Failure): uv.validate_model_output(json.dumps(normalized))
    wrong = model(); wrong["coordinate_convention"] = "normalized_0_1"
    with pytest.raises(uv.seed.Failure): uv.validate_model_output(json.dumps(wrong))
    wrong = model(); wrong["schema_version"] = 1
    with pytest.raises(uv.seed.Failure): uv.validate_model_output(json.dumps(wrong))


def test_v4_mechanical_conversion_keeps_raw_and_versioned_hashes_as_proposals(sample):
    value = model("game_menu")
    control = next(c for c in value["controls"] if c["id"] == "logout")
    control.update(status="known", bbox={"x1": 400, "y1": 700, "x2": 600, "y2": 800}, label="返回角色选择", confidence=.99)
    result = worker(value).analyze(**sample)
    assert result["status"] == "ok" and result["candidate_controls"] == ["logout"]
    normalized = next(c for c in result["model_result"]["controls"] if c["id"] == "logout")
    assert normalized["rect"] == {"x": .4, "y": .7, "width": .2, "height": .1}
    assert result["model_result"]["anchors"][0]["rect"] == {"x": .82, "y": .08, "width": .12, "height": .04}
    assert result["candidate_authority"] == "proposal_only" and result["input_authority"] is False
    assert result["requires_pixel_ocr_revalidation_before_input"] is True
    mapping = result["coordinate_mapping"]; out = sample["output_dir"]
    assert mapping["status"] == "converted" and mapping["source_schema_version"] == 4 and mapping["target_schema_version"] == 1
    assert mapping["raw_model_output_artifact"]["sha256"] == hashlib.sha256((out / "model-output-unvalidated.txt").read_bytes()).hexdigest()
    assert json.loads((out / "model-output-unvalidated.txt").read_text()) == value
    assert mapping["normalized_model_output_artifact"]["sha256"] == hashlib.sha256((out / "model-result.json").read_bytes()).hexdigest()
    rules = json.dumps(uv.COORDINATE_CONVERSION, sort_keys=True, separators=(",", ":")).encode()
    assert mapping["conversion_sha256"] == hashlib.sha256(rules).hexdigest()
    assert mapping == json.loads((out / "coordinate-conversion.json").read_text())
    assert result == json.loads((out / "result.json").read_text())
    assert uv.normalize_bbox({"x1": 0, "y1": 0, "x2": 1000, "y2": 1000}) == {"x": 0, "y": 0, "width": 1, "height": 1}
    assert uv.normalize_bbox({"x1": 999, "y1": 999, "x2": 1000, "y2": 1000}) == {"x": .999, "y": .999, "width": .001, "height": .001}


def test_v4_conversion_does_not_relax_anchor_control_overlap():
    value = model("game_menu")
    control = next(c for c in value["controls"] if c["id"] == "logout")
    control.update(status="known", bbox=copy.deepcopy(value["anchors"][0]["bbox"]), label="返回角色选择", confidence=.99)
    with pytest.raises(uv.seed.Failure, match="anchor_overlaps_control"): uv.validate_model_output(json.dumps(value))

def test_v5_prompt_keeps_v4_geometry_and_blocks_enter_world_behind_any_central_modal():
    prompt=(uv.ROOT/'prompts/ui-skill-retail-v5.txt').read_text()
    assert prompt.startswith((uv.ROOT/'prompts/ui-skill-retail-v4.txt').read_text())
    assert '中央有任何模态对话框' in prompt and 'enter_world必须unknown/null/0' in prompt
    assert '"schema_version":4' in prompt and '十三控件必须全部保留' in prompt


def test_ui_v5_actual_request_json_mode_retry_same_source_and_v4_converter(sample):
    calls=[]; before=copy.deepcopy(sample['source'])
    def transport(payload, *_):
        calls.append(copy.deepcopy(payload))
        if len(calls)==1: return {'choices':[{'message':{'role':'assistant','content':'{"broken":'},'finish_reason':'stop'}]}
        return provider(model())
    result=uv.UiSkillVision(allow_upload=True,transport=transport,credential_loader=lambda _:('unit-test-fake-secret',uv.recovery.MODEL)).analyze(**sample)
    assert result['status']=='ok' and result['api_calls']['attempted']==2
    assert result['source']==before and result['coordinate_mapping']['source_schema_version']==4
    assert all(c['response_format']=={'type':'json_object'} for c in calls)
    assert result['model_result']['anchors'][0]['rect']=={'x':.82,'y':.08,'width':.12,'height':.04}
    assert '0–1000整数' in calls[0]['messages'][1]['content'][1]['text']
    assert result['candidate_authority']=='proposal_only' and result['requires_pixel_ocr_revalidation_before_input'] is True

REAL_CONTRACT_PATH = Path(__file__).parent / 'fixtures/ui_skill_vision_contract_controls19.json'


def test_real_controls19_contract_mechanical_typing_keeps_overlapping_anchor_rejection():
    raw = REAL_CONTRACT_PATH.read_text()
    canonical, audit = uv.normalize_model_contract(raw)
    assert canonical['controls'][-1]['bbox'] == {'x1':450,'y1':805,'x2':550,'y2':845}
    assert canonical['tutorial']['dialog_state'] == {'status':'known','value':'closed','confidence':1}
    assert len(audit['changes']) == 17 and audit['original_object_sha256'] == hashlib.sha256(raw.encode()).hexdigest()
    assert audit['coordinate_bounds_changed'] is False and audit['symbol_or_value_guessing'] is False
    with pytest.raises(uv.seed.Failure, match='anchor_overlaps_control'):
        uv.validate_model_output(raw)
    assert json.loads(raw)['controls'][-1]['bbox']['x1'] == '450'


@pytest.mark.parametrize('text', ['0','000','450','1000'])
def test_explicit_ascii_decimal_strings_only_mechanically_become_integers(text):
    value=model();value['anchors'][0]['bbox']['x1']=text
    canonical,audit=uv.normalize_model_contract(json.dumps(value))
    assert type(canonical['anchors'][0]['bbox']['x1']) is int and canonical['anchors'][0]['bbox']['x1']==int(text,10)
    assert audit['changes'][0]['original']==text and audit['changes'][0]['operation']=='ascii_decimal_string_to_integer'


@pytest.mark.parametrize('text', ['+450','-1',' 450','450 ','4.5e2','450px','４５０','450.0','','1001','00000'])
def test_ambiguous_signed_whitespace_exponent_units_unicode_or_outside_coordinate_strings_reject(text):
    value=model();value['anchors'][0]['bbox']['x1']=text
    with pytest.raises(uv.seed.Failure,match='invalid_ascii_integer_coordinate'):
        uv.normalize_model_contract(json.dumps(value))


@pytest.mark.parametrize('state', ['open','closed'])
def test_only_unambiguous_dialog_status_shorthand_converts_without_changing_confidence(state):
    value=model();value['tutorial']['dialog_state']={'status':state,'value':None,'confidence':.7}
    canonical,audit=uv.normalize_model_contract(json.dumps(value))
    assert canonical['tutorial']['dialog_state']=={'status':'known','value':state,'confidence':.7}
    assert audit['changes'][0]['operation']=='explicit_open_closed_status_to_known_value'
    value['tutorial']['dialog_state']['value']='open' if state=='closed' else 'closed'
    with pytest.raises(uv.seed.Failure,match='invalid_dialog_state'):
        uv.normalize_model_contract(json.dumps(value))


def test_contract_schema_retry_keeps_original_real_output_mapping_and_source(sample):
    raw=REAL_CONTRACT_PATH.read_text();corrected=json.loads(raw)
    corrected['anchors']=[{'label':'单独Logo证据','bbox':{'x1':10,'y1':10,'x2':100,'y2':100},'confidence':.99}]
    calls=[]
    def transport(payload,*_):
        calls.append(copy.deepcopy(payload))
        if len(calls)==1:return {'choices':[{'message':{'role':'assistant','content':raw},'finish_reason':'stop'}]}
        return provider(corrected)
    before=copy.deepcopy(sample['source'])
    result=uv.UiSkillVision(allow_upload=True,transport=transport,credential_loader=lambda _:('unit-test-fake-secret',uv.recovery.MODEL)).analyze(**sample)
    assert result['status']=='ok' and result['api_calls']['attempted']==2
    assert result['source']==before==sample['source'] and calls[0]['messages'][1]==calls[1]['messages'][1]
    assert result['request_attempts'][0]['reason']['code']=='anchor_overlaps_control'
    assert result['contract_normalization'][0]['semantic_validation_status']=='failed'
    assert len(result['contract_normalization'][0]['changes'])==17
    assert result['model_result']['tutorial']['dialog_state']=={'status':'known','value':'closed','confidence':1}
    out=sample['output_dir'];assert (out/'model-output-unvalidated.txt').read_text()==raw
    assert json.loads((out/'contract-normalization.json').read_text())==result['contract_normalization']
    assert result['input_authority'] is False and result['requires_pixel_ocr_revalidation_before_input'] is True
