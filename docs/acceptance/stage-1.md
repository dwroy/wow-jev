# 第 1 阶段：Windows 键鼠执行

验收日期：2026-10-04。键鼠工程部分已通过负责人实际验收；正式服游戏效果待用户体验，整个 WSL 发行版重启恢复尚未验证。因此第 1 阶段整体仍待游戏效果验收，尚未进入第 2 阶段。

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
# 向前250ms；自行确认人物是否移动、何时停止
npm --prefix agent run input -- --window 0xHWND --pid PID --action '{"kind":"key","keys":["W"],"duration_ms":250}' --live
# 跳跃
npm --prefix agent run input -- --window 0xHWND --pid PID --action '{"kind":"key","keys":["SPACE"],"duration_ms":100}' --live
# 按实际游戏键位确认背包开关
npm --prefix agent run input -- --window 0xHWND --pid PID --action '{"kind":"key","keys":["B"],"duration_ms":100}' --live
```

执行器不抢焦点；失焦会拒绝或终止当前会话并释放，重新执行时重新绑定。急停按 **Ctrl+Alt+F10**。长期开启的 session 可在另一个 WSL 终端使用 `input panic --session UUID --live` 释放。当前尚无自动游戏效果识别，正式服短移动、跳跃、镜头和界面开关须分别记录效果。

键位和时长也可以编辑 `profiles/actions/` 中的 JSON，再以 `--action ../profiles/actions/jump.json` 等文件路径执行；npm 入口的当前目录是 `agent/`。这四份示例均按当前 schema 验证，只代表默认 W/SPACE/A/B，实际绑定须与游戏设置一致。

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

最终原生运行共 26 组、CLI 共 9 组，两个脚本 exit 0。每个基本动作验证目标窗口原始事件，持键另测 Windows QPC 实际时长；释放检查使用扰动后的新 `GetAsyncKeyState` 样本。取消要求实际 cancelled 终态，不能用自然结束充数；鼠标坐标和相对方向均检查。

日志保存于 `out/acceptance/stage-1/recorder-final/` 与 `client-final/`，含 `summary.json`、逐条原生/CLI/Recorder JSONL、`manifest.json` 中的源码/schema/profile/二进制 SHA256 与 Git 基线。先前失败的 recorder-run1..4 及修复前通过的 run5/client-run1 一并保留；外部鼠标移动或失焦导致的失败没有改记为通过。Recorder 最终无输出丢失。

当前未检测到 WoW 候选窗口；没有发送游戏输入、读取凭据或调用模型。整个 WSL 发行版重启、同时强杀执行器与看门狗、正式服实际动作效果不由这些结果外推。
