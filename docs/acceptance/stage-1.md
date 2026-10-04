# 第 1 阶段：Windows 键鼠执行

验收日期：2026-10-04。第 1 阶段已通过负责人验收：专用记录窗口、WSL TypeScript 实际链路，以及正式服角色场景的短移动、跳跃、镜头和背包开关均有实测证据。正式服效果由负责人核对本地前后截图确认，自动识别尚未实现。整个 WSL 发行版重启恢复尚未验证，第 2 阶段未开始。

## 交付内容

- Windows 常驻 `WinInput.exe`：扫描码按键/组合键、客户区绝对移动、相对移动、点击、滚轮、有限时长拖拽；实际输入前和动作期间核实窗口身份与焦点。
- 独立 `WinInputWatchdog.exe`：Windows 本地 QPC 心跳与持键期限、所有权账本、异常释放和 Ctrl+Alt+F10 急停。
- WSL TypeScript `hand` 客户端：严格 JSONL schema、单动作调度、并发心跳/取消/释放、有限超时、路径转换；CLI 默认 dry-run，明确 `--live` 后才执行。
- `InputRecorder.exe` 与两个独立验收脚本：用脚本自行创建的 HWND/PID 验证真实窗口事件和 `GetAsyncKeyState`，保留每轮原始日志。

`effect.status` 始终为 `unknown`。输入插入、账本释放、记录窗口实际松键与游戏效果是不同证据，不能互相替代。

## 构建与验证入口

在 WSL 仓库根目录运行：

```bash
bash native/windows/build.sh
npm --prefix agent ci
npm --prefix agent run typecheck
npm --prefix agent test
python3 tools/input_acceptance.py --run-live-tests --out out/acceptance/stage-1/recorder
python3 tools/input_client_acceptance.py --run-live-tests --out out/acceptance/stage-1/client
```

两个 live 验收脚本需要可交互的 Windows 桌面；测试期间暂停手动键鼠。输入仅发往脚本自行启动的两个记录窗口。默认不带 `--run-live-tests` 会拒绝运行。两脚本应顺序执行，避免争抢全局输入所有权。

原生验收包括按键、组合键、点击、滚轮、拖拽和长按各 10 次，绝对/相对移动各 10 次；取消、释放、失焦、心跳丢失、EOF、执行器强杀和急停各 3 次；真实 Windows PID 与 Linux 协调器 PID 分开处理。CLI 验收经过真正的 TypeScript → Windows 链路及严格 schema，再测试跨终端 panic、Node 强杀和 native 断连时诚实的未确认回执。

## 本轮发现与修复

- 看门狗在账本锁外取时间，会误把随后写入的正常心跳判断为未来时间；已改为锁内采样，再比较同一份账本。
- Windows 连续点击会将第二次 DOWN 转成双击消息；记录器现将左/右/中双击消息记录为对应 `mouse_down`。
- 请求 ID 与在途 heartbeat/status 冲突可能覆盖 pending；客户端现拒绝显式冲突，并让自动 ID 跳过冲突。
- session UUID 在原生、schema 和客户端统一使用小写形式。
- 新增 ExecutorAdmission 与 guardian GlobalOwner 两个生命周期锁，避免 guardian 死亡时新会话与旧释放重叠；停机释放失败会保持 Windows 执行程序存活并继续重试。

## 用户体验入口

无需游戏，可先运行上面的专用窗口验收。正式服手动体验时，先让游戏进入可操作的角色场景，再枚举准确窗口：

```bash
npm --prefix agent run input -- list
```

将列出的 `hwnd` 与 `pid` 填入命令。先去掉 `--live` 检查输出，再加 `--live`；命令默认等待最多 5 秒，让用户手动切回游戏窗口：

```bash
# 当前实测角色使用 ESDF，向前键为 E；按实际绑定调整
npm --prefix agent run input -- --window 0xHWND --pid PID --action '{"kind":"key","keys":["E"],"duration_ms":250}' --live
# 跳跃
npm --prefix agent run input -- --window 0xHWND --pid PID --action '{"kind":"key","keys":["SPACE"],"duration_ms":100}' --live
# 按实际游戏键位确认背包开关
npm --prefix agent run input -- --window 0xHWND --pid PID --action '{"kind":"key","keys":["B"],"duration_ms":100}' --live
```

执行器不抢焦点；失焦会拒绝或终止当前会话并释放，重新执行时重新绑定。急停按 **Ctrl+Alt+F10**。长期开启的 session 可在另一个 WSL 终端使用 `input panic --session UUID --live` 释放。当前尚无自动游戏效果识别，正式服短移动、跳跃、镜头和界面开关须分别记录效果。

键位和时长也可以编辑 `profiles/actions/` 中的 JSON，再以 `--action ../profiles/actions/jump.json` 等文件路径执行；npm 入口的当前目录是 `agent/`。向前示例已按此次实测更新为 E；jump/背包示例为 SPACE/B。`turn-left.json` 的 A 是默认示例，当前角色自定义绑定不能直接使用它；本轮以右键拖拽验证转镜头。

本轮检测到的窗口为 `hwnd=0x3c080c`、`pid=2880`，客户区 2048×1536；游戏重启后应重新枚举。可直接体验：

```bash
npm --prefix agent run input -- --window 0x3c080c --pid 2880 --action ../profiles/actions/jump.json --live
```

有限游戏探针也可重跑，输出目录必须是新目录。它依次执行五个动作、保存本地前后截图，等待用户聚焦最多 30 秒，始终将自动 effect 留作 unknown：

```bash
python3 tools/input_game_probe.py --live --window 0x3c080c --pid 2880 --forward-key E --out out/acceptance/stage-1/game/probe-2
```

## 验收结果与边界

源码提交：原生 `c76fa61`、看门狗/记录器 `fb5c3de`、TypeScript adapter `632f012`，并含修复 `3ae70ae`、`8af6a0b`、`90d98ab`。最终原生源码基线为 `90d98ab`；验收脚本、示例和文档随后提交。没有推送远端。

| 验证 | 实际结果 |
| --- | --- |
| Framework C# 实际构建 | 三个 Windows 程序构建成功，exit 0 |
| TypeScript 类型及全量单元测试 | typecheck exit 0；40/40 passed、0 skipped，exit 0 |
| 原生真实输入 | 六类基础动作各 10 次；绝对/相对移动各 10 次；全部到达专用窗口并释放 |
| 原生异常中断 | 取消、release_all、失焦、心跳丢失、EOF、executor 强杀、Ctrl+Alt+F10 各 3 次，实际状态全部释放 |
| 坐标与去重 | 移窗/resize 后客户区坐标正确；重复 ID 不再注入，改 payload 拒绝；非法时长/坐标不发 DOWN |
| guardian 死亡并发接管 | 测试 Gate 持有自己 lease 锁 1500ms；旧 W 仍按下时杀 guardian，新 executor 三次均 executor_busy；旧清理完后重新绑定并执行成功 |
| WSL 协调器 SIGKILL | Python、直接 Node 协调器各 3 次，Windows 实际状态均恢复释放；没有重启 WSL |
| 实际 TS → Windows | six-action 输入、cancel/panic 各 3 次、关闭均通过；native 被杀时 TS 正确输出 release unconfirmed，记录器另证实已释放 |
| 正式服单轮效果 | E250ms 短移动、SPACE100ms 起跳并落地、右键拖拽200ms 转镜头、B100ms 打开/再次关闭背包；输入均 completed，关闭 release confirmed，前后画面核对五项效果确认 |

最终原生运行共 26 组、CLI 共 9 组，两个脚本 exit 0。每个基本动作验证目标窗口原始事件，持键另测 Windows QPC 实际时长；释放检查使用扰动后的新 `GetAsyncKeyState` 样本。取消要求实际 cancelled 终态，不能用自然结束充数；鼠标坐标和相对方向均检查。

日志保存于 `out/acceptance/stage-1/recorder-final/` 与 `client-final/`，含 `summary.json`、逐条原生/CLI/Recorder JSONL、`manifest.json` 中的源码/schema/profile/二进制 SHA256 与 Git 基线。先前失败的 recorder-run1..4 及修复前通过的 run5/client-run1 一并保留；外部鼠标移动或失焦导致的失败没有改记为通过。Recorder 最终无输出丢失。

正式服本轮记录在 `out/acceptance/stage-1/game/probe-1/`：客户端真实回执、11 张本地游戏截图、捕获元数据、manifest、`review.json` 和实测探针源码快照。客户端路径确认为 `_retail_/Wow.exe`；本地 bindings-cache 显示向前为 E，S/D/F 分别是左平移/后退/右平移，故没有把默认 W/A 当作本角色移动键。

游戏效果结论仅覆盖这个角色场景中的一轮五项检查；没有读游戏坐标、量化移动距离/转角、调用模型 API 或读取凭据。原生回执保持 `effect:unknown`，负责人画面复核另外记录，不能当作已实现自动效果验证。整个 WSL 发行版重启及同时强杀执行器与看门狗未测，不能从协调器强杀结果外推。
