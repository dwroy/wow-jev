-- 在客户区左上角画色条：每秒 hz 次读取状态、编码、只重设颜色变了的格子。
-- 框体挂在 WorldFrame 下，Alt+Z 隐藏界面时色条仍然可见。
-- 斜杠命令：/jevbridge on | off | hz <n> | px <n> | height <n> | status

JevBridge = JevBridge or {}
local Bridge = {}
JevBridge.Bridge = Bridge

local Codec, State = JevBridge.Codec, JevBridge.State

Bridge.hz = 30
Bridge.cellPx = 3           -- 每格边长，物理像素
Bridge.heightOverride = nil -- 客户区物理高度；nil 时读 gxResolution
Bridge.enabled = true
Bridge.seq = 0
Bridge.frame = nil
Bridge.textures = {}

local levels, lastKey = {}, {}
local elapsedSince = 0

local function say(msg)
  if DEFAULT_CHAT_FRAME then DEFAULT_CHAT_FRAME:AddMessage("|cff66ccffJevBridge|r " .. msg) end
end

function Bridge.physicalHeight()
  if Bridge.heightOverride then return Bridge.heightOverride end
  local res = GetCVar("gxResolution")
  local h = res and tonumber(res:match("%d+x(%d+)"))
  return h or 768
end

-- 让每格正好 cellPx 个物理像素：UI 坐标系高 768 个单位，再除掉框体的有效缩放
function Bridge.layout()
  local f = Bridge.frame
  local cells = Codec.cellCount(JevBridge.SchemaV1)
  local rows = math.ceil(cells / Codec.COLUMNS)
  local unit = Bridge.cellPx * 768 / Bridge.physicalHeight() / f:GetEffectiveScale()
  f:SetWidth(Codec.COLUMNS * unit)
  f:SetHeight(rows * unit)
  for i = 1, cells do
    local t = Bridge.textures[i]
    if not t then
      t = f:CreateTexture(nil, "OVERLAY")
      Bridge.textures[i] = t
    end
    local col, row = Codec.cellPos(i - 1)
    t:ClearAllPoints()
    t:SetPoint("TOPLEFT", f, "TOPLEFT", col * unit, -row * unit)
    t:SetWidth(unit)
    t:SetHeight(unit)
    t:Show()
  end
  for i = cells + 1, #Bridge.textures do Bridge.textures[i]:Hide() end
  for i = 1, #lastKey do lastKey[i] = nil end
  Bridge.cells, Bridge.unit = cells, unit
end

function Bridge.tick()
  if not Bridge.cells then return end  -- PLAYER_LOGIN 排版之前 OnUpdate 就可能触发
  Bridge.seq = (Bridge.seq + 1) % 65536
  local state = State.read(GetTime())
  local _, cells = Codec.encodeFrameLevels(JevBridge.SchemaV1, state, Bridge.seq, levels)
  local tex = Bridge.textures
  for c = 1, cells do
    local r, g, b = levels[3 * c - 2], levels[3 * c - 1], levels[3 * c]
    local key = r * 256 + g * 16 + b
    if lastKey[c] ~= key then
      tex[c]:SetTexture(r / 15, g / 15, b / 15, 1)
      lastKey[c] = key
    end
  end
end

local function onUpdate(_, elapsed)
  if not Bridge.enabled then return end
  elapsedSince = elapsedSince + elapsed
  if elapsedSince < 1 / Bridge.hz then return end
  elapsedSince = 0
  Bridge.tick()
end

local function refreshMap()
  if SetMapToCurrentZone and not (WorldMapFrame and WorldMapFrame:IsShown()) then
    SetMapToCurrentZone()
  end
end

local function onEvent(_, event)
  if event == "PLAYER_LOGIN" then
    Bridge.layout()
    refreshMap()
    say(string.format("已启动：%d 格，每格 %d 像素，%d Hz，客户区高 %d", Bridge.cells, Bridge.cellPx, Bridge.hz, Bridge.physicalHeight()))
  elseif event == "DISPLAY_SIZE_CHANGED" or event == "UI_SCALE_CHANGED" then
    Bridge.layout()
  else
    refreshMap()
  end
end

function Bridge.init()
  local f = CreateFrame("Frame", "JevBridgeFrame", WorldFrame)
  f:SetFrameStrata("TOOLTIP")
  f:SetFrameLevel(100)
  f:SetScale(1)
  f:SetPoint("TOPLEFT", WorldFrame, "TOPLEFT", 0, 0)
  f:SetScript("OnUpdate", onUpdate)
  f:SetScript("OnEvent", onEvent)
  for _, ev in ipairs({ "PLAYER_LOGIN", "DISPLAY_SIZE_CHANGED", "UI_SCALE_CHANGED",
                        "PLAYER_ENTERING_WORLD", "ZONE_CHANGED_NEW_AREA" }) do
    f:RegisterEvent(ev)
  end
  Bridge.frame = f
end

local function command(msg)
  local cmd, arg = (msg or ""):match("^%s*(%S*)%s*(%S*)")
  local n = tonumber(arg)
  if cmd == "on" then
    Bridge.enabled = true
    Bridge.frame:Show()
  elseif cmd == "off" then
    Bridge.enabled = false
    Bridge.frame:Hide()
  elseif cmd == "hz" and n and n > 0 and n <= 120 then
    Bridge.hz = n
  elseif cmd == "px" and n and n >= 1 and n <= 16 then
    Bridge.cellPx = math.floor(n)
    Bridge.layout()
  elseif cmd == "height" and n and n >= 200 then
    Bridge.heightOverride = math.floor(n)
    Bridge.layout()
  elseif cmd ~= "status" and cmd ~= "" then
    say("用法：/jevbridge on | off | hz <n> | px <n> | height <n> | status")
    return
  end
  say(string.format("%s，%d Hz，每格 %d 像素，客户区高 %d，序号 %d",
    Bridge.enabled and "运行中" or "已关闭", Bridge.hz, Bridge.cellPx, Bridge.physicalHeight(), Bridge.seq))
end

Bridge.init()
SLASH_JEVBRIDGE1 = "/jevbridge"
SlashCmdList["JEVBRIDGE"] = command
