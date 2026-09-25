"""从 protocol/schema_v1.json 生成 addon/JevBridge/SchemaV1.lua（去掉 doc 字段）。

用法：python tools/gen_schema_lua.py          写文件
      python tools/gen_schema_lua.py --check  只检查是否最新，不一致时退出码 1
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_JSON = ROOT / "protocol" / "schema_v1.json"
SCHEMA_LUA = ROOT / "addon" / "JevBridge" / "SchemaV1.lua"

HEADER = "-- 由 tools/gen_schema_lua.py 从 protocol/schema_v1.json 生成，不要手改。\n"
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def strip_doc(v):
    if isinstance(v, dict):
        return {k: strip_doc(x) for k, x in v.items() if k != "doc"}
    if isinstance(v, list):
        return [strip_doc(x) for x in v]
    return v


def lua_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def to_lua(v, indent=0):
    pad = "  " * (indent + 1)
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return lua_str(v)
    if isinstance(v, list):
        if all(not isinstance(x, (dict, list)) for x in v):
            return "{ " + ", ".join(to_lua(x) for x in v) + " }"
        items = [pad + to_lua(x, indent + 1) + "," for x in v]
        return "{\n" + "\n".join(items) + "\n" + "  " * indent + "}"
    if isinstance(v, dict):
        if all(not isinstance(x, (dict, list)) or (isinstance(x, list) and all(not isinstance(y, (dict, list)) for y in x))
               for x in v.values()) and len(v) <= 5:
            return "{ " + ", ".join(key(k) + " = " + to_lua(x) for k, x in v.items()) + " }"
        items = [pad + key(k) + " = " + to_lua(x, indent + 1) + "," for k, x in v.items()]
        return "{\n" + "\n".join(items) + "\n" + "  " * indent + "}"
    raise TypeError(f"不支持的类型：{type(v)}")


def key(k):
    return k if IDENT.match(k) else "[" + lua_str(k) + "]"


def generate():
    schema = strip_doc(json.loads(SCHEMA_JSON.read_text(encoding="utf-8")))
    return HEADER + "JevBridge = JevBridge or {}\nJevBridge.SchemaV1 = " + to_lua(schema) + "\n"


def main():
    text = generate()
    if "--check" in sys.argv:
        current = SCHEMA_LUA.read_text(encoding="utf-8") if SCHEMA_LUA.exists() else ""
        if current != text:
            print(f"{SCHEMA_LUA} 不是最新，请运行 python tools/gen_schema_lua.py", file=sys.stderr)
            sys.exit(1)
        return
    SCHEMA_LUA.write_text(text, encoding="utf-8", newline="\n")
    print(f"已写入 {SCHEMA_LUA}")


if __name__ == "__main__":
    main()
