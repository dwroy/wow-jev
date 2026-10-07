# Console 会话首任务验收

2026-10-07。用户已在会话1执行tscon转到物理console，并明确授权有限焦点切换、恢复进入世界和联盟战士小啊的第一个“与吉安娜·普罗德摩尔交谈”。只做这个交谈，输入发出与独立效果确认分开。

独立开发树`.worktrees/console-session`，集成基线90bf5c8。原件位于主`out/acceptance/console-first-task-20261007`。本轮因输入桌面不可用与console会话不一致停止；首交谈未完成，真实输入、应用模型调用和确认效果均为0。

## 本轮只读与修正

readonly-01实测session1 WTSActive、thread/input desktop Default、OpenInputDesktop成功、WoW仍PID22072/start639268827443062278/HWND0x904a6/class waApplication Window。客户区2560×1440物理像素、DPI144，屏幕起点612,413；可见、未最小化，前台0。WGC已有19回调/19帧，但原新鲜度判断错误地比较两个未经验证对时的时间域，全部拒绝；原始SystemRelativeTime比同次回调QPC领先约15.47ms。原失败保留，不把空样本报告为捕获成功。

修正使用真实FrameArrived回调QPC作为源观察时间，原compositor时间独立存档且alignment=unverified；同时拒绝缓存回调和重复compositor戳。readonly-02三个新帧及证据图成功，场景是WOW51900319断线确定框，尚未选角/进入世界。ROI分别580.337/589.777/588.913ms，CV20.820/12.071/10.573ms，整个帧源年龄615.885/609.216/608.642ms，不能当作输入延迟。

多ROI改为一次GPU包围矩形staging/map后原字节切片，ROI坐标/独立SHA不变，无PNG/OCR热路径。readonly-03三帧ROI80.158/67.871/67.612ms，CV21.568/8.655/9.672ms，源至响应115.385/83.076/83.488ms（n=3，未发输入）。四个可见背景候选均被原生point_patch_not_target拒绝，尚未判定具体遮挡物；早期拒绝的cursor_free/mouse_buttons_held为拒绝缺省值，不能称已实测有人按鼠标。每项通过共享schema；尚未发送激活点击。

新的显式visible_point恢复入口保留身份、5×5像素点归属、显示器覆盖、自由光标、严格>5s空闲和原hand看门狗。只有正面识别的断线界面背景候选可激活，避开按钮；普通输入仍要求前台。每次切换必须独立复核前台，失败释放并停止。当前没有Alt+Tab或移动/最小化窗口的实现或验收结论。

## 验证与清理

typecheck通过；专项TS66/66，包括hand16/16、新协议回调时钟反例。C#纯策略/schema/ROI切片78/78，可见点纯几何24/24。子agent环境hand mock10项提前退出的原失败保留；主执行环境实际完整重跑16/16通过，不删除或跳过用例。完整套件将在共同Git快照再验收。

readonly-01/02/03都未取得输入执行器，game_inputs=0、Seed模型=0；每轮正常shutdown/capture_disposed和临时任务删除、独立GetTask80070002回查分开存档。release_scope仅no_executor_acquired，不冒称持键或強杀释放验收。正式输入/效果、全量测试及最终完整任务列表待本轮现场结束后补充。

## 最终现场阻塞与用户操作

readonly-04独立查询实际确认：WinSta0；线程与OpenInputDesktop都为Default，UOI_IO查询成功但值false；GetGUIThreadInfo(0)失败，错误0，未知字段保持null；GetCursorInfo失败，错误5（Access denied），不能证明自由光标。实际用户空闲1683015ms，三个鼠标按钮未检测为按下；这些独立读数与候选早退的保守缺省分开。物理显示器3840×2160、per-monitor-aware、WoW完整客户区位于显示器内，当前失败不是点落到屏幕外。

四个候选5×5像素各25点全部命中Claude根窗口0x2106a0（PID3996、class Chrome_WidgetWin_1、rect1802,667–3629,1889），位于WoW上方Z26。Chrome0x400ce/PID27380/rect0,0–1938,2088/Z56也遮挡WoW；WoW在Z70。只读识别了遮挡物，未移动、最小化、关闭或向它们输入内容。

input-desktop-05三次采样均WTSGetActiveConsoleSessionId=3；会话1依然WTSActive、RDP-Tcp#0、ClientProtocolType2、WTSInfoEx unlocked（这不等于它的desktop接收输入）。辅助只读进程查询确认会话3有LogonUI PID18948和winlogon PID18172。现场没有观察到用户预期的“session1已转console”；不能据用户之前执行tscon声明覆盖当前原生事实，也不能据此唯一推断命令失败或后来重连的历史原因。

需要用户让**WoW所在会话1**真正显示于可交互桌面：在物理显示器登录/解锁正确会话，或重新连接会话1的RDP并保持客户端可见，在该桌面点击WoW、留>5s空闲，再通知继续。不要向我们提供密码/验证码。没有改注册表、组策略、服务、安装软件、会话连接或Windows设置；本轮不在不可核验的输入desktop发送Alt+Tab，也不通过窗口API伪造成功激活。

WoW当前截图仍为WOW51900319断线确定框。当前角色、教程任务和键位未取得新世界证据，agent.sqlite没有注册本轮教程facts、冻结世界包未改；recovery未启动有限输入，L4/L3任务未执行。应用Seed/Jev/执行大脑调用0，助手人工复核图像1次单独记；不把人工截图判断计为程序视觉性能样本。有效动作速率、各层命中比例、单层对照和观察→输入/输入→效果均unknown，输入与效果各n=0；p50<150ms未验收。

使用原TraceRecorder从同帧真实QPC原件生成35条readonly-latency记录，只有观察、fresh-frame等待、ROI、CV及源至Windows响应，不补造decision/input_issued/effect_confirmed。readonly-03的n=3只读ROI p50=67.871ms、CV p50=9.672ms、源→Windows响应p50=83.488ms；后一数值不包含WSL决策/各层/输入，不能称端到端动作成绩。未经对时的compositor→回调仍unknown。

## 最终软件验收

实现提交a251575；全量发现一项stdin写失败与child exit事件的竞态：首次TS679/680，断线释放实际仍unconfirmed，但native_write_failed错误信息漏写释放不确定。1b35c7d补齐实际错误信息，测试断言未放宽、旧用例未删除/跳过；首次原始日志保留。最终共同Git快照完整重跑TS680/680（原644保留，新增36），Python820passed+3原有strict xfail（收集823，0fail/普通skip），typecheck通过。Python XML的3个skipped节点全部为原gamma1.1的pytest.xfail，不是缺环境的skip。当前Native WinEye/NpcClassify/旧Capture均由本树源码构建且显式绑定测试。

C#纯Resident策略/schema/时钟/原字节ROI切片78/78，可见点几何/身份/首DOWN条件24/24；无桌面窗口、实际输入或游戏效果。编译、模拟回归与只读现场独立报告，本轮未测真实持键EOF/强杀/WSL重启释放或30次fixture输入，不能从正常退出外推。所有测试源码与17项原生payload SHA在frozen-source-manifest.json。

## 本轮临时任务清理

| 创建并删除的任务 | 最终独立回查 |
| --- | --- |
| WowJev-Resident-12185d5dcd14436bb4eac883ae50b22d | GetTask HRESULT80070002不存在 |
| WowJev-Resident-2bfaf06529434da98d1b68219eef52a8 | GetTask HRESULT80070002不存在 |
| WowJev-Resident-a3ceb59079174129aec914d4a293b215 | GetTask HRESULT80070002不存在 |
| WowJev-Resident-ed8606ab9962490999d643af3c5abaef | GetTask HRESULT80070002不存在 |
| WowJev-FirstQuest-Readonly-7178c7f0b47c420b965b5bc4ee165bb1 | GetTask HRESULT80070002不存在 |

四项Resident任务均正常同session shutdown、capture_disposed、relay exit0，未启动hand/watchdog；release_scope只为no_executor_acquired。纯desktop诊断任务也正常exit0。本轮五项任务全部删除，task-deletion-inline.json最终再逐项核验，session1本项目执行助手列表为空。源码固定且最低权限的一次性/IT任务，没有持久任务或系统配置改动。最终回查第一次-File因本机PowerShell文件脚本策略报UnauthorizedAccess；原失败保留，使用项目既有固定内联只读COM查询取得回查，未改执行策略、未加Bypass。最初相对config路径/旧probe未构建错误也保留，均在任务注册前发生。

本轮软件与验收在独立树分步提交，主checkout只ff-only集成与验收。仅正常推codex/agent-system，不force、不推其它game-db分支；推送及原wow-jev.bundle/HANDOFF备份SHA复查另存主out。本轮到此停止，等待用户修正可交互桌面状态再只读重验，不继续下一任务。
