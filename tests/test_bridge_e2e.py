"""用 tests/mock_wow.lua 模拟 3.3.5a 接口跑整个插件：State 读数 → Codec 编码 → Bridge 排格子上色，
再按 Bridge 记录的纹理位置和颜色渲染成图，交给 JevCapture.exe 解码，核对字段。"""
import math
from pathlib import Path

import pytest

from jevbridge import render as R
from jevbridge import schema
from jevbridge.luahost import LuaHost

ALL = ("SchemaV1.lua", "Codec.lua", "State.lua", "Bridge.lua")
OUT = Path(__file__).resolve().parent.parent / "out" / "test_e2e"


def make_host(before=None, phys_h=2160, world_scale=1.0):
    setup = f'MockWoW.cvars.gxResolution = "3840x{phys_h}"; MockWoW.worldScale = {world_scale}\n' + (before or "")
    return LuaHost(files=ALL, mock_wow=True, before=setup)


def lua_payload(h, state_table):
    out, n = h.jb.Codec.encodePayload(h.jb.SchemaV1, state_table)
    return bytes(int(out[i]) for i in range(1, int(n) + 1))


def login(h):
    h.g.MockWoW.fire("PLAYER_LOGIN")
    return h.jb.Bridge


def bridge_rects(h, phys_h):
    """把 Bridge 的纹理换算成物理像素矩形，并检查每格都落在整数像素上。"""
    br = h.jb.Bridge
    f = br.frame
    k = f.GetEffectiveScale(f) * phys_h / 768
    rects = []
    for i in range(1, int(br.cells) + 1):
        t = br.textures[i]
        assert t.shown
        p = t.points[1]
        assert p.point == "TOPLEFT" and p.relPoint == "TOPLEFT" and h.lua.eval("rawequal")(p.rel, f)
        vals = [p.x * k, -p.y * k, t.width * k, t.height * k]
        for v in vals:
            assert abs(v - round(v)) < 1e-6, f"第 {i} 格没有对齐物理像素：{vals}"
        x, y, w, hh = (round(v) for v in vals)
        c = t.color
        rgb = []
        for j in (1, 2, 3):
            v = c[j] * 255
            assert abs(v - round(v)) < 1e-6 and round(v) % 17 == 0
            rgb.append(round(v))
        rects.append((x, y, w, hh, tuple(rgb)))
    return rects


def set_scene(h):
    lua = h.lua
    lua.execute('''
      local now = MockWoW.time
      local p = MockWoW.player
      p.combat = true
      p.cast = { name = "火球术", endMs = now * 1000 + 1234, notInterruptible = false }
      MockWoW.target = { hp = 750, hpmax = 1000, level = -1, classification = "elite",
        guid = "0xF1300000BC0012EF", hostile = true, targetingMe = true, range = 2,
        channel = { name = "精神鞭笞", endMs = now * 1000 + 2500, notInterruptible = false } }
      MockWoW.actions[1] = { usable = true, range = 1, cd = { start = now - 1, duration = 10, enable = 1 } }
      MockWoW.actions[2] = { usable = true, cd = { start = now - 0.5, duration = 1.5, enable = 1 } }
      MockWoW.actions[3] = { noMana = true, range = 0 }
      MockWoW.auras.player.HELPFUL[1] = { name = "真言术：韧", stacks = 0, expires = now + 60, caster = "player", spellId = 48161 }
      MockWoW.auras.target.HARMFUL[1] = { name = "暗言术：痛", stacks = 3, expires = 0, caster = "party1", spellId = 48125 }
    ''')


def check_scene(d, t_now):
    assert d["t_ms"] == math.floor(t_now * 1000) % 2 ** 32
    assert all(d["caps"].values())
    pf = d["p_flags"]
    assert pf["in_combat"] and pf["casting"] and pf["moving"] and pf["has_target"] and not pf["dead"]
    assert (d["p_hp"], d["p_hp_max"], d["p_power"], d["p_power_max"], d["p_level"]) == (5000, 6000, 3000, 4000, 80)
    assert d["p_cast_hash"] == schema.name_hash("火球术") and d["p_cast_rem_ms"] == 1234
    assert (d["p_map_id"], d["p_map_x"], d["p_map_y"]) == (301, 16384, 49151)
    assert (d["p_facing"], d["p_speed"]) == (15000, 700)
    tf = d["t_flags"]
    assert tf["exists"] and tf["hostile"] and tf["channeling"] and tf["interruptible"] and tf["targeting_me"]
    assert not tf["casting"] and not tf["is_player"]
    assert (d["t_hp_pct"], d["t_level"], d["t_class"], d["t_guid"]) == (7500, 255, 2, 0xBC0012EF)
    assert d["t_cast_hash"] == schema.name_hash("精神鞭笞") and d["t_cast_rem_ms"] == 2500
    assert d["t_range"] == 2
    assert d["gcd_rem_ms"] == 1000
    a = d["actions"]
    assert a[0]["cd_ms"] == 9000 and a[0]["flags"]["usable"] and a[0]["flags"]["in_range"]
    assert a[1]["cd_ms"] == 0
    assert a[2]["flags"]["no_mana"] and a[2]["flags"]["out_of_range"] and not a[2]["flags"]["usable"]
    assert not a[3]["flags"]["has"]
    assert d["p_buffs"][0] == {"id": 48161, "rem_ds": 600, "stacks": 0, "flags": {"mine": True}}
    assert d["t_debuffs"][0] == {"id": 48125, "rem_ds": 0, "stacks": 3, "flags": {"mine": False}}


@pytest.mark.parametrize("phys_h,world_scale,px", [(2160, 1.0, 3), (1080, 1.0, 3), (1440, 0.9, 3), (2160, 1.0, 4)])
def test_end_to_end(exe, phys_h, world_scale, px):
    h = make_host(phys_h=phys_h, world_scale=world_scale)
    br = login(h)
    if px != 3:
        h.g.SlashCmdList["JEVBRIDGE"](f"px {px}")
    assert int(br.cells) == 189
    set_scene(h)
    br.tick()  # 直接刷新一帧，时钟不前进，施法剩余时间保持精确值
    t_now = h.g.MockWoW.time
    rects = bridge_rects(h, phys_h)
    assert rects[0][:4] == (0, 0, px, px) and rects[128][:4] == (0, px, px, px)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"e2e-{phys_h}-{world_scale}-{px}.png"
    R.render_rects(rects, (128 * px + 40, 2 * px + 20)).save(path)
    r = exe.decode_images([path])[0]
    assert r["ok"], r
    assert r["seq"] == int(br.seq) and r["pitch"] == pytest.approx(px, abs=0.01)
    check_scene(schema.decode_payload(bytes.fromhex(r["payload"])), t_now)


def test_state_read_fields():
    # 不经过渲染，直接核对 State.read + Lua 编码的字段
    h = make_host()
    login(h)
    set_scene(h)
    state = h.jb.State.read(h.g.MockWoW.time)
    payload = lua_payload(h, state)
    check_scene(schema.decode_payload(payload), h.g.MockWoW.time)
    assert schema.encode_payload(schema.decode_payload(payload)) == payload


def test_tick_before_login_is_safe():
    h = make_host()
    h.g.MockWoW.update(0.1)  # 排版之前 OnUpdate 触发，不应报错
    assert int(h.jb.Bridge.seq) == 0


def test_only_changed_cells_are_reset():
    h = make_host()
    br = login(h)
    h.g.MockWoW.update(0.05)
    first = sum(int(br.textures[i].setTextureCalls) for i in range(1, 190))
    assert first == 189
    h.g.MockWoW.update(0.05)
    second = sum(int(br.textures[i].setTextureCalls) for i in range(1, 190)) - first
    assert 0 < second < 30  # 只有 seq、t_ms、CRC 相关的格子变了


def test_hz_throttle():
    h = make_host()
    br = login(h)
    for _ in range(10):
        h.g.MockWoW.update(0.01)  # 100 fps，30 Hz 下大约每 4 帧刷新一次
    assert 2 <= int(br.seq) <= 4


def test_facing_missing():
    h = make_host(before="GetPlayerFacing = nil")
    login(h)
    s = h.jb.State.read(h.g.MockWoW.time)
    assert not s.caps.facing
    assert s.caps.speed and s.caps.map_area
    d = schema.decode_payload(lua_payload(h, s))
    assert not d["caps"]["facing"] and d["p_facing"] == 0


def test_speed_missing():
    h = make_host(before="GetUnitSpeed = nil")
    s = h.jb.State.read(h.g.MockWoW.time)
    assert not s.caps.speed and not s.p_flags.moving


def test_slash_commands():
    h = make_host()
    br = login(h)
    cmd = h.g.SlashCmdList["JEVBRIDGE"]
    cmd("off")
    assert not br.enabled and not br.frame.shown
    cmd("on")
    assert br.enabled and br.frame.shown
    cmd("hz 60")
    assert br.hz == 60
    cmd("height 1080")
    assert br.physicalHeight() == 1080
    br.tick()  # 重新排版后，颜色要到下一次刷新才重设
    bridge_rects(h, 1080)
    cmd("status")
    assert "运行中" in h.g.MockWoW.chat[len(h.g.MockWoW.chat)]
