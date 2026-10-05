"""Brain bounded route planning JSONL worker; uploads are disabled by default."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import time

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from perception import seed_worker as sw

PROMPT_VERSION = 'brain-retail-v1'
ROOT = Path(__file__).resolve().parent
PROMPT_PATH = ROOT / 'prompts' / (PROMPT_VERSION + '.txt')
CHOICE_SCHEMA = sw.strict_json((ROOT / 'schemas' / 'brain-choice-v1.schema.json').read_text())
MODEL_SCHEMA = sw.strict_json((ROOT / 'schemas' / 'brain-model-retail-v1.schema.json').read_text())


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def matches(value, schema, root):
    """Validate only the draft-07 subset used by the checked-in request/reply contracts."""
    if '$ref' in schema:
        target = root
        for component in schema['$ref'].removeprefix('#/').split('/'):
            target = target[component]
        return matches(value, target, root)
    if 'oneOf' in schema and sum(matches(value, item, root) for item in schema['oneOf']) != 1:
        return False
    if 'anyOf' in schema and not any(matches(value, item, root) for item in schema['anyOf']):
        return False
    if 'const' in schema and (type(value) is not type(schema['const']) or value != schema['const']):
        return False
    if 'enum' in schema and not any(type(value) is type(item) and value == item for item in schema['enum']):
        return False
    kind = schema.get('type')
    types = {'object': lambda v: type(v) is dict, 'array': lambda v: type(v) is list,
             'string': lambda v: type(v) is str, 'boolean': lambda v: type(v) is bool,
             'null': lambda v: v is None, 'integer': lambda v: type(v) is int,
             'number': lambda v: type(v) in (int, float) and math.isfinite(v)}
    if kind and not types[kind](value):
        return False
    if type(value) is dict:
        props = schema.get('properties', {})
        if not set(schema.get('required', ())).issubset(value):
            return False
        for key, required in schema.get('dependencies', {}).items():
            if key in value and not set(required).issubset(value):
                return False
        if schema.get('additionalProperties') is False and not set(value).issubset(props):
            return False
        if not all(matches(item, props[key], root) for key, item in value.items() if key in props):
            return False
    if type(value) is list:
        if not schema.get('minItems', 0) <= len(value) <= schema.get('maxItems', len(value)):
            return False
        if schema.get('uniqueItems') and len({canonical(item) for item in value}) != len(value):
            return False
        if 'items' in schema and not all(matches(item, schema['items'], root) for item in value):
            return False
    if type(value) is str:
        # JSON/TS strings count UTF-16 units, including astral characters.
        size = len(value.encode('utf-16-le', errors='surrogatepass')) // 2
        if not schema.get('minLength', 0) <= size <= schema.get('maxLength', size):
            return False
        if 'pattern' in schema and not re.fullmatch(schema['pattern'], value):
            return False
    if type(value) in (int, float):
        if not math.isfinite(value) or not schema.get('minimum', value) <= value <= schema.get('maximum', value):
            return False
    return True


def validate_request(request):
    if not matches(request, CHOICE_SCHEMA['definitions']['request'], CHOICE_SCHEMA):
        raise sw.Failure('brain_request_schema')
    if not request['at_ms'] < request['deadline_ms'] <= request['at_ms'] + 15000:
        raise sw.Failure('brain_request_deadline')
    routes = request['routes']
    if len({item['id'] for item in routes}) != len(routes):
        raise sw.Failure('brain_request_duplicate_route')
    if not any(item['id'] == 'wait' and item['outcome'] == 'wait' for item in routes):
        raise sw.Failure('brain_request_missing_wait')
    if hashlib.sha256(canonical(routes).encode('utf-8')).hexdigest() != request['routes_sha256']:
        raise sw.Failure('brain_request_routes_hash')
    if request['consulted_fact_ids'] != [fact['id'] for fact in request['consulted_facts']] or request['goal']['revision'] != request['plan']['revision']:
        raise sw.Failure('brain_request_consulted_facts')
    return request


def validate_model(raw, request):
    result = sw.strict_json(raw)
    if not matches(result, MODEL_SCHEMA, MODEL_SCHEMA):
        raise sw.Failure('brain_reply_schema')
    if result['request_id'] != request['id']:
        raise sw.Failure('brain_reply_request_mismatch')
    if not any(item['id'] == result['route_id'] for item in request['routes']):
        raise sw.Failure('brain_reply_route_unknown')
    if result['plan_revision'] != request['plan']['revision'] or result['evidence_observation_id'] != request['based_on_observation_id'] or result['consulted_fact_ids'] != request['consulted_fact_ids']:
        raise sw.Failure('brain_reply_evidence_mismatch')
    if not result['reason'].strip():
        raise sw.Failure('brain_reply_empty_reason')
    return result


class Worker:
    def __init__(self, *, allow_upload=False, env_file=sw.ENV_PATH, timeout=15.0,
                 transport=sw.ark_transport, credential_loader=sw.read_credentials, prompt_file=None, prompt_sha256=None):
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 15:
            raise sw.Failure('invalid_timeout')
        if type(allow_upload) is not bool:
            raise sw.Failure('invalid_upload_gate')
        self.allow_upload, self.env_file, self.timeout = allow_upload, Path(env_file).expanduser(), float(timeout)
        self.transport, self.credential_loader = transport, credential_loader
        self.credentials, self.timed_out = None, False
        prompt_path = PROMPT_PATH if prompt_file is None else Path(prompt_file)
        import os, stat
        if not prompt_path.is_absolute():
            raise sw.Failure('brain_prompt_path')
        try:
            fd = os.open(prompt_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
            with os.fdopen(fd, 'rb') as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 65536:
                    raise sw.Failure('brain_prompt_size')
                data = source.read(65537)
            if len(data) != info.st_size or len(data) > 65536:
                raise sw.Failure('brain_prompt_changed')
            if prompt_sha256 is not None and (not re.fullmatch('[a-f0-9]{64}', prompt_sha256) or hashlib.sha256(data).hexdigest() != prompt_sha256):
                raise sw.Failure('brain_prompt_hash')
            if prompt_file is not None and prompt_sha256 is None:
                raise sw.Failure('brain_prompt_hash_required')
        except OSError:
            raise sw.Failure('brain_prompt_unavailable') from None
        self.prompt, self.prompt_sha256 = data.decode('utf-8'), hashlib.sha256(data).hexdigest()

    def plan(self, command):
        started = time.monotonic()
        identity = command.get('id') if isinstance(command, dict) else None
        if type(identity) is not str or not sw.ID.fullmatch(identity):
            identity = 'invalid-request'
        result = {'type': 'brain_choice', 'id': identity, 'status': 'failed', 'reply': None,
                  'reason': {'code': 'brain_worker_failed'}, 'model': None,
                  'prompt_version': PROMPT_VERSION, 'prompt_sha256': self.prompt_sha256,
                  'elapsed_ms': 0.0, 'usage': {'input_tokens': None, 'output_tokens': None}, 'raw_text': None}
        try:
            sw.exact_object(command, {'id', 'op', 'image_path', 'prompt_version', 'request'})
            if command['id'] != identity or command['op'] != 'plan' or command['prompt_version'] != PROMPT_VERSION:
                raise sw.Failure('invalid_request')
            request = validate_request(command['request'])
            if request['id'] != identity:
                raise sw.Failure('brain_request_id_mismatch')
            image_path = command['image_path']
            if image_path is not None and (type(image_path) is not str or not 1 <= len(image_path) <= 32768 or '\0' in image_path or not Path(image_path).is_absolute()):
                raise sw.Failure('invalid_image_path')
            if not self.allow_upload:
                result.update(status='disabled', reason={'code': 'upload_disabled'})
                return result
            if self.timed_out:
                raise sw.Failure('worker_timed_out')
            if image_path is None:
                raise sw.Failure('image_unavailable')
            image = sw.read_jpeg(Path(image_path))
            if self.credentials is None:
                self.credentials = self.credential_loader(self.env_file)
            key, model = self.credentials
            result['model'] = model
            payload = {'model': model, 'stream': False, 'max_tokens': 256, 'thinking': {'type': 'disabled'},
                       'messages': [{'role': 'system', 'content': self.prompt}, {'role': 'user', 'content': [
                           {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + base64.b64encode(image).decode('ascii')}},
                           {'type': 'text', 'text': canonical(request)},
                       ]}]}
            budget = min(self.timeout, (request['deadline_ms'] - request['at_ms']) / 1000)
            timeout = budget - (time.monotonic() - started)
            if timeout <= 0:
                raise sw.Failure('timeout')
            response = sw.bounded_request(self.transport, payload, key, timeout)
            choices = response.get('choices') if isinstance(response, dict) else None
            if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
                raise sw.Failure('invalid_provider_response')
            message = choices[0].get('message')
            raw = message.get('content') if isinstance(message, dict) and message.get('role') == 'assistant' else None
            if type(raw) is not str or len(raw.encode('utf-8')) > sw.MAX_RAW:
                raise sw.Failure('model_response_too_large')
            if key in raw or 'data:image/' in raw.lower() or sw.BASE64_TEXT.search(raw):
                raise sw.Failure('unsafe_model_text')
            result['raw_text'] = raw
            usage = response.get('usage')
            if isinstance(usage, dict):
                result['usage'] = {'input_tokens': sw.usage_count(usage.get('prompt_tokens')), 'output_tokens': sw.usage_count(usage.get('completion_tokens'))}
            if choices[0].get('finish_reason') not in (None, 'stop'):
                raise sw.Failure('model_response_incomplete')
            reply = validate_model(raw, request)
            if time.monotonic() - started >= budget:
                raise sw.Failure('timeout')
            result.update(status='ok', reply=reply, reason={'code': 'selected', 'message': reply['reason']})
        except sw.Failure as error:
            if error.code == 'timeout':
                self.timed_out = True
            result['reason'] = {'code': error.code}
        except Exception:
            result['reason'] = {'code': 'brain_worker_failed'}
        finally:
            result['elapsed_ms'] = round((time.monotonic() - started) * 1000, 3)
        return result

    def serve(self, source, destination):
        while True:
            line = source.readline(sw.MAX_LINE + 1)
            if not line:
                return
            if not line.strip():
                continue
            error_code = None
            if len(line) > sw.MAX_LINE:
                while line and not line.endswith('\n'):
                    line = source.readline(sw.MAX_LINE + 1)
                command, error_code = None, 'command_too_large'
            else:
                try:
                    command = sw.strict_json(line)
                except sw.Failure as error:
                    command, error_code = None, error.code
            result = self.plan(command)
            if error_code:
                result['reason'] = {'code': error_code}
            destination.write(json.dumps(result, ensure_ascii=False, allow_nan=False) + '\n')
            destination.flush()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true', required=True)
    parser.add_argument('--allow-game-image-upload', action='store_true')
    parser.add_argument('--env-file', type=Path, default=sw.ENV_PATH)
    parser.add_argument('--prompt-file', type=Path)
    parser.add_argument('--prompt-sha256')
    parser.add_argument('--timeout', type=float, default=15.0)
    args = parser.parse_args(argv)
    try:
        Worker(allow_upload=args.allow_game_image_upload, env_file=args.env_file, timeout=args.timeout, prompt_file=args.prompt_file, prompt_sha256=args.prompt_sha256).serve(sys.stdin, sys.stdout)
    except (sw.Failure, OSError, ValueError):
        print('brain_worker_startup_failed', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    # Supports both -m perception.brain_worker and direct absolute script paths.
    raise SystemExit(main())
