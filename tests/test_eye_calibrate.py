import hashlib
import json

from PIL import Image
import pytest

from tools.eye_calibrate import CalibrationError, generate, rgb_distance


@pytest.fixture
def pair(tmp_path):
    opened, closed = tmp_path / "open-source.png", tmp_path / "closed-source.png"
    Image.new("RGB", (40, 30), (180, 90, 20)).save(opened)
    Image.new("RGB", (40, 30), (10, 20, 30)).save(closed)
    return opened, closed


def test_bundle_exact_contract_pixels_and_full_source_sha(pair, tmp_path):
    opened, closed = pair
    out = tmp_path / "bundle"
    bundle, distance = generate(opened, closed, (4, 6, 8, 9), out, "inventory-test")
    assert set(bundle) == {"version", "id", "client_width", "client_height", "roi", "templates", "thresholds", "provenance"}
    assert bundle["templates"] == {"open": "open.png", "closed": "closed.png"}
    assert bundle["provenance"] == {"open_sha256": hashlib.sha256(opened.read_bytes()).hexdigest(),
                                    "closed_sha256": hashlib.sha256(closed.read_bytes()).hexdigest()}
    assert json.loads((out / "calibration.json").read_text()) == bundle
    with Image.open(opened) as original, Image.open(out / "open.png") as crop:
        assert crop.size == (8, 9) and crop.tobytes() == original.crop((4, 6, 12, 15)).tobytes()
    assert distance > 0.04


@pytest.mark.parametrize("roi", [(True, 0, 5, 5), (0, 0, 5.0, 5), (-1, 0, 5, 5),
                                  (0, 0, 0, 5), (35, 0, 6, 5), (0, 29, 5, 2)])
def test_strict_roi_and_bounds(pair, tmp_path, roi):
    with pytest.raises(CalibrationError):
        generate(*pair, roi, tmp_path / "bundle", "inventory-test")
    assert not (tmp_path / "bundle").exists()


@pytest.mark.parametrize("name,value", [("max_distance", 0), ("min_margin", -1), ("max_distance", 1.1),
                                      ("min_margin", True), ("max_distance", float("inf")), ("min_margin", float("nan"))])
def test_threshold_ranges(pair, tmp_path, name, value):
    with pytest.raises(CalibrationError):
        generate(*pair, (0, 0, 5, 5), tmp_path / "bundle", "inventory-test", **{name: value})


def test_same_roi_not_separable_even_different_sources(tmp_path):
    first, second = tmp_path / "a.png", tmp_path / "b.png"
    image = Image.new("RGB", (40, 30), (10, 20, 30))
    image.save(first)
    image.putpixel((30, 20), (255, 255, 255))
    image.save(second)
    with pytest.raises(CalibrationError, match="不可分"):
        generate(first, second, (0, 0, 5, 5), tmp_path / "bundle", "inventory-test")


def test_different_layout_and_existing_output_preserved(pair, tmp_path):
    Image.new("RGB", (42, 30), (0, 0, 0)).save(pair[1])
    with pytest.raises(CalibrationError, match="尺寸"):
        generate(*pair, (0, 0, 5, 5), tmp_path / "bundle", "inventory-test")
    Image.new("RGB", (40, 30), (0, 0, 0)).save(pair[1])
    out = tmp_path / "bundle"
    out.mkdir()
    keep = out / "keep.txt"
    keep.write_text("keep")
    with pytest.raises(FileExistsError):
        generate(*pair, (0, 0, 5, 5), out, "inventory-test")
    assert keep.read_text() == "keep"
