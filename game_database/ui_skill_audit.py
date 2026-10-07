"""Offline, self-contained UI skill audit; no input, network or model calls.

The JSON report is the exact artifact a user/Claude approves. HTML displays its
actual source image bytes, geometry, independent negative tests and histories.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
from html import escape
from pathlib import Path

from .runtime import RuntimeDatabase
from .store import ValidationError, canonical
from .ui_skills import UiSkills, _read


def image(proof: dict | None, *, bbox: dict | None = None, title: str = '') -> str:
    if proof is None: return '<p>No full PNG was collected for this frame.</p>'
    raw = _read(proof)
    overlay = '' if bbox is None else ('<span class="bbox" style="left:%.8f%%;top:%.8f%%;width:%.8f%%;height:%.8f%%"></span>' %
        tuple(bbox[k] * 100 for k in ('x', 'y', 'width', 'height')))
    return '<figure><figcaption>' + escape(title) + '</figcaption><div class="frame"><img alt="Original evidence image" src="data:image/png;base64,' + base64.b64encode(raw).decode() + '">' + overlay + '</div><code>' + escape(proof['sha256']) + '</code></figure>'


def document(report: dict, report_sha: str) -> str:
    parts = ['<!doctype html><html lang="zh"><meta charset="utf-8"><title>UI Skill Audit</title>',
             '<style>body{font-family:system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem}section{border-top:2px solid #aaa;margin-top:3rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:1rem}figure{max-width:900px}.frame{position:relative}.frame img{width:100%;display:block}.bbox{position:absolute;border:2px solid red;box-sizing:border-box}code{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:.5rem}.pass{color:#067700}.fail{color:#ad0000}</style>',
             '<h1>UI Skill Audit</h1><p>只读离线审核。生成报告不授予输入权限。</p>',
             '<p>Report SHA256: <code>' + escape(report_sha) + '</code></p>',
             '<p>Activation frozen: ' + str(report['activation_frozen']) + '</p>',
             '<p>Knowledge snapshot: <code>' + report['snapshot_sha256'] + '</code></p>']
    for entry in report['skills']:
        skill = entry['skill']; signature = skill['signature']; matrix = entry['negative_matrix']
        parts += ['<section><h2>' + escape(skill['skill_id']) + '</h2>',
                  '<pre>' + escape(canonical({k: skill[k] for k in ('state_id', 'scope', 'status', 'revision', 'element', 'action', 'expected_effect', 'governance')})) + '</pre>',
                  '<h3>原帧与输入元素框</h3>', image(signature['source']['capture'], bbox=skill['element']['bbox'], title=skill['state_id']),
                  '<h3>状态签名裁图及独立锚点</h3>', image(signature['crop'], title='entry signature')]
        for anchor in signature['anchors']: parts.append(image(anchor['crop'], title=anchor['id']))
        if skill.get('modal_guard'):
            parts += ['<h3>模态覆盖规则与实际负例</h3><pre>' + escape(canonical(skill['modal_guard'])) + '</pre>']
            for proof in skill['modal_guard']['negative_artifacts']: parts.append(image(proof, title='Reviewed unknown-modal negative'))
        parts += ['<h3>全已知其它状态负例矩阵</h3><table><tr><th>状态</th><th>来源 SHA</th><th>是否误匹配</th><th>结果</th></tr>']
        for row in matrix['rows']:
            parts.append('<tr><td>' + escape(row['state_id']) + '</td><td><code>' + row['capture_sha256'] + '</code></td><td>' + str(row['matched']) + '</td><td class="' + ('pass' if row['pass'] else 'fail') + '">' + ('PASS' if row['pass'] else 'FAIL') + '</td></tr>')
        parts += ['</table><pre>' + escape(canonical({k: matrix[k] for k in ('own_positive', 'pass', 'threshold_scope')})) + '</pre>',
                  '<h3>逐条审核链</h3><pre>' + escape(canonical(skill['review_chain'])) + '</pre>', '<h3>实际尝试与前后图</h3>']
        for attempt in entry['attempts']:
            parts += ['<h4>' + escape(attempt['attempt_id']) + '</h4><pre>' + escape(canonical(attempt)) + '</pre>',
                      image(attempt['before']['capture'], title='before: ' + attempt['before']['observation_id'])]
            if attempt['after']: parts.append(image(attempt['after']['capture'], title='after: ' + attempt['after']['observation_id']))
        parts.append('</section>')
    parts += ['<section><h2>隔离记录</h2><pre>' + escape(canonical(report['quarantine'])) + '</pre></section></html>']
    return '\n'.join(parts)


def generate(database: Path, output: Path) -> dict:
    with RuntimeDatabase(database, read_only=True) as runtime:
        report = UiSkills(runtime).audit_manifest()
    output.mkdir(parents=True, exist_ok=True)
    raw = (canonical(report) + '\n').encode(); sha = hashlib.sha256(raw).hexdigest()
    json_path = output / ('ui-skill-audit-' + sha + '.json')
    html_path = output / ('ui-skill-audit-' + sha + '.html')
    html = document(report, sha).encode()
    for path, data in ((json_path, raw), (html_path, html)):
        if path.exists() and path.read_bytes() != data: raise ValidationError('UI audit: immutable artifact changed')
        if not path.exists():
            with path.open('xb') as stream: stream.write(data)
    return {'report': {'path': str(json_path.resolve()), 'sha256': sha}, 'html': str(html_path.resolve()),
            'snapshot_sha256': report['snapshot_sha256'], 'activation_frozen': report['activation_frozen'], 'input_count': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True); parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try: print(canonical({'ok': True, 'result': generate(args.database, args.out)}))
    except Exception as error:
        print(canonical({'ok': False, 'error': str(error) if isinstance(error, ValidationError) else type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == '__main__': main()
