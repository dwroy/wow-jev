"""Bounded one-request stdio bridge for read-only TypeScript queries."""
from __future__ import annotations

import json
import sys
from .store import GameDatabase, ValidationError, canonical, _keys, parse_json


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValidationError("bridge: request limit")
        request = parse_json(raw)
        _keys(request, {"schema_version", "operation", "database", "query"}, "bridge")
        if request["schema_version"] != 1 or type(request["schema_version"]) is not int:
            raise ValidationError("bridge: unsupported schema")
        with GameDatabase(request["database"], read_only=True) as db:
            op, q = request["operation"], request["query"]
            if op == "lookup":
                _keys(q, {"version", "kind", "entity_id", "name"}, "lookup")
                result = db.lookup(**q)
            elif op == "references":
                _keys(q, {"branch", "locale", "kind", "entity_id", "name"}, "references")
                result = db.references(**q)
            elif op == "stats":
                _keys(q, set(), "stats")
                result = {"schema_version": 1, **db.stats()}
            else:
                raise ValidationError("bridge: unsupported operation")
        print(canonical({"schema_version": 1, "ok": True, "result": result}))
        return 0
    except Exception as exc:
        # Return type/category only for unexpected failures; do not dump inputs.
        error = str(exc) if isinstance(exc, (ValidationError, OSError, json.JSONDecodeError)) else type(exc).__name__
        print(canonical({"schema_version": 1, "ok": False, "error": error}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
