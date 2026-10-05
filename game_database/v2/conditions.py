"""Controlled three-valued conditions; missing facts never become False."""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Protocol

from ..store import ValidationError, canonical, canonical_sha256, parse_json, validate_version
from .model import RULE_VERSION, condition, digest, entity_key, json_value

CONDITION_RULE_VERSION = "conditions-v3.1"
FACT_KEYS = {"state", "value", "evidence"}


class FactProvider(Protocol):
    def read_fact(self, scope: str, key: str) -> dict: ...
    def read_progress(self, scope: str, entity: dict, field: str) -> dict: ...


def unknown(reason: str, *, state: str = "unknown", evidence: list | None = None) -> dict:
    return {"state": state, "value": None, "evidence": evidence or [], "reason": reason}


def validate_fact(value: Any) -> dict:
    if type(value) is not dict or not FACT_KEYS <= set(value) or set(value) - FACT_KEYS - {"reason", "completeness"}:
        raise ValidationError("condition fact: explicit state/value/evidence required")
    if type(value["state"]) is not str or value["state"] not in {"value", "unknown", "unsupported", "not_present"}:
        raise ValidationError("condition fact: invalid state")
    if (value["state"] == "value") != (value["value"] is not None):
        raise ValidationError("condition fact: value/state mismatch")
    if type(value["evidence"]) is not list or len(value["evidence"]) > 2048:
        raise ValidationError("condition fact: bounded evidence list required")
    if any(type(e) is not dict or type(e.get("kind")) is not str or not e["kind"] for e in value["evidence"]):
        raise ValidationError("condition fact: typed evidence references required")
    if "completeness" in value and value["completeness"] not in ("complete", "partial", "unknown"):
        raise ValidationError("condition fact: invalid completeness")
    if "reason" in value and (type(value["reason"]) is not str or not value["reason"]):
        raise ValidationError("condition fact: reason text required")
    json_value(value)
    return deepcopy(value)


class Conditions:
    @staticmethod
    def evaluate(ast: Any, context: dict | None = None, provider: FactProvider | None = None) -> dict:
        """Strong Kleene AND/OR/NOT, with decisive evidence and unresolved leaves.

        Context contains character/account/context maps of explicit fact records.
        Caller-provided/manual evidence remains a clue; it never authorizes input.
        """
        condition(ast)
        contexts = {} if context is None else deepcopy(context)
        if type(contexts) is not dict or set(contexts) - {"character", "account", "context"}:
            raise ValidationError("condition context: invalid scopes")
        for values in contexts.values():
            if type(values) is not dict:
                raise ValidationError("condition context: fact map required")
            for key, fact in values.items():
                if not isinstance(key, str) or not key or len(key) > 256:
                    raise ValidationError("condition context: invalid fact key")
                validate_fact(fact)
        result = Conditions._evaluate(ast, contexts, provider, "$")
        result["rule_version"] = RULE_VERSION
        result["condition_rule_version"] = CONDITION_RULE_VERSION
        result["automatic_action_eligible"] = False
        return result

    @staticmethod
    def _result(truth: str, evidence: list | None = None, blockers: list | None = None) -> dict:
        unique = {canonical(item): item for item in evidence or []}
        blocked = {canonical(item): item for item in blockers or []}
        return {"truth": truth, "evidence": [unique[k] for k in sorted(unique)], "blockers": [blocked[k] for k in sorted(blocked)]}

    @staticmethod
    def _evaluate(ast: dict, context: dict, provider: FactProvider | None, path: str) -> dict:
        op = ast["op"]
        if op in {"true", "false"}:
            return Conditions._result(op)
        if op == "unknown":
            return Conditions._result("unknown", blockers=[{"path": path, "reason": "explicit_unknown"}])
        if op == "not":
            child = Conditions._evaluate(ast["arg"], context, provider, path + ".arg")
            return Conditions._result({"true": "false", "false": "true", "unknown": "unknown"}[child["truth"]], child["evidence"], child["blockers"])
        if op in {"and", "or"}:
            children = [Conditions._evaluate(child, context, provider, f"{path}.args[{i}]") for i, child in enumerate(ast["args"])]
            decisive = "false" if op == "and" else "true"
            selected = [child for child in children if child["truth"] == decisive]
            if selected:
                # Unknown siblings do not block a proven false AND / true OR.
                return Conditions._result(decisive, [e for c in selected for e in c["evidence"]])
            truth = "unknown" if any(c["truth"] == "unknown" for c in children) else "true" if op == "and" else "false"
            return Conditions._result(truth, [e for c in children for e in c["evidence"]], [b for c in children for b in c["blockers"]])
        scope = ast["scope"]
        if op == "fact":
            raw = context.get(scope, {}).get(ast["key"])
            if raw is None and provider is not None:
                raw = provider.read_fact(scope, ast["key"])
            fact = validate_fact(raw) if raw is not None else unknown("missing_fact")
        else:
            field = "unlock" if op == "unlock" else "quest_status"
            fact = validate_fact(provider.read_progress(scope, ast["entity"], field)) if provider is not None else unknown("progress_provider_missing")
        if fact["state"] != "value" or not fact["evidence"]:
            return Conditions._result("unknown", fact["evidence"], [{"path": path, "reason": fact.get("reason", fact["state"] if fact["state"] != "value" else "missing_evidence"), "scope": scope}])
        value = fact["value"]
        if op == "fact":
            comparison = ast["cmp"]
            if comparison == "eq":
                matched = canonical(value) == canonical(ast["value"])
            elif comparison == "in":
                matched = any(canonical(value) == canonical(item) for item in ast["value"])
            else:
                if type(value) not in {int, float} or type(ast["value"]) not in {int, float}:
                    return Conditions._result("unknown", fact["evidence"], [{"path": path, "reason": "numeric_comparison_type_unknown"}])
                matched = value >= ast["value"]
            return Conditions._result("true" if matched else "false", fact["evidence"])
        if fact.get("completeness") != "complete":
            return Conditions._result("unknown", fact["evidence"], [{"path": path, "reason": "incomplete_progress"}])
        if op in {"quest_completed", "quest_active"} and type(value) is dict:
            conflict = Conditions._progress_conflict(value)
            if conflict is not None:
                return Conditions._result("unknown", fact["evidence"], [{"path": path, "reason": conflict}])
        truth = "unknown"
        if op == "unlock":
            flag = value if type(value) is bool else value.get("unlocked") if type(value) is dict else None
            if type(flag) is bool:
                truth = "true" if flag else "false"
        elif op == "quest_completed":
            # Objective-complete is ready for turn-in, not historical delivery.
            if type(value) is dict:
                status = value.get("status")
                confirmed = (status == "completed_confirmed" or value.get("completed_confirmed") is True) and value.get("completion_source") in ("quest_flagged_completed", "server_completed_quest_list")
                if value.get("turned_in") is True or status == "turned_in" or confirmed:
                    truth = "true"
                elif value.get("turned_in") is False:
                    truth = "false"
        elif op == "quest_active":
            if type(value) is dict:
                if type(value.get("active")) is bool:
                    truth = "true" if value["active"] else "false"
                elif type(value.get("status")) is str and value["status"] in {"active", "in_progress", "objectives_complete", "ready_to_turn_in"}:
                    truth = "true"
                elif value.get("status") == "turned_in":
                    truth = "false"
        return Conditions._result(truth, fact["evidence"], [] if truth != "unknown" else [{"path": path, "reason": "explicit_progress_semantics_missing", "scope": scope}])

    @staticmethod
    def _progress_conflict(value: dict) -> str | None:
        for name in ("active", "turned_in", "completed_confirmed"):
            if name in value and type(value[name]) is not bool:
                return "progress_semantics_invalid"
        status = value.get("status")
        if status is not None and type(status) is not str:
            return "progress_semantics_invalid"
        active_status = status in ("active", "in_progress", "objectives_complete", "ready_to_turn_in")
        historical = status == "completed_confirmed" or value.get("completed_confirmed") is True
        delivered = status == "turned_in" or value.get("turned_in") is True
        if ((delivered or historical) and value.get("turned_in") is False or
            historical and value.get("completed_confirmed") is False or
            delivered and value.get("completed_confirmed") is False or
            delivered and (active_status or value.get("active") is True) or
            active_status and value.get("active") is False):
            return "progress_semantics_conflict"
        return None


class RuntimeProgressProvider:
    """Read exact-world/client facts and enforce source-clock freshness.

    Fact bindings map scope/key to a typed entity and runtime field.  They never
    infer a character/account relationship or a fact from an entity name.
    """
    def __init__(self, runtime: Any, *, world_pack_sha256: str, version: dict,
                 character_id: str, account_id: str, as_of_clock: dict,
                 maximum_age: float, fact_bindings: dict | None = None):
        self.runtime = runtime
        self.world_pack_sha256 = digest(world_pack_sha256)
        self.version = deepcopy(validate_version(version, require_known=True))
        self.character_id, self.account_id = character_id, account_id
        self.as_of_clock = deepcopy(as_of_clock)
        self.maximum_age = maximum_age
        self.fact_bindings = deepcopy(fact_bindings or {})
        if any(type(v) is not str or not v for v in (character_id, account_id)):
            raise ValidationError("progress provider: explicit character/account identity required")
        self.runtime._check()
        rows = list(self.runtime.connection.execute("SELECT account_id,namespace,content_sha256,payload FROM character WHERE character_id=?", (character_id,)))
        if not rows or rows[0][0] != account_id:
            raise ValidationError("progress provider: character/account ownership mismatch")
        account, namespace, sha, payload = rows[0]
        if canonical_sha256(parse_json(payload)) != sha or parse_json(payload) != {"character_id": character_id, "account_id": account, "namespace": namespace}:
            raise ValidationError("progress provider: character content/index hash mismatch")
        # Validate freshness parameters through the runtime's normal read path.
        self.read_progress("character", {"namespace": namespace, "kind": "quest", "native_id": 1}, "quest_status")
        for scope, bindings in self.fact_bindings.items():
            if scope not in {"character", "account", "context"} or type(bindings) is not dict:
                raise ValidationError("progress provider: invalid fact binding scope")
            for key, binding in bindings.items():
                if not isinstance(key, str) or not key or type(binding) is not dict or set(binding) != {"entity", "field"}:
                    raise ValidationError("progress provider: invalid fact binding")
                entity_key(binding["entity"])
                if not isinstance(binding["field"], str) or not binding["field"]:
                    raise ValidationError("progress provider: field required")

    def read_fact(self, scope: str, key: str) -> dict:
        binding = self.fact_bindings.get(scope, {}).get(key)
        if binding is None or scope == "context":
            return unknown("missing_runtime_fact_binding")
        return self.read_progress(scope, binding["entity"], binding["field"])

    def read_progress(self, scope: str, entity: dict, field: str) -> dict:
        if scope not in {"character", "account"}:
            raise ValidationError("progress provider: invalid owner scope")
        result = self.runtime.get_progress(scope=scope, scope_id=self.character_id if scope == "character" else self.account_id,
            world_pack_sha256=self.world_pack_sha256, client_version=self.version,
            entity=entity_key(entity), field=field, as_of_clock=self.as_of_clock, maximum_age=self.maximum_age)
        records = result.get("records", [])
        evidence = [{"kind": "runtime_progress", "observation_sha256": record["observation_sha256"],
                     "source_event": record["source_event"], "source_clock": record["source_clock"],
                     "observed_at": record["observed_at"], "world_pack_sha256": self.world_pack_sha256,
                     "scope": scope, "scope_id": record["scope_id"]} for record in records]
        return {"state": result["state"], "value": result["value"], "evidence": evidence,
                "reason": result["reason"], "completeness": result.get("observation", {}).get("completeness", "unknown")}
