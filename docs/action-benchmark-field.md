# 联盟战士现场验收入口

2026-10-07常驻会话路线保留前台输入闸，WGC与ROI在Windows内存内处理，低频证据/OCR单独请求。教程由局部事实与既有L4/L3/Body执行，恢复只到可玩世界；详见[教程分层入口](tutorial-layered-runtime.md)、[常驻宿主](resident-session.md)、[常驻集成实测](acceptance/resident-session-integration.md)。专用记录窗口以独立fixture_effect验收相同执行链，不能代替游戏效果。当前RDP会话1已断开，用户要求只完成离线代码/测试/文档后推送并停止，不轮询RDP或发送输入；实际WGC/30次控件输入/持键断链及首个交谈待用户通知窗口就绪。

2026-10-06新增受限会话启动/选角/焦点恢复和首个交谈入口见[session-recovery](session-recovery.md)。最新用户授权允许空闲/无遮挡且身份确认后的单次恢复点击，普通输入仍前台；本节原背包对照方案不自动获得任意失焦输入权限。恢复的code/冷桥/QPC输入/独立效果证据另记，不冒充single/layered成对跑分。

离线交付时客户端仍在安装，当时仅运行`prepare`、`validate`和`--help`。2026-10-06用户已授权Windows桌面只读截图、低频视觉及“联盟战士第一个教程任务”的有限输入，保留前台校验、有限时长、取消及独立释放要求；现场最新授权与实际阻塞以`HANDOFF.md`和[第一个任务验收记录](acceptance/exiles-first-task.md)为准。下面通用基准命令仍需满足各自前置证据，不因客户端启动或焦点恢复自动串联执行；现有背包对照入口不能冒充教程NPC任务执行入口。

用户已选联盟战士，教程尚未确认：离线同时准备 **流放者离岛教程未完成** 与 **已进入巨龙群岛苏醒海岸（The Waking Shores，实际中文 locale 地名现场再核）** 两条路径，只能等现场只读后选分支，不能默认教学已完成。“巨龙岛新手区”不能解释为禁忌离岛的龙希尔种族开场。最终入口仍取决于种族、等级及任务历史；具体任务链见战士数据准备文档，候选任务 ID 不能转成当前已接任务事实。联盟/战士属于用户声明，不冒充 CV 已观察字段。当前本地包保持参考级，未增加来源、OAuth、大包下载或许可判断。

## 分阶段入口与证据

从 WSL 项目根目录运行。脚本仅使用固定项目 TS 入口与独立 argv，不接受任意 shell、executable、worker 或 PowerShell 代码。每次只执行一个阶段；只读成功后立即停下，禁止串到输入阶段。

```bash
python3 tools/action_benchmark_field.py --help
python3 tools/action_benchmark_field.py prepare --run-dir out/benchmark/field-preparation
python3 tools/action_benchmark_field.py validate --config field-config.json
```

`prepare` 会写入不含桌面观察的 `field-plan.json` 和阻塞清单，明确 `desktop_access=false`、`input_enabled=false`、`models_enabled=false`。同时生成 `field-config.template.json`、`client-profile.template.json`；未核实 HWND/PID/角色 ID/客户端 build/patch 等都为 null，模板不能直接验收通过。`validate` 只验证本地 JSON、键位 profile、客户端六维配置与校准文件，不验证当前安装/进程，不读取凭据。每个输出目录必须不存在，避免覆盖原件。

`field-config.json` 的字段为：

```json
{
  "version": 1,
  "runtime_schema_version": 1,
  "window": "0x1234",
  "pid": 1234,
  "character_id": "warrior-character-confirm-after-install",
  "character_class": "warrior",
  "character_faction": "alliance",
  "tutorial_state": "unknown",
  "client_profile": "client-profile.json",
  "body_profile": "body-profile.json",
  "bindings": "bindings.json",
  "binding_artifact": "bindings-cache.wtf",
  "calibration": "calibration/calibration.json",
  "readonly_duration_ms": 10000,
  "sample_interval_ms": 100,
  "max_input_duration_ms": 60000,
  "max_actions": 8
}
```

以上 HWND/PID/角色名是示例，不能原样用于现场。路径按配置文件目录解析。客户端 profile 必须包含且仅包含 `branch/expansion/patch/build/region/locale` 六维，不能填写推测值；当前真实适配器仍仅接受正式服 Midnight 12.x。BodyProfile 必须绑定同一角色、build、locale 并包含真实键位来源 SHA，bindings 全量显式提供；`binding_artifact` 是实际该角色 binding-cache 原件，必须匹配 Profile 来源 SHA，并按最后有效 bind/unbind 覆盖规则核对 inventory 键确实绑定 OPENALLBAGS/TOGGLEBACKPACK，不能只声明一个 B 键。背包 CV 校准必须包含 `calibration.json`、`open.png`、`closed.png` 原件。它们由真实只读采样与用户手动确认后生成，不能把模拟模板用于现场。

首次无键位/背包校准时，获得只读授权后先运行发现采样：

```bash
python3 tools/action_benchmark_field.py readonly --config field-config.json \
  --run-dir out/benchmark/field-discovery-01 --readonly-authorized --discovery
```

发现模式只需要当前客户端六维 JSON 和显式 HWND/PID，不读取 profile/键位/校准文件，也不启动输入或模型。源码和原始图像/观察仍完整归档，未校准的 fields 保持 unknown/unavailable。发现清单明记 `discovery_uncalibrated`，不能作为输入阶段批准对象。人工核对角色、教学分支并补真实键位/校准之后，再单独采样校准后的只读证据：

```bash
python3 tools/action_benchmark_field.py readonly --config field-config.json \
  --run-dir out/benchmark/field-readonly-01 --readonly-authorized
```

该命令从当前项目 C# 源码复制构建，原生 `WinInput list` 仅用于窗口列举和版本 probe，**不启动输入 serve**。然后只运行原 `NativeEyeClient/EyeRuntime` 收集指定 WoW 客户区：最多 30 秒、600 帧、32 张图。校验客户端实际 FileVersion、安装分支、region/locale、HWND/PID/start_ticks、物理客户区尺寸；进程重启或窗口变化失败。只读阶段无输入/模型端口，不读取凭据，不上传截图。日志、图像、schemas、CV 校准、源码/原生二进制 SHA 与只读清单完整归档，原 Eye 严格回放必须成功且 actions=0。

只读完成后审阅 `readonly.json`、Eye 原日志/图像、版本探测结果、捕获成功率/焦点/校准与下文检查清单。它给出的 `readonly_sha256` 是下一步必须明确复制的批准对象。只读不会把未观察的职业、坐标、任务/实体 ID 或键位推断为 CV 已知字段。校准不够或只有一帧时，有限输入仍拒绝；重新只读或补校准后再次取证。

再次获得有限输入及场景确认授权后才可执行：

```bash
python3 tools/action_benchmark_field.py input --config field-config.json \
  --readonly-dir out/benchmark/field-readonly-01 --readonly-sha256 READONLY_FILE_SHA256 \
  --run-dir out/benchmark/field-input-01 --finite-input-authorized --role-scene-confirmed
```

默认有限输入入口是 **v1 背包打开/关闭接线验收**，不声称已经完成世界任务或模型对照跑分。它真正复用原 `CodePlay → compileSkill → evaluateGate → NativeInputClient/Windows watchdog`，只允许已校准背包状态相反的一次开/关动作，每次只有 100ms 显式键位输入。总时间最多 120 秒、动作最多 20 次；v2 世界 live 拒绝保持不变。

接线验收通过后，如另外获得模型与截图上传授权，可用同一入口执行真正的现场对照组：

```bash
python3 tools/action_benchmark_field.py input --config field-config.json \
  --readonly-dir out/benchmark/field-readonly-01 --readonly-sha256 READONLY_FILE_SHA256 \
  --run-dir out/benchmark/field-paired-01 --finite-input-authorized --role-scene-confirmed \
  --paired --models-authorized --allow-game-image-upload --schedule-seed 0
```

`--paired` 复用模拟基准同一 `chooseBenchmarkCandidate` 策略，仍共用上述真实执行 gate。先共同预热视觉/大脑 worker：只选择当前安全候选，不发送输入，冷启动耗时和两次端口请求单独归档；预热失败直接停止。正式两臂都在这之后测量。采用平衡 AB/BA 区组：seed 偶数为 `single → layered → layered → single`，奇数反向；不提供 seed 则随机起始并记录 seed。每块两次背包转换回到已确认初态，合计 8 次有限动作，因此 max_actions 至少 8。单层每一步实际调用原视觉 Seed worker，再调用原 SeedBrainClient；分层每块第一步在目标边界做视觉/大脑决策，第二步由当前 CV 唯一候选走代码。视觉摘要使用原图 source observation/time，真正作为 Brain 请求语义上下文，不能把模型完成时间当观察时间，也不覆盖 CV 闸门。

当前现场只有可逆背包动作的 code/brain 对照；Jev 熟悉行为缺乏已验证目标/导航身份时明确 `unconfigured_no_verified_familiar_behavior`，不能把背包动作伪装成 kill/talk/move 的 BehaviorSpec。离线模拟另验证三层命中。模型请求/回复、原始语义结果及采纳字段归档；worker 才读取凭据，脚本不复制或打印凭据。可用 `--seed-env-file` 指定凭据文件，但仅在 paired 且两个模型/上传开关同时明确时接受。模型调用统计区分端口尝试与需要 worker 证据确认的实际云请求，失败不算成功决策。

现场对照输出 `paired.json`，保留原 trace、同帧跨系统对时区间、每个决策/输入/效果与独立释放证据，并按 single/layered 分别汇总观察→决策、决策→输入、观察→输入 lower/upper 的 p50/p95、unknown 数；每层尝试/命中/条件命中率/所选比例的分母、输入尝试/已发出/完整插入/效果确认、有效动作每分钟和模型端口请求数。每组 active elapsed 包含取图、实际模型等待、每步重新 probe/CV/gate、Native 回执、CV 验效和初态恢复；最终公共释放耗时单独保留并均分计入两臂有效动作率分母，启动/共同预热耗时单独报告。worker 共用会话已预热、后续复用；没有客户端回复缓存，服务器缓存 unknown，不宣称服务器模型都已 warm。总期限同时取消模型链、停止输入及请求原 release，超预算不会让模型完成后再继续输入。

原 native receipt 首次成功 SendInput 的始末区间是输入发出边界，最早源捕获优先取 processing_timing.capture_started_ms 的 QPC 精确标记，与 SendInput 在同一已绑定 Windows 时钟下可得端到端区间；旧样本只有整毫秒开始时间时保留量化信息。观察→协调器决策需同帧发送/接收 bracket 对时，缺映射/旧 native 无 first-send 字段时明确 unknown。各环节 spans 单独统计，重叠 spans 不相加成端到端。当前仅 fake ports 测过该现场适配器，未实际执行这些现场命令。

输入前必须严格回放并核对只读原件 SHA、源码/原生二进制 SHA、同一客户端六维、角色/profile/键位/三份 CV 校准原件、HWND/PID/**start_ticks** 和物理尺寸；只读证据超过 30 分钟或源码改变须重新只读。每次动作前重新 probe，原 gate 再收新当前 CV 帧、校验前台及源时效。只读没有实际 input-ready 能力证据，清单明确标记为来源与二进制绑定的预期能力；有限输入另行启动原 input/watchdog 后核对 Native ready 的键位、timeline、最大持续时间及心跳租期，不能把预期标成实际已确认。

## 取消与释放

所有长阶段响应 Ctrl+C/SIGTERM。输入 ready 输出 `session_id`，另一个 WSL 终端可运行：

```bash
python3 tools/action_benchmark_field.py status --session-id SESSION_UUID
python3 tools/action_benchmark_field.py cancel --session-id SESSION_UUID
```

取消首先停止后续决策/动作，调用原 cancel/releaseAll 并保留回执；正常退出再独立关闭 transport。Windows 原生 Ctrl+Alt+F10 为现场停止热键。强杀协调器后由既有独立 Windows watchdog 管理释放，**不能用 finally、进程退出或 EOF 推断 released**；若缺相应 session 的成功 released 原件，最终 release 必须 unconfirmed。真实强杀、WSL 重启、焦点切换故障恢复必须在用户许可的单独有限验收中测量，不能从离线测试外推。

## 现场检查清单

1. 确认当前正式服六维版本、联盟战士/种族/等级、实际教学链完成情况、地图及任务日志；明确选择“流放者离岛教程未完成”或“已进入巨龙群岛苏醒海岸”。不清楚就保持 tutorial_state=unknown，不自动完成教程、传送或开始任务；记录截图/人工确认来源，不猜任务 credit 对应 ID。
2. 固定窗口物理客户区尺寸、Windows 缩放/DPI、UI scale、布局、键位与站立安全区域；确认前台，无输入法/聊天焦点/载具/战斗。记录 HWND/PID/start_ticks，不只记 PID。
3. 先单独只读：核对截图是指定 WoW 客户区，图像非黑/冻结，CV 校准一致，观察时效/源来源有效，原日志严格回放 actions=0；不同时开启上传。
4. 分别批准有限输入与截图模型上传。对照必须固定模型部署、prompt/schema/代码/知识 hash、timeout/retry/cache、网络区域、截图分辨率、预算、候选动作、键位/前后台和角色状态，禁止 baseline 偷用分层缓存或补偿性重试。
5. paired 采用随机起始、平衡 AB/BA 区组，两臂共用相同动作候选、gate、revalidate、Native 执行和效果检查。稳定背包开/关需每个区组从同一已确认状态开始；不把上一个区组的迟到模型结果用于下一区组。World quest 不可逆任务进度不得伪装成可重复配对；先使用可逆稳定动作。
6. 保存每次 capture request 的协调器发送/接收 bracket 与同帧 Windows QPC 捕获标记，时钟 ID 绑定相同 Windows 主机/进程实例。先对时后使用区间统计跨域延迟；未对时保留 unknown。记录 capture/CV/桥接/融合/视觉/代码/Jev/大脑/重验证/gate/dispatch/原生输入各环节，不能拿 execute started_ms 当首个 SendInput 时刻。
7. 输入已发出只认真实 Native 回执内成功 SendInput 的原始 first-send 时间区间与 events_inserted；效果已确认另认输入后同一校准/窗口的独立 CV 状态变化。未验证动作不计“每分钟有效动作数”。同时报 attempted/issued/confirmed、每层尝试与成功比例、模型调用次数、p50/p95/p99 与样本数/超时/阻塞。
8. 每个区组设置有限总时间/动作数，演练 Ctrl+C 与控制口取消，核对 released 原回执；失焦/断链/超时/取消不得续跑。发现释放未确认，立即停止后续区组并保留原件。
9. 完成后归档配置/版本/模型/prompt/知识/native 文件 SHA、只读 manifest、原 Eye JSONL/图像、trace/对时映射、模型请求/结果与采纳/拒绝、输入回执、效果后观察、取消与释放证据、paired 编排和报告。日志不含凭据；当前阶段没有真实游戏效果结论。
