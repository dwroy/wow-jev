"""Import an already fetched, credential-free Blizzard API response.

No OAuth client, key reading, network access, or fabricated historical API build.
"""
from __future__ import annotations

import hashlib
import json
from urllib.parse import parse_qsl, urlsplit
from typing import Any

from .store import ValidationError, _url, validate_assertion, validate_version, parse_json


def adapt_response(raw: bytes, *, source_url: str, source_version: dict, retrieved_at: str, applicability: list | None = None) -> dict:
    _url(source_url, "Blizzard source URL")
    v = validate_version(source_version)
    parsed = urlsplit(source_url)
    domains = {f"{region}.api.blizzard.com" for region in ("us", "eu", "kr", "tw")} | {"gateway.battlenet.com.cn"}
    if parsed.hostname not in domains:
        raise ValidationError("Blizzard source: official API hostname required")
    region = "cn" if parsed.hostname == "gateway.battlenet.com.cn" else parsed.hostname.split(".")[0]
    if region != v["region"]:
        raise ValidationError("Blizzard source: region mismatch")
    namespace_prefix = {"retail": "static", "classic-era": "static-classic1x", "classic-progression": "static-classic"}.get(v["branch"])
    if namespace_prefix is None:
        raise ValidationError("Blizzard source: branch namespace not independently supported")
    query_items = parse_qsl(parsed.query)
    query = dict(query_items)
    if len(query) != len(query_items) or set(query) != {"namespace", "locale"}:
        raise ValidationError("Blizzard source: exactly namespace and locale required")
    if query["namespace"] != f"{namespace_prefix}-{region}" or query["locale"] != v["locale"]:
        raise ValidationError("Blizzard source: namespace/locale mismatch")
    parts = parsed.path.strip("/").split("/")
    if len(parts) != 4 or parts[:2] != ["data", "wow"] or parts[2] not in {"creature", "quest", "item", "spell"}:
        raise ValidationError("Blizzard source: supported entity detail path required")
    try:
        entity_id = int(parts[3])
        body = parse_json(raw)
    except (ValueError, UnicodeDecodeError):
        raise ValidationError("Blizzard response: invalid ID/JSON") from None
    if not isinstance(body, dict) or body.get("id") != entity_id or type(body.get("id")) is not int:
        raise ValidationError("Blizzard response: ID mismatch")
    name = body.get("name")
    if isinstance(name, dict):
        name = name.get(v["locale"])
    if not isinstance(name, str):
        raise ValidationError("Blizzard response: name missing in exact locale")
    # Preserve structural fields only; omit copyrighted narrative and credentials.
    allowed = {
        "creature": {"type", "family", "is_tameable"},
        "quest": {"type", "category", "area", "requirements", "is_repeatable", "is_daily", "is_weekly"},
        "item": {"quality", "level", "required_level", "item_class", "item_subclass", "inventory_type"},
        "spell": set(),
    }[parts[2]]

    def clean(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items() if key != "_links" and key != "href"}
        if isinstance(value, list):
            return [clean(item) for item in value]
        return value

    a = {
        "kind": parts[2], "entity_id": entity_id, "name": name,
        "facts": {key: clean(body[key]) for key in sorted(allowed) if key in body},
        "source": {
            "provider": "blizzard-game-data-api", "url": source_url, "retrieved_at": retrieved_at,
            "evidence_kind": "blizzard_api", "source_version": v,
            "artifact_sha256": hashlib.sha256(raw).hexdigest(),
            "locator": "entity detail JSON response",
            "note": "API namespace alone does not establish historical patch/build; applicability requires independently verified exact source version.",
        },
        "applicability": applicability or [],
    }
    validate_assertion(a)
    return {"schema_version": 1, "assertions": [a]}
