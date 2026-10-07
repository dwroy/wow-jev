# 可见背景点激活

用户本轮明确授权以当前可见 WoW 客户区点恢复前台。入口仍是现有恢复编排和原 Windows 手执行端；普通游戏动作继续要求 WoW 在前台。恢复只到可玩世界，任务交谈走独立分层入口。

```bash
python3 tools/recover.py recover \
  --run-dir /home/dw/Projects/wow-jev/out/acceptance/CONCRETE_NEW_RUN \
  --recovery-authorized --target-character 小啊 \
  --focus-visibility-mode visible_point
```

缺省及显式 `complete_client` 保留原完整客户区可见要求。`visible_point` 不要求完整客户区都在显示器内，但只接受当前同帧已明确识别的断线界面、原生返回的固定背景候选，并与识别出的所有按钮保留至少 32 物理像素距离。它不会点击“确定”来兼作激活；激活后重新采样，再由原流程处理确定、重连与选角。

候选为实际客户区尺寸乘以 `(0.6,0.25)`、`(0.75,0.25)`、`(0.6,0.75)`、`(0.75,0.75)` 后向下取整。每项由 `Native.GetRecoveryPointSafety` 独立返回：WoW PID、十进制字符串启动时间、HWND、类名、正式服路径、目标与探针 session1、实际尺寸、Windows QPC 检查时间，以及以下事实：

- 可见且未最小化；点周围半径 2、共 5×5 的物理像素区域完整落在客户区与显示器覆盖内。
- 区域每个像素 `WindowFromPoint` 的顶层根窗口都是同一 WoW HWND。
- 光标状态已知、可见且句柄存在；目标线程和非零当前前台线程没有鼠标捕获；用户未持左、右、中鼠标键。
- 当前交互会话 `GetLastInputInfo` 空闲严格大于 5000ms；未来或不明时钟值拒绝。

TS 恢复闸绑定原观察与全部目标字段，并再次核验上述事实、QPC 检查范围、候选点和尺寸。桥接宿主核验原件中的点证明和当前位置；原手执行端在所有权闸内、首个 DOWN 前再作当前原生检查。显式 `visibility_mode` 只属于 `focus_click`，普通输入不能借用该字段绕过焦点要求。

点击使用原有原子绝对移动＋LEFT_DOWN、有限持续时间（原生上限 150ms；恢复默认 60ms、编排上限 100ms）、取消、独立释放看门狗和原始回执。登记后的自身左键可能改变捕获与空闲，因此仅本次有限持有期间不重复把这些变化当成用户按键；目标身份、点可见、其它鼠标按钮和前台激活期限仍检查。用户输入来源不可完全区分，此限制如实记录。

原生要求前台及时变成 WoW；已激活后失焦、激活失败、取消或释放不确定会释放并停止。恢复编排还要求下一独立观察确认前台，不从 `SendInput` 成功推断效果。每轮最多一次焦点恢复。没有可证明的候选就停止；本改动没有 AltTab、窗口移动/最小化、后台消息、`SetForegroundWindow`、线程附着或系统设置操作。

跨语言定义在 `protocol/session-recovery-v1.schema.json` 的 `recovery_focus_point_safety`；原生输入 action 的可选 `visibility_mode` 在 `protocol/native-input-v1.schema.json`。完整客户区证明仍用原 `recovery_safety`，点证明单独放在 `window.recovery_focus_candidates`，不能把点证明改名当完整客户区证明。

本模块子 agent 只做 Linux 离线验证：新 TS 35/35、原恢复 TS 45/45、Python 桥接 27/27、typecheck 通过，日志在工作树 `out/acceptance/console-visible-focus`。另次原手客户端回归 6/16，10 项发生 mock 子进程提前退出，待负责人复查，不能称这组全绿。`tools/NativeVisibleFocusFixture.cs` 提供 24 项无窗口/截屏/输入的纯原生检查，由负责人构建运行；本模块尚未调用 Windows，也没有现场激活或游戏效果结论。实际现场成功、取消与释放按负责人原始证据独立记录。
