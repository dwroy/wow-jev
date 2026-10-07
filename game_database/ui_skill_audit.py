"""Offline UI skill audit with bounded JPEG previews and original evidence links.

The exact JSON report and original PNGs remain authoritative. HTML is a
versioned presentation, never an input authorization or a new observation.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
from html import escape
from io import BytesIO
import os
from pathlib import Path
from urllib.parse import quote

from .runtime import RuntimeDatabase
from .store import ValidationError, canonical, parse_json
from .ui_skills import UiSkills, _read

RENDER_VERSION = 'thumb-v2'
THUMBNAIL_MAX_EDGE = 640
THUMBNAIL_QUALITY = 78


class Images:
    """One render's verified thumbnails; no cache survives an invocation."""
    def __init__(self, base_dir: Path | None = None):
        self.base_dir = base_dir.resolve() if base_dir else None
        self.cache = {}

    def link(self, proof: dict) -> str:
        path = Path(proof['path']).absolute()
        href = quote(os.path.relpath(path, self.base_dir).replace(os.sep, '/'), safe='/') if self.base_dir else path.as_uri()
        return '<a class="original" href="' + escape(href, quote=True) + '">原图</a> <code class="source-path">' + escape(proof['path']) + '</code>'

    def image(self, proof: dict | None, *, bbox: dict | None = None, title: str = '') -> str:
        if proof is None: return '<p>No full PNG was collected for this frame.</p>'
        key = (str(Path(proof['path']).absolute()), proof['sha256'])
        if key not in self.cache:
            from PIL import Image
            raw = _read(proof)
            with Image.open(BytesIO(raw)) as original:
                if original.format != 'PNG': raise ValidationError('UI audit: original evidence must be PNG')
                source_width, source_height = original.size
                thumbnail = original.convert('RGB')
            try:
                thumbnail.thumbnail((THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE), Image.Resampling.LANCZOS)
                output = BytesIO()
                thumbnail.save(output, format='JPEG', quality=THUMBNAIL_QUALITY, optimize=True, subsampling=2)
                self.cache[key] = (base64.b64encode(output.getvalue()).decode(), thumbnail.width, thumbnail.height, source_width, source_height)
            finally:
                thumbnail.close()
        encoded, width, height, source_width, source_height = self.cache[key]
        overlay = '' if bbox is None else ('<span class="bbox" style="left:%.8f%%;top:%.8f%%;width:%.8f%%;height:%.8f%%"></span>' %
            tuple(bbox[k] * 100 for k in ('x', 'y', 'width', 'height')))
        return ('<figure><figcaption>' + escape(title) + '</figcaption><div class="frame" style="width:' + str(width) + 'px" '
            'data-source-width="' + str(source_width) + '" data-source-height="' + str(source_height) + '">'
            '<img alt="JPEG preview; original PNG remains authoritative" loading="lazy" width="' + str(width) + '" height="' + str(height) + '" '
            'src="data:image/jpeg;base64,' + encoded + '">' + overlay + '</div>' + self.link(proof) +
            '<br>原图 SHA256: <code class="source-sha256">' + escape(proof['sha256']) + '</code></figure>')


def image(proof: dict | None, *, bbox: dict | None = None, title: str = '') -> str:
    return Images().image(proof, bbox=bbox, title=title)


def document(report: dict, report_sha: str, *, base_dir: Path | None = None) -> str:
    images = Images(base_dir)
    parts = ['<!doctype html><html lang="zh"><meta charset="utf-8"><title>UI Skill Audit</title>',
             '<style>body{font-family:system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem}section{border-top:2px solid #aaa;margin-top:3rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:1rem}figure{margin:1rem 0;max-width:640px}.frame{position:relative;max-width:100%}.frame img{width:100%;height:auto;display:block}.bbox{position:absolute;border:2px solid red;box-sizing:border-box}code{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:.5rem}.pass{color:#067700}.fail{color:#ad0000}</style>',
             '<h1>UI Skill Audit</h1><p>只读离线审核。生成报告不授予输入权限。</p>',
             '<p>JPEG 缩略图长边不超过 640 像素，仅供浏览；原始 PNG、路径与 SHA256 保留，精确像素审核请打开原图。</p>',
             '<p>Renderer: ' + RENDER_VERSION + '; Report SHA256: <code>' + escape(report_sha) + '</code></p>',
             '<p>Activation frozen: ' + str(report['activation_frozen']) + '</p>',
             '<p>Knowledge snapshot: <code>' + report['snapshot_sha256'] + '</code></p>']
    for entry in report['skills']:
        skill = entry['skill']; signature = skill['signature']; matrix = entry['negative_matrix']
        parts += ['<section><h2>' + escape(skill['skill_id']) + '</h2>',
                  '<pre>' + escape(canonical({k: skill[k] for k in ('state_id', 'scope', 'status', 'revision', 'element', 'action', 'expected_effect', 'governance')})) + '</pre>',
                  '<h3>原帧与输入元素框</h3>', images.image(signature['source']['capture'], bbox=skill['element']['bbox'], title=skill['state_id']),
                  '<h3>状态签名裁图及独立锚点</h3>', images.image(signature['crop'], title='entry signature')]
        for anchor in signature['anchors']: parts.append(images.image(anchor['crop'], title=anchor['id']))
        if skill.get('modal_guard'):
            parts += ['<h3>模态覆盖规则与实际负例</h3><pre>' + escape(canonical(skill['modal_guard'])) + '</pre>']
            for proof in skill['modal_guard']['negative_artifacts']: parts.append(images.image(proof, title='Reviewed unknown-modal negative'))
        parts += ['<h3>全已知其它状态负例矩阵</h3><table><tr><th>状态</th><th>来源 SHA / 原图及缩略图</th><th>是否误匹配</th><th>结果</th></tr>']
        for row in matrix['rows']:
            proof = {'path': row['capture_path'], 'sha256': row['capture_sha256']}
            parts.append('<tr class="negative-row"><td>' + escape(row['state_id']) + '</td><td>' + images.image(proof, title='negative: ' + row['state_id']) + '</td><td>' + str(row['matched']) + '</td><td class="' + ('pass' if row['pass'] else 'fail') + '">' + ('PASS' if row['pass'] else 'FAIL') + '</td></tr>')
        parts += ['</table><pre>' + escape(canonical({k: matrix[k] for k in ('own_positive', 'pass', 'threshold_scope')})) + '</pre>',
                  '<h3>逐条审核链</h3><pre>' + escape(canonical(skill['review_chain'])) + '</pre>', '<h3>实际尝试与前后图</h3>']
        for attempt in entry['attempts']:
            parts += ['<h4>' + escape(attempt['attempt_id']) + '</h4><pre>' + escape(canonical(attempt)) + '</pre>',
                      images.image(attempt['before']['capture'], title='before: ' + attempt['before']['observation_id'])]
            if attempt['after']: parts.append(images.image(attempt['after']['capture'], title='after: ' + attempt['after']['observation_id']))
        parts.append('</section>')
    parts += ['<section><h2>隔离记录</h2><pre>' + escape(canonical(report['quarantine'])) + '</pre></section></html>']
    return '\n'.join(parts)


def _write_new(path: Path, data: bytes) -> None:
    if path.exists() and path.read_bytes() != data: raise ValidationError('UI audit: immutable artifact changed')
    if not path.exists():
        with path.open('xb') as stream: stream.write(data)


def _render(report: dict, raw: bytes, output: Path) -> dict:
    sha = hashlib.sha256(raw).hexdigest()
    output.mkdir(parents=True, exist_ok=True)
    json_path = output / ('ui-skill-audit-' + sha + '.json')
    html_path = output / ('ui-skill-audit-' + sha + '.' + RENDER_VERSION + '.html')
    html = document(report, sha, base_dir=output).encode()
    _write_new(json_path, raw); _write_new(html_path, html)
    return {'report': {'path': str(json_path.resolve()), 'sha256': sha}, 'html': str(html_path.resolve()),
            'html_sha256': hashlib.sha256(html).hexdigest(), 'html_bytes': len(html), 'render_version': RENDER_VERSION,
            'thumbnail': {'format': 'JPEG', 'max_edge': THUMBNAIL_MAX_EDGE, 'quality': THUMBNAIL_QUALITY},
            'snapshot_sha256': report['snapshot_sha256'], 'activation_frozen': report['activation_frozen'], 'input_count': 0}


def render_report(proof: dict, output: Path) -> dict:
    """Render an existing immutable JSON artifact without opening a database."""
    raw = _read(proof)
    report = parse_json(raw)
    if report.get('protocol') != 'wow-ui-skill-audit' or report.get('version') != 2:
        raise ValidationError('UI audit: existing report protocol/version unsupported')
    return _render(report, raw, output)


def generate(database: Path, output: Path) -> dict:
    with RuntimeDatabase(database, read_only=True) as runtime:
        report = UiSkills(runtime).audit_manifest()
    return _render(report, (canonical(report) + '\n').encode(), output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--database', type=Path); source.add_argument('--report', type=Path)
    parser.add_argument('--report-sha256'); parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if bool(args.report) != bool(args.report_sha256): parser.error('--report and --report-sha256 must be supplied together')
    try:
        result = render_report({'path': str(args.report), 'sha256': args.report_sha256}, args.out) if args.report else generate(args.database, args.out)
        print(canonical({'ok': True, 'result': result}))
    except Exception as error:
        print(canonical({'ok': False, 'error': str(error) if isinstance(error, ValidationError) else type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == '__main__': main()
