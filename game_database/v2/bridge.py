"""Bounded offline stdio bridge for pinned, batched world queries."""
import sys
from ..store import ValidationError, _keys, canonical, parse_json
from .pack import WorldPack


def main():
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValidationError('bridge: request limit')
        request = parse_json(raw)
        _keys(request, {'schema_version', 'operation', 'directory', 'world_pack_sha256', 'version', 'selectors'}, 'world bridge')
        if type(request['schema_version']) is not int or request['schema_version'] != 2 or request['operation'] not in {'lookup', 'references'}:
            raise ValidationError('bridge: unsupported schema/operation')
        with WorldPack(request['directory'], expected_sha256=request['world_pack_sha256']) as pack:
            result = pack.batch(request['version'], request['selectors'], references=request['operation'] == 'references')
        reply = canonical({'schema_version': 2, 'ok': True, 'result': result})
        if len(reply.encode()) > 4 * 1024 * 1024:
            raise ValidationError('bridge: response limit')
        print(reply)
        return 0
    except Exception as exc:
        print(canonical({'schema_version': 2, 'ok': False, 'error': str(exc) if isinstance(exc, (ValueError, OSError)) else type(exc).__name__}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
