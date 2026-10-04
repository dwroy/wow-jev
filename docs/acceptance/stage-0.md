# 第 0 阶段验收：工程基线与协议

验收日期：2026-10-04（Asia/Shanghai）。负责人完成并行实施、独立审查及主 checkout 集成验收。结论：第 0 阶段通过，可体验环境诊断、协议验证和纯模拟消息链路。

代码集成版本：`6487a3986d70ed7908c91b2c1565dc5ed46400e3`，分支 `codex/agent-system`。本记录的后续提交仅追加验收文档。

## 交付

- TypeScript agent 包及本地依赖锁文件，入口 `doctor / validate / demo`。
- JSON Schema draft-07 的 Observation、ActionIntent、ExecutionReceipt，以及 4 个正例、6 个反例。
- 严格 schema 验证、单消息时间顺序和输入计数语义检查。
- 进程超时、输出上限、参数数组、stdin 关闭；POSIX 探针拥有独立进程组，清理只针对本探针。
- WSL/Windows 运行分工、逐步验收计划和项目协作规则。

## 实际环境

WSL2 Ubuntu 24.04，Python 3.12.3，Node 18.19.1，npm 9.2.0；Windows 程序由系统 .NET Framework 4 的 csc 编译，保留 C# 5 兼容性。独立 DPI 探针确认虚拟屏幕 3840×2160、Per-Monitor V2。

WSL 运行 TypeScript 决策编排及 Python 离线/低频处理；Windows 侧承担截屏、高频 CV、键鼠与独立释放。后两项属于后续阶段，当前没有真实输入执行器。

## 测试结果

| 验证 | 实际结果 |
| --- | --- |
| 主 checkout `npm --prefix agent ci --no-fund --no-audit` | 退出 0，按锁文件重新安装成功 |
| `npm --prefix agent run typecheck` | 退出 0 |
| `npm --prefix agent test` | 退出 0，21 passed，0 failed/skip |
| 主 checkout `.venv/bin/python -m pytest -q` | 退出 0，261 passed，3 xfailed；gamma 1.1 为预期失败 |
| 隔离工作树 `/bin/bash capture/build.sh`，随后用现有 Python 环境测试该树 | 构建退出 0，新编译 Windows 程序通过 261 passed、3 xfailed |
| Ajv 默认 strict 编译及全部协议例子 | 退出 0；4 个正例接受，6 个反例拒绝 |
| 合并后 `doctor --probe-windows` | 退出 0；Node 从 WSL 实际启动 WinSnap 与 JevCapture 的只读探针；窗口数量 6，DPI 为 per_monitor_v2 |
| 合并后 `demo` → `validate --jsonl` | 两命令退出 0，3 条模拟消息全部通过结构及基础语义校验 |

最终完整测试已包含 DPI 降级报告、CLI 退出码、未知值、模拟状态、时间/计数矛盾以及孙进程继承管道的超时回归。独立审查曾复现 100ms 探针延至约 992ms 返回；修复后复核约 102ms 返回，完整测试也已覆盖该场景。

本机验收证据保存在主 checkout 的 `out/acceptance/stage-0/`：`doctor.json`、`demo.jsonl`、`validate.jsonl`。out 为本地产物，不进入 Git。

## 体验方法

从项目根运行：

```bash
npm --prefix agent run doctor -- --probe-windows
npm --silent --prefix agent run demo
npm --prefix agent run validate -- ../protocol/examples/valid-observation.json
```

doctor 的 `ready_for_offline_demo: true` 表示离线演示可运行。`real_input_enabled: false` 和 `input_adapter: skipped` 明确表示键鼠执行尚未实现。

demo 的输入结果是 `simulated`，事件数为 0，效果是 `not_applicable`。这些是协议与入口的验收，不是角色已移动、技能成功或任务完成的证据。

## 验证边界与下一阶段

- 已验证 WSL 调用 Windows 只读程序、离线解码与新 CLI；没有截图游戏、调用模型或发送游戏输入。
- 第 1 阶段将实现 Windows 键鼠、有限持续时间、取消、独立看门狗和正式服短动作实测。
- 当前没有跨消息状态闸、字段融合、计划判重或真实效果验证；这些按后续阶段接入。
- 原始 JSON 重复对象键检测尚未实现；生产者必须避免重复键，当前校验基于解析后的对象。
- Windows 原生进程树清理、协调器/执行器强杀及 WSL 重启后的释放需要输入层的独立实测，不能从只读探针退出外推。
- 默认桌面沙盒进程入口存在启动器错误；本次通过自动审批的 Bash 执行入口完成真实验证，没有修改全局环境。
