# 会话恢复与首个教程交谈验收（2026-10-06）

实现与入口见 [session-recovery](../session-recovery.md)，本次边界以更新后的 [AGENTS](../../AGENTS.md) 为准。A/B/C 软件实现已分步提交并在主 checkout 集成；现场在只读后遇到完整客户区可见性阻塞，已停止。**未完成与吉安娜的第一个交谈，未发送任何游戏输入。**

## 实现与软件验证

| 阶段 | 提交与结果 |
| --- | --- |
| A：焦点恢复 | `525d712`；唯一受限 `focus_click` 复用统一执行闸、所有权账本、取消与独立看门狗。完整可见、目标身份、空闲严格大于 5s 才允许一次点击；普通动作保留前台校验。AGENTS 与原生协议同步更新。 |
| B：会话 1 执行端 | `f881b73`；当前登录用户一次性 InteractiveToken 任务，固定 payload/SHA、阶段超时、只读捕获/OCR/CV、原生输入通信和任务删除回查。当前选中“小啊”须同时核对名字、战士、联盟与选中行。 |
| C：恢复/启动编排 | `be99ab0`；独立 `recover`/`launch` 入口。已有 WoW 复用；缺失时只读发现战网并请求正式服启动，凭据/验证/协议/更新立即停。启动请求与独立发现客户端、输入发出与后图效果分别记录。 |
| 实图驱动修补 | `4844f61`；断线公告的账号文字不再误报凭据要求，明确零面积上方窗口不再误报几何未知。保留原始失败证据，并增加截图 API、PNG、窗口复核的独立 QPC 埋点。 |

最终全量：**TS 546/546；Python 729 passed + 3 项原有 strict xfail；失败/跳过均 0；typecheck 通过。** Python 收集总数为 732，预期失败不计作通过。软件日志在主 `out/acceptance/session-recovery-20261006/software-fix-01/`。其中 C 状态机 45、交互桥 Python 27、原生安全 fixture 42、窗口/延期心跳 fixture 50、真实保存图离屏 CV 14 项检查通过；这些是全量测试中的子集或独立原生检查，不能相加当作另一项全量数字。

测试没有发送游戏输入。窗口 fixture 在 session 0，不证明 session 1 战网可见正例；本次现场已有 Wow.exe，没有实际执行缺客户端冷启动。物理输入、释放、游戏完成、强杀/WSL 重启恢复均不能从软件验收推断。

## 两轮现场只读结果

主 checkout 使用固定构建入口运行 `recover --recovery-authorized --target-character 小啊`，输出全新 `live-01`、`live-02`；每轮仅 `discover` 与 `observe`，没有输入执行器或看门狗会话。

`live-01` 基线 `be99ab0`，协调器耗时 8964.746ms。程序误报 `credentials_or_authentication_required`；保存原图实际为中心“已从服务器断开（WOW51900319）”及“确定”，背后“重新连接”。公告/创建账号中的泛词不构成密码表单。另有零面积系统窗口导致几何未知误拒。两处程序问题已修，原件未改，随后全量复验再运行第二轮。

`live-02` 基线 `4844f61`，协调器耗时 12065.231ms，正确识别 `disconnected`。目标 PID `22072`、start_ticks `639268827443062278`、HWND `0x904a6`、类 `waApplication Window`、session 1、正式服路径均核对一致。物理客户区 2560×1440、DPI 144，屏幕矩形 `(612,413)-(3172,1853)`；可见、未最小化、**未激活**。完整可见检查返回 `client_occluded`，上方窗口 `0x400ce` 区域与客户区相交；其进程/内容未取证，不能据此猜测遮挡程序。零面积 `0x104e0` 已正确排除并记录。

根据 A 的明确边界，本轮在恢复点击前停于 `focus_recovery_safety_gate`，未点击确定/重连，也未进入世界。断线可由实现处理，但当前遮挡使恢复输入不具备许可条件。当前任务/键位与交谈效果尚未在世界内重新核实；没有发送键盘输入或套用旧 NPC 坐标。

| 最新分域实测环节 | 时间与范围 |
| --- | --- |
| PrintWindow API | 320.613ms，Windows QPC |
| PNG 编码与写盘 | 394.943ms，Windows QPC |
| 窗口身份/安全复核 | 25.819ms，Windows QPC |
| 本地选角/教程 CV | 1274.770ms，Windows QPC，两个校准检查均未匹配当前断线画面 |
| 本地 Windows OCR | 562.182ms，Windows QPC，识别中心断开/错误码/确定 |
| 完整 Windows observe 宿主 | 3246.147ms，Windows QPC，包含以上环节及其它准备 |
| 旧 capture envelope | 729.708ms，Windows QPC，包含 PNG，不等于纯截图 API |
| 冷桥 discover / observe | 6337.612 / 5719.915ms，协调器 monotonic，包含任务往返、Windows 工作及清理 |
| 协调器恢复输入闸 | 0.108ms，协调器 monotonic，结果 blocked，未下发原生动作 |
| 全轮运行 | 12065.231ms，协调器 monotonic |
| 观察→输入发出 / 输入→效果确认 | unknown，均没有样本，不能填 0ms |

各跨度有嵌套，不能相加；未经对时不能跨 Windows QPC 与协调器域相减。原 `TraceRecorder` 的分域 span/mark 保留在 `recovery.jsonl` 及 `summary.json.trace`。本轮决策为代码状态机、root 监督；Seed/Jev/执行大脑模型调用均 0，未参与层的动作命中率与动作比例无有效分母。有效游戏动作 0；没有 single/layered 成对现场数据，不能报告加速。

输入尝试、输入已发出、效果已确认均为 **0**，`goal_effect=unverified`。摘要中的 `release=confirmed` 是“未取得输入所有权”的抽象收尾，不是物理 KEYUP/释放 ACK。未持有任何程序按键或鼠标按钮，不推断其他用户的按键状态。

## 一次性任务清理

本次创建并删除以下 4 个当前用户、最低权限、无触发器的交互任务；每项 `last_task_result=0`、`deleted=true`、`deletion_rechecked=true`，独立 `GetTask` 回查 HRESULT `0x80070002` 不存在。没有强行终止输入进程、修改注册表/组策略/服务、安装软件或更改系统设置。

| 轮次/操作 | 已创建并删除的任务名 |
| --- | --- |
| live-01 discover | `WowJev-SessionRecovery-5038b8fbbc1f4e9bae22f3655358b05d` |
| live-01 observe | `WowJev-SessionRecovery-6009b03026db46938d18a799aea568b5` |
| live-02 discover | `WowJev-SessionRecovery-2736f12e1b4a4fd983dc35f62e366009` |
| live-02 observe | `WowJev-SessionRecovery-b42a8d989af745d99d127155d7bf6232` |

## 证据与后续

主本地目录 `out/acceptance/session-recovery-20261006/` 保留软件日志、两轮冻结源码/协议/配置、原图、OCR/CV、身份、分域时间、任务生命周期、摘要与 stderr。`field-summary.json` 汇总当前真实阻塞与时钟区间，`evidence-sha256.json` 核对 250 个本地文件；证据、EXE、依赖与凭据不随 Git 推送。

最新图 SHA256 `d072c415964ecd7d1c957b62d97d18f61d5961b1d0ba690ab4e0109b3de5aa77`；observation_id `session-observe-943ac497-267f-4841-a2d5-61336a328107`，路径 `live-02/step-1-observe/client.png`。首轮原图 SHA256 `7cb972892540a8c8e958473425702e7b1fe872588104635cda1c81d3e8a1d875` 保留供误判回放。

当前已停。需要用户移开覆盖 WoW 客户区的窗口，使完整客户区保持可见、未最小化，并在恢复点击前留出严格大于 5s 的键鼠空闲；再次继续时必须从新取证起步。不能使用 SetForegroundWindow、擅自移窗或放宽可见性条件处理本次阻塞。软件与记录正常推送仅 `codex/agent-system`，不 force push，不推其它工作分支。
