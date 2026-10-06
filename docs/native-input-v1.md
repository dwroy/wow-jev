# Windows 输入协议 v1

唯一格式来源为 `protocol/native-input-v1.schema.json`，与上层 `agent-v1.schema.json` 及旧像素桥协议分别管理。WSL TypeScript 在线校验命令与所有回帧；原生执行器也严格检查字段、类型、重复键和范围。

启动：`WinInput.exe serve --window HWND --expected-pid PID --session 小写UUID --watchdog Windows路径`。WSL 可直接启动 Linux 路径下的 exe；`--watchdog` 交给 Windows `Process.Start`，必须先经 `wslpath -w` 转换。

输入与输出是 UTF-8 JSONL，单行不超过 64KiB。每条消息带 `protocol: "wow-input"`、`version: 1`、`session_id`。`ready` 含 Windows executor/watchdog PID、目标 HWND/PID、客户区大小、支持键位、最长动作 5000ms 和 1000ms 心跳租约。跨 Windows 与 WSL 不能互用进程 PID。

命令示例：

```json
{"protocol":"wow-input","version":1,"type":"command","id":"move-1","session_id":"12345678-1234-1234-1234-123456789abc","op":"execute","action":{"kind":"key","keys":["W"],"duration_ms":250}}
```

`op` 可为 `execute/heartbeat/cancel/release_all/shutdown/status`。执行先回 `accepted`，再回一个终态。心跳与 status 不占动作去重缓存；同 ID 同内容重放不再注入，改内容拒绝。去重缓存最多 1024 个 execute/控制记录，满后拒绝新 execute，仍允许取消、释放和关闭。

| kind | 字段 | 含义 |
| --- | --- | --- |
| key | keys, duration_ms | 大写规范键名；扫描码按下后有限持有，释放本次登记的键 |
| mouse_move | mode:absolute, x,y | 客户区物理像素；每次执行重新 ClientToScreen |
| mouse_move | mode:relative, dx,dy | Windows 相对输入；实际距离受系统鼠标设置影响 |
| mouse_click | button, x,y, duration_ms | left/right/middle；移动后有限持有并释放 |
| focus_click | x,y, duration_ms | 零额外字段；固定左键，1..150ms；仅前台恢复专用，条件见下 |
| mouse_wheel | delta | 非零 120 倍数；光标必须在目标客户区内 |
| mouse_drag | button, from:{x,y}, to:{x,y}, duration_ms | 有限时长插值移动，最后释放按钮 |

`receipt` 区分动作终态、输入插入和游戏效果：`input.events_requested/events_inserted` 仅统计此回执能归账的 SendInput 事件；`input.released` 表示账本没有本程序持有的键/按钮。看门狗代发释放而执行器无法归账时，不伪造完整计数。`effect.status` 固定 `unknown`，须由后续眼模块确认游戏效果。

`timing.clock` 为 `windows_qpc`，`local_clock.domain` 为 `windows-qpc`；两字段是该 native 协议的固定枚举。`started_ms`/`finished_ms` 可以为 null，不能与 WSL 的 monotonic 时间直接相减。验收脚本的 `release_ms` 是协调器侧触发到收到实际释放样本的耗时，包含传输/采样延迟。

首次绑定可在未聚焦时 ready。普通 execute 和动作期间仍查 HWND/PID/启动时间/焦点；失焦终止会话并释放。用户于 2026-10-06 授权一个专门的焦点恢复例外：统一执行闸可提交 `focus_click`，点击客户区已核验安全位置一次，释放后必须复核 `GetForegroundWindow==目标 HWND`；失败停止会话，不能继续普通输入。`ready.capabilities.focus_click=true` 表示此能力，旧二进制未宣告时不能发此动作。禁止调用 SetForegroundWindow、AttachThreadInput、后台按键消息或改变窗口位置/系统配置。

`Native.GetRecoverySafety(HWND)` 是只读检查 API，返回 `allowed/reason`、观察 QPC `checked_at_ms`、PID/启动时间/会话、客户区屏幕矩形、显示器覆盖、遮挡窗口、空闲计时和当前焦点。该结果供交互桥保留证据，不能替代输入按下前的原生复查。仅会话 1 内的正式服 Wow.exe 可以执行焦点恢复；HWND、PID、进程启动时间与已绑定身份必须一致，窗口可见且未最小化，完整客户区落在显示器矩形并集内。Z 序链与 EnumWindows 集合必须一致；目标上方可见窗口的确定 region 或保守外框矩形与客户区相交就拒绝。DWM cloak、几何、窗口顺序等 API 不确定时拒绝。未设 region 与 API 错误不能区分时使用整个外框作为遮挡范围，透明/不可命中的覆盖窗口也保守拒绝。完整区域检查后再作客户区边界/中心及实际点击点 WindowFromPoint 复核；格点检查不承担完整无遮挡证明。不读取可能过期的 SYSRGN 作为证明。

点击前调用 GetLastInputInfo，要求会话 1 内空闲 **严格大于 5000ms**，DWORD 计时回绕用无符号差值处理，未来或半周期歧义值拒绝。该 API 仅报告调用会话；SendInput 也可能更新时间，它不能区分真人与注入来源。原生先登记所有权，最后复查空闲和可见性，再在同一 SendInput 批次移动鼠标和按下，避免自己的移动导致空闲复查误拒绝。之后仍查可见性，最多给 75ms（且不超过动作时长）等待焦点激活，已确认聚焦后再次失焦立即取消。150ms 内释放后再确认焦点，失败停止会话。恢复前任一鼠标按钮已有按下状态就拒绝；取消、EOF、心跳/租约过期、执行器死亡仍由原有账本和独立看门狗释放自身所有权。[微软 GetLastInputInfo 说明](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo)、[GetWindowRgn 返回值](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrgn)。

无输入验收入口 `tools/NativeRecoverySafetyFixture.cs` 与 InputCommon.cs 一起用 .NET Framework csc 编译即可运行；覆盖显示器并集/间隙、单像素遮挡、屏外、最小化、空闲边界/回绕、无效 HWND、取消和空账本重复释放。此 fixture 不打开游戏、不发送输入，实际焦点恢复效果需现场证据单独报告。

Windows 看门狗独立于 WSL 与执行器运行。Ctrl+Alt+F10 全局急停由看门狗注册；Node 的 Unix socket panic 是另一条协调器控制入口。EOF、超时或关闭传输都不能被 TypeScript 当作释放确认。实际释放由 Windows 所有权账本和独立验收证据核实。

执行程序完整生命周期持有 ExecutorAdmission，看门狗持有 GlobalOwner 直至清理完成。单边死亡时，新会话必须等旧所有权清空；旧执行程序释放失败会保持存活并重试，不让新会话与旧 UP 重试重叠。同时强杀两个 Windows 进程不在恢复保证内。
