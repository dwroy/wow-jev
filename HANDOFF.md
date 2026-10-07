**2026-10-07 最新里程碑：联盟战士“小呵”首任务（与吉安娜交谈）已完成，reviewer=claude 人工验收confirmed，后续“热身”已接受；当前任务进度0/1摧毁作战假人。已安全回选角开发下一攻击入口，不因已定位并修好的bug重复询问。**

首交谈经当帧姓名板/黄色躯干→局部世界事实→L4→L3 talk_to→Body统一闸→hand，有限右键3/3并释放。原后图`out/acceptance/ui-skill-learning-20261007/autonomous-jaina-34/frame-3-evidence-10.png` SHA e27f11852045c7aa6b36c86d6aaca2d7034eeb5896bf9571264706917be0e85c显示吉安娜“热身”任务对话框；`autonomous-safe-logout-42/frame-1-evidence-5.png` SHA 3b2c37291efafd720ceec1a223573d88dd73d03ba4c93afa62fe11a072a0b69b显示已接受“热身”和攻击提示。人工验收原件`first-conversation-claude-acceptance.json`写入agent.sqlite原run的独立manual_effect_acceptance事件seq2（2812eda29037e574780debfc1a7e3f928cc52497d4177961b33fcd6741fac6ab），回读confirmed；不改原failed回执、学习计数0、不授active。

后验修补包括同物理行的分词NPC标题、接受/拒绝/继续/完成控件、当前Native NPC头像+羊皮纸+任务按钮签名，以及同源前后任务追踪新增条目；不要求UI从不存在变成存在，仍须独立新观察和对应NPC。接交任务只有实际提交后才使用只读效果时效，不能续发输入；750ms普通输入保持。原任务面板新增头像/羊皮纸校准保留修订，14个其它状态负例均通过，candidate/合格确认0。专项TS67/67和typecheck通过；全量验收与仅codex/agent-system正常推送随后补记。

Windows QPC最新源→首MOVE：首次交谈209.5049ms、接受热身195.228ms，未达到150ms，分别n=1不能称稳态p50。MOVE→DOWN分别161.2194/162.3177ms、DOWN完成→UP开始94.5545/83.3444ms。动作选择代码模型0；交谈后效Seed另两次失败请求仍计入。实际对话/接受与程序假阴性分别记录，详见[自主交谈验收](docs/acceptance/autonomous-jaina.md)。登出43有限3/3并释放，独立44新帧确认选角；43原超时不追认为晋升成功，临时任务删除回查、空账本、输入端退出和capture dispose均确认。

本轮冻结d582cae完整验收：Python980 passed+3原有strict xfail、0普通skip/fail；TS760/760、0skip/fail/cancel；typecheck通过。独立验收树接入忽略的capture/NPC测试工具后完整重跑，环境skip日志保留。任务面板更新后的审计JSON SHA 2df449748e99518efd07c1b6243beb57894d41656bd2a0d72c28d749d67b9d06，HTML19,772,636字节，JPEG长边≤640及原图链接，active0/治理合格确认0。人工验收不计入该合格数。

a73f5a0已正常推送唯一codex/agent-system，远端SHA核验一致；Windows Native/Resident/Recovery冻结树编译通过，OCR/恢复98项、主checkout集成35项与typecheck通过，bundle原SHA保留。后续thumb-v3为报告增长增加严格20,000,000字节上限：只递减JPEG预览长边（640至64），保留精确JSON、全部负例/记录/历史和原图；若最小预览仍超限明确失败，不删记录。四项展示不变量测试通过，包含缩图时不丢负例/技能。

34原OCR只有右下姓名，缺左侧任务窗标题/按钮，不是仅分词；当前CV任务面板无需OCR成功。低频OCR白名单另补热身、拒绝/完成、作战假人及0/1与1/1目标，供新任务追踪正例识别，仍不保留任意聊天/账号文本；必须独立Native编译和检查，不把保存图OCR漏读写成恢复成功。

遗留：作战假人当前实体定位与L4/L3攻击入口正在独立开发；≥2跨run独立确认、5轮学习曲线与现场成对速度比较未完成，不宣称反射学习收敛。长开发先留选角。以下为先前阶段历史记录，不代表当前首任务尚未完成。

作战假人离线接线：d0049a1原生当前中立姓名glyph/木桩独立chroma定位与一次screen-engage L3 helper，三张独立保存图正例37/44/47ms、菜单完整组合与选角负例拒绝。检测点来自当前木桩patch内部，不复用参考坐标，不宣称GUID/已攻击成功。新engage_target schema仅单次80–150ms与目标签名，Runtime仍走Body/统一闸；输入后只读选中假人确认不等于摧毁/任务完成，不能追加动作。resident唯一schema只新增method枚举，原Source/身份/ROI/点语义保留；宿主编译列表含新纯模块。角色仍安全选角，profile/Collector/field接线后再实测。

**先前治理v2软件阶段：现场未完成交谈时曾停在选角，历史数字如下。**

最新授权允许游戏内自主执行，self/Seed无需逐点预审；active按独立原后图重算、全已知状态负例、至少两次跨run live确认、最近成功率≥80%晋升，HTML供Claude/user定期抽查与撤销。user拒绝/撤销不能被self覆盖；同一步三次失败/十分钟无进展及凭据、协议、更新、真钱账号/玩家交互/销毁、管理员系统设置仍停止。普通输入保留当前帧、身份、前台、有限时长、取消和释放闸。

已集成不可变修订/快照、独立学习者后验、坏记录隔离、稳定转移ID、实际drag/move记录、当前NPC姓名板/黄色躯干定位、匹配裕度、模态退慢路、Seed坐标/像素复核及新鲜局部事实→L4/L3接线。真实agent.sqlite完整备份后迁移v2，11条旧记录修订保留历史。审计16技能（6 candidate、8 deprecated、2 alias），0 active、0合格确认；一条失败late-review回执隔离，不回填成功。

最终软件检查：Python942 passed+3原有strict xfail（0普通skip/fail），TS752/752（0skip/cancel/fail）、typecheck；原生纯治理32/32、保存图NPC定位8/8，Resident/Input/Watchdog/Relay编译通过。首次Python940+2失败是两份fixture缺新原生schema字段，修正fixture后完整重跑，原日志保留。源码检查点a3ff44a，当前提交只补验收与交接。

现场重连09后独立图到选角，进入11/确认12/镜头13均发出且释放，但不作为治理v2合格晋升确认。最后enter16选角识别通过、模态guard未就绪，Seed返回非法JSON，0输入；不猜坐标或补录成功。Windows QPC最新源→首MOVE三个审计期样本p50=181.1080ms，未达到150ms；不是最初观察/模型到输入全链成绩。落盘模型调用11次（Jev文本5、Seed视觉6，其中视觉结果失败3），没有active反射命中。所有已创建任务删除并独立回查；只读无执行器的释放不外推物理按键释放。

详见[本次治理验收](docs/acceptance/ui-skill-governance-v2.md)、[真实交谈/性能记录](docs/acceptance/ui-skill-learning.md)。主out的audit-report提供HTML及精确JSON，报告SHA b2ff1380b4e4d4e55ba0b1328a690f43cc11f722213e346379e84ec7787147d2。下次恢复先核验当前会话/身份/帧，补选角模态场景证据或有效慢路，再进世界→当前局部事实→L4/L3交谈；成功后按最新授权继续教程。长时间开发先留选角或安全登出，不发送无意义保活输入。

**2026-10-07 审计 HTML 展示更新：** 独立离线重渲染既有 b2ff1380… 报告，旧 199,711,810 字节 HTML 保留；新 thumb-v2 为 6,986,882 字节（约 6.99 MB），151 张 SHA 核验 JPEG 长边≤640，原图相对链接/原 SHA/元素框、16 技能/84 负例/9 尝试及审核链完整。原 JSON 241,834 字节逐字节保留。入口及 27 项专项验收见 [审计缩略图验收](docs/acceptance/ui-audit-thumbnails.md)，新 HTML 位于主 out 的 audit-report-thumbnails-v2；本步骤为展示更新，现场进度沿用负责人最新记录。

# WoW Agent 当前交接

更新：2026-10-07。用户最新授权和项目规则见 `AGENTS.md`，实施计划见 `docs/agent-roadmap.md`。历史3.3.5a像素桥任务原文已保留在 `docs/handoff-pixel-bridge.md`；当前测试目标为用户指定的正式服客户端。

## 历史阶段记录（当前状态以上方收尾为准）

**2026-10-07用户处理遮挡后继续人工审核重连：WoW已前台，点击发出并释放，但后图仍重连页，当前供监督审核。** 稳定源码3c16340；初始session1 inputDefault/UOI_IO=true、FG0x904a6=Wow22072，目标start/class/path未变、物理2560×1440/DPI144。无需focus_click。使用原RecoveryOrchestrator/InteractiveRecoveryBridge/hand与看门狗，review callback作为现有review-file等价适配：以reviewer=claude原帧SHA f60daaacd71fc016cf6dbc53dc7d876305326eb0e49ad56769fd477e57498737为审核依据，每个新capture单独SHA及按钮/独立logo像素匹配后才返回同源human_reviewed，不伪称Claude已独立看过新图，不刷新参考源时间。重连中心客户区(1280,720)，一次有限mouse_click，原生3/3事件、released=true、空账本/executor exited。

独立after截图仍是“重新连接/登出”登录页，FG保持WoW；自动effects_confirmed=0，未观察到选角/世界。该后图冷桥回读超过15s观察上限，原程序source_capture_age_unknown_or_stale停止；当前人工判断为页面未改变，不以回执completed证明重连成功。未重复点击、未选角或启动L4/L3交谈，首任务未完成。按最新要求已向监督报帧路径/简短判断，等待当前帧审核，不长时间研究OCR或11.2s、不搜索密钥。

当前帧主out/acceptance/manual-resume-20261007-02/recovery/step-3-observe/client.png SHA85b8f0c589086eb3b63bb8bd6f7e854177308a417fe8c07342cc3bf5ea441a76；完整审阅适配脚本/源码SHA、live comparison、input原件与trace均保留。五项临时任务（1Resident/4SessionRecovery）全删除且独立GetTask80070002回查。业务代码未改，本轮仅独立manual-resume-record树验收/HANDOFF提交、ff-only主集成，不重跑软件全量或推送。

**2026-10-07用户授权的单次背景focus_click实测：SendInput插入成功，但前台未改变，立即停止。** 独立manual-first-task树、业务基线40c1650。当前readonly确认session1/Default/UOI_IO=true、Wow22072/start639268827443062278/HWND0x904a6/物理2560×1440/DPI144；客户区点(1536,360)→屏幕(2148,773)的5×5像素全为WoW，避开按钮/公告且在PowerShell右侧。PowerShell外框(141,152)-(1893,1088)，WoW外框(601,368)-(3183,1864)、客户区(612,413)-(3172,1853)。当前光标flags2/handle0（系统抑制），本次明确授权的固定验收助手仅对此已知状态、无鼠标捕获/无人持键、空闲>5s放行，普通生产光标闸未改；使用原GlobalExecutorAdmission/LeaseStore账本及独立WinInputWatchdog。

唯一次Focus输入为绝对MOVE+LEFT_DOWN，SendInput返回2/2、GetLastError raw0；有限60ms后UP返回1/1，成功释放、held keys/mouse均0、watchdog退出。前台复核仍0x3607de/PID32924管理员PowerShell，没有成为WoW；按最新指令失败即停，没有第二次点击、重连、AltTab、窗口操作、权限提升或其它绕过。总插入鼠标事件3、focus_click意图1、普通游戏任务输入0，首交谈未完成；SendInput成功不替代focus效果确认。没有拿此单次焦点试验作为L4/L3性能或150ms目标。

本轮1Resident只读/1FocusClickTrial临时任务全删除且GetTask80070002回查；原始返回、窗口矩形、native source/payload SHA和清理在主out/acceptance/focus-click-trial-20261007，详情docs/acceptance/focus-click-trial.md。C#编译及真实受限试验已执行，diff检查；普通核心源码未改，未重新全量测试或推送。OCR/慢视觉/学习候选仍暂停、方舟配置仍待用户，禁止密钥搜索。到此停止等待，不尝试其它方法。

**2026-10-07人工审核优先轮次：重连按钮当前像素匹配，但管理员遮挡窗最小化被Windows拒绝，切换复核失败后停止。** 用户最新指令暂停OCR/模板与耗时研究，使用reviewer=claude对seed-recovery/initial/evidence-2.png的人工审核：原SHA f60daaacd71fc016cf6dbc53dc7d876305326eb0e49ad56769fd477e57498737，reconnect normalized bbox x.431–.569/y.474–.526、center(.5,.5)，不能点logout y.603。新readonly-01成功：session1 inputDefault/UOI_IO=true，Wow22072/start639268827443062278/HWND0x904a6/2560×1440/DPI144一致；按钮ROI与审核图mean absRGB .00065264、独立logo .686516，仍为重连界面，未授权把旧图改称当前源。

现场前台0x3607de/PID32924是“管理员: Windows PowerShell”WindowsTerminal，实际覆盖WoW且高Z。独立manual-first-task树新增固定单遮挡窗最小化闸（会话/身份/正面遮挡/空闲>5s/人类按钮检查，一次ShowWindowAsync SW_MINIMIZE，不含键鼠输入/SetForegroundWindow/系统设置），当前用户least-privilege /IT执行返回false/GetLastError5；窗口未最小化，1.5s后FG仍0x3607de，立即停止，未尝试第二切换。游戏/键鼠输入0，未取得输入执行器；不能冒称物理release ACK。两项临时任务均删除且独立GetTask80070002回查。编译通过，实测权限拒绝；不声称成功焦点恢复、重连/选角/首任务或完整套件复验。

新帧与reviewer=claude审核记录、真实权限拒绝/任务名/源码与payload SHA在主out/acceptance/manual-first-task-20261007；业务稳定基线3acb376。seed-recovery独立树中的慢视觉/候选匹配与未完成接线均暂停，不能当已验收路径；方舟凭据由用户另行放置，禁止继续搜索或读取其它密钥文件。本轮到此停止。需要用户解决前台管理员遮挡窗权限（本机最小化并点击WoW，或明确选择用现有管理员上下文执行此固定动作）；不继续研究OCR/11.2s或游戏输入。

**2026-10-07现场立即复测：会话/焦点已可用，发送一次确定后遇恢复识别阻塞并停止。** 源码12948ec，初始Resident只读确认session1 WTSActive/WinSta0 Default/UOI_IO=true、自由光标、用户空闲170453ms，FG0x904a6=WowPID22072，start/class/正式服path一致、2560×1440物理/DPI144。没有焦点切换、搬窗或系统设置改动。原恢复闸完成一次中心“确定”有限60ms鼠标点击，3/3事件、原生released/empty ledger/executor exited；后图保持WoW前台，弹窗已关且重新连接按钮可见，但OCR输出漏掉该按钮，程序unknown→disconnect_ack_effect_unconfirmed。程序效果0；root对同源图确认弹窗已关闭另记，不刷新或伪装程序CV。按最新“阻塞即汇报”停止，未重连、选角、进世界或L4/L3交谈，首任务未完成，不接下一任务。

QPC实测冷capture API66.248ms、PNG344.780、CV1319.312、OCR987.116、native spawn→ready1933.234、原生闸→首SendInput开始17.951；捕获API→输入11186.133–11199.632ms n=1，仅冷恢复ACK，不能当常驻分层交谈成绩。初始只读WGC ROI74.910/CV25.761/响应117.122ms n=1。热分层输入/效果n=0、150ms目标及命中率/有效任务动作率/单层对照未测；应用模型0。五项临时任务（1Resident/4SessionRecovery）全删除且GetTask80070002独立回查，项目Windows助手无残留，真实正常释放证据不外推强杀。完整原件/任务名/源码SHA与trace见docs/acceptance/first-task-resume.md和主out/acceptance/first-task-resume-20261007-01。

本轮仅记录现场、无业务代码修改；独立field-resume-record树提交、ff-only主集成，不重复全量、不推送。当前需要修实际重新连接图的识别或接同源低频审核再取新帧；Python recover包装器漏转发focus-visibility-mode亦登记待修，本轮用原TS CLI且已前台。旧console不可交互阻塞不再当当前事实，不要求用户再次搬桌面；等待新指示后再继续。

**2026-10-07本轮收尾：全量全绿，console首交谈因输入桌面阻塞而停止。** 实现a251575及断线诊断修补1b35c7d，最终完整Git快照TS680/680、Python820passed+3原有strict xfail（收集823，0fail/普通skip）、typecheck；原644TS全部保留、新增36。原生纯Resident78/78、visible-point24/24通过，编译和离屏验证不替代游戏成功。首次TS679/680为stdin写失败竞态消息未明确unconfirmed，补实际客户端错误信息后完整重跑，不改/删/skip用例，全部原失败保留。

最新原生事实：活动console是session3且LogonUI18948/winlogon18172；WoW仍session1 WTSActive/RDP-Tcp#0/protocol2/unlocked。WinSta0/Default但UOI_IO=false，GetCursorInfo错误5，FG0；Claude0x2106a0与Chrome0x400ce实际遮挡WoW，坐标与3840×2160物理显示器覆盖已确认。未观察到session1已转物理console。需要用户在物理显示器登录/解锁正确会话，或重连会话1且RDP可见、点击WoW、留>5s空闲并通知；不读/输入凭据，不改系统设置，不在不可核验的输入桌面发AltTab或盲目搬窗。

首任务未完成，当前世界角色/任务/键位未重验、本轮facts未写；游戏输入、程序Seed/Jev/大脑调用、确认效果均0。TraceRecorder35条实际只读记录，观察→输入及输入→效果n=0/unknown，150ms目标未测。readonly-03 n=3 ROI p50 67.871ms、CV9.672ms、真实回调→Windows响应83.488ms，只读热路径成绩不可冒称动作端到端；原compositor时间单独未对时。四个Resident和一个纯desktop /IT任务全删除，最终逐项GetTask80070002回查、执行助手为空；no_executor_acquired不冒称强杀释放。详细原件/任务名/测试失败与重跑见docs/acceptance/console-first-task.md和主out/acceptance/console-first-task-20261007。

软件与最终验收记录分步提交，主树只ff-only集成，按当前授权仅正常推codex/agent-system，不force、不推game-db-*；受保护bundle/HANDOFF原备份SHA复查。停止现场，不自动重连/等待轮询或继续下一任务；收到用户修正桌面通知后重新只读核验，再恢复世界→局部事实/L4/L3/统一闸/hand首交谈。

**2026-10-07现场已停止：当前活动console不是WoW所在会话1。** a251575完成真实FrameArrived QPC/批量ROI/显式可见背景点闸/只读命中窗口诊断。readonly-04及input-desktop-05实测WinSta0/Default但UOI_IO=false、GetCursorInfo错误5、FG0；actual console session3且有LogonUI/winlogon，WoW会话1仍WTSActive/RDP-Tcp#0/protocol2/unlocked。不是仅仅未激活WoW；未观察到用户预期的session1物理console转移。Claude0x2106a0、Chrome0x400ce在WoW上方覆盖全部候选点，完整客户区位于3840×2160显示器内，DPI/坐标错误假设不成立。需要用户让会话1真正显示于可交互桌面（本机登录/解锁正确会话，或保持RDP可见并点击WoW），输入desktop/自由光标可核验后再继续；不给密码、不修改会话/系统设置，不在安全桌面发Alt+Tab，也不移动窗口来掩盖输入desktop不可用。所有本轮游戏输入/模型为0，首交谈未完成，当前角色/任务/键位未获得新证据。

共同快照a251575首轮全量Python820passed+3原有strict xfail（收集823，0fail/普通skip）；TS679/680，一项disconnect断线回归在并发下由stdin写失败先于exit事件报native_write_failed，释放状态仍unconfirmed但错误信息漏写这个边界。保留原失败，修正实际客户端写失败的消息为native_write_failed; release remains unconfirmed，不放宽/跳过/删除测试。补丁提交后完整套件重新验收，全绿后才主集成/正常推codex/agent-system。Windows四个只读常驻任务和一个纯desktop诊断任务均删除，最终独立回查及详细验收正在整理。

**2026-10-07 console首任务恢复进行中。** 用户最新授权覆盖此前离线等待：会话1已由用户tscon转console，允许空闲闸内可见点激活，必要时另经统一闸Alt+Tab或仅移动/最小化遮挡窗口；每次切换独立复核前台，失败释放停止。独立树console-session基线90bf5c8，recovery仍只到可玩世界，首交谈仍须world引用/局部facts→L4→L3→Body闸→hand，不能在恢复中绕过任务链。

本轮readonly-01 WTSActive/Default/WGC19回调，但原compositor时间比宿主QPC领先约15ms；修正为真实FrameArrived QPC与未重复render戳，原render域未对时单独保存。readonly-02成功取三帧/断线实图，ROI约589ms；批量GPU读取后readonly-03 ROI67–80ms/CV9–22ms、源→响应83–115ms，n=3零输入，尚非观察→输入成绩。WowPID22072/start639268827443062278/HWND0x904a6/物理2560×1440/DPI144仍一致、FG0；四个背景点击点point_patch_not_target，正在只读核对具体遮挡和输入desktop。当前游戏输入/模型/首任务完成均0，不宣称p50<150ms达成。

专项TS66/66、typecheck、C#纯78/78及新可见点24/24通过，hand主环境16/16修正子agentmock运行环境故障的结论；完整Git快照待后续复验。readonly三轮任务均删除且独立回查，不从no_executor_acquired外推物理释放。可运行入口与原件见docs/acceptance/console-first-task.md及docs/recovery-visible-focus.md。

**2026-10-07 第3阶段全部离线实现与完整回归通过，按用户要求仅推codex/agent-system后停止。** 隔离组合候选bbf43fe含72文件，TS644/644、Python820passed+3原有strict xfail（收集823），0失败/普通skip，typecheck通过；相对第2阶段新增77TS/55Python，原用例全保留。JUnit三项skipped节点均为pytest.xfail的gamma1.1反例。完整原生构建及71/71纯策略/schema/合成ROI检查通过；两个新入口help和控件prepare实跑0桌面/输入/模型。离线六场景×四重复single/layered共48trial（8完成/32预期阻塞/8取消/0失败），严格语义回放verified；模拟成本/模型次数与实际性能分开，不报告150ms目标达成。最后审计修正cold已发输入丢失/unknown终态伪零、Python独立注册遗漏完整Native schema，以及真实知识原件SHA与全部artifact读回；全量基于已提交共同Git快照，一次完整套件全绿后只补文档。

体验入口`python3 tools/layered_tutorial.py --help`、`python3 tools/resident_readonly.py --help`、`python3 tools/resident_fixture_benchmark.py prepare --run-dir <全新目录>`；现场readonly/run/bootstrap/cancel及recording窗口/基准入口见docs/tutorial-layered-runtime.md和docs/resident-session.md，完整验收docs/acceptance/resident-session-integration.md。root原件在out/acceptance/layered-tutorial-20261006/stage-3-integration及stage-3-native；源/失败/模块专项均保留。主集成只ff-only，推送不force、不推其它game-db分支；原wow-jev.bundle与原HANDOFF备份SHA未变。

当前仍为RDP session1断开；用户明确先全部离线、全绿推送后停，不轮询RDP、不启动现场任务或发输入。首交谈未完成、WGC成功采样/本轮游戏输入/云模型均0；六项只读临时任务全部删除且回查，06正常退出仅no_executor_acquired，不冒称持键释放。记录窗n>=30、真实持键EOF/强杀、实际同域延迟/单层只读模型比较、当前初始事实及动态场景可靠dialog缺席校准均待用户另行通知窗口就绪，不能虚报游戏效果。

**2026-10-07 第3阶段离线组合候选，完整Git快照回归待执行；现场按用户最新要求停止。** 第1阶段归一化ROI和第2阶段局部事实/L4/L3路径已全绿正常推送至ebed98b。第3阶段在独立session-integration树组合常驻session1 WGC/ROI、会话0固定relay/本地JSON通道、私有来源登记与统一Body执行闸、原hand/watchdog、完整Native协议、取消/心跳/独立释放与任务删除，以及教程readonly/run/bootstrap/cancel和专用控件基准入口。控件走通用L3 activate_control、fixture_effect独立于game_effect；recovery仍只到可玩世界，教程仍只做首交谈，不接下一任务。数据原件包括实际知识使用清单/代码prompt配置与六维client证明，冻结世界包不改，临时模板不能伪装当前事实。模块专项全绿后形成隔离候选供Git快照完整套件验证，不以专项数字代替全量数字。

本轮root六次只读宿主验证，未取得输入所有权、游戏输入/模型/成功WGC采样均0。05身份链已通过；06确认同用户的session1 medium宿主与session0 high relay，双方PID/start/path/SHA及pipe session/SID校验，relay只为自身进程补当前用户0x1000查询ACE、不改全局。06实际WTS状态4(Disconnected)、Default线程桌面/OpenInputDesktop错误5/FG0、WGC零回调/零帧；同Wow PID22072/start639268827443062278/HWND0x904a6仍visible/nonminimized，物理2560×1440/DPI144。06正常shutdown收到同session ACK/capture_disposed，release_scope仅no_executor_acquired；六个WowJev-Resident临时任务均删除且GetTask80070002回查。源/原件/失败与清理见out/acceptance/layered-tutorial-20261006/stage-3-native和docs/acceptance/resident-session-integration.md，不把只读退出外推持键强杀释放。

用户随后明确RDP仍断开、暂不在线：完成全部离线实现/测试/文档，全绿后仅正常推codex/agent-system，再停止汇报；不轮询RDP、不启动现场任务、不发输入，窗口就绪由用户另行通知。待现场：实际WGC分布、记录窗n>=30真实有限输入与持键EOF/强杀释放、当前世界初始facts与独立dialog缺席校准、首个与吉安娜交谈及可选单层只读模型对照。严格exact左侧缺席模板在动态世界可能unknown，不能承诺一键成功或由NPC+hint推absence。当前Windows QPC观察→输入p50及150ms目标均未测、首任务未完成。只读FileVersion12.1.0.69933/CN/zhCN已实际核验，但缺成功WGC窗口来源，完整client-proof尚未生成；不默认旧profile为当前证据。

**2026-10-07 第2阶段完整Git快照复验全绿，准备ff-only集成后实施第3阶段。** 9208675隔离候选形成完整归档后，全量TS567/567（546旧+21新增）、Python765passed+3原有strict xfail（729旧+36新增，收集768），失败/跳过均0，typecheck通过。14个初始化失败确为新schema未入旧Git快照，提交后同一完整套件恢复；全部首次日志保留，未删除/跳过测试。28文件候选含源/文档与AGENTS边界；root仅追加此验收记录。当前仍无现场事实、输入、模型或目标完成；hotmemory/常驻宿主/当前现场driver属于下一阶段，窗口就绪通知仍待用户。主日志out/acceptance/layered-tutorial-20261006/stage-2，API入口docs/tutorial-layered-runtime.md。

**2026-10-07 第2阶段候选已专项验证，隔离提交用于Git快照全量验收；尚未主集成/现场。** 第1阶段4df54e6已正常推codex/agent-system。tutorial-layered独立树实现agent.sqlite同一RuntimeDatabase单writer连接的版本化局部断言扩展（base schema/world包零diff），源码与共享schema绑定原run/event、actor/session、六维client/world SHA、截图/校准字节、源clock，unknown/conflict/过期等不自动授权。新增tutorial plan/runtime经原createLayerExecution→L4→L3 talk_to→Body通用screen_interact→统一闸→hand；世界NPC不冒充UI，dialog absence未取得拒绝，post成对OCR仅效果。recovery两个入口都只停可玩世界，焦点恢复保留无遮挡/空闲>5s/有限单点击，空闲不足可预算内只读等待。

专项TS110/110，新增教程21项；Python局部36/base runtime与CLI合计73/73，typecheck/diff通过。完整TS收集567，553pass/14同before-hook失败，原因Git冻结导出4df54e6不包含尚未跟踪的local-assertion-schema.sql而新source reader已枚举它。原失败保留，先在隔离分支提交全体新源形成可导出快照，再完整复跑，全绿前不主集成/推送。普通字段/输入闸750ms；仅已发talk_to后的独立只读effect字段5000ms且不能发第二动作。新collectEffect端口请求在Body返回后，避免旧图；阶段3需接memory proof及常驻driver，当前仍旧file证据硬闸。源码入口/未验边界见docs/tutorial-layered-runtime.md。仍无现场事实写入、游戏输入或模型调用；窗口并排就绪通知尚未收到。

**2026-10-06 新指导第1阶段完成：客户区归一化/锚点/UI候选及常驻ROI接口，全量复验后提交。** 根据用户经Claude给出的新指导，顺序为1尺寸识别→2恢复/分层任务职责拆分+agent.sqlite局部实测断言→3session1常驻WGC/原hand与guardian/当前用户管道→4窗口就绪后仅第一个交谈及分层延迟。开发独立工作树resolution-aware/tutorial-layered/resident-session，模块单owner；当前后两阶段只读设计审计，未实施。游戏输入须等用户窗口并排无遮挡通知，保留空闲>5s与焦点恢复闸；不因用户打字抢鼠标。

第1阶段取消2560×1440硬拒，字形保持等比UI候选、选角右侧中心/NPC归一化位置/提示底部中心独立锚点，未知缩放/布局/相机变化仍unverified。DescribeRegions/MatchRegions为后续WGC仅ROI staging接口；预载模板/hash/缩放缓存，warm LockBits/稀疏ink+积分图，不per-frame磁盘读取/GetPixel。115离屏检查（全部旧14保留）通过：1280×720/1920×1080整图缩放与1600×1200/1920×800/1713×956×UI因子.75/1/1.25/1.5；错误名字/职业/阵营/提示/变形/ROI原点等拒绝。不同宽高比重绘不是实际相机/FOV证明。两场景各100 warm CV合计p50 10.920/12.046ms、p95 15.178/16.360ms；仅CV，不是动作E2E。

新session1只读取证实测当前物理客户区仍2560×1440/DPI144，用户外框很可能是DPI虚拟化坐标（推断，不作为尺寸证据）。新代码observe在实际断线图中选角/教程均false，cold完整CV1064.062ms含初始化/文件读取，0游戏输入/模型；3项只读临时任务均删除且回查80070002。实际其它尺寸正样本尚无。全量最终TS546/546、Python729passed+3原有strict xfail、0fail/skip、typecheck通过。首次独立树缺.venv入口/capture原生二进制和可选原生测试绑定导致1worker失败/84→44→21环境skip，原件保留；补齐构建+显式WOW_COMBAT_EYE_EXE/WOW_NPC_CLASSIFY_EXE后真正零跳过复验，不删/skip用例。日志/源SHA在主out/acceptance/layered-tutorial-20261006/stage-1；验收docs/acceptance/resolution-aware.md。下一步先把交谈搬入既有L4→L3→Body→闸→hand，recovery只停可玩状态，冻结世界包不改。

**2026-10-06 A/B/C 已集成并全绿；第二轮现场正确识别断线，但客户区遮挡，输入前停止。** 525d712/f881b73/be99ab0/4844f61 分步实现焦点恢复、session1受限交互桥、recover/launch及实图修补。最终TS546/546、Python729passed+3原有strict xfail（收集732，0fail/skip）、typecheck通过；原件在主out/acceptance/session-recovery-20261006/software-fix-01。最新验收详见docs/acceptance/session-recovery.md，旧阶段记录作为历史保留。

live-02基线4844f61，只读discover+observe，PID22072/start_ticks639268827443062278/HWND0x904a6/class waApplication Window/session1核验一致；物理客户区2560×1440/DPI144，visible/nonminimized但focused=false。当前断线WOW51900319中心确定识别正确；完整客户区核验发现上方0x400ce区域相交，reason client_occluded，协调器focus_recovery_safety_gate在任何点击前停止。目标第一个交谈未完成、goal_effect unverified；两轮总输入/效果/输入执行器/看门狗/云模型均0，abstract release confirmed仅未取得输入所有权，没有物理释放ACK。没有实际冷启动或游戏完成可报告。

最新Windows QPC：截图API320.613ms、PNG394.943ms、窗口复核25.819ms、CV1274.770ms、OCR562.182ms、完整observe3246.147ms；协调器全轮12065.231ms，冷桥discover6337.612/observe5719.915ms。分域/嵌套不相减相加，观察→输入与效果延迟均unknown，没有single/layered现场跑分。四项WowJev-SessionRecovery一次性任务全部删除且独立GetTask回查80070002不存在；没有系统配置改动。汇总field-summary.json及250文件evidence-sha256.json留本地主out。当前停止，用户需移开覆盖WoW客户区的窗口、保持完整可见/未最小化并留>5s空闲；收到继续指示再新取证。仅按当前授权正常推送codex/agent-system，不force、不推其它分支。

**2026-10-06 第一轮恢复实测无输入；断线公告误判及零面积窗口误拒已修并全量复验，准备重新取证。** A525d712/Bf881b73/Cbe99ab0已ff-only主集成。live-01约8.965s在只读后停credentials_or_authentication_required，实图实际上是“已从服务器断开（WOW51900319）”中心确定、背后重新连接，账号仅公告/创建账号文字；没有密码表单，不能称用户需输入凭据。Native可见性另误把上方成功读取的零宽/零高系统窗口当geometry unknown。原件未改，0输入/0native session/0模型，当前任务仍未完成；release abstract confirmed仅表示未取得输入所有权，不是物理释放ACK。

实际图回放驱动修补：强认证词仍阻塞，泛账号/登录改中心表单成对上下文，公告/创建账号不单独触发；统一schema增加断开/确定/重新连接与错误码。只有中心明确断线marker与下方当前确定框几何配对才一次ACK，随后独立复采重连；focus点击若已关弹窗不再点击旧ACK。Native只排除确定零面积矩形，反向矩形/仍存在但读取失败继续deny，消失窗口最多重新枚举一次；occluder diagnostics只HWND/class/错误/rect，不读其它标题。新增截图API、PNG写盘、窗口复核QPC独立可选字段；旧capture区间仍含PNG，不与旧85ms API数据混同。

修补最终全量TS546/546、Python729passed+3原有strict xfail、0skip、typecheck/diff全绿；C状态机45/45，bridge27/27，native safety42、window/heartbeat50、calibration14检查通过，真实归档断线PNG的本地OCR也识别正确，均不发游戏输入。software-fix-01完整日志/原件主out/acceptance/session-recovery-20261006/，修补本地提交集成后重建固定payload再运行live-02；当前还未完成教程、没有真实输入/释放或冷启动成功可报告。

**2026-10-06 B→C：恢复/启动编排及入口已完成软件验收，准备主集成现场。** TypeScript RecoveryOrchestrator统一预算/源观察/目标身份/按钮边界/前台例外闸，recover只到第一个交谈、launch只到世界，默认180s/阶段30s/8操作/100ms点击。真正现场class waApplication Window已精确纳入（不再误用旧Gx前缀）；已有无窗口进程不重复启动。战网冷窗口轮询、CLI仅请求后独立发现WoW；明确技术失败或限期无效果才在重新取证的健康战网执行唯一CV备用，auth/terms/update/unknown/权限拒绝不回退。进入世界的无字loading仅有限只读等候，不生成动作、不先计效果；中途危险词即时停止。

C的37项状态机测试包括真实canonical危险词+背景Play全部0input、wa实际类、冷窗口、launched但无WoW后唯一fresh-CV fallback、错误/近似角色、无字loading/认证中断、取消/永不返回端口/源时效、独立effect与未知release；全树typecheck绿。恢复code状态机/root监督，Jev/Brain/Seed调用0，不虚构模型分层加速；当前输入首SendInput与后独立观察按QPC/协调器分域trace记录。可用python3 tools/recover.py launch|recover --recovery-authorized --target-character 小啊 --run-dir <全新主out目录>，见docs/session-recovery.md。A525d712、B受限交互桥已分步本地提交，C收尾提交后ff-only主集成；全绿后再运行现场recover，任务完成或实际用户处理阻塞后更新取证并停，不继续后续训练。

**2026-10-06 A→B：会话1受限交互桥及当前选角/教程CV已完成，仍未现场输入。** A提交525d712；B支持discover/observe/input/launch_battlenet/launch_wow，当前登录用户、最低权限、无trigger、固定payload/源码与校准/schema SHA、一次性/IT+RunEx1、30s上限、取消文件及精确删除回查。C#只在session1做捕获/OCR/CV和原WinInput通信；普通输入/恢复点击都复用A闸与原guardian/ledger，ready即200ms独立心跳、stdin写锁，签名/UNC复核不会饿1000mslease。源观察hash/身份/尺寸/DPI/15s时效严格匹配。unsafe KILL_ON_JOB_CLOSE拒绝输入；记录nested_parent_jobs_checked=false及整树强杀未验证。AllowHardTerminate=false，不Stop/强杀输入树；release必须原回执+空账本+executor退出证据。

Battle.net按验签的path/session/PID独立EnumWindows发现，不扩展旧Native游戏list；注册表/已知安装位置只读，固定--exec launch WoW只记请求/effect unknown，不把Process.Start当客户端成功。认证/协议/更新危险关键词跨OCR、Native launch和TS共用session-recovery schema枚举，不得用CV回退绕过requires_user拒绝。OCR只输出白名单状态词及line框，credential/raw text不留日志。选中小啊金色行/name/战士/联盟徽记独立小ROI，名字/职业阈值收严至fraction .002/mean .8，30像素改名反例拒绝；当前名字和交谈提示掩码同新帧匹配才给一次吉安娜右键候选，旧图只作校准。

B当前Windows编译、26Python mock全绿，窗口/心跳原生fixture50检查（session0没有visible launcher正例，诚实记录未验session1实际战网）、真实保存图离屏CV14检查全过，均0游戏输入/模型/现场图。全量工作树软件验收仍538TS/728Python+3strict xfail/0skip/typecheck通过，A最新35fixture/21专项也通过。源码/原件主out/acceptance/session-recovery-20261006/software/；尚未验证冷客户端缺失启动或物理游戏效果，后续C编排本地提交后集成再现场。

**2026-10-06 22:15，最新用户授权A/B/C恢复链；A原生焦点安全已完成，尚未现场输入。** 本轮授权覆盖旧“不抢前台/失焦只停止”：普通动作仍前台，唯专门focus_click可在同session1正式服目标身份、完整客户区无遮挡/显示器覆盖/落点归属、空闲严格>5000ms、用户未持按钮时单次短点击；不得SetForegroundWindow/后台消息/系统改动。首次点击后至多75ms等激活，聚焦后再失焦停止，释放后复核；其它动作焦点不放宽。普通mouse_click另外在移动/登记/DOWN前及持有期间核对落点，并同一SendInput数组move+DOWN，账本UP，总3事件，避免两批之间鼠标交错。复用既有Input调度/账本/独立watchdog，不只靠finally；capability未声明focus_click的旧executor在TS前置拒绝。AGENTS/native协议同步更新。

独立`.worktrees/session-recovery`并行明确模块owner，root集成；A原生纯fixture35检查、相关TS21/21、4原生编译/typecheck/diff通过（均0游戏输入）。本轮全量软件回归TS538/538、Python728passed+3原有strict xfail、0skip/typecheck通过；最后原生点击批次修补另以35/21与编译复验，未改TS/Python旧用例。B/C实现及真实字段/冷启动/危险词交叉审查也已完成，分步提交随后记录；当前尚未运行真实recover，任务完成/现场释放/客户端缺失启动效果不得从软件测试外推。原始software日志和离屏fixture在主`out/acceptance/session-recovery-20261006/software/`，后续从已选“小啊”进入世界并仅与吉安娜交谈，遇用户处理的阻塞即停。

**2026-10-06 21:03，用户恢复WoW激活后继续第一个教程任务；只读复核焦点通过，但角色尚在选择界面，按遇阻塞停止。** 用户现场复查确认前台0x904a6/PID22072，并确认先前零前台来自“窗口在最上层但未激活”，不是RDP断开；先前RDP显示抑制仅为未证实候选，不再作为当前根因。本轮session1 helper PID18088再次实际核实采前/采后前台0x904a6、focused=true、同一正式服path/start_ticks，2560×1440客户区/DPI144，客户区屏幕原点已变为612,413。PrintWindow真实原图显示选中“小啊”、等级1战士、联盟图标及“进入魔兽世界”按钮，当前是角色选择界面，未见船上吉安娜、教程提示或任务窗口；不复用旧船上截图/NPC坐标，不从用户任务名称推定当前已在游戏内。当前任务/游戏内键位无法完成输入前只读核验，因此按用户“完成或遇阻塞停止”不进入有限输入；需要用户手动进入该角色的游戏世界并保持WoW激活后再继续。

本轮唯一任务WowJev-FirstQuest-Readonly-52ed32a9cca246d5bac3ac437119209d创建/执行/删除，独立GetTask回查80070002不存在。没有创建输入执行器/看门狗、没有持有按键；真实输入0、外部Seed调用0、助手原图复核1，没有物理释放ACK或游戏任务完成可报告。Windows QPC capture85.461ms、完整只读观察697.609ms，协调器任务生命周期monotonic1895.437ms；按既有TraceRecorder分域记录，观察→输入、输入发出与效果确认均unknown/未开始，不混减时钟，不报告行动收益。原图/身份/生命周期/清理/sidecar/摘要及SHA在主`out/acceptance/exiles-first-task-20261006/foreground-restored-*`。仅独立树更新HANDOFF与验收记录，本地提交集成，不推送；源码不变，最新完整源码回归仍为309e858阶段的TS498/498、Python702passed+3strict xfail、0skip/typecheck通过，本轮只做diff-check，不重复软件套件冒充现场验收。

**2026-10-06 20:25，按用户最新指示只读诊断 RDP/桌面；诊断后停止，游戏输入仍为0。** 两轮一次性最低权限/IT任务实际执行于session1（helper PID23028、15720），各三次间隔500ms采样。任务/游戏线程均为同一WinSta0\Default（各轮GetThreadDesktop借用句柄一致：第一轮0x120、第二轮0x11c；不跨进程比较句柄数值），OpenInputDesktop成功且名字Default，相关GetLastError=0；不是session0或另一个命名桌面的执行端。WoW HWND0x904a6/PID22072/线程18008/start_ticks仍一致，IsWindowVisible=true、IsIconic=false。session1=XDWIN\XD、RDP-Tcp#0、协议2、WTSActive；第二轮WTSSessionInfoEx返回232字节/level1/session1/flags1=unlocked（CIM核实实际Windows11 10.0.26300）。控制台session2=WTSConnected、无登录用户，active_console_session_id=2；不据控制台登录屏推断RDP会话锁定。

六次GetForegroundWindow=0x0，GetGUIThreadInfo(0)=false/GetLastError0；游戏指定线程的GUI查询成功但Active/Focus均0。GetWindowThreadProcessId(前台0)=tid0/pid0/error1400，该错误属于查询空HWND而非GetForegroundWindow本身。线程桌面及第二轮OpenInputDesktop句柄UOI_IO均false。WTS成功返回时raw error1008不解释为API失败或权限拒绝。当前证据排除任务跑错会话/命名桌面、采样时RDP断连及WoW最小化；实际输入前台不可用，客户端最小化/显示抑制是候选原因而未被服务端API唯一证实，也不能从约1秒窗口外推全部历史状态。下一步需要用户恢复并保持本机RDP客户端可见、确认远程桌面未锁定/无安全提示、仅点WoW标题栏后告知；如一直如此，需客户端类型/是否嵌套RDP信息，再做恢复前后只读对照，当前不自动重试或继续任务。

本轮任务WowJev-FirstQuest-Readonly-a9f5349c633842029fa0c8aa6e9682f7、WowJev-FirstQuest-Readonly-c787ab9325954a92b8be87661b13e82c均创建、执行并删除；独立GetTask回查均80070002不存在。未改变AGENTS、焦点闸门、Windows注册表/组策略/服务/安装/会话状态；没有抢前台、切换/附着桌面、截图、模型调用或输入。诊断模式仅API查询，保留默认只读截图路径；实施独立树`.worktrees/exiles-first-task`。原始数据/创建删除/XML/SHA位于主`out/acceptance/exiles-first-task-20261006/rdp-desktop-diagnostic-01/`、`02/`及`rdp-diagnostic-*`，第二轮实际源码/EXE归档SHA核对，分域延迟sidecar用既有TraceRecorder生成。Windows完整诊断1059.239/1059.751ms（各含1000ms主动采样等待），协调器往返2873.537/2872.410ms，不混减、不作为游戏动作延迟。全量Python收集705：702passed+3原有strict xfail、0skip；TS最终498/498，typecheck通过。TS首轮497/498为独立树缺少固定.venv路径的环境故障，补齐同主树环境后全量重跑全绿，首轮日志保留，未改/跳过测试。详情`docs/acceptance/exiles-first-task.md`最新节。本地提交集成，不推送，等待用户。

**2026-10-06 20:00，用户恢复原前台设计并授权一次性/IT交互任务；只读取图成功，焦点核验未通过，已停止。** 用户不做后台PostMessage/WGC方案，保留前台焦点规则，禁止抢前台。目标仍仅联盟战士流放者离岛第一个任务，完成或阻塞即停。允许当前登录用户的会话1执行端及任务完成删除，不允许注册表/组策略/服务/安装改动。未改AGENTS或原输入/截图设计。

三次最低权限、无触发器、15秒上限的`WowJev-FirstQuest-Readonly-*`任务已创建后删除；完整名称/XML/SHA/删除回查在主`out/acceptance/exiles-first-task-20261006/`。第一轮winexe Console.OutputEncoding启动异常原件保留并修复；第二轮旧Gx类名假设拒绝，修为只读记录经PID/start/正式服路径验证的实际类，不提升输入授权。第三轮helper PID12036实际session1，Wow PID22072/start_ticks639268827443062278仍一致，HWND0x904a6，class=`waApplication Window`，2560×1440物理客户区，DPI144，未最小化；PrintWindow flags3保存有效客户区PNG。截图中1级角色“小啊”在联盟船上，教程提示与吉安娜·普罗德摩尔交谈，黄色可接图标；任务标题/ID/接取及键位尚未核实。

第三轮采前/采后`GetForegroundWindow=0x0/focused=false`，无法确认目标在输入前台；按原闸门要求不发输入并停止，不把用户“已放前台”声明代替Win32检查，也不据0句柄断言用户窗口实际不在前台。输入执行器/看门狗未创建、命令/事件0、程序持有按键0，无物理释放ACK可报告。Seed调用0，助手原图复核1；未接取/完成任务、不继续下个任务。实测同Windows QPC capture76.636ms、整个只读观察764.976ms；协调器任务注册→执行→等待→删除2632.632ms，分域sidecar来自既有TraceRecorder，重叠跨度不相加；CV/模型/决策→输入/效果延迟均unknown。

只读实现使用独立树`.worktrees/exiles-first-task`，新增InteractiveReadonlyProbe及固定payload/取消文件的一次性任务脚本，无输入API调用/无提权/密码。C#编译和3项非法参数/任意输出/路径穿越拒绝、8项Python离线生命周期/清理反例通过；本轮未重跑历史498TS/692Python套件，不将其当现场验收。原始失败、完整任务创建/删除、截图/时间与`resumed-summary.json`、`readonly-latency.jsonl`、`tasks-deletion-verified.json`均保留，详细`docs/acceptance/exiles-first-task.md`。本地提交/集成、不推送；当前停止边界是实际输入焦点未知，下一步需验证交互执行端能读到当前前台后重新只读，本轮没有任何游戏输入。

**2026-10-06 19:42，联盟战士教程第一个任务现场尝试：前置会话隔离阻塞，已按用户要求停止。** 用户本轮明确授权Windows只读截图、低频视觉和有限输入；目标仅流放者离岛教程第一个任务，完成或阻塞就停，不继续下个任务。最新焦点约束：不通过就禁止输入，不能抢前台；遮挡/最小化如实记录。该授权更新下面安装中/尚无现场授权的历史状态。

实际只读探针核实Wow.exe PID22072，Windows session1，2026-10-06T11:25:44.3062278Z（本地19:25:44）启动，start_ticks=`639268827443062278`，路径`C:\Program Files (x86)\World of Warcraft\_retail_\Wow.exe`，FileVersion12.1.0.69933。调用PowerShell PID32172/session0，身份XDWIN\XD；session1 Explorer PID12544。调用环境中的game/shell/foreground HWND均0x0，不能把这个结果当成游戏不存在、失焦、最小化或实际前台状态。

仓库HostLaunchProbe固定只启动WslRestartAcceptance.exe的只读preflight，不是通用交互启动器；其Explorer路径也要求调用方GetShellWindow非零。当前仓库没有可信的session0→1 NativeEye/NativeInput transport，因此窗口、物理客户区、DPI、当前任务、键位及实际焦点尚未核实。未尝试新ScheduledTask/服务/身份权限调整，未修改旧Host限制；根据“遇阻塞停止”，本轮到此前置检查为止。

截图0、模型调用0、输入命令/事件0，未创建输入执行器/未持有按键；不报告物理释放ACK或任务完成。实测协调器单调时钟元数据探针往返586.049ms；capture/CV/视觉/决策/观察→输入/效果延迟均unknown，未混减Windows/WSL时钟。原件`out/acceptance/exiles-first-task-20261006/{context-probe.json,context-probe.stdout,context-probe.stderr,summary.json,sha256.json}`；记录`docs/acceptance/exiles-first-task.md`。只提交本地验收文档、不推送；后续需先有session1执行入口/可信交互桥，再从只读核验开始，仍只处理用户批准的第一个任务。

**2026-10-06 用户新决定：联盟战士，离线动作基准与现场准备完整回归通过。** 客户端仍在安装，本轮没有 Windows 桌面取证授权；数据继续现有本地包，不增加来源、OAuth、大包或许可判断。教程未定，必须同时保留“流放者离岛未完成”和“已进入巨龙时代苏醒海岸”两条路径，现场只读核验后再选。官方现行新玩家流程 Exile's Reach→更新 Dragonflight 至70→The War Within 70–80 已查；旧联盟港口入口和 69933 profile 仅参考，不直接当新机器流程/客户端证据。联盟任务候选只取本地明确无冲突联盟记录，部落/unknown/冲突仅保留参考，typed identity、giver、规范目标及当前适用仍不得推定。

本轮独立实施树`.worktrees/action-benchmark`，明确owner分别负责时钟/原生及旧运行时埋点、成对策略/模拟/严格回放、现场分步脚本、联盟战士数据准备；主checkout只集成验收。预注册及指标见`docs/action-benchmark.md`，现场入口/检查单`docs/action-benchmark-field.md`，任务准备`docs/warrior-dragon-isles-start.md`。single每一步视觉+brain，layered按代码/熟悉Jev/目标异常brain分流；相同有限候选/复采样/输入闸/效果确认。模型语义结果进入相同决策上下文，不能只调用后丢弃；critical CV条件保留。模拟固定seed/AB-BA，真实代码wall与显式注入virtual成本分列，零模型成本对照允许分层更慢。Windows QPC原始capture/CV/artifact/SendInput区间与WSL单调id分开；跨域只有带有效期的对时上下界，不直接相减。输入发出、完整输入、效果确认及释放分别计。

全量Python收集695项：692passed/3原有strict xfail/0skip/失败；原始完整TS498/498、0fail/skip/cancel/todo；typecheck/diff-check通过。旧TS437/Python660保留，新增TS61/Python32；当前C#原生模块、JevCapture、NpcClassify构建与离屏回归通过，未做桌面/物理输入验收。重hash负wall反例、量化对时、源视觉摘要及无回复worker/无release ACK独立审查关闭，所有原始证据在主`out/acceptance/action-benchmark/`。固定提交主CLI验收另补下方；通过后普通push仅codex/agent-system，再停下。当前尚未进行真实动作/速度或Windows桌面验收；后续必须先客户端装好及用户只读授权，冻结只读原件/当前身份/校准，再由用户单独授权有限输入和模型。现场首轮有限v1可逆背包动作对照不冒称联盟战士苏醒海岸自动任务；v2世界任务入口仍阻塞。

源码`f41b4a9`已ff-only合入主checkout，并完成实际CLI验收：default/all四重复48trial（8completed/32blocked/8cancelled/0failed），zero-model和double-model各8trial全completed，三份独立严格replay均exit0，所有paired工作量一致。正常每arm11个simulated confirmed动作：默认single5105ms/layered2584ms、capture→simulated input p50=341/42ms、p95均341ms、模拟调用visual/brain/Jev=11/11/0对2/2/2、虚拟有效动作/min=129.3/255.4；layered选择份额code63.6%/Jev18.2%/brain18.2%。模型成本0时single1805/layered1864ms，模型成本×2为8405/3304ms，不能写成恒定加速；实测wall与上述注入时间分开、初始未预热pair单列。所有真实model/input和game confirmed计数0，不构成正式服速度结论。

主目录实际联盟战士prepare生成30参考卡/4明确联盟候选，其余26卡排除，0current/giver；任务profile与报告SHA和工作树一致。现场WSL脚本prepare/help已实际exit0，输出`main-field-kit/field-plan.json`、`field-config.template.json`、`client-profile.template.json`，未知实例/版本保持null。原world-brain-demo四child及严格parent replay仍exit0。全部原始结果`out/acceptance/action-benchmark/main-acceptance.json`及`scorecard.json`；完整说明`docs/acceptance/action-benchmark.md`。本轮离线目标完成，验收记录提交后只普通push codex/agent-system，所有远端heads前后核对另留证据。bundle/原HANDOFF备份完整SHA未变。

下一步停止等待：客户端安装完成、用户明确Windows只读授权后再核实联盟战士实际角色/教程分支/客户端/布局/键位/任务源观察，不能重用旧HWND/PID、69933或参考目标。职业/阵营/本地来源已经用户决定，不重复询问；未完成流放者离岛与已进入苏醒海岸两分支继续保留。只读原件/校准审阅后再单独授权有限输入与模型对照；本轮没有进入现场、新增来源、OAuth/下载或许可判断。

**2026-10-06 用户第3步，阶段B离线实现及完整回归通过：既有执行大脑→有限世界任务编排已接入。** `ExecutionBrain.runWorldQuest`与旧run互斥，取消转发、世界模式换目标拒绝；仅named custom:synthetic，真实v2入口未开放。独立coordinator根据新观察选择接取/独立ordinal/交付，child继续使用原L4→L3→L2及hand:null；独立episode协议/哈希日志重新编译固定世界、逐child严格回放，独立释放证据、实际代码字节及同钟域父审批→子执行→源效果顺序均绑定。独立审查的错误driver冻结与父时间整体后移反例已修复。全量Python660passed/3原有strict xfail/0skip；最终完整TS437/437、0fail/skip/cancel/todo，typecheck/diff-check通过。第一轮430项429通过/1旧Jev取消回放失败原件保留；持久审计检查点修复后，7项新增确定性取消测试及原CLI回放均通过，不跳过/放宽。固定提交后的主checkout CLI集成验收另记下方，验收记录见`docs/acceptance/world-task-planning.md`，原始证据在`out/acceptance/world-task-planning/stage-2/`。

阶段B源提交`f072c0d`已ff-only合入主checkout，并在固定提交运行实际CLI：normal完成接取→ordinal0=2→ordinal1=1→交付四个child，parent严格回放complete=true；unknown和identity-change均blocked、0child，CLI预期exit1，独立parent回放exit0/complete=false。全部0真实输入、0模型、game_effect=unverified。共用初始化后的旧world-demo及四个独立layers回放仍exit0。完整结果`main-acceptance.json`/`main-legacy-world-acceptance.json`及原始日志保留在上述stage-2目录。A/B离线阶段已完成；后续C–F与历史正式服最终验收仍未完成。本阶段验收记录提交后仅普通push codex/agent-system，推送输出及所有远端head核对另留stage-2；bundle与原HANDOFF备份完整SHA未变。

下一项C必须先用户决定：当前客户端六维及实际角色/阵营/职业/等级、要选的未完成任务/区域与现有进度；是否授权本机Windows桌面只读客户端核验/采样及目标/对话/任务计数/键位校准；当前任务规范目标、starter/finisher与地点证据采用何种来源。任何OAuth/新大包/新许可判断，以及后续有限输入/释放/WSL整重启分别停下来确认。阶段B完成后不擅自进入C。

**2026-10-06 用户第3步，后续阶段A：固定世界提示→L4候选已完成离线实施与全量回归。** 按`docs/four-layer-agent-design.md`尚未接通的大脑→L4接口补全，不重做已完成四个数据库里程碑。独立树`.worktrees/world-task-planning`新增实际包查询的候选编译器，要求world/client/quest、typed starter/finisher/目标ordinal与技能及有限预算显式匹配；输出深冻结且`executable=false/automatic_action_eligible=false`。原world-demo改用编译器，保留任务/行为身份与既有严格回放；新增只读`world-task-cli candidates`。全量Python660passed/3原有strict xfail/0skip，TS397/397（新增15项）/0skip，typecheck/diff-check通过。现存M2包70124当前版本示例实际仍not_found/blocked/0候选，原件不改、许可local_only不变。本阶段固定提交后主checkout四任务demo/回放证据留`out/acceptance/world-task-planning/stage-1/`，详细验收`docs/acceptance/world-task-planning.md`。

阶段A源提交`b0cafb2`已ff-only合入主checkout，并实际运行新world-demo：接取→ordinal0=2→ordinal1=1→交付四任务全部完成、四个独立严格回放exit0，real_inputs=0、game_effect=unverified、scenario_effect=confirmed。完整结果`out/acceptance/world-task-planning/stage-1/main-acceptance.json`。仅普通推送codex/agent-system，推送原始输出另留该目录；没有桌面/游戏取证或新增来源。

剩余顺序：A可复用任务适配（已完成）→B既有ExecutionBrain的有限世界任务编排/独立严格episode回放（已完成离线集成验收）→C当前客户端/角色/任务的数据与原观察身份取证（必须先停下来请用户决定）→D v2只读/有限输入及取消释放现场验收→E真实学习消费/同条件收益对照→F导航/飞行/职业策略与新来源。当前只实施A/B离线部分，v2 live/observe继续拒绝。真实游戏/Windows桌面、OAuth、新大包或许可判断均不擅自执行；用户允许阶段完成后仅普通push codex/agent-system，不force、不推其它分支。

**2026-10-06 用户第2步：PNG CLI mock路径已修复，完整回归通过。** 独立工作树`.worktrees/png-cli-portability`将两个mock的shebang改为`#!/usr/bin/env node`，全部原用例/断言保留。构建当前源码的JevCapture、WinEye、NpcClassify并显式配置Python原生离线测试路径后，全量Python收集663项：660passed、3项原有strict xfail（gamma1.1容差反例）、0skip、0失败；原始全量TS为382/382、0skip/0cancel/0todo；typecheck和diff-check通过，均exit0。先全绿再提交并本地集成；用户明确授权本步普通`git push -u origin codex/agent-system`，仅该分支，不推其它game-db-*分支、不force。推送结果及远端SHA核对记录保留在`out/acceptance/png-cli-portability/`，测试原始日志/JUnit/命令/源码SHA在其`worktree/`。完整说明见`docs/acceptance/ts-suite-audit.md`第2步；本步不继续其它规划。

**2026-10-06 用户第1步：TS测试数量核查完成，仅做本步，后续等待指示。** 两个独立工作树保持快照源码不变，分别执行原始全量`npm test`：dcbf332为46文件/335项、333通过/2失败；核查开始时HEAD 7ccd361为52文件/382项、381通过/1失败；均0skip/0cancel/0todo，exit1。无测试删除、禁用或漏发现，旧335项全保留，新增47项。上次131仅为17文件定向回归（84旧+47新），未运行剩余35文件/251项，不能表示全量通过。旧版独有失败是已修正的/home/dai Python路径；两版共同失败是既存PNG CLI mock写死/usr/bin/node，本机该路径不存在，仍未修复。当前TS全量验收尚非全绿。详见`docs/acceptance/ts-suite-audit.md`；原始两版完整TAP、逐文件/逐用例比对、路径探针及SHA清单在`out/acceptance/ts-suite-audit/`。本步仅更正文档，不推送。

**2026-10-06 里程碑四完成离线闭环，四个里程碑已本地集成，完整TS验收状态以上述核查为准。** 实现提交a6f5cce已按ff-only合入主checkout，主目录185项Python和17文件/131项TS定向回归、typecheck通过，0skip；当时未运行完整TS套件。实际world-demo在固定提交执行接取→两独立目标→交付四任务，ordinal0=2/ordinal1=1，接受/交付/奖励scenario证据完整；game_effect=unverified，real_inputs=0。独立严格回放产生4条experience/4sources，重复来源去重；新知识版本实际召回4条，SQLite索引4候选+评估+注册，simulated_samples=4、actual_game_samples=0。136事件（原始108+28派生依赖）重复索引0新增，444个受保护SHA包含全冻结原件。

world A SHA `5d7576f2ef44b13f7dcaec01d61b85e72348c851d848824378320992ecd1e827` 切到B `90427fa1dea8d30bd0e1491ac4ef7ce79642a1bda86c45c175cbef0c468059aa` 后，旧4run仍按A回放；新B任务不召回A范围经验，持有的冻结snapshot不变；实际rollback到synthetic-world-learned后旧run再通过。知识SHA `9c2aac77dc4cc66a3a4d22e63b3d0815fb69b951bfa6d3fda85e6ae775bee2de`。默认world-demo及learner learn/版本inspect/rollback CLI已实测，本轮全程无模型、凭据读取、Windows/游戏输入或远端push。

主证据 `out/acceptance/game-database-v2/milestone-4/{main-demo,main-close,checks,close.mts}`，main-close/summary.json保存版本/知识/索引/保护集合；代码、世界、prompt、知识及原日志在每run保留。主M3真实包再测current69933 ID/中文/区域not_found、references保持不可采纳；ID/中文/区域新连接/复用连接p50/p95已记录，OS缓存未清除。真实M2仍24任务参考、规范目标23unsupported/1unknown、starter/finisher及当前正式服核实覆盖0；合成闭环不代替正式服接取/完成/交付或性能收益。v2 live/observe继续早于native调用拒绝，后续现场验证需要本机真实客户端/任务/目标/校准和释放证据。

新机器体验：安装项目锁定依赖后 `npm --prefix agent run layers -- world-demo`；按输出四个run目录逐个replay或learner learn。详细入口 `docs/game-database-v2.md`；完整验收 `docs/acceptance/game-database-v2.md`。主原未跟踪wow-jev.bundle及备份HANDOFF完整SHA再核未变；既有pixel-bridge工作树未动。本轮独立树/原件/失败及候选均保留供复核，不删除被旧run引用的证据。

**2026-10-06 里程碑四，步骤4a：执行/学习/固定版本实现通过模块验收。** `.worktrees/game-db-execution` 集成固定世界SHA的不可执行L4规划提示、显式目标断言/ordinal与每次L3/L2发送前身份/原帧时间校验、v2 RuntimeVersion世界/知识/客户端契约、逐run代码/prompt/世界/知识原件、严格三阶段layers回放及独立知识来源。原v1接口、RuntimeVersion/知识字节与旧Eye学习路径保留；带新schema标记但类型非法不能降级旧回放。

185项Python、131项TS定向集成回归通过（两项新拒绝路径/统计字段的旧断言修正后18项重验全通过），typecheck/diff-check通过、0skip。独立审查关闭quest归因错、代码/prompt只标签、event冒kill_credit、schema类型宽松、middle objective漂移/旧帧、live原生因果及索引依赖保护缺口。RuntimeIndex严格回放后才写APSW单writer；原seq+1，原始JSONL/SHA不重写，派生dependency事件保护代码/prompt/计划/世界原件及Eye附件；外层事务完整回滚，正/反例分开，模拟真实样本=0。知识发布为offlinedata评估，父代码/prompt固定，不绕过旧代码提案的真实问题要求。

实际M2包WorldTask默认及refs均blocked/currentnot_found/steps0；10项实际helper→Python→TS验证、8项版本/回退和10项严格学习验证通过。v2 live/observe在任何Windows构建/探针/输入前拒绝，旧v1入口保持；没有本机正式服动作或模型验收。默认 `npm --prefix agent run layers -- world-demo` 需固定已提交源码，接下来完成主checkout实际CLI四任务→回放→学习→agent.sqlite候选/评估/注册→新知识消费→换包旧run/回退闭环，再记录最终验收。不把模块通过当整体M4完成。

**2026-10-06 里程碑三完成：角色条件与只读规划查询。** 独立模块集成三值AND/OR/NOT、精确世界/客户端的账号与角色进度、历史交付/目标完成区分、解锁/跳过、中文双字检索、RTree候选复核、楼层/位面/变换、路线及合成成就/副本样例。165项Python通过、0skip；新增59项规划/实际CLI测试。独立复核发现并关闭跨世界/客户端provider污染、未知候选掩盖已知冲突、独立路线/难度/楼层/位面误冲突，保留原来源而按关系身份和空间适用范围判断。

入口 `python -m game_database.v2.query_cli --pack DIR --sha256 SHA --version game-data/profiles/retail-cn-12.1.0.69933.json --references search --text 练手 --namespace retail`；条件、区域/近点/路线及runtime只读进度入口见 `docs/game-database-v2.md`。真实M2包练手返回两个ID歧义，参考IDs不采纳、可接truth unknown；当前69933三类查询not_found。原包/schema和v1SHA未改。ID/中文/区域新建及复用连接p50/p95已测，OS缓存未清除，不宣称物理冷缓存或广域性能。合成副本数据不冒称真实机制。

下一步里程碑四：`.worktrees/game-db-execution` 负责版本/任务闭环，独立world-task与learning树负责不可执行世界规划提示和严格layers证据来源；v2 RuntimeVersion固定world+knowledge，旧v1保留原格式。全部仍为离线模拟/只读，本轮未操作游戏、读取凭据或push。

**2026-10-06 里程碑二完成：固定ATT/TDB苏醒海岸参考种子。** `.worktrees/game-db-foundation` 集成静态Lua/SQL适配、固定源锁、24任务选择、四主区UI地图层次、小原始字节摘取链、逐任务覆盖/冲突/缺失及增量语义；不执行来源Lua/SQL。固定实际原件首尾完整SHA验证，97POI/181点等保留来源build，mixed row build不以首行代表全数组。独立审查的symlink越界缓存、非原子缓存和raw覆盖冒充规范目标支持均关闭并有反例。

106项Python数据库/来源回归通过，14TS及typecheck已在步骤2a通过；实际CLI生成129实体/779断言，全reference_only/local_only，证据1944426字节。最终包SHA `5f762a251e9fb301ee3c8e50d9bbbc31fefc8bf2a67b686a60ef8360bb1c2774`，实际TS桥读练手材料/数量及uint64字符串正确，当前69933 exact not_found。24名称/作者provider/UI点，faction已知8/未知16；23任务raw目标/逐项count、1缺失；规范动作目标23unsupported/1unknown，starter/finisher和当前客户端已核实均0。计数不累加隐藏/可选项，Type0不推kill。

入口 `python -m game_database.v2.source_cli --source-root .worktrees/backups/source-audit --output-root out/runtime/world/retail/dragon-isles/source-v2 --report-dir out/acceptance/game-database-v2/milestone-2`（使用项目venv）。跟Git仅源码、固定源锁/选择与合成测试，原件和包留本地out/backup。旧候选包39d6…及原失败保留，引用旧包不被新包删除。M3独立模块48测试已冻结，下一步集成三值条件、角色进度、中文短词、楼层/位面/路线及代表性合成成就/副本查询；不声称当前游戏可接或可通行。

**2026-10-06 里程碑二，步骤2a完成：参考文本的语言隔离。** 双语ATT/TDB源准备发现按ID references会把同一实体中英文name误判为同字段冲突。已按source locale筛选name/alias/description，未知locale保留原候选但不采纳为请求语言，数值字段参考与六维精确query不变；Python与TS字段采纳校验同步。84Python/14TS及typecheck通过，无skip；尚未发布M2实源种子。

source适配器在 `.worktrees/game-db-seeds` 实施，固定原件每次正式导入重新核完整父SHA，SQL原tuple摘取逐byte-range比对，不执行Lua/SQL。并行独立 `.worktrees/game-db-queries` 准备M3三值条件、角色/账号、中文短词与空间候选，集成验收仍按二→三顺序。源provider不推为已核starter/finisher，uint64位掩码保留十进制字符串；TDBcredit不推为杀怪，unsupported不冒称作者withdrawn或游戏不存在。

**2026-10-06 里程碑一完成：运行库、批量桥与基础库联合验收。** 在独立工作树集成APSW单写WAL运行库、run/event缺口索引、严格原观察绑定的角色/账号进度、经验候选/评估/不可变注册、Backup API备份恢复及runtime CLI；新增schema-v2和固定世界SHA的TS批量只读桥。83项Python、13项TS（含旧v1回归）全部通过无skip，typecheck通过；真实WAL未checkpoint备份、第二writer拒绝、SIGKILL后恢复和CLI恢复均验证。经验注册仍需里程碑四接通layers/既有知识快照，不宣称执行学习闭环已完成。

独立桥审查复现“字段/断言同时改写而沿用旧SHA”和“conflict总状态冒充found”已修正；精确canonical字节SHA、source绑定、规则版本和总状态均核验，覆盖Python1.0/Unicode及有效重复键反例，不以JS重序列化字节冒充Python原SHA。主checkout已验收世界包46Python；本步骤按ff-only集成后复核83Python/13TS。体验与证据见 `docs/game-database-v2.md`、`docs/acceptance/game-database-v2.md`。

接下来里程碑二：ATT固定提交及TDB1210.26091已只读准备；TDB实际156449334字节与完整发布SHA核验一致。24任务有24模板/zhCN名、23任务54目标、24任务97POI，但starter/ender、苏醒海岸spawn与当前国服已核实覆盖均0；目标Type0不能推为击杀。未执行来源Lua/SQL；原件在 `.worktrees/backups/source-audit/`，默认local_only，不分发/推送。生产适配器尚未实施；继续保持缺字段unknown、移除时间线/阵营/前置语义和字段覆盖报告，不根据总行数判完成。

**2026-10-06 里程碑一，步骤1a完成：v2世界包与v1兼容迁移。** `.worktrees/game-db-foundation` 新增受控中间格式/关系schema、字段级冲突解析、固定manifest SHA的只读批量Python查询、原子staging发布、来源原件校验及v1映射。独立审查发现的本地证明SHA未绑定、孤立资产分发标记、迁移来源/条件及保留谓词语义问题均修正并有反例；旧库19+世界包27=46项Python通过，无skip。运行库/TS批量桥尚在独立树实施，里程碑一整体尚未验收。

实际重新导入11条seed并迁移，得到9实体/27字段，全部reference_only；当前69933 query仍not_found，references保留来源冲突。没有注册旧机器安装profile为新机器证据。体验入口见 `docs/game-database-v2.md`；验收见 `docs/acceptance/game-database-v2.md`。步骤0已在主checkout fast-forward集成并再次通过19Python/2TS/typecheck；本步骤将按同样流程集成验收。不读取凭据、调用模型、发送游戏输入或push。

**2026-10-06 新机器接续：准备完成，里程碑一实施中。** 主 checkout `/home/dw/Projects/wow-jev` 已 fetch 并安全切到 `codex/agent-system`（远端起点47423e8）；旧的未跟踪 HANDOFF.md 与目标分支冲突，已完整移到 `.worktrees/backups/pre-agent-system-20261005/HANDOFF.md`，SHA `6f35f53b9a9a8aea7de885390e16d160386735aed57fb87c6823c6db23c117d7`。未跟踪 `wow-jev.bundle` 保留原位，SHA `7a6ebc4daef3a421d357ff2ab41a659e605e5954c7c20cb5d2e65256ff6c1931`；既有 pixel-bridge 工作树未修改。

已读 AGENTS、本交接、数据库交接及要求的 game-database/four-layer-agent-design/agent-roadmap。实施工作树 `.worktrees/game-db-foundation`（共同schema/世界包/迁移/桥）、`.worktrees/game-db-runtime`（运行库）分别有单一负责人；来源和学习链路只读核查已完成。依赖按 lock 安装；本机旧库19项Python、2项TS整链及typecheck通过。沙箱网络/tsx IPC拒绝经同一命令正常权限审查后运行，保留首次环境失败，不作为程序失败或测试通过。未读取凭据、调用模型、操作游戏或推送。

本机CPython3.14.4，标准库SQLite3.46.1未包含WAL-reset修补；新增 `database` 依赖组固定 APSW3.53.4.0，实测其SQLite3.53.4。v1保持标准库接口，新的可写运行库使用已修补运行时并自检，不默默在旧SQLite启用WAL。当前只完成恢复与基线，里程碑一尚未验收；按交接四个里程碑逐步实施，每个完成步骤更新本文件并提交。验收入口与证据将记在 `docs/acceptance/game-database-v2.md`。

**2026-10-05 数据库设计交接（最新）**：用户已要求将讨论后的设计保存并推送远端，交由其它机器继续研发。先读 `docs/handoff-game-database.md`，在 `codex/agent-system` 接续；优先实施v2规范schema、不可变世界包、运行/经验索引及v1兼容迁移，再以ATT固定提交和TDB12.1抽样构建巨龙群岛种子库。设计已落盘不等于新数据库已实现：目前只有11条reference_only，尚未下载TDB/批量导入或接通layers→learner/world pack版本。完整跨机器命令、依赖、许可、数据边界及四个里程碑在该文档。

本轮推送范围为当前分支源码与文档；`out/`运行数据库、截图/原始日志、EXE、依赖和凭据不随Git传输，新机器按交接命令重建或单独核SHA迁移证据。该文档是后续数据库阶段的设计入口，以下四层与旧正式服记录作为已完成/未验收历史保留。

**2026-10-05 四层实施（当前轮）**：用户已确认L1基础输入、L2人物动作、L3高级行为、L4任务，并明确要求记录设计和实施代码；此前“不要新增架构规划文件”的临时限制已被本次授权替代。设计在 `docs/four-layer-agent-design.md`。负责人工作树 `.worktrees/four-layer-foundation`；独立实施工作树 actions-v2、behaviors-tasks、regional-eye，由负责人审查后本地集成，不推送。

本轮已在负责人分支完成L1/L2、区域CV/OCR框架、九个L3行为、三类L4任务及四层demo/live/replay/cancel入口的审查集成。最终335项TS全通过、无skip，typecheck和四个Windows原生程序构建通过；2有效/9无效时间线原生参数校验、6项真实Windows日志文件条件、6组无损codec/配额、真实离屏区域Bitmap与PNG、真实PNG→JPEG裁切映射及6项拒绝反例分别通过。模拟六行为小闭环完成，实际输入0、chooser0、scenario_effect=confirmed、game_effect=unverified；模拟回放通过。旧Node timer早醒导致wait回放失败已复现并修复，不放宽回放条件；原失败保留。

体验：`npm --prefix agent run layers -- demo`，其输出给运行目录；`npm --prefix agent run layers -- replay --run-dir /绝对路径`。真实开发入口需匹配客户端/profile/区域校准和角色场景，未知定位/运动模式/技能状态会阻塞；详见 `docs/layers-runtime.md`、`docs/acceptance/four-layer-runtime.md`。本轮未检测到可用WoW窗口，未进行新时间线的物理输入/释放、正式服布局、真实OCR权重效果、区域Seed token成本、导航/飞行与自主升级验收。战斗日志仍只回填历史；四层任务到既有执行大脑及学习迭代入口的直接接入也待后续。没有读取凭据、调用云API、推送或重启WSL。

最终主目录已fast-forward合入至3ddb3a8，主目录四原生重建、typecheck、六行为demo/replay及原生时间线参数校验通过。238个必要ignored产物逐SHA验证归档至out/acceptance/four-layer-runtime/worktree-archive-1；检查工作树clean及无活动测试进程后，本轮四工作树正常git worktree remove，分支保留，其它历史工作树未清理。后续直接使用主checkout及上述体验命令。

**最新用户目标与小闭环**：用户明确以已知攻略扫任务、自主打怪/拾取快速升级；先体验 NPC 互动小闭环。已通过 Battle.net 正常入口启动12.1.0.69933并进入角色，辅助选中/靠近森德拉克斯并取得真实对话图。`out/acceptance/npc-loop-1/automatic-local-1` 是0模型调用的实际程序运行：6949ms、名字/关闭对话证据unknown、等待后停止、0输入/0效果/释放confirmed，严格回放通过，未证明自动互动。相同捕获/冻结校准对照确认原Bitmap字形555与对应JPEG90字形456，在线unknown、JPEG离线known；不能把JPEG模板自匹配当直播准确率。v2对话头像ROI改进已冻结但名字仍为JPEG，下一轮必须取真实NPC无损源图。用户随后手动打怪；此时停止输入，补录30秒只读27观察/26图/0动作，独立复核取得1个新的4K死亡目标选择事件（非新击杀），全部相邻帧只计1事件。target.dead仅真值已知20图评分：known正确15/错误0/CVunknown5，另6图视觉unknown不计准确率；旧错误汇总与纠正summary-v2均保留。

无损WinEye存档和旧JPEG启动兼容补丁已负责人审查，以34ff5e8/6d4fd96合入；agent完整266项TS、typecheck及6组Windows实际codec/配额通过，主目录四原生模块重建和typecheck通过。主目录尝试真实PNG observe时未检测到可用WoW窗口，保留原失败，未截游戏/未发送输入；同帧游戏PNG实测及NPC自动G仍待现场。300个必要实施产物/SHA归档到out/acceptance/npc-loop-1/lossless-integration-1，确认无活动进程/工作树clean后正常remove，分支保留；没有push。用户最新要讨论整系统架构/运行流程，正在对话中解释；不要新增架构规划文件。已异步请求用户方便时回NPC旁准备约30秒，不依赖无回复继续输入。详见docs/acceptance/npc-loop.md、lossless-eye.md。

**当前交付（18:40后）**：本轮增补已由负责人以bbd76b9本地合入codex/agent-system，f4a4937的版本probe修复也已接入；最终docs补充d16cef8。主目录四个Windows原生模块重建、typecheck和main-demo-1纯模拟/严格回放通过；集成260项TS全量通过，109项Python/真实Windows感知与数据库、27项录制/长跑回归、34组Windows重启机制模拟及Host helper13项边界分别通过。冻结启动独立审查关闭已发现P1，真实259源码只读两轮各21条/2观察/0输入，首编译→缓存复用、四exe同SHA；最终f4窗口补测因旧HWND/PID消失拒绝，不能冒充通过。没有推送，没有执行实际WSL重启。

多版本SQLite实际在out/runtime/game-data.sqlite（11条reference_only/1安装profile）。十分钟只读录制7段492ok/491不同图/0输入完整结束；快速轮换复测将唯一缺口缩到1520ms；Seed实际只读规划也通过。全部原始证据主out/acceptance/retail-closure，独立审查out/acceptance/runtime-closure，当前状态和体验见docs/acceptance/retail-closure.md、docs/system-runtime.md、docs/game-database.md。

**仍未完成五项最终正式服验收**：独立4K战斗/死亡正例、Jev非wait主动动作、当前NPC现场校准/对话闭环与可靠距离、两对同条件真实学习收益、整Ubuntu重启/物理释放/新会话恢复。长跑部分已过。当前已检测不到可用WoW HWND/PID，前台准备问题未回复；此前G已持久为INTERACTTARGET，原E/S/D/F不改。computer-use仍有WSL sandboxCwd错误，先前实际用战网正常启动入口进入过角色，没有插件点击或认证操作。外部Host只读breakaway/Explorer/Documents均job=true，不能直接run；Ubuntu有acehr共享进程，真实重启还需具体授权/外部启动条件。

本轮五个实施工作树已在检查无活动进程/保存代码后正常git worktree remove，分支保留，146个必要ignored产物及SHA归档到out/acceptance/retail-closure/worktree-archive-1。未清理其它历史工作树。以下为本轮过程记录，旧的“运行中/未合入”描述不覆盖上述当前交付。

用户进一步授权继续完成五项：4K可靠识别、正式服动作闭环、NPC任务感知、真实学习迭代效果、长期/WSL重启恢复；允许必要时用computer-use打开WoW测试，并新增多版本本地游戏/怪物数据库要求。当前在四个项目内工作树并行：retail-identity-v2、versioned-game-data、retail-npc-perception、负责人retail-runtime-closure；主目录暂未合入这些代码，不推送。本轮尚未完成全部五项，不能标整体验收通过。

已实现并分别提交：848f978稳定名字bank/局部陌生字保护（51项Python+真实Windows测试），8e1b5ef NPC对话/显式目标绑定交互指示（42项），efc6c7f多版本SQLite/TS查询桥（19项Python+2项整链），2386eab真实同条件效果对照（9项边界，模拟/重复/错版本/unknown不算收益），soak driver8c4d8bd及真实日志检查f58bf67/Windows元数据4b5f51d修复。负责人工作树已cherry-pick这些工程与JeV冻结prompt修复d715d64；ab37147提交可选target_name/NPC协议、模板冻结回放、system/live.ts及显式一次interact_npc探测，09b28e0忽略工作树依赖链接。集成236项TS/typecheck和109项Python/真实Windows回归无跳过，原误填不存在测试路径的失败保留，修正后42项审查回归通过。真实只读brain-observe-2版本核对→新bank→大脑→严格回放通过（21条/2图/0输入）；这不是NPC动作验收。独立Eye/NPC审查在codex/eye-npc-review、真实批准源码启动接入在codex/frozen-live-runtime，均尚未合入负责人分支。

当前客户端证据：正式服_retail_/Wow.exe，file/build/UI版本12.1.0.69933，product=wow，配置portal CN/textLocale zhCN，数据库规范locale zh_CN、branch retail/expansion midnight；旁边_classic_titan_为另一产品3.80.2.69874，不能混用。来源原字节/SHAs在out/acceptance/retail-closure/client-version-1.json（94951e43…ca6d）及新game-data/provenance。11条公开网站任务/怪物断言因build未知隔离reference_only；不同ID/历史任务数量保留，精确69933 query正确not_found，不把网页资料冒充当前游戏事实。

computer-use技能已读并尝试初始化/重试/重置，均因sandboxCwd is not a local file URI: file:///home/dai/Projects/wow-jev失败，没有用插件操作桌面。直接Wow.exe启动曾停初始提示；用户指正应从战网“进入游戏”，负责人实际用已登录Battle.net.exe --exec=launch WoW启动新正式服并按一次Enter进入既有Dwroy11，不处理认证/充值。当前真实游戏 HWND0x340894/PID18128/3840×2160；旧0x12c0892/PID25160不能复用。角色在营地安全平地、满血、骑坐骑，任务状态已变化，不能继续把原三任务当当前唯一目标。原生输入保持focus/identity/有限释放；菜单首次焦点探测超时未输入，game-menu-2重试成功，GUI已把“与目标互动”设为G（延迟重绘才显示，后续F7没有替换G），E/S/D/F原移动不改；缓存文件尚未显示此新键、功能交互未验证，不能当NPC验收。设置证据及bindings-evidence在out/acceptance/retail-closure，最后只读截图已无设置面板，游戏目前非前台，不抢焦点。异步人工进入角色问题已由战网启动解决；新前台准备问题仅用于接下来有限NPC输入。

十分钟只读长跑soak-10m-1已封存accepted=true：7段逐段严格回放、492次capture ok、491张不同SHA图、0输入、前后同一PID/启动ticks/版本；所有样本focused=false。负责人复核每段首尾仍在营地角色场景，后台画面在本场景可变化，不推广最小化/所有遮挡模式。六个轮换缺口5.053–5.627秒；定位到5秒退出轮询后b0a54e1改250ms并通过27项录制回归，随后真实185秒soak-rotation-fast-1两段159ok样本/158图/0输入、唯一缺口1520ms。不能称无缝或严格1fps。

新的brain-seed-observe-2实际客户区截图→冻结prompt→Seed→重新采样→严格Brain回放完成：21条/2图/1个有效模型回复（1808.847ms，2280input/79output tokens）/0输入，知识为空、game_effect=unverified；只证明只读规划链路。主out/runtime/game-data.sqlite已实际建立：11条reference_only断言、1次导入、1份安装profile；精确69933任务query not_found，初始化报告在retail-closure/game-database-initialization-1.json。

负责人审查后集成Eye/NPC追加436263b（root1968677）和learning模板预检查138d80c，249项TS/typecheck通过。WSL外部重启工具58030bd/3a07ad5与安全审查修复eaeb516/7130cbc已在负责人分支（最近5cecb7e）集成，实际34组Windows机制模拟通过，0fixture输入/0重启；所有模块尚未合入主目录。独立审查已去掉凭历史mask释放全局W的P1，并补fresh raw receipt/session绑定、原lease期限前真实UP、export最终失败口径。外部Host默认interop IsProcessInJob=true；真实breakaway创建虽成功仍在job，不能当脱离。agent继续一次只读Explorer broker探测。Ubuntu还发现acehr外项目node_repl.exe PID425015，真实terminate仍需要具体共享进程授权，不自动执行。

18:13以后最新只读截图已回到角色选择界面、Dwroy11仍被选中；原因未确认，不能继续沿用之前role-scene-confirmed条件。独立互动G已在bindings-cache.wtf实际持久为INTERACTTARGET（sha8dc57d…c6a7），E/S/D/F保持原移动；功能交互仍未验收。新游戏前台准备问题仍未收到回答。冻结live接入与独立审查在frozen-live-runtime进行，原生缓存初次执行前字节校验、--repo-root替换依赖loader两个实际P1正在修；不发布带已知问题版本，尚未正式frozen observe验收。阶段记录工作树docs/acceptance/retail-closure.md。

接下来：把全部接入变化保存并完成负责人审查/无跳过回归；当前bank同名35–37/43稳定、39/40另一类，但仍缺独立名字/死亡正例；补当前NPC名字/对话校准与显式有限交互、新独立战斗实测、两对同条件真实版本效果+知识消费/迭代/回退、10分钟实际录制。Windows外部WSL重启host工具由retail_npc_perception继续准备，尚未执行；只有Ubuntu一个发行版且并行agent/其它项目可能活跃，真实terminate前需完成本项目保存/停进程/影响预检，再决定是否需用户针对共享进程的明确授权。杀Node不能当整发行版重启。源码/原失败/必要Windows产物清理前必须归档。

用户先明确“先做后面，继续5–7”，随后准备好游戏恢复第4阶段实测。第5–7工程已接通并以8e71665本地合入：执行大脑/工作记忆/有限阶段规划/控制权交接，严格真实日志学习与内容hash知识库，证据提案→独立工作树→固定回归→签名发布→冻结源码启动→任务边界切换/回退。入口docs/system-runtime.md，分项证据docs/acceptance/stages-5-7.md及主out/acceptance/stages-5-7。当前system CLI只提供模拟/离线，不操作游戏；真实NPC名字、距离和对话感知尚未接上，不称正式服任务已验收。主目录219项TS/68项Python/typecheck及模拟/冻结v3启动已通过，本轮7个实施/候选工作树正常清理，必要证据和未发布候选快照保留；没有清理其它历史工作树。

四个独立真实/模拟来源学习出25facts（19 observed/6 inferred，19经验/4背包事实/2报告UI名字统计）、14slices/13reviews；重复retail-3去重。knowledge/baseline-v1中的canonical JSON SHA为5134f31f6ac964d4ca50ecfa5f7968075b7f00f43753acf4e76c8d2b4a6910b8。完整4K运动效果unknown保留；实际Brain咨询两条move_for经验后升级处理，0输入。UI名字仅为Seed报告，不生成GUID/击杀/等级/掉落率。Brain/CodePlay/Jev严格嵌套回放和Brain来源学习也已实现。

真实Seed规划协议probe基线3/3有效；v2曾凭空输出request_id，worker拒绝、实际rollback baseline。v3补强复制规则，三次重新对照全部有效（约1.86–2.61s，均wait，两条fact IDs正确）；未证明动作收益或总体质量改善。v2(5ccd113)和失败记录保留，v3(5f5bc81)经隔离回归/模型probe后发布为movement-evidence-runtime-v3，知识/prompt/完整源码均冻结。task-boundary-1实际运行基线任务期间切换版本，旧任务保持baseline，新任务用v3，实际rollback后恢复v3。SDK首次误拒Python缓存已修，原失败完整保留；模拟modelnull误识别、知识scope匹配问题也保留原始失败。

用户在战斗素材对照后决定继续使用Seed。在线视觉方案沿用Seed+CV，本地Qwen不接入在线状态，优化暂缓；xdwin2既有服务或隧道未停止。代码play与纯模拟仍不调用模型；新Jev入口仅在显式Seed+上传开关时启用选择worker。

第4阶段工程已实现并集成候选/选择/重新采样/CodePlay/严格多计划回放与可取消wait；三个模块在stage-4-cv/choice/runtime工作树并行，负责人stage-4-jev统筹。五次纯模拟4动作+1等待通过，真实Seed离线probe3/3选择符合预期、耗时1349–1737ms；该probe观察/候选人为构造、零输入，不能当在线CV或正式服动作验收。入口docs/jev-runtime.md，分项验收docs/acceptance/stage-4.md，原始证据主out/acceptance/stage-4。

工程分项155项TS、75项Python/真实Windows离线测试（无跳过）、typecheck和四模块构建通过；负责人以129bf78本地合并至codex/agent-system，主目录已重建并完成main-demo-1与独立回放，manifest Git dirty=false。旧retail-3的CodePlay与Eye两条严格回放仍通过（514条/50观察/25动作/10confirmed）。8份本轮实施/校准二进制与哈希、原始失败、全量日志保留在out/acceptance/stage-4/integration-1；本轮四个工作树已正常移除，分支保留。本轮没有发送任何游戏输入。

当前战斗CV使用旧2048×1536语料46图，两名Agent盲标且不是用户确认人类金标准。训练combat-01/02为20图，独立留出26图；目标存在42/46 known正确（留出22/26），战斗46/46。死亡v1的两个误判保留，v2紧阈值留出召回2/10；v3仅训练组选黄色死亡字形+独立绿血条证据，规则/代码/原生程序先冻结后评估，留出7/10已知标签正确召回、未输出错误known且16个unknown保持unknown。仍未满足95%完整门槛，不能自动打怪。

上轮capture-4k-1未检测到窗口的原记录保留。本轮capture-4k-2已完成60秒只读补录，51张3840×2160图、51次capture ok/51个不同图像hash，独立Eye回放260条/51观察/0动作通过。源图包含玩家鬼魂→复活、坐骑收藏/行走、一段战斗；两个Agent独立逐图三字段标签153/153一致（非用户确认人类金标准）。选中活目标5张、死目标仅第43张、无目标45张；玩家战斗35–41。35–43整个连续战斗保留一个事件组，不能拆相邻帧充当独立留出，仍缺独立死亡/战斗正例事件。

真实只读retail-observe-4k-1已接通游戏截图→Seed候选ID→重新采样→有限等待→严格回放：三次真实模型回复有效（2518/2410/1608ms，均wait），9张源图、85条日志、0真实/模拟输入、0效果确认。observe只允许wait，不能据此宣称识别准确率或主动动作选择通过。此次51张录制全为前台样本；源码截图不以焦点为前提，但后台渲染是否更新尚未实测。最小化不支持；黑帧/截图失败不可用，静态非黑后台停更检测未验收。输入仍要求前台且失焦停止，禁止抢焦点。

当前4K候选战斗校准cv-4k-2已完成一次冻结后的真实Windows离线分类：存在43/51 known正确、8unknown；战斗51/51正确；死亡6个有效目标标签4known正确、2unknown，45无目标均保持unknown。死亡唯一正例是自身模板训练重代入。30张独立负例留出存在26正确/4unknown、战斗30false正确、死亡30unknown；没有独立战斗/目标死亡正例留出。名字mask四次known得到四个不同SHA，连续同名外观签名稳定性未通过；这是离线JPEG结果，在线原图稳定性未验收，不能绕过身份复核发输入。阈值沿用旧v3、未按留出修改/复跑，源图/标签/配置/二进制SHA均冻结。仍需稳定身份依据和新独立正例再做有限真实Jev动作；旧2048模板在4K返回unknown且不降级为Seed执行条件。本轮只读测试已经结束，已告知用户可以正常操作，不要求继续保持键鼠空闲。

第0–3阶段已按各阶段有限范围验收。第3阶段CodePlay/统一gate/有限技能/CLI/跨终端cancel/严格计划回放已实现：106项TS测试+typecheck、25步模拟回放、真实专用窗口五轮25动作、已满足零输入、跨终端取消与失焦实际停止/物理释放/回放。正式服最终retail-3在3840×2160完成五轮25动作、127/127事件且全released，10次背包变化confirmed、15次运动效果保持unknown，关闭释放与独立严格回放均通过；保存50张前后源图。接口见docs/play-runtime.md，证据及真实失败修复见docs/acceptance/stage-3.md与主out/acceptance/stage-3。

正式服retail-1（2048×1536）最后背包仍开，用户确认有人工操作且冒险指南遮挡；retail-2标题头ROI在转向后背景变化导致unknown，第四轮open在输入前拒绝。两次原始failed记录保留。新retail-bag-4k-buttons-v2使用底部固定小背包按钮并集ROI(3455,2005,300,50)，保持max_distance=0.12/min_margin=0.04；负责人Windows原生离线复核retail-2全部36张独立视觉标注图正确，再做retail-3真实补测通过。此校准只限当前4K布局与B同时开闭全部背包，独立单包/悬停/其它布局未外推。

用户随后要求接取面前三个游戏任务，负责人逐次截图/有限点击，已接“原始龙害”“探险者遇险”“练手材料”，均有游戏聊天与追踪确认，用户也确认完成。证据quest-assist-1；这是负责人辅助操作，不是自动任务大脑验收。用户明确后续继续项目研发和验收，游戏任务的打怪/救援尚不属于本轮自动完成内容。

原始native-1在输入前拒新fixture候选已修；native-2失焦原生failed与后续断连cancel造成计划/步骤终态冲突已修，focus-retest-1通过且不改写关闭ACK缺失(unconfirmed)。原失败保留。90秒录制轮换、整WSL重启、真实游戏移动效果和自动弹窗检测仍不外推。

第4阶段已补战斗CV实现与来源失效，当前布局的独立正例覆盖仍需上述实测。任务对话补录按用户“稍后补任务”安排；第5–7工程已按最新决定完成，后续为Jev有限输入验收、NPC可靠感知及三层系统的正式服效果与经验应用验证。

## 当前增补：xdwin2 视觉服务

服务已在 `iem@172.26.203.214`（DESKTOP-PHTQGNQ，3090）部署并通过负责人真实GPU/图像/有限MP4/本机隧道和生命周期验收。用户要求使用Windows SSH：`/mnt/c/Windows/System32/OpenSSH/ssh.exe`。Windows既有身份可用，不能把WSL key被拒外推为整个登录授权缺失。

远程目录 `/home/iem/Services/wow-vision`；Qwen3.5-9B Q4_K_M与配套F16 mmproj固定Unsloth revision、官方HF LFS SHA，复用既有llama.cpp c8cda8b、CUDA架构86。两份文件全SHA已核验，没有升级驱动/硬件；初期CDN大响应超时，分段并行续传后完成，失败记录保留。

Gateway/backend仅绑定回环18790/18791，默认关闭思考、ctx8192、单生成slot、最多256输出token；MP4最多4帧/12秒，属于有序抽帧理解，不是原生视频流。通过本机Windows SSH隧道18792访问；当前隧道Windows PID8984，精确命令在out证据。远程当前supervisor/backend/gateway=144210/144212/144213。SSH断开存活、正常stop、校验期间取消启动与恢复ready已实测；没有开机自起、强杀监督进程或整个WSL重启恢复验证。

本机凭据在 `out/runtime/vision-service/client-token`，父目录700/文件600。凭据不进git、acceptance、manifest或日志。原始证据在 `out/acceptance/vision-service`；固定3图人工标签和3秒闭开闭合成视频不是准确率基准。

完整7字段图像识别约2.4–2.9秒，修正目标框位置假设后目标原文读对，但2/3结果unknown置信度0.5导致严格schema拒绝。精简5字段profile三图15个标注值均正确，单图1.60–1.91秒，视频1.90秒；这是任务减少的性能对照，不是引擎对照，仍不能作为长期可靠性或1fps承诺。WoW主程序默认继续Seed+CV；本地服务尚未接入在线状态。后续接入须解决格式与时效，并扩大游戏样例；ROI/OCR和短输出先优化，再按相同任务比较引擎。

使用见 `docs/xdwin2-vision-service.md`；验收见 `docs/acceptance/vision-service.md`、`tools/vision_service_probe.py --compact`。本地/远端同13项HTTP边界测试与本地46项视觉/客户端回归通过。实施分支codex/xdwin2-vision-service（0df5a2c、6ec8fd2）及负责人集成均已留存，必要忽略产物归档后清理本轮工作树。

Seed与本地Qwen已按相同3张图/五字段题面各重复3轮，串行交替先后，每家9次响应均有效，45个标注值均正确；中位端到端延迟Seed1.382秒、Qwen1.802秒，Seed本轮低23.3%。源图相同但预处理不同，本地缩到1280×960；只有3张独立截图，不能推为总体准确率或复杂场景能力。证据在 `out/acceptance/vision-service/seed-qwen-comparison-1`，可复用 `tools/vision_compare.py`。完整7字段与在线接入限制仍保留。

用户要求先验证动态识别效果再考虑优化Qwen。实际只读录制191图：第一段128张配额退出，负责人恢复延迟造成缺口；第二段63张因window_unavailable退出，两个源片段合计约204秒，不能称完整十分钟。现封存complete=false；90秒轮换录制工具已补齐有限停止和封存反例，但未重录真实十分钟。用户最新选择“先完成战斗对照，稍后补任务”。

从这批素材盲选46图/10事件组，两名Agent逐图看源图标注，负责人复核关键状态和错误（不是用户确认的人类金标准）。两家同prompt各95次单帧识别，基础五字段Qwen187/216=86.6%、Seed212/216=98.1%；目标存在39/46对45/46、无目标误报6对0、死亡8/21对20/21。双方JSON95/95有效；玩家战斗标记双方大量unknown，不能用于可靠执行条件。当前本地Qwen未通过效果门槛；没优化模型或预处理。任务仅负例、数值血量未显示、多帧视频未测。证据out/acceptance/vision-evaluation，详见docs/acceptance/vision-battle-evaluation.md；复用tools/vision_record.py、vision_corpus.py、vision_evaluate.py。需要先补真实任务对话；若继续本地路线，分辨率/固定UI裁切与模型能力的差异需另测，暂不转入速度优化。

## 已完成

- 第0阶段工程基线、第1阶段真实键鼠执行已完成并合并。Windows独立释放看门狗与焦点检查已实测，原始记录在 `out/acceptance/stage-1`。
- 第2阶段眼与状态日志已通过负责人真实整链验收和最终回归（TypeScript54/Python42），完成本地集成。Windows截图/CV、显式UNC图片导出、Python异步Seed、TypeScript状态融合、录制与回放已接通。
- 正式服 `game-run1` 六次B开关全部获得完整输入计数、released与效果confirmed；每轮离线回放通过，背包恢复起始关闭。10秒观察含72个原生样本、4个真实Seed结果，删动作关联/伪造观察均被拒绝。
- Seed第三次结果漏看实际存在的目标栏，原始错误保留。模型字段仅为带来源的模型观察，目标/战斗读数尚未独立稳定核验，当前不用于执行闸。背包效果确认使用校准CV。

## 环境与体验

主checkout为 `/home/dai/Projects/wow-jev`，分支 `codex/agent-system`；第3阶段在独立工作树实施、负责人验收后，以7074f90本地合入。主checkout四个Windows模块已重建，typecheck及一轮5步纯模拟/独立回放通过；必要测试二进制、106项回归日志和全部实际证据保存在out/acceptance/stage-3，本轮四个工作树已正常清理，分支与失败记录保留。用户已授权负责人组织并行agent、研发测试、验收和本地合并；不推送远端。

WSL运行TypeScript编排和Python低频视觉，Windows运行C#5/.NET4截图、CV、键鼠和释放看门狗。不能将WSL调度器中断测试外推为整个发行版重启恢复。

本轮第4阶段重新枚举的游戏 HWND `0x12c0892`、PID `25160`，客户区3840×2160；旧第3阶段身份为`0x6407cc`/`6932`，retail-1为2048×1536后切4K。身份不能跨重启复用，分辨率或布局变化需重新校准。角色移动绑定ESDF，E前进；W/A不能作为默认WASD移动键，需按实际技能/坐骑栏处理。禁止程序抢焦点。

用户明确授权上传所有WoW游戏截图至火山方舟；只限游戏客户区，不包括其它应用/桌面。新worker默认不启动模型；显式Seed+上传开关才读取 `~/.config/wow-jev/api.env`，不输出凭据。配置固定 `doubao-seed-2-0-mini-260428`。

使用说明见 `docs/eye-runtime.md`。验收与限制见 `docs/acceptance/stage-2.md`；原始证据在主checkout `out/acceptance/stage-2`，包括真实图、JSONL、冻结schema/校准/代码与二进制指纹。不得改写失败的native-run1/native-run2为通过。

## 接续

第3阶段可按`docs/play-runtime.md`体验纯模拟与当前4K正式服有限代码序列，眼单独观察仍见`docs/eye-runtime.md`。第4阶段可按`docs/jev-runtime.md`体验纯模拟与只读入口；第5–7工程可按`docs/system-runtime.md`体验三层模拟、真实日志学习与版本切换。用户已明确先推进后续工程，后续补第4阶段正式服及NPC感知/动作验收。actor=jev必需decision_id，模型只选候选ID、返回后重新采样，再复用统一CodePlay与手。默认真实槽位为空，未知字段只wait/escalate；不能把离线模型probe的人为观察用于live动作。

对移动、跳跃、转向暂不自动确认游戏效果；背包CV仅在已验收布局适用。个人长期记忆按 `/home/dai/agent-memory/SPEC.md` 操作，进度只写项目文件。


## 2026-10-07 重连点击分段时序重试

按 reviewer=claude 对前帧的审核，仅一次重试；鼠标原语改为独立MOVE→Windows QPC等待≥150ms并持续安全复核→DOWN持请求时长→独立账本UP。duration_ms明确是持有时长，不是释放后的等待。首次SendInput边界为MOVE，click_timing另存DOWN/UP，不冒充按钮效果。焦点恢复MOVE不提前触发激活期限，首DOWN前仍保留自由光标/人类按钮/点位核验。

现场 out/acceptance/click-retry-20261007：同源审核帧SHA85b8f0…a441a76与当前重连按钮/Logo匹配；FG=0x904a6，PID22072，2560×1440/DPI144。请求hold80；MOVE完成→DOWN开始158.4412ms，DOWN完成→UP开始88.4799ms；3/3事件，独立release_all+空账本+executor退出。Windows本地以UP结束为参考预约+1/+3/+8秒图片，实际capture开始+1094.649/+3182.840/+8094.750ms（偏差保留）。+1图显示刷新服务器列表，+8图角色列表加载，随后step-3角色选择CV核实小啊/warrior/alliance。恢复有意maxActions=1，返回recovery_action_budget；input_issued=1、effects_confirmed=1、release=confirmed，不是游戏交谈完成。4个一次性WowJev-SessionRecovery任务均删除并GetTask回查。相关83 TS、27 Python、typecheck与Windows编译通过；全量回归/全局Body timeline覆盖继续整合，未推送。

用户新增操作技能自学习A–F并授权反复登出/进世界和退出/战网重启练习；先已报告本次重连成功，下一步docs/ui-skill-learning.md设计、agent.sqlite技能图/独立学习者、分层路由/审核队列、常驻Windows签名识别、最小2轮练习。凭据/验证/协议/更新仍硬停止，Seed配置等待通知，不查其它密钥。
## 2026-10-07：全局点击 Timeline 编译时序（独立工作树）

按最新点击决定，在 `.worktrees/click-timeline` / `codex/click-timeline` 从 `b3d0483` 实施 WSL 侧全局 `TimelineBuilder.click` 和 Body `click` / `screen_interact` 编译。点击显式分为 MOVE、150ms settle、DOWN 与 UP；默认和最短 hold 为 80ms，旧 20/50/60ms hold 归一为 80ms。单击默认完整原生 timeline 为 230ms，默认双击每次独立 settle、间隔 80ms，总计 540ms。显式更长 hold 保留，完整 timeline 超过原生 5000ms 上限时编译阻塞。原通用 drag、转向/复合按键的持续持有语义保持各自预算。

UI 和世界屏幕交互仍使用原同帧目标、布局、自由光标条件及统一执行闸。编译返回的 `duration_ms`、原生 timeline 事件和 Body 意图 deadline 使用完整实际计划；既有原生动作 hash/内存批准来源据这些编译参数绑定，不能保留旧 50/60ms 整体时长来批准新动作。模拟 sleep 也使用完整 230ms，游戏输入和游戏效果仍未验证。

验收：TypeScript 定向 102/102、0 跳过/失败（actions-timeline、actions-body、activate-control、memory-frame-gate、tutorial-resident、tutorial-layered），全树 typecheck 与 diff check 通过。日志 `/tmp/wow-click-timeline-targeted.tap`、`/tmp/wow-click-timeline-typecheck.log`。首轮教程契约测试因独立树缺 Python venv 报环境故障；连接主 checkout 既有环境后定向全绿，不删/跳测试。本模块未编译或启动 Windows、未读取凭据/调用模型/发送输入；仅本地提交，不推送。

原生验收由负责人继续：`RunTimeline` 的绝对计划时间本身不能证明真实 MOVE→DOWN ≥150ms 或 DOWN→UP ≥80ms。原生必须以实际 MOVE 完成和 DOWN 完成时刻守住下界，慢 MOVE/检查需顺延，取消或失焦在 DOWN 前必须阻止按下。focus_click 的 own MOVE 更新 GetLastInputInfo，idle 豁免须与 actual DOWN/焦点激活计时分开，不能因此放宽用户按钮与自由光标检查。

## 2026-10-07 重连点击分段时序重试

按 reviewer=claude 对前帧的审核，仅一次重试；鼠标原语改为独立MOVE→Windows QPC等待≥150ms并持续安全复核→DOWN持请求时长→独立账本UP。duration_ms明确是持有时长，不是释放后的等待。首次SendInput边界为MOVE，click_timing另存DOWN/UP，不冒充按钮效果。焦点恢复MOVE不提前触发激活期限，首DOWN前仍保留自由光标/人类按钮/点位核验。

现场 out/acceptance/click-retry-20261007：同源审核帧SHA85b8f0…a441a76与当前重连按钮/Logo匹配；FG=0x904a6，PID22072，2560×1440/DPI144。请求hold80；MOVE完成→DOWN开始158.4412ms，DOWN完成→UP开始88.4799ms；3/3事件，独立release_all+空账本+executor退出。Windows本地以UP结束为参考预约+1/+3/+8秒图片，实际capture开始+1094.649/+3182.840/+8094.750ms（偏差保留）。+1图显示刷新服务器列表，+8图角色列表加载，随后step-3角色选择CV核实小啊/warrior/alliance。恢复有意maxActions=1，返回recovery_action_budget；input_issued=1、effects_confirmed=1、release=confirmed，不是游戏交谈完成。4个一次性WowJev-SessionRecovery任务均删除并GetTask回查。相关83 TS、27 Python、typecheck与Windows编译通过；全量回归/全局Body timeline覆盖继续整合，未推送。

用户新增操作技能自学习A–F并授权反复登出/进世界和退出/战网重启练习；先已报告本次重连成功，下一步docs/ui-skill-learning.md设计、agent.sqlite技能图/独立学习者、分层路由/审核队列、常驻Windows签名识别、最小2轮练习。凭据/验证/协议/更新仍硬停止，Seed配置等待通知，不查其它密钥。

## 2026-10-07：原生标准 click timeline 的真实时钟下界

在同一独立 `codex/click-timeline` 树先合入负责人原生分段点击提交 `7cbc4eb`（本树 `55f4c42`），HANDOFF 双方段落完整保留。新增 WinInput 生产 `ClickTimelineTiming`，仅识别 Builder 标准单/双 click 的三/六阶段，依据真实成功 SendInput 的 MOVE 完成 QPC 等待 DOWN 至少 150ms、依据 DOWN 完成 QPC 等待 UP 至少 80ms或显式更长 hold。双击保留独立两次 settle 与批准的 inter-click gap，原动作 Events、duration 和批准 hash 不改。计划总时长额外安全排程最多 250ms，每次原生发送前再次检查下界/剩余预算；超宽限取消并释放，普通前台、取消、看门狗、点位、首 DOWN 自由光标和账本仍生效。drag、转向与按键不被重释为 click。

新增 `tools/ClickTimelineTimingFixture.cs` 直接调用同一生产 helper，无窗口/截屏/SendInput。29项检查覆盖 MOVE/DOWN 自身延迟、显式 hold、双击、MOVE后取消/丢焦无 DOWN、DOWN后取消的 fake owned release、250ms上限、形态隔离与批准计划不变。复用原纯 safety 42项/visible point 24项全部通过；这些既有几何/空账本测试不冒充新 click 实际时序证明。Windows 四模块编译、TypeScript定向105/105、typecheck、diff check通过。原件 `/tmp/wow-click-timeline-native-fixture.json`、`/tmp/wow-click-native-safety.json`、`/tmp/wow-click-native-visible.json`、`/tmp/wow-click-native-build.log`、`/tmp/wow-click-timeline-native-targeted.tap`。

`click_timing` 对标准 timeline 记录第一 click 的真实原始 MOVE/DOWN/UP区间，hold_requested取该 click 的计划 UP-DOWN（默认80），不能误用整条230/540时长；整体 input_timing仍保留最后实际输入。预登记但没有发送DOWN的清理UP不写成click UP，双click后续紧急释放不覆盖第一click记录。输入已发出边界仍为第一成功 MOVE，不宣称游戏效果。仅本地提交、未推送、无真实游戏输入；Resident总时长准入调整和主集成/现场由负责人继续。

## 2026-10-07：受当前 UI 状态约束的 Body 按键

新增显式 `ui_key` capability 和 BodyAction `{kind:'ui_key',key:'ESC'|'ENTER',state_id,duration_ms:1..150}`，仅编译有限 key_down/key_up，不增加 click settle、不开放文本或其它键。必须当前 known 原生 CV `ui.state` 与 `ui.layout_id` 同 observation/capture，布局等于 profile、状态 id 等于请求；完整 `{id,confidence,signature_sha256,hard_stop}` 保存为独立条件快照。正常 hard_stop=null（兼容旧 false）；危险/未知/畸形状态拒绝。BodyRuntime 保留统一闸、前台/来源/时效/批准重验、取消与释放，不猜 movement mode。未新增跨语言 Body wire，原 NativeTimeline schema 继续约束实际原生动作。

新增5项回归覆盖 ESC/ENTER 的1/80/150ms、非法按键/时长/文本、能力缺失、状态与布局的旧来源/时间、危险状态、原 BodyRuntime mock 发送、失焦、log后同id换signature以及取消释放。定向 TS 110/110、全树 typecheck、diff check通过；证据 `/tmp/wow-ui-key-targeted.tap`、`/tmp/wow-ui-key-typecheck.log`。仅本地提交，无游戏输入、未推送。此阶段未扩展旧 strict layer replay 的通用 UI 按键任务；正式 UI 学习入口和现场验收由负责人集成。

**2026-10-07自主恢复续跑：autonomous-resume-17先核验当前选中小呵/战士/联盟与按钮，旧恢复统一闸已有限点击进世界并释放。独立后图在船上，但OCR英文误作launcher，原自动恢复结果仍blocked；不回填晋升成功。autonomous-jaina-18只读见键位说明弹窗，0交谈输入。新增同源Seed正常场景+可见按钮框与现有Native控件吻合时选择既有candidate，未知modal不再要求active用的场景guard；Native present/hardstop仍拒绝且不授active。关键测试1项及typecheck通过。**

## 2026-10-07：视觉 JSON 输出约束与一次解析重试（离线）

独立 `.worktrees/vision-json-retry` 从331eea4实现Recovery promptv2/UI promptv5，保旧坐标schema1/4与硬停/像素复核。实际Chat请求带json_object，首个完整对象可从围栏/说明提取，原输出与提取证据不覆盖；仅invalid_json同原图最多重试一次，共用15s API预算，attempted/completed及每次请求/失败原文保留。双语法失败是无模型结果/零候选的nonfatal unknown，CLI exit0让上层继续只读观察，不合成成功或刷新QPC。其它安全/语义错误不重试；中央选角模态不得产生enter_world候选。专项Python81/81、py_compile、diff check通过；未读密钥/访问桌面/调用模型/输入或推送。详见docs/ui-skill-learning.md本次JSON段落；主负责人继续集成和现场验收。

**2026-10-07自主运行停止：controls19/20/21三轮识别失败，0教程确认输入；21更新self candidate的按钮/不透明键鼠锚点后，独立Native证据已known（正距离0.00056966）；最初热帧的空候选没有随证据帧刷新，导致仍送模型，不能授active。旧源码run17已发进入世界且后图到船上，18只读见教程键位弹窗；尚未交谈。新增同帧Native+按钮OCR只允许普通教程candidate，决策者记code并保留slow_path闸，未放宽认证/模态present或晋升。类型/OCR缺失拒绝与治理专项已通过；修补合入后须完整回归并仅推codex/agent-system。现场已停止，后续无第四次尝试。**

## 2026-10-07：真实v5契约异常的v6规范化补充（离线）

针对controls19原输出，仅将明确v4 xyxy的ASCII十进制数字串机械转整数，dialog_state精确open/closed+null简写转known/同词，记录原SHA、逐字段操作与canonical-wire原件；不修坐标、置信度、矛盾值或重叠锚点。原件尚有两个anchor与control重叠，规范化后仍拒绝。按最新用户决定，无明确硬停声明的模型schema失败也可同原图重试一次，语法/契约共享总2请求/15s预算；auth/verification/terms/update声明、不安全回显、重复键/NaN及传输错误不重试，不刷新QPC、不授权输入。UI promptv6，模型schema4不变。契约真实fixture+104项专项Python、py_compile、diffcheck通过；只做离线，无真实模型、密钥、桌面或输入/推送。

**2026-10-07证据帧候选刷新修复：controls21的新模板在原Native证据帧匹配成功，正距离0.00056966、锚点均通过；错误是路由仍沿用首个未知热帧的空候选。现于新证据采集后重算候选，后续Body仍独立取新帧验证，不改原观察时间。新增冷热帧变化回归，场景/OCR/候选三项及typecheck通过。已集成JSON模式、同图一次语法/契约重试、严格数值串/对话状态机械转换及640px JPEG审计（真实旧报告6,986,882字节）。当前仍停止于普通教程弹窗、0该弹窗点击/0吉安娜交谈。准备完整回归后推送。**

**2026-10-07用户恢复且补充已定位修好的bug直接继续，无需重复问；只有原因不明的连续失败才停止。controls24经Seed正常选角+当前Native按钮候选发进入世界；controls27代码/同帧OCR一次3/3且释放，独立后图关闭键位说明。旧purpose为confirm_controls_intro，已支持别名；Native私有技能/控件签名继续绑定，confidence仅遥测不比较整浮点state。orient29当前截图黄色文字/鼠标锚点修订candidate后经L4/L3一次950ms、11/11释放，独立后图为与吉安娜交谈；动作模型0。当前尚未交谈，世界中会话1前台，原图autonomous-orient-29/frame-3-evidence-12.png。等待/开发前10分钟内须有限无害输入或安全回选角；原失败历史保留、active0。**
