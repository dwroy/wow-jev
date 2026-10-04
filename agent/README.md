# WoW Agent 在线入口

第 0 阶段提供环境诊断、协议校验和离线演示。这里不会调用视觉 API，也没有真实键鼠执行入口。

在仓库根目录安装本地依赖并验证：

```bash
npm --prefix agent ci
npm --prefix agent run typecheck
npm --prefix agent test
npm --prefix agent run doctor
npm --prefix agent run demo
```

`demo` 按 JSONL 输出三条互相关联的观察、模拟动作和执行回执。输入回执是 `simulated`，游戏效果是 `not_applicable`；没有观测证据和真实输入时不能报告 `sent` 或 `confirmed`。

协议的唯一运行时来源是 `protocol/agent-v1.schema.json`。`src/core/protocol.ts` 提供在线代码使用的类型；校验时不会自动修复或丢弃多余字段。

```bash
# 校验单条 JSON（也可以用 FILE 替代 -）
npm --prefix agent run validate -- ../protocol/examples/valid-observation.json

# demo 写出 JSONL，然后逐行校验；--silent 避免 npm 的提示混进 JSONL
npm --silent --prefix agent run demo > /tmp/wow-agent-demo.jsonl
npm --prefix agent run validate -- --jsonl /tmp/wow-agent-demo.jsonl

# 工作树中使用主仓已经构建好的只读工具（请替换路径）
npm --prefix agent run doctor -- --legacy-root /home/dai/Projects/wow-jev --probe-windows
```

`doctor` 默认只读本地运行环境、Git 状态、schema 和二进制文件属性，不读取 `.env` 或 key，不截图。加 `--probe-windows` 后调用 `WinSnap.exe list` 与 `JevCapture.exe --dpi`，只报告窗口数量与 DPI 模式，不输出窗口标题。子进程使用参数数组、关闭 stdin、设置超时与输出上限。

执行边界是 Windows / WSL：这里的 TypeScript 在线编排运行在 WSL，Python 负责离线分析与低频视觉；Windows C# 负责桌面截屏、高频 CV、键鼠输入和独立释放。第 0 阶段的跨边界验收只覆盖从 Node 启动 Windows 只读探针；截图与真实动作将在各自阶段验收。

工作树缺少 `capture/bin` 是未构建的状态，doctor 会报告 warning。文件存在也不代表能够启动。`ready_for_offline_demo` 只依赖 Node 和协议；它不意味着能够截屏、执行游戏动作或运行完整 agent。

`validate` 校验 schema 形状、单条消息内部的时间先后和输入事件计数。它不验证跨消息引用、条件是否满足或游戏效果；这些约束将在后续运行时与回放层实现。消息时间都来自同一个 run 协调器的单调时钟，不直接比较未经对时的不同进程时钟。

退出码：`0` 表示命令成功，`1` 表示消息校验失败或离线必需环境不满足，`2` 表示参数、文件或 schema 加载失败。

## 第 1 阶段原生输入

WSL 侧常驻 `hand/client.ts` 通过 JSONL 与 Windows `WinInput.exe` 通信，每 250ms 心跳。输入期限、焦点检查与独立释放由 Windows 管理。Node 不使用短探针的进程组终止策略启动执行器，Windows 看门狗路径通过 `wslpath -w` 转换。

```bash
# 只列出 WoW 候选和专门输入记录窗口
npm --prefix agent run input -- list

# 默认 dry-run：只校验动作，不启动执行器
npm --prefix agent run input -- --window 0xHWND --pid PID --action '{"kind":"key","keys":["W"],"duration_ms":250}'

# --live 后等待5秒，手动切回目标；完成一个动作后释放并关闭
npm --prefix agent run input -- --window 0xHWND --pid PID --live --action '{"kind":"key","keys":["W"],"duration_ms":250}'

# 持久会话可从stdin接收JSONL，另一个终端能panic释放
npm --prefix agent run input -- session --window 0xHWND --pid PID --live
npm --prefix agent run input -- panic --session UUID --live
```

工作树可加 `--native-root /home/dai/Projects/wow-jev` 使用集成构建的二进制；schema 和默认 profile 仍从当前仓库读取。执行必须明确绑定 HWND 与预期 PID，不自动选择客户端，不抢焦点。`--wait-focus-ms` 默认 5000，设为 0 立即尝试；Windows 在实际发送输入时仍复核焦点。

持久会话接受 `{"op":"execute","action":{...}}`、`{"op":"cancel"}`、`{"op":"release_all"}`、`{"op":"status"}`、`{"op":"shutdown"}`。同一时间只允许一个动作；控制命令与心跳能在持续动作期间处理。会话急停使用仅当前用户可访问的 0600 Unix socket。

原生回执描述事件插入与 Owned 输入是否释放，`effect.status` 始终为 `unknown`。超时、断连和关闭管道不构成释放证据，WSL 不会据此宣称松键成功；它们由 Windows 看门狗兜底，实际强杀恢复需独立实测。
