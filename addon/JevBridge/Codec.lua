-- JevBridge 编解码核心：纯函数，不调用任何 WoW 接口，可以在普通 Lua 5.1 里离线测试。
-- 格式定义见 docs/protocol-v1.md。整数一律大端。
-- 3.3.5a 虽然有 bit 库，离线环境没有；这里全用算术实现，保证两边走同一条代码路径。

JevBridge = JevBridge or {}
local Codec = {}
JevBridge.Codec = Codec

Codec.MAGIC = 0x4A      -- 'J'
Codec.VERSION = 1
Codec.COLUMNS = 128     -- 每行格数，第 0 行包含 8 个同步格
Codec.SYNC_CELLS = 8
Codec.HEADER_BYTES = 6  -- magic, version, seq(2), len(2)
Codec.CRC_BYTES = 2

local floor = math.floor

local SIZES = { u8 = 1, u16 = 2, u24 = 3, u32 = 4, bits8 = 1, bits16 = 2 }
local MAXES = { u8 = 255, u16 = 65535, u24 = 16777215, u32 = 4294967295, bits8 = 255, bits16 = 65535 }

local function bxor16(a, b)
  local r, p = 0, 1
  for _ = 1, 16 do
    if a % 2 ~= b % 2 then r = r + p end
    a, b, p = floor(a / 2), floor(b / 2), p * 2
  end
  return r
end
Codec.bxor16 = bxor16

-- CRC-16/CCITT-FALSE：多项式 0x1021，初值 0xFFFF，不反射，无最终异或
local CRC_TABLE = {}
for i = 0, 255 do
  local c = i * 256
  for _ = 1, 8 do
    if c >= 32768 then
      c = bxor16((c * 2) % 65536, 0x1021)
    else
      c = (c * 2) % 65536
    end
  end
  CRC_TABLE[i] = c
end

function Codec.crc16(bytes, n)
  local crc = 0xFFFF
  for i = 1, n or #bytes do
    crc = bxor16((crc * 256) % 65536, CRC_TABLE[bxor16(floor(crc / 256), bytes[i])])
  end
  return crc
end

-- 法术名哈希：h = (h*31 + 字节) mod 2^24，按 UTF-8 字节算；空串为 0，结果为 0 时记作 1
function Codec.nameHash(s)
  if not s or s == "" then return 0 end
  local h = 0
  for i = 1, #s do h = (h * 31 + s:byte(i)) % 16777216 end
  if h == 0 then h = 1 end
  return h
end

local function clampInt(v, max)
  v = tonumber(v) or 0
  if v ~= v then return 0 end  -- NaN
  v = floor(v + 0.5)
  if v < 0 then return 0 end
  if v > max then return max end
  return v
end

local function putInt(out, n, v, size)
  for k = size - 1, 0, -1 do
    n = n + 1
    out[n] = floor(v / 256 ^ k) % 256
  end
  return n
end

local function encodeFields(fields, state, out, n)
  state = state or {}
  for i = 1, #fields do
    local f = fields[i]
    local t = f.type
    if t == "array" then
      local list = state[f.name] or {}
      for j = 1, f.count do
        n = encodeFields(f.fields, list[j], out, n)
      end
    else
      local size = SIZES[t] or error("JevBridge: unknown field type " .. tostring(t))
      local v
      if t == "bits8" or t == "bits16" then
        local set = state[f.name] or {}
        v = 0
        for b = 1, #f.bits do
          if set[f.bits[b]] then v = v + 2 ^ (b - 1) end
        end
      else
        v = clampInt(state[f.name], MAXES[t])
      end
      n = putInt(out, n, v, size)
    end
  end
  return n
end

-- state -> 载荷字节（1 基数组），返回 bytes, n
function Codec.encodePayload(schema, state, out)
  out = out or {}
  local n = encodeFields(schema.fields, state, out, 0)
  return out, n
end

-- 载荷 -> 整帧字节：header + payload + crc
function Codec.buildFrame(seq, payload, len, out)
  out = out or {}
  len = len or #payload
  seq = seq % 65536
  out[1], out[2] = Codec.MAGIC, Codec.VERSION
  out[3], out[4] = floor(seq / 256), seq % 256
  out[5], out[6] = floor(len / 256), len % 256
  for i = 1, len do out[6 + i] = payload[i] end
  local crc = Codec.crc16(out, 6 + len)
  out[7 + len], out[8 + len] = floor(crc / 256), crc % 256
  return out, 8 + len
end

-- 整帧字节 -> 每格三通道档位（0–15），展平成 levels[3c-2..3c]。
-- 前 8 格是白黑交替的同步头；之后按高半字节在前的顺序，每格装 3 个半字节，末尾补 0。
function Codec.frameToLevels(frame, n, out)
  out = out or {}
  local k = 0
  for i = 1, Codec.SYNC_CELLS do
    local v = (i % 2 == 1) and 15 or 0
    out[k + 1], out[k + 2], out[k + 3] = v, v, v
    k = k + 3
  end
  for i = 1, n do
    out[k + 1] = floor(frame[i] / 16)
    out[k + 2] = frame[i] % 16
    k = k + 2
  end
  while k % 3 ~= 0 do
    k = k + 1
    out[k] = 0
  end
  return out, k / 3
end

-- 给定 schema 算出一帧占多少格（载荷定长，所以是常数）
function Codec.cellCount(schema)
  local _, n = Codec.encodePayload(schema, {})
  local bytes = Codec.HEADER_BYTES + n + Codec.CRC_BYTES
  return Codec.SYNC_CELLS + math.ceil(bytes * 2 / 3)
end

-- 第 i 格（0 基）所在的列和行
function Codec.cellPos(i)
  return i % Codec.COLUMNS, floor(i / Codec.COLUMNS)
end

local scratchPayload, scratchFrame = {}, {}

-- 一步到位：state -> levels, cellCount
function Codec.encodeFrameLevels(schema, state, seq, out)
  local payload, n = Codec.encodePayload(schema, state, scratchPayload)
  local frame, fn = Codec.buildFrame(seq, payload, n, scratchFrame)
  return Codec.frameToLevels(frame, fn, out)
end
