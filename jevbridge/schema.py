"""像素桥 v1 的 Python 参考实现，与 addon/JevBridge/Codec.lua 逐字节一致。

- encode_payload / decode_payload：state 字典 <-> 载荷字节
- crc16：CRC-16/CCITT-FALSE
- name_hash：法术名哈希
- build_frame / parse_frame：组帧 / 拆帧
- frame_to_levels：整帧字节 -> 每格 (r, g, b) 档位（含 8 个同步格）
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "protocol" / "schema_v1.json"

MAGIC = 0x4A
VERSION = 1
COLUMNS = 128
SYNC_CELLS = 8
HEADER_BYTES = 6
CRC_BYTES = 2

SIZES = {"u8": 1, "u16": 2, "u24": 3, "u32": 4, "bits8": 1, "bits16": 2}
MAXES = {t: 256 ** n - 1 for t, n in SIZES.items()}


def load_schema(path=SCHEMA_PATH):
    return json.loads(Path(path).read_text(encoding="utf-8"))


SCHEMA = load_schema()


# ---------- 基础 ----------

def _crc_table():
    table = []
    for i in range(256):
        c = i << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF
        table.append(c)
    return table


_CRC_TABLE = _crc_table()


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc = ((crc << 8) & 0xFFFF) ^ _CRC_TABLE[(crc >> 8) ^ b]
    return crc


def name_hash(name):
    """h = (h*31 + 字节) mod 2^24，按 UTF-8 字节；空串/None 为 0，结果为 0 时记作 1。"""
    if not name:
        return 0
    data = name.encode("utf-8") if isinstance(name, str) else bytes(name)
    h = 0
    for b in data:
        h = (h * 31 + b) % 16777216
    return h or 1


def _clamp_int(v, maxv):
    # 与 Lua 的 clampInt 一致：非数字 -> 0，NaN -> 0，四舍五入（floor(v+0.5)），截到 [0, max]
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return 0
    v = float(v)
    if v != v or v < 0:
        return 0
    if v > maxv:
        return maxv
    return min(int(math.floor(v + 0.5)), maxv)


def payload_size(schema=SCHEMA):
    return _size(schema["fields"])


def _size(fields):
    n = 0
    for f in fields:
        if f["type"] == "array":
            n += f["count"] * _size(f["fields"])
        else:
            n += SIZES[f["type"]]
    return n


def cell_count(schema=SCHEMA):
    total = HEADER_BYTES + payload_size(schema) + CRC_BYTES
    return SYNC_CELLS + math.ceil(total * 2 / 3)


# ---------- 载荷 ----------

def _encode_fields(fields, state, out):
    state = state or {}
    for f in fields:
        t = f["type"]
        if t == "array":
            lst = state.get(f["name"]) or []
            for j in range(f["count"]):
                _encode_fields(f["fields"], lst[j] if j < len(lst) else None, out)
            continue
        if t in ("bits8", "bits16"):
            flags = state.get(f["name"]) or {}
            if not isinstance(flags, dict):
                flags = {k: True for k in flags}
            v = sum(1 << b for b, name in enumerate(f["bits"]) if flags.get(name))
        else:
            v = _clamp_int(state.get(f["name"]), MAXES[t])
        out += v.to_bytes(SIZES[t], "big")


def encode_payload(state, schema=SCHEMA):
    out = bytearray()
    _encode_fields(schema["fields"], state, out)
    return bytes(out)


def _decode_fields(fields, data, pos):
    obj = {}
    for f in fields:
        t = f["type"]
        if t == "array":
            lst = []
            for _ in range(f["count"]):
                item, pos = _decode_fields(f["fields"], data, pos)
                lst.append(item)
            obj[f["name"]] = lst
            continue
        n = SIZES[t]
        v = int.from_bytes(data[pos:pos + n], "big")
        pos += n
        if t in ("bits8", "bits16"):
            obj[f["name"]] = {name: bool(v >> b & 1) for b, name in enumerate(f["bits"])}
        else:
            obj[f["name"]] = v
    return obj, pos


def decode_payload(data, schema=SCHEMA):
    need = payload_size(schema)
    if len(data) < need:
        raise ValueError(f"载荷长度 {len(data)} < {need}")
    obj, _ = _decode_fields(schema["fields"], bytes(data), 0)
    return obj


# ---------- 帧 ----------

def build_frame(seq, payload):
    seq %= 65536
    head = bytes([MAGIC, VERSION, seq >> 8, seq & 0xFF, len(payload) >> 8, len(payload) & 0xFF])
    body = head + bytes(payload)
    return body + crc16(body).to_bytes(2, "big")


def parse_frame(frame):
    """整帧 -> (seq, payload)；格式错误抛 ValueError。"""
    frame = bytes(frame)
    if len(frame) < HEADER_BYTES + CRC_BYTES or frame[0] != MAGIC:
        raise ValueError("magic 不对")
    n = frame[4] << 8 | frame[5]
    end = HEADER_BYTES + n
    if len(frame) < end + CRC_BYTES:
        raise ValueError("长度不够")
    if crc16(frame[:end]) != int.from_bytes(frame[end:end + 2], "big"):
        raise ValueError("CRC 不对")
    return frame[2] << 8 | frame[3], frame[HEADER_BYTES:end]


def frame_to_levels(frame):
    """整帧 -> [(r, g, b), ...]，每个分量是 0–15 档；前 8 格为白黑交替同步头。"""
    nib = []
    for b in frame:
        nib += (b >> 4, b & 15)
    while len(nib) % 3:
        nib.append(0)
    sync = [(15, 15, 15) if i % 2 == 0 else (0, 0, 0) for i in range(SYNC_CELLS)]
    return sync + [tuple(nib[i:i + 3]) for i in range(0, len(nib), 3)]


def encode_frame_levels(state, seq, schema=SCHEMA):
    return frame_to_levels(build_frame(seq, encode_payload(state, schema)))
