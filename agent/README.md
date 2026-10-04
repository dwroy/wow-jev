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
