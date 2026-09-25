-- 离线模拟 WoW 3.3.5a 接口，供 lupa 端到端测试用。只实现 JevBridge 用到的部分。
-- 测试通过修改 MockWoW 里的数据来控制接口返回值。

MockWoW = {
  time = 1000.0,
  cvars = { gxResolution = "3840x2160" },
  worldScale = 1.0,
  chat = {},
  player = {
    hp = 5000, hpmax = 6000, power = 3000, powermax = 4000, ptype = 0, level = 80,
    combat = false, dead = false, ghost = false,
    mounted = false, resting = false, swimming = false, flying = false, indoors = false, stealthed = false,
    cast = nil,      -- { name = "火球术", endMs = ..., notInterruptible = false }
    channel = nil,
  },
  target = nil,      -- { hp, hpmax, level, classification, guid, hostile, dead, isPlayer, tapped, tappedByPlayer, targetingMe, cast, channel, range = 1..4 }
  facing = 1.5, speed = 7.0,
  mapId = 301, mapX = 0.25, mapY = 0.75,
  auras = { player = { HELPFUL = {}, HARMFUL = {} }, target = { HELPFUL = {}, HARMFUL = {} } },
  actions = {},      -- [slot] = { usable, noMana, range (1/0/nil), current, autoRepeat, cd = { start, duration, enable } }
}

-- ---------- 框体 ----------

local Region = {}
Region.__index = Region

local function newRegion(kind, parent)
  return setmetatable({ kind = kind, parent = parent, scale = 1, points = {}, shown = true,
                        width = 0, height = 0, scripts = {}, events = {}, textures = {}, setTextureCalls = 0 }, Region)
end

function Region:SetFrameStrata(s) self.strata = s end
function Region:SetFrameLevel(l) self.level = l end
function Region:SetScale(s) self.scale = s end
function Region:GetEffectiveScale()
  if self == WorldFrame then return MockWoW.worldScale end
  return self.scale * (self.parent and self.parent:GetEffectiveScale() or 1)
end
function Region:ClearAllPoints() self.points = {} end
function Region:SetPoint(point, rel, relPoint, x, y)
  self.points[#self.points + 1] = { point = point, rel = rel, relPoint = relPoint, x = x or 0, y = y or 0 }
end
function Region:SetWidth(w) self.width = w end
function Region:SetHeight(h) self.height = h end
function Region:GetWidth() return self.width end
function Region:GetHeight() return self.height end
function Region:SetScript(name, fn) self.scripts[name] = fn end
function Region:GetScript(name) return self.scripts[name] end
function Region:RegisterEvent(ev) self.events[ev] = true end
function Region:Show() self.shown = true end
function Region:Hide() self.shown = false end
function Region:IsShown() return self.shown end
function Region:CreateTexture(_, layer)
  local t = newRegion("Texture", self)
  t.layer = layer
  self.textures[#self.textures + 1] = t
  return t
end
function Region:SetTexture(r, g, b, a)
  self.color = { r, g, b, a }
  self.setTextureCalls = self.setTextureCalls + 1
end

WorldFrame = newRegion("Frame", nil)
UIParent = newRegion("Frame", nil)
MockWoW.frames = {}

function CreateFrame(kind, name, parent)
  local f = newRegion(kind, parent)
  if name then _G[name] = f end
  MockWoW.frames[#MockWoW.frames + 1] = f
  return f
end

DEFAULT_CHAT_FRAME = { AddMessage = function(_, msg) MockWoW.chat[#MockWoW.chat + 1] = msg end }
SlashCmdList = {}

-- 驱动事件与帧刷新
function MockWoW.fire(event, ...)
  for _, f in ipairs(MockWoW.frames) do
    if f.events[event] and f.scripts.OnEvent then f.scripts.OnEvent(f, event, ...) end
  end
end

function MockWoW.update(elapsed)
  MockWoW.time = MockWoW.time + elapsed
  for _, f in ipairs(MockWoW.frames) do
    if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, elapsed) end
  end
end

-- ---------- 全局接口 ----------

function GetCVar(k) return MockWoW.cvars[k] end
function GetTime() return MockWoW.time end
function SetMapToCurrentZone() end

local function unitData(unit)
  if unit == "player" then return MockWoW.player end
  if unit == "target" then return MockWoW.target end
  return nil
end

local function flag(v) if v then return 1 end return nil end

function UnitExists(unit) return flag(unitData(unit) ~= nil) end
function UnitHealth(unit) local u = unitData(unit); return u and u.hp or 0 end
function UnitHealthMax(unit) local u = unitData(unit); return u and u.hpmax or 0 end
function UnitPower(unit) local u = unitData(unit); return u and u.power or 0 end
function UnitPowerMax(unit) local u = unitData(unit); return u and u.powermax or 0 end
function UnitPowerType(unit) local u = unitData(unit); return u and u.ptype or 0, "MANA" end
function UnitLevel(unit) local u = unitData(unit); return u and u.level or 0 end
function UnitAffectingCombat(unit) local u = unitData(unit); return flag(u and u.combat) end
function UnitIsDead(unit) local u = unitData(unit); return flag(u and u.dead) end
function UnitIsGhost(unit) local u = unitData(unit); return flag(u and u.ghost) end
function UnitCanAttack(_, unit) local u = unitData(unit); return flag(u and u.hostile) end
function UnitIsPlayer(unit) local u = unitData(unit); return flag(u and u.isPlayer) end
function UnitIsTapped(unit) local u = unitData(unit); return flag(u and u.tapped) end
function UnitIsTappedByPlayer(unit) local u = unitData(unit); return flag(u and u.tappedByPlayer) end
function UnitClassification(unit) local u = unitData(unit); return u and u.classification or "normal" end
function UnitGUID(unit) local u = unitData(unit); return u and u.guid end
function UnitIsUnit(a, b)
  if a == "targettarget" and b == "player" then return flag(MockWoW.target and MockWoW.target.targetingMe) end
  return flag(a == b)
end

function IsMounted() return flag(MockWoW.player.mounted) end
function IsResting() return flag(MockWoW.player.resting) end
function IsSwimming() return flag(MockWoW.player.swimming) end
function IsFlying() return flag(MockWoW.player.flying) end
function IsIndoors() return flag(MockWoW.player.indoors) end
function IsStealthed() return flag(MockWoW.player.stealthed) end

-- name, subText, text, texture, startTime, endTime, isTradeSkill, castID, notInterruptible
function UnitCastingInfo(unit)
  local u = unitData(unit)
  local c = u and u.cast
  if not c then return nil end
  return c.name, "", c.name, "icon", c.endMs - 2000, c.endMs, false, 1, c.notInterruptible
end

-- name, subText, text, texture, startTime, endTime, isTradeSkill, notInterruptible
function UnitChannelInfo(unit)
  local u = unitData(unit)
  local c = u and u.channel
  if not c then return nil end
  return c.name, "", c.name, "icon", c.endMs - 2000, c.endMs, false, c.notInterruptible
end

-- name, rank, icon, count, debuffType, duration, expirationTime, unitCaster, isStealable, shouldConsolidate, spellId
function UnitAura(unit, i, filter)
  local list = MockWoW.auras[unit] and MockWoW.auras[unit][filter]
  local a = list and list[i]
  if not a then return nil end
  return a.name, "", "icon", a.stacks, nil, a.duration or 0, a.expires or 0, a.caster, nil, nil, a.spellId
end

function GetCurrentMapAreaID() return MockWoW.mapId end
function GetPlayerMapPosition() return MockWoW.mapX, MockWoW.mapY end
function GetPlayerFacing() return MockWoW.facing end
function GetUnitSpeed() return MockWoW.speed, 7, 4.5, 4.72 end

function CheckInteractDistance(unit, index)
  local u = unitData(unit)
  if not u or not u.range then return nil end
  -- index 3 决斗 9.9 码 → range 1；2 交易 11.11 码 → range ≤2；4 跟随 28 码 → range ≤3
  local limit = ({ [3] = 1, [2] = 2, [4] = 3, [1] = 3 })[index]
  return flag(u.range <= limit)
end

local function action(slot) return MockWoW.actions[slot] end
function HasAction(slot) return flag(action(slot) ~= nil) end
function IsUsableAction(slot) local a = action(slot); return flag(a and a.usable), flag(a and a.noMana) end
function IsActionInRange(slot) local a = action(slot); return a and a.range end
function IsCurrentAction(slot) local a = action(slot); return flag(a and a.current) end
function IsAutoRepeatAction(slot) local a = action(slot); return flag(a and a.autoRepeat) end
function GetActionCooldown(slot)
  local a = action(slot)
  local cd = a and a.cd
  if not cd then return 0, 0, 1 end
  return cd.start, cd.duration, cd.enable
end
