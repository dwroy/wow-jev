"""把 Python 渲染的色条图交给 JevCapture.exe --image 离线解码，覆盖各种干扰。"""
from pathlib import Path

import pytest

from jevbridge import render as R
from jevbridge import schema
from tests.helpers import random_state

OUT = Path(__file__).resolve().parent.parent / "out" / "test_decode"
SEEDS = range(3)


def build_images(lv):
    base = R.render_levels
    bg = lambda seed: R.random_background((600, 40), seed)
    return {
        "plain": base(lv),
        "offset": base(lv, offset=(37, 11), size=(560, 40)),
        "cell4": base(lv, cell_px=4, offset=(2, 3), size=(530, 16)),
        "scale125": R.scale(base(lv, offset=(3, 2), size=(400, 12)), 1.25),
        "scale150": R.scale(base(lv, offset=(3, 2), size=(400, 12)), 1.5),
        "blur06": R.blur(base(lv, offset=(4, 4), size=(400, 16)), 0.6),
        "noise6": R.noise(base(lv, offset=(5, 5), size=(400, 16)), 6, seed=11),
        "gamma105": R.gamma(base(lv), 1.05),
        "gamma110": R.gamma(base(lv), 1.1),
        "random_bg": base(lv, offset=(29, 13), size=(600, 40), background=bg(5)),
        "corrupt": base(R.corrupt_cell(lv, 100)),
    }


@pytest.fixture(scope="module")
def decoded(exe):
    OUT.mkdir(parents=True, exist_ok=True)
    cases, paths = [], []
    for seed in SEEDS:
        state = random_state(1000 + seed)
        seq = 4000 + seed
        lv = schema.encode_frame_levels(state, seq)
        for name, img in build_images(lv).items():
            p = OUT / f"{name}-{seed}.png"
            img.save(p)
            cases.append((name, seed, seq, schema.encode_payload(state)))
            paths.append(p)
    results = exe.decode_images(paths)
    return {(name, seed): (seq, payload, r) for (name, seed, seq, payload), r in zip(cases, results)}


def check_ok(decoded, name, seed):
    seq, payload, r = decoded[(name, seed)]
    assert r["ok"], r
    assert r["seq"] == seq and r["ver"] == 1 and r["len"] == 263
    assert bytes.fromhex(r["payload"]) == payload
    assert r["max_err"] <= 8


MUST_PASS = ["plain", "offset", "cell4", "scale125", "scale150", "blur06", "noise6", "gamma105", "random_bg"]


@pytest.mark.parametrize("seed", SEEDS)
@pytest.mark.parametrize("name", MUST_PASS)
def test_decodes(decoded, name, seed):
    check_ok(decoded, name, seed)


@pytest.mark.xfail(strict=True, reason="gamma 1.1 会让 6 档附近偏差超过 8，超出 ±8 的容差；见 docs/protocol-v1.md")
@pytest.mark.parametrize("seed", SEEDS)
def test_gamma_110_expected_to_fail(decoded, seed):
    check_ok(decoded, "gamma110", seed)


@pytest.mark.parametrize("seed", SEEDS)
def test_corrupt_cell_reports_crc(decoded, seed):
    _, _, r = decoded[("corrupt", seed)]
    assert not r["ok"] and r["reason"] == "crc"


def test_geometry(decoded):
    assert decoded[("plain", 0)][2]["pitch"] == pytest.approx(3, abs=0.01)
    r = decoded[("offset", 0)][2]
    assert (r["x0"], r["y0"]) == (pytest.approx(36.5, abs=0.05), pytest.approx(10.5, abs=0.05))
    assert decoded[("cell4", 0)][2]["pitch"] == pytest.approx(4, abs=0.01)
    assert decoded[("scale150", 0)][2]["pitch"] == pytest.approx(4.5, abs=0.02)


def test_blank_image_reports_no_sync(exe, tmp_path):
    p = tmp_path / "blank.png"
    R.render_levels([(0, 0, 0)] * 10, size=(400, 20)).save(p)
    r = exe.decode_images([p])[0]
    assert not r["ok"] and r["reason"] == "no_sync"


def test_decode_time_under_5ms(exe, decoded):
    # 预热后的纯解码耗时，取 200 次平均（截屏耗时要等 --live 实测）
    paths = [OUT / "plain-0.png", OUT / "random_bg-0.png", OUT / "scale150-0.png"]
    for r in exe.decode_images(paths, extra_args=["--repeat", "200"]):
        assert r["ok"] and r["dec_ms"] < 5, r
