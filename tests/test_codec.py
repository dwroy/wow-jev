import random

import pytest

from jevbridge import schema
from jevbridge.luahost import LuaHost
from tests.helpers import random_state


@pytest.fixture(scope="module")
def lua():
    return LuaHost()


def test_lua_is_51_without_bit(lua):
    assert lua.lua.eval("_VERSION") == "Lua 5.1"
    assert lua.lua.eval("bit") is None


@pytest.mark.parametrize("data,crc", [
    (b"123456789", 0x29B1),
    (b"", 0xFFFF),
    (b"A", 0xB915),
])
def test_crc_vectors(lua, data, crc):
    assert schema.crc16(data) == crc
    if data:
        assert lua.crc16(data) == crc


def test_crc_random_matches(lua):
    rng = random.Random(7)
    for _ in range(50):
        data = bytes(rng.randrange(256) for _ in range(rng.randint(1, 300)))
        assert lua.crc16(data) == schema.crc16(data)


@pytest.mark.parametrize("name", ["Fireball", "火球术", "暗影箭", "a", "Mind Flay"])
def test_name_hash_matches(lua, name):
    assert lua.name_hash(name) == schema.name_hash(name)


def test_name_hash_empty_and_zero(lua):
    assert schema.name_hash("") == 0 and lua.name_hash("") == 0
    # 找一个 h 恰好为 0 的串，确认两边都记作 1
    rng = random.Random(3)
    while True:
        s = bytes(rng.randrange(32, 127) for _ in range(5))
        h = 0
        for b in s:
            h = (h * 31 + b) % 16777216
        last = (-h * 31) % 16777216
        if 32 <= last < 127:
            s = s + bytes([last])
            break
    text = s.decode("ascii")
    assert schema.name_hash(text) == 1
    assert lua.name_hash(text) == 1


def test_payload_size():
    assert schema.payload_size() == 263
    assert schema.cell_count() == 189


@pytest.mark.parametrize("seed", range(200))
def test_random_state_lua_python_identical(lua, seed):
    state = random_state(seed)
    py = schema.encode_payload(state)
    assert len(py) == 263
    assert lua.encode_payload(state) == py
    seq = seed * 331 % 65536
    assert lua.build_frame(seq, py) == schema.build_frame(seq, py)
    assert lua.frame_levels(state, seq) == schema.encode_frame_levels(state, seq)


def test_decode_roundtrip():
    state = {"p_hp": 12345, "p_flags": {"dead": True, "moving": True}, "t_level": 255,
             "actions": [{"cd_ms": 1500, "flags": {"has": True}}],
             "t_debuffs": [{}, {"id": 48125, "rem_ds": 150, "stacks": 2, "flags": {"mine": True}}]}
    out = schema.decode_payload(schema.encode_payload(state))
    assert out["p_hp"] == 12345
    assert out["p_flags"]["dead"] and out["p_flags"]["moving"] and not out["p_flags"]["ghost"]
    assert out["actions"][0] == {"cd_ms": 1500, "flags": {**{k: False for k in out["actions"][0]["flags"]}, "has": True}}
    assert out["t_debuffs"][1]["id"] == 48125 and out["t_debuffs"][1]["flags"]["mine"]
    seq, payload = schema.parse_frame(schema.build_frame(70000, schema.encode_payload(state)))
    assert seq == 70000 % 65536 and schema.decode_payload(payload) == out


def test_clamp_and_rounding():
    out = schema.decode_payload(schema.encode_payload(
        {"p_level": 300, "p_power_type": -5, "p_hp": 2.5, "p_hp_max": 2.49, "p_power": float("nan"), "t_hp_pct": True}))
    assert (out["p_level"], out["p_power_type"], out["p_hp"], out["p_hp_max"], out["p_power"], out["t_hp_pct"]) == (255, 0, 3, 2, 0, 0)


def test_levels_layout():
    lv = schema.encode_frame_levels({}, 1)
    assert len(lv) == 189
    assert lv[:8] == [(15, 15, 15), (0, 0, 0)] * 4
    assert lv[8] == (4, 10, 0)  # 0x4A 0x01 的前三个半字节
