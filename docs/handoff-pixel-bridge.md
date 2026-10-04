第 0 步：确认 pwd 是 /home/dw/Projects/wow-jev。先把这条消息原样存成 ~/Projects/wow-jev/HANDOFF.md，上下文被压缩后回来重读。

【边界】这是研究实验，只在本地自建的 AzerothCore 3.3.5a 服务器上跑。不上暴雪正式服或怀旧服，不上有真人玩家的公开私服，也不做任何规避反作弊检测的工作。遇到权限拦截就停下来告诉我原因，不要换工具或换写法绕过去。代码只放在 ~/Projects/wow-jev，不要碰 ~/Projects/sts2-jev（那边的对局还在后台跑）。不推送到任何远端。不下载来路不明的二进制。全程用中文。每完成一个待办项，用一两句话报一次进度。

【背景】Jev（TypeSafe 的 System One 模型，单次决策 100–500ms，只回答 Choice/Score/Noul 三种类型化问题，输入只能是文本或 JSON，不能看图）做快系统，DeepSeek 做慢系统（规划、处理没见过的情况、复盘、长期记忆）。实验场地是 AzerothCore Playerbot 分支加 mod-playerbots。本任务做的是第 2 阶段的感知层：像素桥 v1。WoW 插件把游戏状态编码成客户区左上角的一条色块，Windows 侧程序截屏、解码、校验，输出 JSON。像素桥不做决策，也不碰键鼠。

【位置】pixel-bridge 分支，worktree 在 .worktrees/pixel-bridge。里面已有 4 个文件，未提交也未测试，先读一遍：
- protocol/schema_v1.json：字段的唯一来源，载荷约 263 字节；
- addon/JevBridge/Codec.lua：字段编码、帧封装、CRC16、半字节转色块档位、法术名哈希，全部用算术实现，不依赖 bit 库；
- addon/JevBridge/State.lua：读 3.3.5a 接口，版本不确定的接口先判断存不存在，结果记在 caps 里；
- addon/JevBridge/Bridge.lua：框体挂在 WorldFrame 下，按像素对齐排格子，30Hz 刷新，只重设颜色变了的格子；斜杠命令 /jevbridge on|off|hz|px|height|status。

【协议 v1】
- 每格 3×3 物理像素，解码只采中心像素；每行 128 格，行优先排列；第 0 行开头 8 个同步格，白黑交替。
- 每通道 16 档，第 n 档的值为 n×17，每格 12 bit（RGB 各一个半字节）。解码取 round(v/17)，每通道偏差 ±8 以内都能还原。
- 帧结构：magic 0x4A、version 1、seq u16、len u16、载荷、CRC16，全部大端。CRC 用 CCITT-FALSE（多项式 0x1021，初值 0xFFFF），校验向量 "123456789" → 0x29B1。字节按高半字节在前拆开，每格装 3 个半字节，末尾补 0。
- 定位：用三通道均值 ≥128 判白；格距 =（第 8 段的起点 − 第 1 段的起点）/7；行的位置从第一个白格的上下边界推出来；一行里有多个候选起点时逐个试。
- 法术名哈希：h = (h×31 + 字节) mod 2^24，按 UTF-8 字节算，结果为 0 时记作 1。原因是 3.3.5a 的 UnitCastingInfo 不返回法术 ID。
- 解码器对每帧输出 max_err，即各通道离最近档位的最大偏差。

【待办】
1. 写 addon/JevBridge/JevBridge.toc：Interface 30300，加载顺序 SchemaV1、Codec、State、Bridge。再给 worktree 补 .gitignore：.venv、__pycache__、.pytest_cache、capture/bin、out。
2. 写生成脚本：从 schema_v1.json 生成 SchemaV1.lua（内容为 JevBridge.SchemaV1 = {...}，去掉 doc 字段）。加一个测试，检查生成的文件是最新的。
3. Python 包 jevbridge/：
   - schema.py：参考实现，包括编码、解码、crc16、名字哈希、组帧、帧转档位；
   - render.py：把档位渲染成图片，提供各种干扰函数；
   - capture.py：调用 exe 的包装，路径用 wslpath -w 转换；
   - luahost.py：用 lupa 加载插件文件，Python 字典转 Lua 表用 table_from(..., recursive=True)。
   pyproject.toml：dev 依赖组放 pytest、lupa、pillow；设 package=false；pytest 设 pythonpath=["."]。
4. capture/JevCapture.cs 加 build.sh，三种模式：
   - --image：离线解码图片，每张一行 JSON；
   - --live：按窗口类 GxWindowClassD3d 或标题 World of Warcraft 找窗口，只截客户区左上角一小块，seq 变了才输出；
   - --show：开测试窗口，1:1 显示图片，没有客户端时用来测真实截屏链路。
   输出字段：ok、reason、seq、ver、len、payload（十六进制）、pitch、x0、y0、max_err、tick_ms、cap_ms、dec_ms。C# 端不解析具体字段，字段交给使用方解析。启动时先调 SetProcessDpiAwarenessContext(-4)，失败就退回 SetProcessDPIAware。用 timeBeginPeriod(1) 提高计时精度。
5. 测试：
   - CRC 校验向量；
   - 随机 state 下，Lua 编码和 Python 编码的字节完全一致；
   - 渲染后交给 exe 解码，覆盖这些干扰：偏移、每格 4 像素、1.25 和 1.5 倍双线性缩放、半径 0.6 的模糊、±6 噪声、gamma 1.05（必须通过）、gamma 1.1（预期失败，写进文档）、随机背景、改坏一个格子（必须报 CRC 失败）；
   - 用 tests/mock_wow.lua 模拟 WoW 接口做端到端测试：按 Bridge 记录的纹理位置和颜色渲染，顺带测像素对齐；
   - 模拟 GetPlayerFacing 不存在时，caps.facing 应为假。
6. 写 docs/protocol-v1.md 和 README（中文，写明只用于本地服务器），然后在 pixel-bridge 分支上提交。
7. 写 tools/watch.py：拉起 --live，按 schema 解码并打印字段。

【目标】截屏加解码不超过 5ms；从状态变化到 WSL 拿到 JSON 不超过 60ms；连跑 1 小时，CRC 失败率低于 0.1%。

【机器事实】
- WSL：没有 gcc 和 pip；uv 在 ~/.local/bin；uv run --with lupa 得到的是 Lua 5.1，没有 bit 库；Node 22 在 ~/.local/node/bin，不在非交互 shell 的 PATH 里。
- Windows：
  - 物理分辨率 3840×2160，缩放 150%，截屏程序必须声明支持高 DPI；
  - 没有 Python，也没有 .NET SDK；
  - 用 C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe 编译，只支持 C# 5 语法（不能用 $""、?.、=>、nameof），编译参数加 /codepage:65001 /utf8output；
  - PowerShell 用绝对路径 /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe，并加 </dev/null。
- 我不在电脑前、Windows 锁屏时，截屏会失败或拿到黑图，所以 --live 和 --show 的实测可以往后放，离线测试先做。
- 3.3.5a 客户端由我自己解决，你不要去找或下载。

【等有客户端再确认】GetPlayerFacing、GetUnitSpeed、UnitAura 的第 11 个返回值 spellId、GetCurrentMapAreaID 是否可用；GetTime 和 Environment.TickCount 是否同一个时钟；gxResolution 是否等于客户区高度；独占全屏下截屏会不会是黑的（应该用窗口化或无边框窗口，gamma 保持 1.0）。

先读完这 4 个文件，再从待办 1 开始做。
