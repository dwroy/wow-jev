# Windows 输入执行与测试工具

在 WSL 中构建三个本地程序：

```bash
bash native/windows/build.sh
```

使用 Windows 自带 .NET Framework C# 编译器，不安装全局工具。输入协议、账本和执行程序由 `InputCommon.cs`、`WinInput.cs` 提供。

## 独立释放看门狗

```text
WinInputWatchdog.exe serve --session <小写 UUID> --executor-pid <Windows PID>
```

执行程序先创建命名内存账本；看门狗打开同一账本。看门狗必须取得 Windows 当前登录会话的唯一输入所有者 mutex，并成功注册 **Ctrl+Alt+F10** 全局急停后，才能写入 `WatchdogReady`。执行程序必须检查就绪标志、进程身份和本地心跳再发送输入。

看门狗每 20ms 检查执行程序 PID 与启动时间、本地 QPC 心跳、动作 lease 和停止标志。默认执行程序及协调器心跳上限为 1000ms，可用 `--heartbeat-timeout-ms 200..10000` 配置。动作持有键或按钮时，lease 到期即开始释放；空账本不以零 lease 误判动作超时。失效后就绪标志变为 false，并拒绝恢复旧会话。

释放只发送账本所有权中的键和按钮的 UP。部分插入不会清除账本，也不会宣称释放完成；继续重试 UP，直到全部已插入。释放结束前持有唯一输入 mutex。看门狗自身被强杀由执行程序检测并停止；同时强杀两者的恢复不在当前保证内。

`--log C:\本地目录\guardian.jsonl` 可记录本地诊断；UNC/WSL 路径不接受。诊断输出和文件写入经过有界后台队列，无法阻塞清理。stdout 断开、日志文件不可写不影响账本和释放；进程结束时后台诊断可能未全部写出，释放事实应以账本和记录窗口真实状态验收。

## 专用输入记录窗口

```text
InputRecorder.exe [--keep-open] [--state-interval-ms 100]
```

默认客户区 600×400，使用正常 WinForms 窗类，标题 `WoW Jev Input Recorder - primary`；另有同进程 secondary 窗口，供失焦测试。以 ready 的 PID、hwnd 绑定，不根据模糊标题操作窗口；实际窗类在 ready 中报告。仅记录这两个窗口收到的消息，不安装全局键盘鼠标钩子。开启 Per-Monitor V2 DPI 感知，事件坐标是客户区物理像素。

stdout 为 JSONL：

- `recorder_ready`：窗口已 Shown，含 `hwnd`、`pid`、`client_width`、`client_height`、`focused` 和 `secondary_hwnd`。
- `recorder_event`：`event` 为 `key_down/key_up/mouse_down/mouse_up/mouse_move/wheel`；含窗口身份、事件计数序号及扫描码或鼠标物理坐标。
- `recorder_state`：周期性查询真实 `GetAsyncKeyState`，含 W、SPACE、CTRL、SHIFT、ALT、F10 与左右中鼠标按钮，以及当前焦点和聚合 `counts`。失焦不会清空或伪造释放状态。
- `recorder_status`：控制命令执行后状态，含 `ok`、`op` 和可选请求 `id`；若有排队丢失，`output_dropped` 大于零，不能把该段事件日志当作完整记录。

Windows 可能把连续点击的第二个 DOWN 表示为双击消息。左、右、中按钮的这类消息均记录为对应按钮的 `mouse_down`，并附 `double_click: true`；随后正常记录 `mouse_up`，不会漏掉第二次按下或另加一组虚构输入。

stdin 控制示例：

```json
{"type":"recorder_control","id":"focus-1","op":"focus_secondary"}
{"type":"recorder_control","id":"focus-2","op":"focus_primary"}
{"type":"recorder_control","op":"move_window","x":400,"y":200}
{"type":"recorder_control","op":"resize","width":800,"height":500}
{"type":"recorder_control","id":"sample","op":"status"}
{"type":"recorder_control","op":"trigger_emergency"}
{"type":"recorder_control","op":"close"}
```

控制通过 GUI 线程执行。焦点请求以实际 `focused/active_window` 验证，不能因为操作返回就视为成功取得焦点。`trigger_emergency` 仅用于测试，要求记录窗口当前在前台且 Ctrl/Alt/F10 原本松开；只发送这组三键急停并释放本次插入的键。不要用该控制操作游戏或其他应用。默认 stdin EOF 关闭窗口；体验模式使用 `--keep-open`。
