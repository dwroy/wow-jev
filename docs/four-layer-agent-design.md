# 四层 Agent：分区感知、人物动作、高级行为与任务

记录日期：2026-10-05。用户已确认四层划分并要求记录设计、开始实施。本文件区分目标设计、首版代码能力和真实验收；当前状态以 HANDOFF.md 及阶段验收记录为准。

## 四层职责

| 层 | 输入与输出 | 执行者 | 完成条件 |
| --- | --- | --- | --- |
| L1 基础输入 | 键鼠 down/up、press、长按、点击/双击/拖动、有限同步时间线 | Windows C# 输入执行器 | 回执、输入计数与持有账本释放，不证明游戏效果 |
| L2 人物动作 | 前进/后退/横移、转向/镜头、跳跃/曲线、骑乘/飞行、施法/互动 | 本地代码与语义绑定 profile | 操作结束；可观察效果另行确认 |
| L3 高级行为 | 击杀、拾取、移动到地标、交谈/接交任务、危险躲避与脱困 | Jev 选择，本地行为控制器执行 | 同目标、同任务和后续观察的效果证据 |
| L4 任务 | 区域、任务目标、数量、路线、交付与进度 | 执行大脑/任务编排 | 对应任务进度、交付与奖励证据 |

确定动作可直接使用代码；Jev 在高级行为的完成、阻塞、失败、策略分叉或目标变化时做选择。行为内部的运动修正、技能机会及紧急停止不逐次调用模型。高级行为是有反馈和期限的状态机，不是未经观察的长键序列。

`TurnInQuest` 处理到达 NPC 后的局部交付；L4 交任务目标决定去哪里、怎样到达及之后做什么。`MoveTo` 负责到达，任务层负责目的与顺序。飞行点交通、平稳飞行、驭空术使用不同能力 profile，不能由一个空格长按接口推导。

## 指令与输入契约

每条指令保存 command/parent/task 身份、revision/epoch、模式、profile、参数、前置条件、资源、期限、结果及证据。取消终止旧控制权并释放自身输入；同 ID 不重复执行，恢复使用新观察和新 ID。输入发出、输入释放、观察到动作效果和任务完成分别记录。

L1 的 down/up 在一个有限命令内表达，所有 DOWN 必须配对 UP 并由同一 owner 持有。press/长按和双击是时间线模式。曲线行走需要前进与鼠标转向同步，由 Windows 本地调度一个组合命令，不能并发两个既有 execute。保留最多5秒动作、1秒心跳租约、焦点/PID/启动身份检查及独立释放看门狗。

L2 使用语义绑定而非固定 WASD。已冻结缓存显示 E=MOVEFORWARD、D=MOVEBACKWARD、S=STRAFELEFT、F=STRAFERIGHT、G=INTERACTTARGET；实际动作效果、灵敏度与各模式仍须验证。profile 包含版本、角色、布局、修饰键、技能/槽、鼠标模式与适用运动模式；缺失映射为 unbound。前进/后退和左右横移互斥，鼠标界面操作与 mouse-look 互斥，读条/引导是否允许移动由能力契约规定。

`MoveFor(300ms)` 只表达输入时长，`TurnByMousePixels(40)` 只表达鼠标增量。距离、角度、骑乘、碰撞与到达需要独立观察。真实未知状态不由模拟或计时结果升级成 confirmed。

## L3 行为与 L4 任务

L3 首版目录：kill_target、loot_target、talk_to、accept_quest、turn_in_quest、move_to、fly_to、avoid_hazard、recover_stuck。每个行为有明确参数、前置条件、动作和时间预算、成功证据与恢复上限。危险抢占和失焦停止在本地处理；模型答复到来后重新采样并验证任务 revision/epoch。

战斗分离能力定义与策略：能力区分瞬发、读条、引导、地面指定、目标/资源/冷却和移动相容性；策略处理输出、打断、控制、减伤、治疗和撤退。首版可评测官方 Single-Button Assistant 与固定能力策略，但其实际可用性、额外 GCD和效果必须本机核验，不能等同完整自动打怪。击杀贡献以关联事件或任务进度判断；发现已有尸体只确认目标死亡。

L4 首版 sequence、kill_count、deliver_quest。任务数量优先来自对应任务进度，不能累计连续死亡截图；经验、未知、失败和取消保留。到达、路线和飞行缺少可靠定位时返回 blocked/unsupported，而非盲目输入。攻略和知识按 branch/expansion/patch/build/region/locale 隔离。

## 眼：像素、区域、元素与原子观察

流水线：共享原帧 → 区域树 → 元素 → 原子观察 → 对象视图/状态/事件。字段带 frame/region/layout 身份、来源、源时间、质量与有效期。像素、区域几何、文字/数值和推断分开；同名和视觉 track ID 不等于游戏 GUID。

固定 HUD（玩家/目标、动作条、小地图、任务追踪）采用 profile+锚点；背包、任务、NPC 和弹窗采用动态容器定位；世界姓名板和危险地面单独检测/跟踪。profile 至少包含真实 build、locale、客户区物理尺寸、DPI、UI缩放、布局、字体和插件组合。遮挡/未显示/明确不存在不混用。

最小对象：UnitView、ActionSlot、BagSlot、QuestEntry、DialogueChoice、MapMarker；最小决策单位是目标血量比例、按钮位置、任务计数等带证据原子字段。动作条分页、背包排序、框架池重用及同名目标交叉会使旧绑定失效。图标不唯一对应技能/物品ID，格位不等于底层bag/slot，小地图像素不直接等于世界坐标。

识别路由：几何/颜色/模板 → 局部数字或文字 OCR → Seed 歧义裁决。共享 ROI、预处理与识别缓存，文字/面板变化时重读；全帧用于初始化、布局失效和低频场景发现。缓存保留原解析源时间与本帧像素相同验证时间，不能伪装成新模型观察。

CV/OCR 使用原像素或无损 PNG；给 Seed 的 JPEG 是具备裁切/缩放映射的派生证据。当前同捕获 raw Bitmap/JPEG 字形不一致已证实，不能以 JPEG 自匹配证明线上精度。ROI 是否节省 token 以同任务 API usage 对照测量，不按面积直接推断。

截屏保留 PrintWindow 基线，FrameSource 可插拔；Windows.Graphics.Capture 是性能对照候选。高频像素留在 Windows，向 WSL 主要输出 JSON；Python 处理低频 OCR/视觉、分析和学习。

## 战斗日志旁路

Windows 本地尾读 WoWCombatLog*.txt，处理共享读写/删除、文件代际、截断、UTF-8跨块、半行、轮换、背压和恢复。保存原行/hash、offset、原时间戳及精度、日志/build/parser版本、Windows接收QPC和WSL接收单调时钟。去重用文件代际+offset，不吞掉合法同时事件。

尾读及时不代表游戏及时落盘。当前公开12.1样例为V22，本机日志头仍须核验；新鲜屏幕用于即时状态，迟到日志回填历史，不用接收时间刷新时效。GUID未可靠绑定当前视觉目标时 unit_link=unknown；无事件不推断非战斗。SavedVariables不是实时IPC，WCL/WoWAnalyzer是报告/复盘来源。

12.1 的 secret/secure API 限制不能套旧CLEU和旧像素桥。可选插件旁路逐字段检查实际权限，不尝试导出secret值。当前实现不以此旁路作为必需条件。

## 研究来源与版本

以下作者/官方资料于2026-10-05核对；main/live会改变，落地冻结SHA并核对实际客户端。

- [12.1.0.69933界面源码镜像，2026-09-22](https://github.com/Gethe/wow-ui-source/commit/09b9db7948abc9b9648dedaab51eb0cf3ee67b31)：当前模块/API结构；不是暴雪托管仓库。
- [ElvUI](https://github.com/tukui-org/ElvUI)、[Plater](https://github.com/Tercioo/Plater-Nameplates)、[BetterBags](https://github.com/Cidan/BetterBags)：锚点/profile、姓名板分类、容器/格位；TOC/作者支持声明不代替本机验收。
- [Questie](https://github.com/Questie/Questie)：只支持Classic，借数据组织；[WeakAuras Midnight声明](https://www.patreon.com/WeakAuras/posts/midnight-144610594)、[Hekili](https://github.com/Hekili/hekili)：旧设计可研究，不能直接当12.1运行依赖。
- [ConsolePort](https://github.com/seblindfors/ConsolePort)、[GSE](https://github.com/TimothyLuke/GSE-Advanced-Macro-Compiler)、[Clicked](https://github.com/Snakybo/Clicked)：语义绑定、序列编译、点击施法。secure点击不等于自主循环。
- [官方单键辅助](https://worldofwarcraft.blizzard.com/en-gb/news/24205457)：每次按键、额外GCD、伤害策略之外另管；不硬编码二手GCD数值。
- [RapidOCR](https://github.com/RapidAI/RapidOCR)、[PP-OCR模型清单](https://github.com/RapidAI/RapidOCRDocs/blob/main/docs/model_list.md)：当前v4/v5/v6候选，游戏字体精度和本机性能须测。
- [WCL日志说明](https://www.warcraftlogs.com/help/start)、[12.1/V22作者reader样例](https://github.com/double-buffer/wow-stream-overlay/releases)、[WoWAnalyzer](https://github.com/WoWAnalyzer/WoWAnalyzer)：文件缓冲、增量读取与报告分析分别处理。
- [Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)、[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)：OS捕获/输入机制；不证明游戏效果。
- [国服官方协议](https://wow.blizzard.cn/news/privacy/20240402/40295_1147007.html)：平台自动化条款与项目研发授权分开；不提供绕过。

## 实施与验收

并行模块：L1/L2输入与动作、区域感知/OCR、L3/L4行为/任务；负责人维护共同契约、文档、日志旁路和集成入口。先审查、回归与明确模拟，再使用专用窗口及有限正式服实测，不推动未经验证的动作能力。

验收分别量测 known正确/错误、unknown覆盖率、中文文字/CER、血条误差、布局和身份失效、捕获至输入/效果的p50/p95/p99、每行为模型调用次数、token/字节与重复上传率。物理释放、失焦/人工接管、取消/强杀及WSL整重启分别证明。当前1Hz录制不证明20Hz感知；提出的速度目标不冒充实测。

首版体验入口应提供明确simulated/readonly/live模式、完整版本与日志、可取消和独立回放。飞行/通用导航/职业策略的数据与真实游戏验收单列，不以框架演示冒充已自主升级。
