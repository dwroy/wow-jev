"""Read-only, evidence-bearing planning queries over a pinned v2 world pack.

Indexes only recall candidates.  Every result rechecks the original assertion,
exact client applicability, conditions and typed references.  Nothing here
operates the game or claims that a point/route can be traversed.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import math
from typing import Any

from ..store import ValidationError, _keys, _text, canonical, parse_json, validate_version
from .conditions import Conditions, FactProvider, unknown, validate_fact
from .model import KINDS, RULE_VERSION, condition, digest, entity_key
from .pack import WorldPack, normalized

QUERY_RULE_VERSION = "planning-queries-v3.1"
MOVEMENT_MODES = {"ground", "steady_flight", "skyriding", "transport"}
MAP_KINDS = {"ui_map", "world_map", "map_floor", "journal_instance", "challenge_map"}


def _number(value: Any, label: str, minimum: float = 0) -> float:
    if type(value) not in {int, float} or not math.isfinite(value) or value < minimum:
        raise ValidationError(f"{label}: finite number required")
    return value


def _key(value: Any, *, kinds: set[str] | None = None) -> dict:
    if type(value) is not dict or type(value.get("kind")) is not str:
        raise ValidationError("query: typed entity key required")
    key = deepcopy(entity_key(value))
    if kinds is not None and key["kind"] not in kinds:
        raise ValidationError("query: incompatible entity kind")
    return key


def _utc(value: Any) -> str:
    _text(value, "verification time", 80)
    try:
        if datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError()
    except ValueError:
        raise ValidationError("verification: timezone required") from None
    return value


def validate_route(value: Any) -> dict:
    """A controlled route-edge payload, independent of existing world schema.

    Location references are location table keys (assertion SHA, ordinal), not
    map IDs or entity names.  Unknown verification is preserved as a blocker.
    """
    _keys(value, {"from", "to", "direction", "movement_mode", "required_capabilities",
                  "condition", "estimated_seconds", "risk_cost", "verification",
                  "failure_counterexamples", "revision"}, "route edge")
    for name in ("from", "to"):
        endpoint = _keys(value[name], {"entity", "location"}, "route endpoint")
        _key(endpoint["entity"])
        reference = _keys(endpoint["location"], {"assertion_sha256", "ordinal"}, "location table key")
        digest(reference["assertion_sha256"])
        if type(reference["ordinal"]) is not int or not 0 <= reference["ordinal"] < 256:
            raise ValidationError("route: invalid location ordinal")
    if value["from"]["entity"]["namespace"] != value["to"]["entity"]["namespace"]:
        raise ValidationError("route: cross-product/server endpoint references forbidden")
    if type(value["direction"]) is not str or value["direction"] not in {"forward", "bidirectional"}:
        raise ValidationError("route: explicit supported direction required")
    if type(value["movement_mode"]) is not str or value["movement_mode"] not in MOVEMENT_MODES:
        raise ValidationError("route: explicit movement mode required")
    if type(value["required_capabilities"]) is not list or len(value["required_capabilities"]) > 128:
        raise ValidationError("route: bounded capabilities required")
    for capability in value["required_capabilities"]:
        _text(capability, "route capability", 128)
    if len(set(value["required_capabilities"])) != len(value["required_capabilities"]):
        raise ValidationError("route: duplicate capability")
    condition(value["condition"])
    _number(value["estimated_seconds"], "route time")
    _number(value["risk_cost"], "route risk")
    verification = _keys(value["verification"], {"status", "observed_at", "evidence_sha256"}, "route verification")
    if type(verification["status"]) is not str or verification["status"] not in {"verified", "unknown", "failed"}:
        raise ValidationError("route: invalid verification status")
    if verification["observed_at"] is not None:
        _utc(verification["observed_at"])
    if verification["evidence_sha256"] is not None:
        digest(verification["evidence_sha256"])
    if verification["status"] == "verified" and (verification["observed_at"] is None or verification["evidence_sha256"] is None):
        raise ValidationError("route: verified claim requires timestamp and evidence SHA")
    if type(value["failure_counterexamples"]) is not list or len(value["failure_counterexamples"]) > 256:
        raise ValidationError("route: bounded counterexamples required")
    for failure in value["failure_counterexamples"]:
        _keys(failure, {"sha256", "resolved"}, "route counterexample")
        digest(failure["sha256"])
        if type(failure["resolved"]) is not bool:
            raise ValidationError("route: explicit counterexample resolution required")
    _text(value["revision"], "route revision", 128)
    return deepcopy(value)


class WorldQueries:
    def __init__(self, pack: WorldPack, version: dict, *, context: dict | None = None, provider: FactProvider | None = None):
        self.pack = pack
        self.version = deepcopy(validate_version(version))
        self.context = deepcopy(context or {})
        self.provider = provider
        self.bound_provider = _WorldProvider(pack, provider, self.version)
        Conditions.evaluate({"op": "true"}, self.context, provider)
        try:
            validate_version(self.version, require_known=True)
            self.version_known = True
        except ValidationError as exc:
            if str(exc) != "version_unknown":
                raise
            self.version_known = False

    def _result(self, status: str, records: list | None = None, blockers: list | None = None, *, references: bool = False, **extra: Any) -> dict:
        return {"schema_version": 2, "world_pack_sha256": self.pack.sha256,
                "rule_version": RULE_VERSION, "query_rule_version": QUERY_RULE_VERSION,
                "requested_version": deepcopy(self.version), "status": status,
                "records": records or [], "blockers": blockers or [],
                "applicable_to_requested_client": not references and self.version_known,
                "automatic_action_eligible": False, **extra}

    def _preflight(self, references: bool) -> dict | None:
        if type(references) is not bool:
            raise ValidationError("query: references must be an explicit boolean")
        if not references and not self.version_known:
            return self._result("version_unknown", references=references)
        return None

    def _evaluate(self, ast: dict) -> dict:
        return Conditions.evaluate(ast, self.context, self.bound_provider)

    def _field(self, key: dict, predicate: str, references: bool, *, locale: str | None = None) -> dict:
        assertions = self.pack._fields(key, None if references else self.version, [predicate], locale=locale)
        return self._resolve_field(assertions, references, locale=locale)

    def _resolve_field(self, assertions: list, references: bool, *, locale: str | None = None) -> dict:
        active, pending, evaluations = [], [], []
        for assertion in assertions:
            evaluation = self._evaluate(assertion["condition"])
            evaluations.append({"assertion_sha256": assertion["assertion_sha256"], **evaluation})
            language_matches = assertion["predicate"] not in {"name", "alias", "description"} or locale is not None and assertion["source_revision"]["source_version"]["locale"] == locale
            if evaluation["truth"] == "true" and language_matches:
                active.append(assertion)
            elif evaluation["truth"] == "unknown" and language_matches:
                pending.append(assertion)
        values = {canonical([a["state"], a["value"]]) for a in active}
        state = "conflict" if len(values) > 1 else "unknown" if pending or not active else active[0]["state"]
        return {"status": state, "value": deepcopy(active[0]["value"]) if state == "known" else None,
                "assertion_ids": [] if references or state == "conflict" or pending else sorted(a["assertion_sha256"] for a in active),
                "assertions": assertions, "conditions": evaluations,
                "blockers": [{"reason": "assertion_condition_unknown", "assertion_sha256": a["assertion_sha256"]} for a in pending]}

    def _relation_field(self, assertions: list, current: dict, references: bool, identity: Any, projection: Any = None) -> dict:
        # An owner may have several edges/mechanics. Resolve disagreement only
        # within one relationship identity; unscoped missing data still blocks.
        wanted = canonical(identity(current["value"]))
        scoped = [a for a in assertions if a["state"] != "known" or canonical(identity(a["value"])) == wanted]
        resolved = self._resolve_field([{**a, "value": projection(a["value"])} if projection is not None and a["state"] == "known" else a for a in scoped], references)
        resolved["assertions"] = scoped
        return resolved

    @staticmethod
    def _provenance(assertions: list) -> list[dict]:
        return [{"assertion_sha256": a["assertion_sha256"], "source_sha256": a["source_sha256"],
                 "artifact_sha256": a["artifact_sha256"], "locator": a["locator"],
                 "observed_at": a["observed_at"], "verification": a["verification"],
                 "predicate": a["predicate"], "state": a["state"], "value": deepcopy(a["value"]),
                 "condition": deepcopy(a["condition"]),
                 "source_revision": a["source_revision"], "applicability": a["applicability"]} for a in assertions]

    @staticmethod
    def _status(records: list, references: bool) -> str:
        if not records:
            return "not_found"
        if references:
            return "references"
        states = {record["status"] for record in records}
        return "conflict" if "conflict" in states else "found" if "known" in states else "unsupported" if states == {"unsupported"} else "not_present" if states == {"not_present"} else "unknown"

    def search(self, text: str, *, namespace: str, kind: str | None = None, references: bool = False, limit: int = 50) -> dict:
        _text(text, "search text", 512)
        _key({"namespace": namespace, "kind": kind or "quest", "native_id": 1})
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ValidationError("search: limit 1..1000 required")
        failed = self._preflight(references)
        if failed:
            return failed
        if self.version["locale"] is None:
            return self._result("version_unknown", blockers=[{"reason": "locale_unknown"}], references=references)
        if namespace.split(":")[0] != self.version["branch"]:
            return self._result("not_found", references=references)
        term = normalized(text)
        if len(term) < 2:
            return self._result("unsupported", blockers=[{"reason": "two_character_search_minimum"}], references=references)
        grams = sorted({term[i:i+2] for i in range(len(term) - 1)})
        placeholders = ",".join("?" for _ in grams)
        sql = f"SELECT t.namespace,t.kind,t.native_id FROM text_token k JOIN localized_text t ON t.assertion_sha256=k.assertion_sha256 WHERE k.token IN ({placeholders}) AND t.namespace=? AND t.locale=?"
        params: list = [*grams, namespace, self.version["locale"]]
        if kind is not None:
            sql += " AND t.kind=?"
            params.append(kind)
        sql += " GROUP BY t.assertion_sha256 HAVING count(DISTINCT k.token)=? ORDER BY t.kind,t.native_id LIMIT 1001"
        params.append(len(grams))
        rows = self.pack.connection.execute(sql, params).fetchall()
        if len(rows) > 1000:
            return self._result("unknown", blockers=[{"reason": "search_candidate_limit"}], references=references)
        keys = {canonical(dict(row)): dict(row) for row in rows}
        records = []
        for name in sorted(keys):
            key, matches, states, assertions = keys[name], [], [], []
            adopted = set()
            for predicate in ("name", "alias", "description"):
                field = self._field(key, predicate, references, locale=self.version["locale"])
                for assertion in field["assertions"]:
                    if assertion["source_revision"]["source_version"]["locale"] != self.version["locale"] or assertion["state"] != "known" or type(assertion["value"]) is not str or term not in normalized(assertion["value"]):
                        continue
                    evaluation = self._evaluate(assertion["condition"])
                    if evaluation["truth"] == "false":
                        continue
                    matches.append({"predicate": predicate, "text": assertion["value"], "assertion_sha256": assertion["assertion_sha256"], "condition": evaluation})
                    states.append(field["status"])
                    assertions.extend(field["assertions"])
                    adopted.update(field["assertion_ids"])
            if matches:
                state = "conflict" if "conflict" in states else "unknown" if "unknown" in states else "known"
                unique_assertions = {a["assertion_sha256"]: a for a in assertions}
                records.append({"entity": key, "status": state, "matches": matches, "assertion_ids": sorted(adopted) if state == "known" else [], "provenance": self._provenance([unique_assertions[k] for k in sorted(unique_assertions)])})
        status = "ambiguous" if len(records) > 1 else self._status(records, references)
        return self._result(status, records[:limit], references=references, truncated=len(records) > limit, normalization_version="nfkc-casefold-bigram-v1")

    def _location_rows(self, map_key: dict, box: tuple | None = None, *, coordinate_space: str | None = None, transform_revision: str | None = None) -> list:
        sql = "SELECT l.*,a.namespace AS entity_namespace,a.kind AS entity_kind,a.native_id AS entity_id FROM location l JOIN assertion a ON a.sha256=l.assertion_sha256"
        params = []
        if box is not None:
            sql += " JOIN spatial_index s ON s.assertion_sha256=l.assertion_sha256 AND s.ordinal=l.ordinal JOIN location_rtree r ON r.row_id=s.row_id"
        sql += " WHERE l.map_namespace=? AND l.map_kind=? AND l.map_id=?"
        params.extend([map_key["namespace"], map_key["kind"], map_key["native_id"]])
        if box is not None:
            sql += " AND ((r.min_x<=? AND r.max_x>=? AND r.min_y<=? AND r.max_y>=?) OR (l.coordinate_space=? AND (l.transform_revision IS NOT ? OR (?='plugin_texture' AND (l.transform_revision IS NULL OR ? IS NULL)))))"
            params.extend(box)
            params.extend([coordinate_space, transform_revision, coordinate_space, transform_revision])
        sql += " ORDER BY a.kind,a.native_id,l.assertion_sha256,l.ordinal LIMIT 1001"
        return self.pack.connection.execute(sql, params).fetchall()

    def _location(self, row: Any, references: bool) -> tuple[dict, dict, dict] | None:
        key = {"namespace": row["entity_namespace"], "kind": row["entity_kind"], "native_id": row["entity_id"]}
        field = self._field(key, "locations", references)
        assertion = next((a for a in field["assertions"] if a["assertion_sha256"] == row["assertion_sha256"]), None)
        if assertion is None or self._evaluate(assertion["condition"])["truth"] == "false":
            return None
        try:
            location = assertion["value"][row["ordinal"]]
        except (IndexError, TypeError):
            raise ValidationError("location: assertion ordinal mismatch") from None
        table_value = {"coordinate_space": row["coordinate_space"], "map": {"namespace": row["map_namespace"], "kind": row["map_kind"], "native_id": row["map_id"]}, "floor": row["floor"], "x": row["x"], "y": row["y"], "z": row["z"], "accuracy": row["accuracy"], "transform_revision": row["transform_revision"], "phase": parse_json(row["phase_json"])}
        if location != table_value:
            raise ValidationError("location: derived table/source assertion mismatch")
        scoped, originals = [], []
        for candidate in field["assertions"]:
            if candidate["state"] != "known":
                scoped.append(candidate)
                originals.append(candidate)
                continue
            points = [p for ordinal, p in enumerate(candidate["value"]) if ordinal == row["ordinal"] and
                all(p[name] == location[name] for name in ("map", "floor", "coordinate_space", "transform_revision"))
                and self._evaluate(p["phase"])["truth"] != "false"]
            if not points:
                continue
            originals.append(candidate)
            scoped.append({**candidate, "value": [{k: v for k, v in p.items() if k != "phase"} for p in points],
                "condition": {"op": "and", "args": [candidate["condition"], *[p["phase"] for p in points]]}})
        field = self._resolve_field(scoped, references)
        field["assertions"] = originals
        return key, location, field

    def region(self, map_key: dict, *, coordinate_space: str = "ui_percent", floor: int | None = None,
               transform_revision: str | None = None, maximum_accuracy: float = 5,
               references: bool = False, limit: int = 100) -> dict:
        return self._locations(map_key, coordinate_space=coordinate_space, floor=floor,
            transform_revision=transform_revision, maximum_accuracy=maximum_accuracy, references=references, limit=limit)

    def locations_near(self, map_key: dict, x: float, y: float, radius: float, *, coordinate_space: str,
                       floor: int | None, transform_revision: str | None = None,
                       maximum_accuracy: float = 5, references: bool = False, limit: int = 100) -> dict:
        for value, label in ((x, "x"), (y, "y"), (radius, "radius")):
            _number(value, label, -math.inf if label in {"x", "y"} else 0)
        return self._locations(map_key, coordinate_space=coordinate_space, floor=floor,
            transform_revision=transform_revision, maximum_accuracy=maximum_accuracy,
            references=references, limit=limit, center=(x, y, radius))

    def _locations(self, map_key: dict, *, coordinate_space: str, floor: int | None,
                   transform_revision: str | None, maximum_accuracy: float,
                   references: bool, limit: int, center: tuple | None = None) -> dict:
        key = _key(map_key, kinds=MAP_KINDS)
        if coordinate_space not in {"ui_percent", "world", "plugin_texture"}:
            raise ValidationError("location query: coordinate space required")
        if coordinate_space == "ui_percent" and key["kind"] != "ui_map" or coordinate_space == "world" and key["kind"] not in {"world_map", "map_floor"}:
            raise ValidationError("location query: map/coordinate-space mismatch")
        if floor is not None and type(floor) is not int:
            raise ValidationError("location query: integer/unknown floor required")
        if transform_revision is not None:
            _text(transform_revision, "transform revision")
        _number(maximum_accuracy, "maximum accuracy")
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ValidationError("location query: bounded limit required")
        failed = self._preflight(references)
        if failed:
            return failed
        if key["namespace"].split(":")[0] != self.version["branch"]:
            return self._result("not_found", references=references)
        box = None
        if center is not None:
            x, y, radius = center
            reach = radius + maximum_accuracy
            box = (x + reach, x - reach, y + reach, y - reach)
        rows = self._location_rows(key, box, coordinate_space=coordinate_space, transform_revision=transform_revision)
        if len(rows) > 1000:
            return self._result("unknown", blockers=[{"reason": "location_candidate_limit"}], references=references)
        records = []
        for row in rows:
            resolved = self._location(row, references)
            if resolved is None:
                continue
            entity, location, field = resolved
            if location["coordinate_space"] != coordinate_space or (floor is not None and location["floor"] is not None and floor != location["floor"]):
                continue
            phase = self._evaluate(location["phase"])
            if phase["truth"] == "false":
                continue
            blockers = list(field["blockers"])
            if field["status"] != "known":
                blockers.append({"reason": "location_field_" + field["status"]})
            if floor is None or location["floor"] is None:
                blockers.append({"reason": "floor_unknown"})
            comparable = location["transform_revision"] == transform_revision and (coordinate_space != "plugin_texture" or transform_revision is not None)
            if not comparable:
                blockers.append({"reason": "transform_unavailable"})
            if location["accuracy"] is None or location["accuracy"] > maximum_accuracy:
                blockers.append({"reason": "accuracy_unknown_or_insufficient"})
            if phase["truth"] == "unknown":
                blockers.append({"reason": "phase_unknown", "condition": phase})
            distance = math.hypot(location["x"] - center[0], location["y"] - center[1]) if center is not None and comparable else None
            if distance is not None and location["accuracy"] is not None:
                if distance - location["accuracy"] > center[2]:
                    continue
                if distance + location["accuracy"] > center[2]:
                    blockers.append({"reason": "radius_boundary_uncertain"})
            state = "conflict" if field["status"] == "conflict" else "unknown" if blockers else "known"
            records.append({"entity": entity, "status": state, "location": location,
                "location_ref": {"assertion_sha256": row["assertion_sha256"], "ordinal": row["ordinal"]},
                "distance": distance, "distance_unit": {"ui_percent": "map_percentage_points", "world": "world_units", "plugin_texture": "texture_units"}[coordinate_space],
                "assertion_ids": field["assertion_ids"] if state == "known" else [],
                "blockers": blockers, "phase": phase, "provenance": self._provenance(field["assertions"]), "can_traverse": False})
        records.sort(key=lambda r: (r["distance"] if r["distance"] is not None else math.inf, canonical(r["entity"]), canonical(r["location_ref"])))
        return self._result(self._status(records, references), records[:limit], references=references, truncated=len(records) > limit)

    def _endpoint(self, endpoint: dict, references: bool) -> dict:
        reference = endpoint["location"]
        rows = self.pack.connection.execute("SELECT l.*,a.namespace AS entity_namespace,a.kind AS entity_kind,a.native_id AS entity_id FROM location l JOIN assertion a ON a.sha256=l.assertion_sha256 WHERE l.assertion_sha256=? AND l.ordinal=?", (reference["assertion_sha256"], reference["ordinal"])).fetchall()
        if not rows:
            return {"truth": "unknown", "blockers": [{"reason": "route_location_reference_missing"}]}
        resolved = self._location(rows[0], references)
        if resolved is None or resolved[0] != endpoint["entity"]:
            return {"truth": "unknown", "blockers": [{"reason": "route_location_entity_or_version_mismatch"}]}
        _, location, field = resolved
        phase = self._evaluate(location["phase"])
        blockers = list(field["blockers"])
        if field["status"] != "known":
            blockers.append({"reason": "route_location_" + field["status"]})
        if location["floor"] is None or location["accuracy"] is None:
            blockers.append({"reason": "route_location_precision_unknown"})
        if location["coordinate_space"] == "plugin_texture" and location["transform_revision"] is None:
            blockers.append({"reason": "route_location_transform_unknown"})
        if phase["truth"] != "true":
            blockers.append({"reason": "route_location_phase_" + phase["truth"]})
        return {"truth": "unknown" if blockers else "true", "blockers": blockers, "location": location, "phase": phase}

    def routes(self, from_entity: dict, *, to_entity: dict | None = None,
               movement_modes: list[str] | None = None, capabilities: dict | None = None,
               references: bool = False, limit: int = 50) -> dict:
        start, destination = _key(from_entity), _key(to_entity) if to_entity is not None else None
        modes = [] if movement_modes is None else movement_modes
        if type(modes) is not list or any(type(m) is not str or m not in MOVEMENT_MODES for m in modes):
            raise ValidationError("route query: explicit supported movement modes required")
        if capabilities is not None and type(capabilities) is not dict:
            raise ValidationError("route query: capabilities require explicit fact records")
        local_context = deepcopy(self.context)
        if capabilities:
            local_context.setdefault("character", {}).update({"capability." + name: validate_fact(fact) for name, fact in capabilities.items()})
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ValidationError("route query: bounded limit required")
        failed = self._preflight(references)
        if failed:
            return failed
        rows = self.pack.connection.execute("SELECT DISTINCT a.namespace,a.kind,a.native_id FROM route_edge r JOIN assertion a ON a.sha256=r.assertion_sha256 ORDER BY a.namespace,a.kind,a.native_id LIMIT 1001").fetchall()
        if len(rows) > 1000:
            return self._result("unknown", blockers=[{"reason": "route_candidate_limit"}], references=references)
        records = []
        artifact_ids = {a["sha256"] for a in self.pack.manifest["artifacts"]}
        for row in rows:
            key = dict(row)
            if key["namespace"] != start["namespace"]:
                continue
            owner_field = self._field(key, "route.edge", references)
            for assertion in owner_field["assertions"]:
                if assertion["state"] != "known" or self._evaluate(assertion["condition"])["truth"] == "false":
                    continue
                route = validate_route(assertion["value"])
                if route["from"]["entity"]["namespace"] != key["namespace"]:
                    raise ValidationError("route: endpoint/owner product namespace mismatch")
                reverse = start == route["to"]["entity"] and route["direction"] == "bidirectional"
                origin, target = (route["to"], route["from"]) if reverse else (route["from"], route["to"])
                if origin["entity"] != start or destination is not None and target["entity"] != destination:
                    continue
                if modes and route["movement_mode"] not in modes:
                    continue
                field = self._relation_field(owner_field["assertions"], assertion, references,
                    lambda v: [v["from"], v["to"], v["direction"], v["movement_mode"]])
                blockers = list(field["blockers"])
                if field["status"] != "known":
                    blockers.append({"reason": "route_field_" + field["status"]})
                if not modes:
                    blockers.append({"reason": "movement_modes_unknown"})
                verification = route["verification"]
                if verification["status"] != "verified" or verification["evidence_sha256"] not in artifact_ids:
                    blockers.append({"reason": "route_verification_missing_or_failed"})
                if any(not f["resolved"] or f["sha256"] not in artifact_ids for f in route["failure_counterexamples"]):
                    blockers.append({"reason": "unresolved_failure_counterexample"})
                requirement = Conditions.evaluate(route["condition"], local_context, self.bound_provider)
                if requirement["truth"] != "true":
                    blockers.append({"reason": "route_condition_" + requirement["truth"], "condition": requirement})
                for name in route["required_capabilities"]:
                    capability = Conditions.evaluate({"op": "fact", "scope": "character", "key": "capability." + name, "cmp": "eq", "value": True}, local_context, self.bound_provider)
                    if capability["truth"] != "true":
                        blockers.append({"reason": "capability_" + capability["truth"], "capability": name, "condition": capability})
                endpoints = [self._endpoint(endpoint, references) for endpoint in (origin, target)]
                blockers.extend(b for endpoint in endpoints for b in endpoint["blockers"])
                if all("location" in endpoint for endpoint in endpoints) and route["movement_mode"] != "transport":
                    a, b = (endpoint["location"] for endpoint in endpoints)
                    if (a["map"], a["coordinate_space"], a["transform_revision"]) != (b["map"], b["coordinate_space"], b["transform_revision"]):
                        blockers.append({"reason": "route_coordinate_transform_unavailable"})
                state = "conflict" if field["status"] == "conflict" else "unknown" if blockers else "known"
                records.append({"entity": key, "status": state, "from": origin, "to": target,
                    "direction_reversed": reverse, "movement_mode": route["movement_mode"],
                    "cost": {"estimated_seconds": route["estimated_seconds"], "risk_cost": route["risk_cost"]},
                    "route_revision": route["revision"], "condition": requirement, "endpoints": endpoints,
                    "assertion_ids": field["assertion_ids"] if state == "known" else [], "blockers": blockers,
                    "provenance": self._provenance(field["assertions"]), "verification_scope": "source_claim",
                    "failure_counterexamples": route["failure_counterexamples"], "can_traverse": False})
        records.sort(key=lambda r: (r["cost"]["estimated_seconds"], r["cost"]["risk_cost"], canonical(r["entity"])))
        return self._result(self._status(records, references), records[:limit], references=references, truncated=len(records) > limit)

    def _condition_entity(self, key: dict, predicate: str, references: bool) -> dict:
        failed = self._preflight(references)
        if failed:
            return failed
        field = self._field(key, predicate, references)
        if not field["assertions"]:
            return self._result("not_found", references=references)
        evaluation = self._evaluate(field["value"]) if field["status"] == "known" else None
        state = field["status"] if evaluation is None or evaluation["truth"] != "unknown" else "unknown"
        record = {"entity": key, "status": state, "field": predicate, "truth": evaluation["truth"] if evaluation else "unknown",
                  "evaluation": evaluation, "assertion_ids": field["assertion_ids"] if state == "known" else [],
                  "provenance": self._provenance(field["assertions"]), "blockers": field["blockers"] + (evaluation["blockers"] if evaluation else [{"reason": "condition_field_" + field["status"]}])}
        return self._result(self._status([record], references), [record], references=references)

    def quest_availability(self, key: dict, *, references: bool = False) -> dict:
        return self._condition_entity(_key(key, kinds={"quest"}), "quest.condition", references)

    def achievement(self, key: dict, *, references: bool = False) -> dict:
        return self._condition_entity(_key(key, kinds={"achievement"}), "achievement.criteria", references)

    def encounter(self, key: dict, *, difficulty: str | None, season: str | None,
                  phase: str | None, role: str | None, references: bool = False) -> dict:
        key = _key(key, kinds={"encounter"})
        failed = self._preflight(references)
        if failed:
            return failed
        field = self._field(key, "encounter.mechanic", references)
        if not field["assertions"]:
            return self._result("not_found", references=references)
        records = []
        if not any(a["state"] == "known" for a in field["assertions"]):
            record = {"entity": key, "status": field["status"], "mechanic": None, "evaluation": None,
                      "blockers": [{"reason": "encounter_field_" + field["status"]}],
                      "assertion_ids": [], "provenance": self._provenance(field["assertions"])}
            return self._result(self._status([record], references), [record], references=references)
        for assertion in field["assertions"]:
            if assertion["state"] != "known" or self._evaluate(assertion["condition"])["truth"] == "false":
                continue
            value = _keys(assertion["value"], {"instance", "difficulty", "season", "phase", "roles", "condition", "spell", "description"}, "encounter mechanic")
            instance = _key(value["instance"], kinds={"instance", "journal_instance"})
            if instance["namespace"] != key["namespace"]:
                raise ValidationError("encounter: product namespace mismatch")
            if not self.bound_provider.exists(instance):
                raise ValidationError("encounter: dangling instance reference")
            if value["spell"] is not None:
                spell = _key(value["spell"], kinds={"spell"})
                if spell["namespace"] != key["namespace"] or not self.bound_provider.exists(spell):
                    raise ValidationError("encounter: dangling/cross-product spell reference")
            for name in ("difficulty", "season", "phase", "description"):
                _text(value[name], "encounter." + name, 2048)
            if type(value["roles"]) is not list or not value["roles"] or any(role_name not in {"tank", "healer", "damage"} for role_name in value["roles"]):
                raise ValidationError("encounter: explicit supported roles required")
            condition(value["condition"])
            if any(requested is not None and requested != value[name] for name, requested in (("difficulty", difficulty), ("season", season), ("phase", phase))) or role is not None and role not in value["roles"]:
                continue
            scoped_field = self._relation_field(field["assertions"], assertion, references,
                lambda v: [v["instance"], v["spell"], v["difficulty"], v["season"], v["phase"], [role] if role in v["roles"] else sorted(v["roles"])],
                lambda v: {**v, "roles": [role] if role in v["roles"] else sorted(v["roles"])})
            blockers = list(scoped_field["blockers"])
            if any(v is None for v in (difficulty, season, phase, role)):
                blockers.append({"reason": "encounter_context_unknown"})
            evaluation = self._evaluate(value["condition"])
            if evaluation["truth"] != "true":
                blockers.append({"reason": "encounter_condition_" + evaluation["truth"]})
            if scoped_field["status"] != "known":
                blockers.append({"reason": "encounter_field_" + scoped_field["status"]})
            records.append({"entity": key, "status": "conflict" if scoped_field["status"] == "conflict" else "unknown" if blockers else "known",
                "mechanic": deepcopy(value), "evaluation": evaluation, "blockers": blockers,
                "assertion_ids": scoped_field["assertion_ids"] if not blockers else [], "provenance": self._provenance(scoped_field["assertions"])})
        return self._result(self._status(records, references), records, references=references)


class _WorldProvider:
    """The query layer supplies the foreign-key check across the two files."""
    def __init__(self, pack: WorldPack, provider: FactProvider | None, version: dict):
        self.pack, self.provider = pack, provider
        self.version = deepcopy(version)
        self._validate_binding()

    def _validate_binding(self) -> None:
        if self.provider is None:
            return
        if getattr(self.provider, "world_pack_sha256", None) != self.pack.sha256:
            raise ValidationError("query provider: world pack binding mismatch or missing")
        version = getattr(self.provider, "version", None)
        if version is None or validate_version(version) != self.version:
            raise ValidationError("query provider: client version binding mismatch or missing")

    def exists(self, key: dict) -> bool:
        return bool(self.pack.connection.execute("SELECT 1 FROM entity WHERE namespace=? AND kind=? AND native_id=?", (key["namespace"], key["kind"], key["native_id"])).fetchone())

    def read_progress(self, scope: str, entity: dict, field: str) -> dict:
        self._validate_binding()
        if entity["namespace"].split(":")[0] != self.version["branch"]:
            return unknown("cross_product_world_reference")
        if not self.exists(entity):
            return unknown("missing_world_entity_reference")
        return self.provider.read_progress(scope, entity, field) if self.provider is not None else unknown("progress_provider_missing")

    def read_fact(self, scope: str, key: str) -> dict:
        self._validate_binding()
        if self.provider is None:
            return unknown("missing_fact_provider")
        bindings = getattr(self.provider, "fact_bindings", {})
        binding = bindings.get(scope, {}).get(key)
        if binding is not None and not self.exists(binding["entity"]):
            return unknown("missing_world_entity_reference")
        return self.provider.read_fact(scope, key)
