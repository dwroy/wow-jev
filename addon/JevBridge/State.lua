-- 读 WoW 3.3.5a 接口，拼成 schema_v1 定义的 state 表。
-- 版本不确定的接口（GetPlayerFacing、GetUnitSpeed 等）先判断是否存在，结果记在 caps 里。

JevBridge = JevBridge or {}
local State = {}
JevBridge.State = State

local Codec = JevBridge.Codec

local CLASSIFICATION = { normal = 1, elite = 2, rare = 3, rareelite = 4, worldboss = 5, trivial = 6 }

local function truthy(v) return v and v ~= 0 and true or false end

-- 施法/引导：3.3.5a 的 UnitCastingInfo 第 9 个返回值、UnitChannelInfo 第 8 个返回值是 notInterruptible
local function readCast(unit, nowMs)
  local name, _, _, _, _, endMs, _, _, notInterruptible = UnitCastingInfo(unit)
  local kind = "casting"
  if not name then
    name, _, _, _, _, endMs, _, notInterruptible = UnitChannelInfo(unit)
    kind = "channeling"
  end
  if not name then return nil end
  local rem = (endMs or nowMs) - nowMs
  return kind, Codec.nameHash(name), rem > 0 and rem or 0, not notInterruptible
end

local function readAuras(unit, filter, count, now, caps)
  local list = {}
  for i = 1, count do
    local name, _, _, stacks, _, _, expires, caster, _, _, spellId = UnitAura(unit, i, filter)
    if not name then break end
    if spellId then caps.aura_spell_id = true end
    local rem = 0
    if expires and expires > 0 then rem = (expires - now) * 10 end
    list[i] = {
      id = spellId or 0,
      rem_ds = rem > 0 and rem or 0,
      stacks = stacks or 0,
      flags = { mine = caster == "player" },
    }
  end
  return list
end

-- 动作条 1–12 格。冷却总时长 ≤1.5 秒的当作公共冷却，单独汇总成 gcd_rem_ms。
local function readActions(now)
  local list, gcd = {}, 0
  for slot = 1, 12 do
    local e = { cd_ms = 0, flags = {} }
    if HasAction(slot) then
      local f = e.flags
      f.has = true
      local usable, noMana = IsUsableAction(slot)
      f.usable, f.no_mana = truthy(usable), truthy(noMana)
      local r = IsActionInRange(slot)
      f.in_range = r == 1 or r == true
      f.out_of_range = r == 0 or r == false
      f.current = truthy(IsCurrentAction(slot))
      f.auto_repeat = truthy(IsAutoRepeatAction(slot))
      local start, duration, enable = GetActionCooldown(slot)
      if enable == 1 and start and start > 0 and duration and duration > 0 then
        local rem = (start + duration - now) * 1000
        if rem > 0 then
          if duration <= 1.5 then
            if rem > gcd then gcd = rem end
          else
            e.cd_ms = rem
          end
        end
      end
    end
    list[slot] = e
  end
  return list, gcd
end

local function readRange()
  if CheckInteractDistance("target", 3) then return 1 end  -- 决斗距离 9.9 码
  if CheckInteractDistance("target", 2) then return 2 end  -- 交易距离 11.11 码
  if CheckInteractDistance("target", 4) then return 3 end  -- 跟随距离 28 码
  return 4
end

local function guidLow32(guid)
  if type(guid) ~= "string" or #guid < 8 then return 0 end
  return tonumber(guid:sub(-8), 16) or 0
end

function State.read(now)
  now = now or GetTime()
  local nowMs = now * 1000
  local caps = {}
  local s = { t_ms = math.floor(nowMs) % 4294967296, caps = caps }

  -- 玩家
  local pf = {
    in_combat = truthy(UnitAffectingCombat("player")),
    dead = truthy(UnitIsDead("player")),
    ghost = truthy(UnitIsGhost("player")),
    mounted = truthy(IsMounted()),
    resting = truthy(IsResting()),
    swimming = truthy(IsSwimming()),
    flying = truthy(IsFlying()),
    indoors = truthy(IsIndoors()),
    stealthed = truthy(IsStealthed()),
    has_target = truthy(UnitExists("target")),
  }
  s.p_flags = pf
  s.p_hp, s.p_hp_max = UnitHealth("player"), UnitHealthMax("player")
  s.p_power, s.p_power_max = UnitPower("player"), UnitPowerMax("player")
  s.p_power_type = UnitPowerType("player")
  s.p_level = UnitLevel("player")

  local kind, hash, rem = readCast("player", nowMs)
  if kind then
    pf[kind] = true
    s.p_cast_hash, s.p_cast_rem_ms = hash, rem
  end

  if GetCurrentMapAreaID then
    s.p_map_id = GetCurrentMapAreaID()
    caps.map_area = true
  end
  local x, y = GetPlayerMapPosition("player")
  if x and y and (x > 0 or y > 0) then
    s.p_map_x, s.p_map_y = x * 65535, y * 65535
    caps.map_pos = true
  end
  if GetPlayerFacing then
    s.p_facing = (GetPlayerFacing() or 0) * 10000
    caps.facing = true
  end
  if GetUnitSpeed then
    local speed = GetUnitSpeed("player") or 0
    s.p_speed = speed * 100
    pf.moving = speed > 0
    caps.speed = true
  end

  -- 目标
  local tf = { exists = pf.has_target }
  s.t_flags = tf
  if pf.has_target then
    tf.hostile = truthy(UnitCanAttack("player", "target"))
    tf.dead = truthy(UnitIsDead("target"))
    tf.is_player = truthy(UnitIsPlayer("target"))
    tf.tapped_by_other = truthy(UnitIsTapped("target")) and not truthy(UnitIsTappedByPlayer("target"))
    tf.targeting_me = truthy(UnitIsUnit("targettarget", "player"))
    local max = UnitHealthMax("target") or 0
    s.t_hp_pct = max > 0 and (UnitHealth("target") or 0) / max * 10000 or 0
    local level = UnitLevel("target") or 0
    s.t_level = level < 0 and 255 or level
    s.t_class = CLASSIFICATION[UnitClassification("target") or ""] or 0
    s.t_guid = guidLow32(UnitGUID("target"))
    local tkind, thash, trem, interruptible = readCast("target", nowMs)
    if tkind then
      tf[tkind] = true
      tf.interruptible = interruptible
      s.t_cast_hash, s.t_cast_rem_ms = thash, trem
    end
    s.t_range = readRange()
  end

  -- 动作条与光环
  s.actions, s.gcd_rem_ms = readActions(now)
  s.p_buffs = readAuras("player", "HELPFUL", 8, now, caps)
  s.p_debuffs = readAuras("player", "HARMFUL", 4, now, caps)
  if pf.has_target then
    s.t_debuffs = readAuras("target", "HARMFUL", 8, now, caps)
    s.t_buffs = readAuras("target", "HELPFUL", 4, now, caps)
  end
  return s
end
