"""Presentation invariants only; no field DB, model or desktop access."""
import base64
import hashlib
from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote

from PIL import Image, ImageDraw
import pytest

from game_database.runtime import RuntimeDatabase
from game_database.store import ValidationError
from game_database.ui_skill_audit import Images, generate, render_report
from game_database.ui_skills import UiSkills
from tests.test_ui_skills import prepare_governed, governed_attempt


class Tags(HTMLParser):
    def __init__(self, html):
        super().__init__(); self.tags = []; self.feed(html)

    def handle_starttag(self, tag, attrs): self.tags.append((tag, dict(attrs)))


def test_verified_jpeg_thumbnail_keeps_source_geometry_sha_and_original_link(tmp_path):
    path = tmp_path / 'source photo.png'
    with Image.new('RGB', (1920, 1080), 'black') as original:
        ImageDraw.Draw(original).rectangle((480, 270, 1439, 809), fill=(0, 200, 0)); original.save(path)
    original_bytes = path.read_bytes(); proof = {'path': str(path), 'sha256': hashlib.sha256(original_bytes).hexdigest()}
    output = tmp_path / 'audit'; output.mkdir()
    html = Images(output).image(proof, bbox={'x': .25, 'y': .25, 'width': .5, 'height': .5})
    tags = Tags(html).tags; img = next(a for t, a in tags if t == 'img')
    with Image.open(BytesIO(base64.b64decode(img['src'].split(',', 1)[1]))) as thumbnail:
        assert thumbnail.format == 'JPEG' and thumbnail.size == (640, 360)
        assert thumbnail.getpixel((320, 180))[1] >= 190  # Same source-box center after scaling.
    surface = next(a for t, a in tags if t == 'div')
    assert surface['data-source-width'] == '1920' and surface['data-source-height'] == '1080'
    box = next(a for t, a in tags if t == 'span')
    assert box['style'] == 'left:25.00000000%;top:25.00000000%;width:50.00000000%;height:50.00000000%'
    assert (int(img['width']) * .25, int(img['height']) * .25) == (160, 90)
    link = next(a for t, a in tags if t == 'a')['href']
    assert (output / unquote(link)).resolve() == path.resolve() and '%20' in link
    assert proof['sha256'] in html and str(path) in html and path.read_bytes() == original_bytes


def test_render_existing_report_preserves_json_legacy_html_all_negatives_and_histories(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        store.attempt(governed_attempt(store, tmp_path, 1))
        first = generate(db.path, tmp_path / 'first')
    json_path = Path(first['report']['path']); original_json = json_path.read_bytes()
    import json
    report = json.loads(original_json)
    old_html = json_path.with_suffix('.html'); old_html.write_bytes(b'legacy full PNG presentation; immutable')
    result = render_report(first['report'], tmp_path / 'new-version')
    new_html = Path(result['html']); html = new_html.read_text()
    assert new_html.name.endswith('.thumb-v3.html') and result['thumbnail']['max_edge'] == 640
    assert result['html_bytes'] == len(new_html.read_bytes())
    assert hashlib.sha256(new_html.read_bytes()).hexdigest() == result['html_sha256']
    assert json_path.read_bytes() == original_json == Path(result['report']['path']).read_bytes()
    assert old_html.read_bytes() == b'legacy full PNG presentation; immutable'
    assert html.count('class="negative-row"') == sum(len(e['negative_matrix']['rows']) for e in report['skills'])
    assert html.count('<h2>') == len(report['skills']) + 1
    for entry in report['skills']:
        assert entry['skill']['skill_id'] in html
        for event in entry['skill']['review_chain']: assert event['event_sha256'] in html
        for row in entry['negative_matrix']['rows']: assert row['capture_sha256'] in html and row['capture_path'] in html
        for attempt in entry['attempts']: assert '<h4>' + attempt['attempt_id'] + '</h4>' in html
    assert render_report(first['report'], tmp_path / 'new-version') == result
    new_html.write_bytes(b'modified output')
    with pytest.raises(ValidationError, match='immutable'): render_report(first['report'], tmp_path / 'new-version')


def test_each_new_render_rechecks_source_and_report_sha(tmp_path):
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        first = generate(db.path, tmp_path / 'first')
    wrong_report = {**first['report'], 'sha256': 'f' * 64}
    with pytest.raises(ValidationError, match='hash changed'): render_report(wrong_report, tmp_path / 'wrong-report')
    import json
    report = json.loads(Path(first['report']['path']).read_bytes())
    capture = Path(report['skills'][0]['skill']['signature']['source']['capture']['path'])
    capture.write_bytes(b'changed original PNG')
    with pytest.raises(ValidationError, match='hash changed'): render_report(first['report'], tmp_path / 'changed-source')


def test_growing_preview_corpus_shrinks_images_without_omitting_records(tmp_path, monkeypatch):
    import game_database.ui_skill_audit as audit
    from game_database.store import canonical
    with RuntimeDatabase(tmp_path / 'agent.sqlite') as db:
        store = UiSkills(db, create=True); prepare_governed(store, tmp_path)
        report = store.audit_manifest()
    large = audit.document(report, 'a' * 64, base_dir=tmp_path, max_edge=640).encode()
    small = audit.document(report, 'a' * 64, base_dir=tmp_path, max_edge=64).encode()
    assert len(small) < len(large)
    monkeypatch.setattr(audit, 'HTML_MAX_BYTES', (len(large) + len(small)) // 2)
    raw = (canonical(report) + '\n').encode()
    result = audit._render(report, raw, tmp_path / 'bounded')
    html = Path(result['html']).read_text()
    assert result['html_bytes'] < result['html_max_bytes'] and result['thumbnail']['max_edge'] < 640
    assert Path(result['report']['path']).read_bytes() == raw
    assert html.count('class="negative-row"') == sum(len(e['negative_matrix']['rows']) for e in report['skills'])
    assert all(e['skill']['skill_id'] in html for e in report['skills'])
