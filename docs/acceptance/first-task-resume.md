# 首任务恢复现场复测

2026-10-07，运行源码12948ec。用户要求立即现场执行：快速确认会话1可交互，前台恢复/断线重连/选角，再经分层路径只做首个与吉安娜交谈；完成或阻塞即停。主原件`out/acceptance/first-task-resume-20261007-01`，本轮只作现场验收记录，无业务代码改动。

## 当前结果

会话1 WTSActive、WinSta0/Default，线程/输入桌面UOI_IO查询成功且true，GetCursorInfo成功、可见、无人持鼠标键、用户空闲170453ms。前台已是0x904a6/PID22072；Wow正式服path/start639268827443062278/class waApplication Window保持一致，物理客户区2560×1440/DPI144，屏幕origin155,361。旧“输入desktop不可用”阻塞已消失，本轮不移动或最小化其它窗口、不发焦点恢复点击。

恢复流程用同帧OCR核验WOW51900319断线marker和中心确定框，统一执行闸发送一次LEFT有限点击（duration60ms）；Native execute completed、3/3 SendInput事件、released=true。独立后图仍focused=true，原弹窗已关闭，中心显示“重新连接”与“登出”。但该后图的OCR白名单结果没有重新连接项，程序返回unknown，终止于disconnect_ack_effect_unconfirmed。人工对同一原件复核确认弹窗已关闭，保留为独立root审核；不把人工结果回写成程序CV或刷新旧源时间。程序effects_confirmed=0，first task/进入世界/角色/任务键位仍未确认。

按用户“阻塞即汇报”停止，不再发重新连接或第二次确定，不继续选角和下个任务。L4/L3交谈尚未启动、agent.sqlite本轮未写教程事实、冻结世界包未改。当前阻塞在恢复识别，而非会话/焦点；未出现凭据、验证码、协议、更新要求。下一步需针对保存的实际重新连接图修识别或接同源低频审核，再重新取新帧，不能盲点旧图。

## 实测延迟

| 环节 | 本轮实测 |
| --- | ---: |
| 输入前PrintWindow API | 66.248ms（Windows QPC） |
| PNG编码/落盘 | 344.780ms（Windows QPC） |
| 冷完整CV | 1319.312ms（Windows QPC） |
| OCR | 987.116ms（Windows QPC） |
| 原生spawn→ready | 1933.234ms（Windows QPC） |
| 原生闸确认→首SendInput开始 | 17.951ms（Windows QPC） |
| 捕获API开始→首成功SendInput区间 | 11186.133–11199.632ms（QPC，n=1） |
| 完整冷恢复轮次 | 30846.363ms（协调器monotonic） |
| 初始常驻只读ROI / CV / 源至Windows响应 | 74.910 / 25.761 / 117.122ms（QPC，n=1） |

冷恢复是一次性/IT桥，包含spawn、跨桥和低频PNG/OCR，不能当作常驻L4/L3交谈的热路径跑分；各嵌套区间不相加，协调器与QPC起点不直接相减。观察→输入使用同Windows QPC的实际capture API与first_send原件，不能拿execute started_ms代替。恢复端程序效果未确认，输入→效果程序样本n=0；同源人工后图另存不冒充自动确认。分层任务输入n=0，p50<150ms、各层命中比例、每分钟有效任务动作数和单层对照均未测；应用视觉/Jev/大脑调用0，助手图像复核1次单独记。实际recovery trace原件复制latency.jsonl，不补造L4/L3事件。

## 释放与临时任务

独立release_all与shutdown同session成功回执，held_keys_mask=0x0、held_mouse_mask=0、executor_exited=true。最终Windows只读查询确认WinInput/Watchdog/Resident/Recovery/Relay进程无残留；这是真实有限鼠标输入的正常释放证据，不外推强杀/WSL重启情况。

| 本轮创建且已删除的任务 | 最终回查 |
| --- | --- |
| WowJev-Resident-d673ac5b53cf40b2b2244f212cb89c0a | GetTask80070002不存在 |
| WowJev-SessionRecovery-e481897638af4456a8767a728b10362e | GetTask80070002不存在 |
| WowJev-SessionRecovery-d9de1e13ee384a2c9986756e09a3c42c | GetTask80070002不存在 |
| WowJev-SessionRecovery-b4d32ae3676a482c8dc2af24a493e379 | GetTask80070002不存在 |
| WowJev-SessionRecovery-e284d08401a84034a325ebd4ec0efbee | GetTask80070002不存在 |

一项常驻只读任务、四项冷恢复任务全部删除且独立回查。原截图SHA逐一核验，原输入/释放账本/native-lines/payload SHA、现场源码归档和新只读client版本metadata保存。最初Node从主目录加载tsx失败，在任何任务或输入前发生；改为项目agent目录运行原CLI后执行，原错误保留。另查到Python recover包装器尚不转发--focus-visibility-mode；本輪用原TS CLI，且WoW已前台，未使用焦点恢复例外；该包装器缺口待单独修复。

本轮仅验收文档与HANDOFF更新，git diff --check通过；未重跑全量软件套件，不将上轮680TS/820Python+3xfail/typecheck当作本轮新测试。记录在独立工作树提交，再ff-only主集成；未推送。现场到此停止，等待下一指示。
