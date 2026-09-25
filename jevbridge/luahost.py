"""用 lupa（Lua 5.1）加载插件文件，离线跑 Codec / State / Bridge。"""
from pathlib import Path

from lupa import lua51

ROOT = Path(__file__).resolve().parent.parent
ADDON = ROOT / "addon" / "JevBridge"
TESTS = ROOT / "tests"


class LuaHost:
    def __init__(self, files=("SchemaV1.lua", "Codec.lua"), mock_wow=False, before=None):
        self.lua = lua51.LuaRuntime(unpack_returned_tuples=True)
        if mock_wow:
            self.run_file(TESTS / "mock_wow.lua")
        if before:
            self.lua.execute(before)
        for name in files:
            self.run_file(ADDON / name)

    def run_file(self, path):
        code = Path(path).read_text(encoding="utf-8")
        self.lua.execute(code)

    @property
    def g(self):
        return self.lua.globals()

    @property
    def jb(self):
        return self.g.JevBridge

    def table(self, obj):
        return self.lua.table_from(obj, recursive=True)

    def encode_payload(self, state):
        codec = self.jb.Codec
        out, n = codec.encodePayload(self.jb.SchemaV1, self.table(state))
        return bytes(int(out[i]) for i in range(1, n + 1))

    def build_frame(self, seq, payload):
        out, n = self.jb.Codec.buildFrame(seq, self.table(list(payload)))
        return bytes(int(out[i]) for i in range(1, n + 1))

    def crc16(self, data):
        return int(self.jb.Codec.crc16(self.table(list(data))))

    def name_hash(self, s):
        return int(self.jb.Codec.nameHash(s))

    def frame_levels(self, state, seq):
        out, cells = self.jb.Codec.encodeFrameLevels(self.jb.SchemaV1, self.table(state), seq)
        cells = int(cells)
        return [(int(out[3 * c + 1]), int(out[3 * c + 2]), int(out[3 * c + 3])) for c in range(cells)]
