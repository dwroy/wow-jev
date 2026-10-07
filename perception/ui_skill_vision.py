"""Learned UI slow observation of an existing PNG; no input or capture authority."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from pathlib import Path
import sys

from . import recovery_vision as recovery
from . import seed_worker as seed

PROMPT_VERSION = "ui-skill-retail-v6"
ROOT = Path(__file__).resolve().parent
SCHEMA_PATH = ROOT / "schemas" / "ui-skill-vision-v4.schema.json"
SCENES = recovery.SCENES | {"game_menu", "logout_countdown", "queue", "tutorial_controls_intro"}
CONTROLS = recovery.CONTROLS + ("game_menu", "logout", "exit_game", "return_game", "cancel_logout", "tutorial_confirm")
EFFECT_SCENES = {"in_world": "world", "game_menu": "game_menu", "char_select": "character_select"}
MINIMUM_EFFECT_CONFIDENCE = 0.95
COORDINATE_CONVERSION = {
    "version": "ui-skill-xyxy-to-xywh-v1", "source_schema_version": 4, "target_schema_version": 1,
    "source_convention": "wow_client_xyxy_0_1000", "target_convention": "wow_client_normalized_xywh_0_1",
    "source_bounds": "integer 0<=x1<x2<=1000 and 0<=y1<y2<=1000",
    "formula": "x=x1/1000;y=y1/1000;width=(x2-x1)/1000;height=(y2-y1)/1000",
    "repair": "none", "input_authority": False, "requires_pixel_ocr_revalidation_before_input": True,
}


def validate_model(raw):
    # The existing internal normalized contract remains strict and unchanged.
    return recovery.validate_model(raw, SCENES, CONTROLS)


def normalize_bbox(bbox):
    seed.exact_object(bbox, {"x1", "y1", "x2", "y2"})
    if any(type(bbox[key]) is not int or not 0 <= bbox[key] <= 1000 for key in bbox):
        raise seed.Failure("invalid_v4_xyxy_bbox")
    if bbox["x1"] >= bbox["x2"] or bbox["y1"] >= bbox["y2"]:
        raise seed.Failure("invalid_v4_xyxy_bbox")
    return {"x": bbox["x1"] / 1000, "y": bbox["y1"] / 1000,
            "width": (bbox["x2"] - bbox["x1"]) / 1000, "height": (bbox["y2"] - bbox["y1"]) / 1000}


def normalize_model_contract(raw):
    """Mechanical v4 canonicalization only; no coordinate or meaning repair."""
    value = seed.strict_json(raw)
    seed.exact_object(value, {"schema_version", "coordinate_convention", "scene", "confidence", "stop_reason",
                              "controls", "anchors", "selected_character", "tutorial"})
    if type(value["schema_version"]) is not int or value["schema_version"] != 4:
        raise seed.Failure("unsupported_ui_model_schema")
    if value["coordinate_convention"] != COORDINATE_CONVERSION["source_convention"]:
        raise seed.Failure("unsupported_ui_coordinate_convention")
    value = copy.deepcopy(value)
    changes = []
    for collection in ("controls", "anchors"):
        if not isinstance(value[collection], list):
            raise seed.Failure("invalid_controls_or_anchors")
        for index, part in enumerate(value[collection]):
            if not isinstance(part, dict):
                raise seed.Failure("invalid_fields")
            bbox = part.get("bbox")
            if bbox is None and collection == "controls":
                continue
            seed.exact_object(bbox, {"x1", "y1", "x2", "y2"})
            for key in bbox:
                original = bbox[key]
                if type(original) is str:
                    if not re.fullmatch(r"[0-9]{1,4}", original, flags=re.ASCII) or not 0 <= int(original, 10) <= 1000:
                        raise seed.Failure("invalid_ascii_integer_coordinate")
                    bbox[key] = int(original, 10)
                    changes.append({"path": f"{collection}[{index}].bbox.{key}", "original": original,
                                    "canonical": bbox[key], "operation": "ascii_decimal_string_to_integer"})
    tutorial = value.get("tutorial")
    if not isinstance(tutorial, dict):
        raise seed.Failure("invalid_fields")
    dialog = tutorial.get("dialog_state")
    if isinstance(dialog, dict) and type(dialog.get("status")) is str and dialog.get("status") in {"open", "closed"}:
        seed.exact_object(dialog, {"status", "value", "confidence"})
        if dialog["value"] is not None or not recovery.finite(dialog["confidence"]):
            raise seed.Failure("invalid_dialog_state")
        original = copy.deepcopy(dialog)
        dialog["value"], dialog["status"] = dialog["status"], "known"
        changes.append({"path": "tutorial.dialog_state", "original": original, "canonical": copy.deepcopy(dialog),
                        "operation": "explicit_open_closed_status_to_known_value"})
    canonical = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()
    return value, {"version": "ui-v4-mechanical-contract-v1", "source_schema_version": 4, "target_schema_version": 4,
                   "original_object_sha256": hashlib.sha256(raw.encode()).hexdigest(), "canonical_wire_sha256": hashlib.sha256(canonical).hexdigest(),
                   "changes": changes, "status": "normalized" if changes else "unchanged", "coordinate_bounds_changed": False,
                   "symbol_or_value_guessing": False, "input_authority": False}


def validate_model_output(raw):
    """Accept only explicit v4 geometry after audited mechanical typing."""
    value, _ = normalize_model_contract(raw)
    normalized = copy.deepcopy(value)
    normalized["schema_version"] = 1
    del normalized["coordinate_convention"]
    if not isinstance(value["controls"], list) or not isinstance(value["anchors"], list):
        raise seed.Failure("invalid_controls_or_anchors")
    for original, converted in zip(value["controls"], normalized["controls"]):
        seed.exact_object(original, {"id", "status", "bbox", "label", "confidence"})
        converted["rect"] = normalize_bbox(original["bbox"]) if original["bbox"] is not None else None
        del converted["bbox"]
    for original, converted in zip(value["anchors"], normalized["anchors"]):
        seed.exact_object(original, {"label", "bbox", "confidence"})
        converted["rect"] = normalize_bbox(original["bbox"])
        del converted["bbox"]
    # Reuse unchanged recovery semantics for controls, independent anchors,
    # blocked states, identity and confidence after the mechanical conversion.
    return validate_model(json.dumps(normalized, ensure_ascii=False, allow_nan=False))


def classify_effect(result, expected_state):
    """Recognize an analyzed source's scene, without input causality or freshness.

    The caller must independently bind this source to the post-input frame and
    check its original clock. This function performs no IO or time refresh.
    """
    if expected_state not in EFFECT_SCENES:
        raise seed.Failure("unsupported_effect_state")
    if not isinstance(result, dict):
        raise seed.Failure("invalid_vision_result")
    summary = {
        "type": "ui_skill_effect_observation", "schema_version": 1,
        "status": "unknown", "expected_state": expected_state,
        "state_id": None, "scene": None, "confidence": 0, "hard_stop": None,
        "source": None, "source_observation_id": None, "capture_sha256": None,
        "input_authority": False, "game_effect": "unverified",
        "verification_scope": "source_bound_visual_scene_only",
        "requires_independent_post_input_source_check": True,
        "original_observation_time_preserved": True,
        "prompt_version": result.get("prompt_version"),
        "prompt_sha256": result.get("prompt_sha256"),
        "model_schema_sha256": result.get("model_schema_sha256"),
        "api_calls": copy.deepcopy(result.get("api_calls")),
        "reason": "visual_observation_unavailable",
    }
    if result.get("status") != "ok" or result.get("input_authority") is not False:
        return summary
    try:
        source = result["source"]
        source = recovery.validate_source(source, source["capture_sha256"])
        model = validate_model(json.dumps(result["model_result"], ensure_ascii=False, allow_nan=False))
        mapping = result["image_mapping"]
        if (mapping.get("original_sha256") != source["capture_sha256"] or
                mapping.get("width") != source["width"] or mapping.get("height") != source["height"]):
            raise seed.Failure("effect_image_source_mismatch")
    except (seed.Failure, KeyError, TypeError, ValueError, AttributeError):
        summary["reason"] = "effect_source_or_model_invalid"
        return summary
    summary.update(source=source, source_observation_id=source["observation_id"],
                   capture_sha256=source["capture_sha256"], scene=model["scene"], confidence=model["confidence"])
    if model["stop_reason"] is not None:
        stops = {"auth": "credentials", "verification": "two_factor", "terms": "terms", "update": "update"}
        summary.update(status="blocked", hard_stop=stops[model["stop_reason"]], reason="visual_hard_stop")
        return summary
    if model["scene"] != EFFECT_SCENES[expected_state]:
        summary["reason"] = "expected_scene_not_observed"
        return summary
    if model["confidence"] < MINIMUM_EFFECT_CONFIDENCE or not model["anchors"] or not any(
            anchor["confidence"] >= MINIMUM_EFFECT_CONFIDENCE for anchor in model["anchors"]):
        summary["reason"] = "scene_or_independent_anchor_not_confident"
        return summary
    summary.update(status="recognized", state_id=expected_state, reason="source_bound_scene_observed")
    return summary


class UiSkillVision(recovery.RecoveryVision):
    def __init__(self, **kwargs):
        super().__init__(prompt_version=PROMPT_VERSION, prompt_path=ROOT / "prompts" / (PROMPT_VERSION + ".txt"),
                         schema_path=SCHEMA_PATH, model_validator=validate_model_output,
                         coordinate_instruction="bbox只用0–1000整数{x1,y1,x2,y2}角坐标，x2/y2是右/下边界，不是width/height。", **kwargs)

    def analyze(self, **kwargs):
        result = super().analyze(**kwargs)
        normalization = []
        output = Path(kwargs["output_dir"])
        for attempt in result.get("request_attempts", []):
            artifact = attempt.get("model_output_artifact")
            if not artifact:
                continue
            audit = {"attempt": attempt["index"], "raw_model_output_artifact": copy.deepcopy(artifact),
                     "semantic_validation_status": attempt["status"], "semantic_failure": attempt.get("reason")}
            try:
                raw = (output / artifact["file"]).read_text(encoding="utf-8")
                extracted, _ = recovery.first_json_object(raw)
                canonical_wire, details = normalize_model_contract(extracted)
                audit.update(details)
                wire_path = output / ("contract-canonical-wire-" + str(attempt["index"]) + ".json")
                wire_bytes = json.dumps(canonical_wire, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()
                with wire_path.open("xb") as stream:
                    stream.write(wire_bytes)
                audit["canonical_wire_artifact"] = {"file": wire_path.name, "sha256": hashlib.sha256(wire_bytes).hexdigest()}
            except (seed.Failure, OSError) as error:
                audit.update(status="rejected", reason=getattr(error, "code", "artifact_unavailable"), input_authority=False)
            normalization.append(audit)
        conversion = copy.deepcopy(COORDINATE_CONVERSION)
        encoded = json.dumps(COORDINATE_CONVERSION, sort_keys=True, separators=(",", ":")).encode("utf-8")
        conversion["conversion_sha256"] = hashlib.sha256(encoded).hexdigest()
        conversion["implementation_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        conversion["status"] = "converted" if result["status"] == "ok" else "rejected" if result.get("model_output_artifact") else "not_attempted"
        conversion["raw_model_output_artifact"] = copy.deepcopy(result.get("model_output_artifact"))
        output = Path(kwargs["output_dir"])
        stored = output / "result.json"
        if result.get("reason", {}).get("code") != "output_already_exists" and stored.is_file():
            if seed.strict_json(stored.read_bytes()) == result:
                if result["status"] == "ok":
                    normalized = output / "model-result.json"
                    conversion["normalized_model_output_artifact"] = {"file": normalized.name, "sha256": hashlib.sha256(normalized.read_bytes()).hexdigest()}
                with (output / "coordinate-conversion.json").open("x", encoding="utf-8") as stream:
                    stream.write(json.dumps(conversion, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
                with (output / "contract-normalization.json").open("x", encoding="utf-8") as stream:
                    stream.write(json.dumps(normalization, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
                recovery.persist(stored, {**result, "contract_normalization": normalization, "coordinate_mapping": conversion, "candidate_authority": "proposal_only",
                                          "requires_pixel_ocr_revalidation_before_input": True})
        return {**result, "contract_normalization": normalization, "coordinate_mapping": conversion, "candidate_authority": "proposal_only",
                "requires_pixel_ocr_revalidation_before_input": True}

    def analyze_effect(self, *, expected_state, **kwargs):
        """Reuse the existing PNG/source for one bounded read-only observation."""
        if expected_state not in EFFECT_SCENES:
            raise seed.Failure("unsupported_effect_state")
        result = self.analyze(**kwargs)
        summary = classify_effect(result, expected_state)
        output = Path(kwargs["output_dir"])
        # Never overwrite any earlier invocation's evidence. Save this call's
        # original analysis before adding the derived summary to result.json.
        stored = output / "result.json"
        if result.get("reason", {}).get("code") != "output_already_exists" and stored.is_file():
            raw = stored.read_bytes()
            if seed.strict_json(raw) == result:
                original = output / "analysis-result.json"
                with original.open("xb") as stream:
                    stream.write(raw)
                summary["analysis_artifact"] = {"file": original.name, "sha256": hashlib.sha256(raw).hexdigest()}
                with (output / "effect-result.json").open("x", encoding="utf-8") as stream:
                    stream.write(json.dumps(summary, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
                recovery.persist(stored, {**result, "visual_effect": summary})
        return {**result, "visual_effect": summary}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--png", type=Path, required=True)
    parser.add_argument("--png-sha256", required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--allow-game-image-upload", action="store_true")
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--expected-state", "--effect-state", dest="expected_state", choices=tuple(EFFECT_SCENES))
    args = parser.parse_args(argv)
    try:
        source = None
        if args.allow_game_image_upload:
            if args.source.stat().st_size > seed.MAX_LINE:
                raise seed.Failure("source_too_large")
            source = seed.strict_json(args.source.read_bytes())
        worker = UiSkillVision(allow_upload=args.allow_game_image_upload, timeout=args.timeout)
        call = {"png_path": args.png, "png_sha256": args.png_sha256, "source": source, "output_dir": args.out}
        result = worker.analyze_effect(expected_state=args.expected_state, **call) if args.expected_state else worker.analyze(**call)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0 if result["status"] in {"ok", "unknown"} else 1
    except (seed.Failure, OSError, ValueError):
        print("ui_skill_vision_startup_failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
