# wow-jev 像素桥 v1（JevBridge）

> **只用于本地自建的 AzerothCore 3.3.5a 服务器上的研究实验。** 不在暴雪正式服、怀旧服或有真人玩家的公开私服上使用，也不做任何规避反作弊检测的工作。

Jev（快系统）+ DeepSeek（慢系统）实验的第 2 阶段感知层。WoW 插件把游戏状态编码成客户区左上角的一条色块，Windows 侧程序截屏、解码、校验，输出 JSON。像素桥只做感知，不做决策，也不碰键鼠。

协议细节见 [docs/protocol-v1.md](docs/protocol-v1.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `protocol/schema_v1.json` | 字段的唯一来源 |
| `addon/JevBridge/` | WoW 插件：`SchemaV1.lua`（生成）、`Codec.lua`、`State.lua`、`Bridge.lua` |
| `capture/JevCapture.cs`、`capture/build.sh` | Windows 截屏解码器 |
| `capture/WinSnap.cs` | 列出可见窗口 / 截取指定窗口（PrintWindow，只读画面） |
| `jevbridge/` | Python：`schema.py` 参考实现、`render.py` 渲染与干扰、`capture.py` exe 包装、`luahost.py` 用 lupa 加载插件、`vision.py` 调火山方舟 Seed 看截图 |
| `tools/gen_schema_lua.py` | 从 JSON 生成 `SchemaV1.lua` |
| `tools/watch.py` | 拉起 `--live`，按 schema 解码并打印字段 |
| `tools/show_frames.py` | 不开游戏测真实截屏链路：渲染 `--show` 用的帧，汇总可靠性、耗时与"画面变化 → JSON"延迟 |
| `tools/clock_sync.py` | 对时：GetTime（`t_ms`）与 TickCount / QPC 是否同一时钟，并测端到端延迟 |
| `tools/seed_live.py`、`tools/seed_report.py` | 按固定间隔截窗口交给 Seed 识别，汇总速度、成本、识别质量与状态事件流 |
| `tests/` | pytest；`mock_wow.lua` 模拟 3.3.5a 接口 |

## 用法

```bash
# 改了 schema_v1.json 之后
uv run python tools/gen_schema_lua.py

# 编译截屏程序（Windows 自带的 .NET Framework 4 csc.exe，C# 5）
./capture/build.sh

# 测试（exe 不存在时，相关用例会跳过）
uv run pytest -q

# 实时查看（需要客户端在前台运行，Windows 不能锁屏）
uv run python tools/watch.py
```

插件：把 `addon/JevBridge` 复制到客户端的 `Interface/AddOns/`。游戏内命令：`/jevbridge on | off | hz <n> | px <n> | height <n> | status`。

JevCapture：

```
JevCapture.exe --image <png>... [--repeat N]       离线解码图片，每张一行 JSON
JevCapture.exe --live [--title T] [--class C] [--w 640] [--h 32] [--poll 1] [--stats 10]
                                                   截取窗口客户区左上角，seq 变了才输出
JevCapture.exe --show <png>... [--x 100] [--y 100] [--interval 33] [--title T] [--dpi-aware 0]
                                                   1:1 显示图片，没有客户端时测真实截屏链路；
                                                   每张图首次绘制时往 stdout 打 {"show":索引,"qpc_ms":…}；
                                                   --dpi-aware 0 模拟不声明 DPI 感知的窗口（被系统缩放）
```

看图识别（慢系统）：key 与模型 ID 放在 `~/.config/wow-jev/api.env`（`ARK_API_KEY`、`ARK_MODEL=doubao-seed-2-0-mini-260428`，权限 600），只在运行时读取。

```bash
./capture/bin/WinSnap.exe list
uv run --with openai python tools/seed_live.py --window 0x句柄 --interval 3 --secs 600
uv run --with numpy python tools/seed_report.py out/seed_live/<时间戳>
```

没有客户端时测真实截屏链路：先开 `--show` 显示渲染好的色条图，再运行 `--live --title "JevCapture Show"`。

## 客户端设置

窗口化或无边框窗口，显示 gamma 1.0。截屏程序已声明 Per-Monitor V2 DPI 感知（Windows 150% 缩放下按物理像素截屏）。
