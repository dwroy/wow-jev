# Console 会话首任务验收

2026-10-07。用户已在会话1执行tscon转到物理console，并明确授权有限焦点切换、恢复进入世界和联盟战士小啊的第一个“与吉安娜·普罗德摩尔交谈”。只做这个交谈，输入发出与独立效果确认分开。

独立开发树`.worktrees/console-session`，集成基线90bf5c8。原件位于主`out/acceptance/console-first-task-20261007`。以下是进行中状态，尚无游戏输入或任务完成结论。

## 本轮只读与修正

readonly-01实测session1 WTSActive、thread/input desktop Default、OpenInputDesktop成功、WoW仍PID22072/start639268827443062278/HWND0x904a6/class waApplication Window。客户区2560×1440物理像素、DPI144，屏幕起点612,413；可见、未最小化，前台0。WGC已有19回调/19帧，但原新鲜度判断错误地比较两个未经验证对时的时间域，全部拒绝；原始SystemRelativeTime比同次回调QPC领先约15.47ms。原失败保留，不把空样本报告为捕获成功。

修正使用真实FrameArrived回调QPC作为源观察时间，原compositor时间独立存档且alignment=unverified；同时拒绝缓存回调和重复compositor戳。readonly-02三个新帧及证据图成功，场景是WOW51900319断线确定框，尚未选角/进入世界。ROI分别580.337/589.777/588.913ms，CV20.820/12.071/10.573ms，整个帧源年龄615.885/609.216/608.642ms，不能当作输入延迟。

多ROI改为一次GPU包围矩形staging/map后原字节切片，ROI坐标/独立SHA不变，无PNG/OCR热路径。readonly-03三帧ROI80.158/67.871/67.612ms，CV21.568/8.655/9.672ms，源至响应115.385/83.076/83.488ms（n=3，未发输入）。四个可见背景候选均被原生point_patch_not_target拒绝，尚未判定具体遮挡物；早期拒绝的cursor_free/mouse_buttons_held为拒绝缺省值，不能称已实测有人按鼠标。每项通过共享schema；尚未发送激活点击。

新的显式visible_point恢复入口保留身份、5×5像素点归属、显示器覆盖、自由光标、严格>5s空闲和原hand看门狗。只有正面识别的断线界面背景候选可激活，避开按钮；普通输入仍要求前台。每次切换必须独立复核前台，失败释放并停止。当前没有Alt+Tab或移动/最小化窗口的实现或验收结论。

## 验证与清理

typecheck通过；专项TS66/66，包括hand16/16、新协议回调时钟反例。C#纯策略/schema/ROI切片78/78，可见点纯几何24/24。子agent环境hand mock10项提前退出的原失败保留；主执行环境实际完整重跑16/16通过，不删除或跳过用例。完整套件将在共同Git快照再验收。

readonly-01/02/03都未取得输入执行器，game_inputs=0、Seed模型=0；每轮正常shutdown/capture_disposed和临时任务删除、独立GetTask80070002回查分开存档。release_scope仅no_executor_acquired，不冒称持键或強杀释放验收。正式输入/效果、全量测试及最终完整任务列表待本轮现场结束后补充。
