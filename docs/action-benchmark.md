# 联盟战士：分层动作延迟基准

2026-10-06，用户明确决定。本轮客户端安装中，无 Windows 桌面取证授权；这里只做离线实现、模拟和严格回放。现场流程见 [action-benchmark-field.md](action-benchmark-field.md)，任务准备见 [warrior-dragon-isles-start.md](warrior-dragon-isles-start.md)，验收数字与原始证据见 [acceptance/action-benchmark.md](acceptance/action-benchmark.md)。

## 问题与预注册口径

主问题是：在相同任务、候选动作、安全闸和效果确认条件下，Windows 高频 CV + 低频视觉解释，以及代码/Jev/执行大脑的分工，能否缩短观察到实际输入发出的延迟、增加有效动作吞吐，并减少模型调用。测试针对整套策略的联合差异；首版两个组不能分别归因到 CV、代码、Jev 或大脑中的单个部件。也不由模拟得出当前国服实测改善。

| 组 | 感知与选择 | 共用部分 |
| --- | --- | --- |
| single | 每个有效步骤先视觉模型解释，再执行大脑选择当前有限候选 | 相同动作/持续时间/候选条件、CV安全条件、重新采样、统一闸、取消/释放、后续效果判定 |
| layered | 当前观察中唯一确定候选走代码；熟悉行为分叉走 Jev；目标/异常边界走视觉与大脑 | 与 single 相同，模型不能绕过闸或自行新增动作 |

视觉结果作为带源观察身份的解释加入相同模型上下文；不改写当前 CV 的焦点、能力、布局或输入前置条件。迟到、未知、错身份、未知能力、当前状态变化和无进展分别记录，不能为速度删掉等待或重新采样。模型只选候选 ID；动作参数已冻结。模拟单层与分层复用真实 `BodyRuntime`、`compileBodyAction`、`evaluateGate`；模型选择复用既有 Brain 请求/回复验证和 `BehaviorJev`，不是当前完整真实世界任务大脑主循环的性能测量。

## 成对实验

离线固定 seed、相同候选工作量和场景状态机；每个重复按 AB/BA 交替跑两组。normal 包括目标边界、确定步骤和熟悉行为，两个目标计数分开。unknown、identity-change、focus-loss、cancel、no-progress 是独立反例：不被当作有效动作，不能用“输入流程完成”替代效果。等待、拒绝、重试、异常和释放占用的时间进入总时长分母。

模型/传输等离线成本由显式 JSON profile 注入虚拟单调时钟，均为场景参数，不是已有真实 Seed 计时。实际进程 wall 时间另列；它测的是本次离线代码/验证/日志路径，不包括真实网络或游戏反应，也不能用作模拟模型延迟。报告默认成本、模型成本为零、成本放大等敏感性结果，允许分层在某些条件下更慢。

现场首轮先用已有独立 CV 确认能力的有限背包闭→开→闭，ABBA 区组、相同角色/窗口/布局/键位/原生二进制与模型版本。每个区组结束恢复已观测状态；恢复不计有效动作、耗时仍记录。场景不匹配、外部人工输入、状态不可恢复或跨区组身份变化使该对不可比较，不通过自动操纵任务重置来“配平”。任务接取/交付通常不可重置，后续对照必须用匹配角色/任务状态或记录局部动作，不把不同任务经历简单相除。

冷启动及 warm 样本分开；报告硬件、代码/prompt/config/知识/校准 SHA、源图、原始日志、网络状态及配对顺序。固定场景才能比较；当前真实协议缺任务 typed identity 时保持 v2 阻塞。阵营、等级、教程、装备、技能/GCD/资源、所处位置、分辨率/DPI/焦点和距离未核实均写 unknown，不沿用旧机器 HWND/PID/69933。

## 指标及时间边界

| 指标 | 口径 |
| --- | --- |
| 观察→决策→输入 | 最早用于本次决策的源截图开始至第一个成功 `SendInput` 调用区间；观察可用→决策批准、批准→输入分列，p50/p95/样本数及 unknown 数一起报告 |
| 环节耗时 | Windows 截图、CV 两段、原图保存；WSL bridge、artifact 导出/转换、fusion、视觉模型、brain/Jev/code、复采样、gate、输入往返、效果等待、释放。嵌套/重叠 span 不相加冒充端到端 |
| 层命中比例 | 按 code/Jev/brain 的实际尝试、最终选择和执行结果计数；blocked/cancelled/wait/miss 单列，不能以仅成功样本作总分母。现场只覆盖 panel 的 code/brain 时，Jev 为未覆盖 |
| 有效动作/min | 原始总活动时长为分母；模拟的后观察 fixture 效果和现场独立 game confirmed 效果分开。输入开始、完整输入、效果已确认、释放 ACK 是四个状态；真实效果为零/未测不能借模拟填入 |
| 模型调用 | visual/brain/Jev 按实际调用尝试计数，错误、取消、超时也计；模拟 transport 次数与真实云调用次数分列。给出每有效动作调用数，零有效动作时比例 null |
| 资源与质量 | 每条真实模型请求的 tokens/耗时/源图及 prompt 版本；未知/无进展/拒绝率、完整输入比例、释放状态与比较有效性随速度一起呈现 |

`TraceRecorder` 是可选 sidecar，默认不启动模型或输入，不在旧 Eye/Brain/layers 原日志插入未知 kind。Eye/Body/Jev/Brain 实际调用点可接它，记录 `{domain,id,ms}`。Windows `Clock.PreciseMs` 保留 QPC 小数；新 native 字段是可选扩展，旧回执/样本有效，但缺字段时原生输入时刻只能 unknown。`timing.started_ms` 是执行工作开始，`timing.finished_ms` 是终态，不作第一次输入时间。

同 Windows 启动实例的 QPC 可在验证身份后比较；WSL 单调时钟、Windows QPC 和游戏时间不直接相减。`calibrateClock` 用请求发出/原生时刻/回包接收的 bracket 给出偏移上下界、有效期及漂移上界，`latencyInterval` 输出区间或 unknown，拒绝跨实例/过期/逆因果。现场更准确的整个观察→输入区间可直接用同 Windows 时钟的源截图和 `first_send_started_ms/first_send_finished_ms`；WSL 各环节只在自己的 clock/id 算持续时间。不得把异步视觉回复时间改成其源截图时间或用统计 median 偷换偏移。

技术依据：[Microsoft QPC 跨线程/进程与启动频率说明](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps)。本实现另外保留 API 调用区间；QPC 精度不是游戏引擎接收、动画/GCD或效果确认精度。

## 离线入口

```bash
npm --prefix agent run benchmark -- run --run-dir out/bench/default --repeats 4 --seed 42 --scenario all
npm --prefix agent run benchmark -- replay --run-dir out/bench/default
npm --prefix agent run benchmark -- run --run-dir out/bench/zero-model --repeats 4 --seed 42 --scenario normal --zero-model-cost
npm --prefix agent run benchmark -- replay --run-dir out/bench/zero-model
/usr/bin/python3 tools/action_benchmark_field.py prepare --run-dir out/bench/field-kit
```

目录必须新建，不能覆盖已有原件。`--cost-profile` 是精确 JSON 数字参数，不能指定执行程序或 shell。回放核对冻结源码/配置/日志 SHA，并重新执行策略、闸和状态机对逐事件语义核验，重新计算指标；不只信 summary/hash。离线 CLI 拒绝真实 desktop/live/model 参数。

## 现场顺序与停止点

准备模板→用户明确只读授权→有限窗口/客户端/角色/教程核验及取图→用户按当前布局确认/校准→冻结只读证据并严格回放→用户明确有限输入与模型/上传授权→有限成对基准→取消/释放/独立回放→比较结果。默认不会自动跨过任何现场阶段。Ctrl+C/外部 cancel 使用现有取消服务，命令租约/焦点检查/Windows 独立看门狗仍生效；缺失 ACK 保留 unconfirmed。编译、离屏测试与假的端口测试不能证明强杀、WSL 重启、物理按键或当前正式服效果。本轮交付后停下等客户端与授权。
