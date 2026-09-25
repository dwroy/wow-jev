from tools import gen_schema_lua


def test_schema_lua_is_up_to_date():
    current = gen_schema_lua.SCHEMA_LUA.read_text(encoding="utf-8")
    assert current == gen_schema_lua.generate(), "SchemaV1.lua 过期，请运行 uv run python tools/gen_schema_lua.py"


def test_schema_lua_has_no_doc():
    assert "doc" not in gen_schema_lua.SCHEMA_LUA.read_text(encoding="utf-8")
