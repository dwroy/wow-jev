# 常驻会话宿主集成验收

2026-10-07。阶段一的归一化ROI和阶段二的教程L4/L3路径已完成完整验收并推送；本文件记录阶段三常驻宿主的实际验证。当前没有成功导出的WGC帧，没有游戏输入，没有首个任务完成或端到端速度结论。离线模块检查与真实Windows结果分别记录。

## 最终离线验收

独立树组合候选bbf43fe（72文件），完整Git快照测试：TS644/644、Python820passed+3项原有strict xfail（收集823）、typecheck通过，失败和普通跳过均0。相较阶段二567TS/765Python，新增77TS/55Python，无删除或跳过旧用例。JUnit以3个skipped节点表示pytest.xfail，全部为原gamma1.1容差反例，不是环境缺失的skip。捕获/WinEye/NPC原生fixture已构建并显式绑定，原全部套件实跑；组合原生纯检查71/71，桌面窗口/捕获/真实输入均0。

冷恢复阻塞或取消后保留原结果，冷/热/总输入计数分别报告，缺终态为lower_bound；Python独立注册也经固定只读Node/Ajv入口完整复用Native唯一schema，缺字段、错类型及额外字段在落库前拒绝。知识SHA来自本轮实际知识使用清单原件，世界参考与局部规则明确不冒充已注册学习快照；局部断言读回核验原event的全部artifact字节。

完整日志、JUnit、构建、CLI help/无桌面prepare和validation-summary.json在主`out/acceptance/layered-tutorial-20261006/stage-3-integration/`。真实源码未在全量通过后修改；后续提交仅补最终文档。入口为`python3 tools/layered_tutorial.py --help`、`python3 tools/resident_readonly.py --help`和`python3 tools/resident_fixture_benchmark.py prepare --run-dir <全新目录>`，均已离线实际运行。

离线对照采用seed42、六种场景各四次重复、平衡single/layered顺序，共48个trial：8completed、32预期blocked、8cancelled、0failed；严格语义重执行回放verified=true。全部真实输入/云模型/游戏效果为0。默认注入capture8/CV4/fusion1/visual180/brain120/Jev60/code1/dispatch2/effect10/release1ms、动作100ms；它验证声明成本下的控制流，不证明现场速度。

normal首对同工作量11次模拟动作，single注入观察→模拟发送p50/p95=341/341ms，layered=42/341ms；注入全程5105/2584ms。single模拟visual/brain各11次，layered模拟visual/brain/Jev各2次，代码/Jev/大脑选中7/2/2；实际云请求0。各环节、命中分母、动作率和独立模拟效果原件保留在paired-simulation，不能将这些数用于Windows QPC的150ms目标，也不能把模拟确认算游戏完成。

## 实际会话验证

所有运行都使用`authorized_input=false`、`focus_recovery_authorized=false`、`max_actions=0`，不创建输入执行器或释放看门狗，不调用模型。当前用户的一次性交互任务将固定宿主运行于会话1；本地管道relay运行于会话0。没有修改注册表、组策略、服务或安装软件。

| 运行 | 实际结果 | 临时任务 |
| --- | --- | --- |
| readonly-01 | 身份查询抛Win32Exception，初版未记录原生错误码，不能直接断言原因 | WowJev-Resident-cce42b2c7c1b44f7a20b6f88b07a460a |
| readonly-02 | ProcessIdToSessionId返回错误5；未到后续limited process查询 | WowJev-Resident-fb5afe13a04d44338c9cf04c362dd0a3 |
| readonly-03 | 管道句柄查询对端会话通过；OpenProcess(0x1000)返回错误5 | WowJev-Resident-c900f26caf3d43e08c1708384abfe285 |
| readonly-04 | 自有relay进程补查询权限后PID/路径/SHA/启动时间校验通过；Identification令牌下的辅助Process.SessionId查询失败 | WowJev-Resident-7da8d19933144ad8a201ea7371e10236 |
| readonly-05 | 整个身份链通过；新鲜WGC帧超时；正常shutdown竞态导致协调器未收到终态ACK | WowJev-Resident-f88922222d6d4c498ce122c392849c72 |
| readonly-06 | 整个身份链和正常shutdown ACK通过；会话1实际Disconnected，WGC零回调/零帧 | WowJev-Resident-6184fc51c1f84595bd29f5b73bc215bf |

六个任务均已删除，独立`GetTask`返回80070002确认不存在，没有强杀宿主。原件位于主checkout的`out/acceptance/layered-tutorial-20261006/stage-3-native/readonly-01`至`readonly-06`，失败原件保留。01至04的初版源码清单覆盖不完整，不冒充完全冻结；05、06另有完整源文件、实际构建脚本、校准/schema及payload SHA清单。

04的relay-access原件记录仅当前relay进程、当前用户SID的0x1000查询ACE，原有其它ACE保留，没有授予内存读写、终止或权限修改权给宿主，没有请求debug privilege。进程退出后对象消失。05/06的令牌证据确认双方SID相同，宿主session1、medium integrity 8192、elevation type3，relay session0、high integrity12288、elevation type1；这是进程查询权限差异的实测证据。最终身份仍由宿主独立查询PID/启动时间/路径/文件SHA及管道会话/SID，不以relay自报代替。

06的原生诊断：调用线程MTA，WGC回调0、取得帧0、无callback_error；线程桌面Default，OpenInputDesktop错误5，WTS连接状态4（Disconnected），前台HWND/PID为0。WoW仍为PID22072、start_ticks639268827443062278、HWND0x904a6、类waApplication Window、session1，窗口visible=true、minimized=false，物理客户区2560×1440、DPI144。此证据要求用户重新连接RDP并摆好窗口；不能归因为STA/MTA已经解决、WGC不支持WoW或窗口被最小化。用户随后确认暂不在线且RDP仍断开，要求完成全部离线部分、全绿后推送并停下。已停止现场操作，不轮询RDP；新的窗口就绪通知由用户另行提供。

06收到同一session的`stopped`，`capture_disposed=true`，launcher退出0，任务删除回查通过。`release_scope=no_executor_acquired`仅表示本轮未取得输入所有权；release_receipt/ledger_empty/native_exited均null，不代表真实持键、EOF、心跳超时或强杀释放已经验收。

## 客户端元数据

只读复用`tools/retail_soak.py`的允许字段查询，未调用session0窗口枚举。当前PID、启动时间和路径与目标一致，FileVersion为12.1.0.69933，安装分支retail，Config.wtf的portal为CN、textLocale为zhCN。只保存这两项配置字段，未复制Config.wtf或认证信息。原查询、输出、代码SHA和独立UTC注记保存在`stage-3-native/client-metadata-01`。

Midnight资料片标签经[暴雪12.1已知问题说明](https://us.forums.blizzard.com/en/wow/t/midnight-curse-of-ulatek-content-update-known-issues-and-information/2335070)审核；精确build来自本地FileVersion，不能说官网核验了69933。session0文件元数据UTC与session1帧QPC各自保留。当前缺成功WGC帧，尚未生成完整客户端批准证明，也未写入本轮教程局部实测断言。

## 性能与后续现场边界

本轮所有游戏输入、模型请求和效果确认均为0；观察→决策→输入延迟、每分钟有效动作数、层命中比例及输入p50/p95均未测。此前单独CV的暖路径耗时不能替代常驻宿主端到端数据。

独立记录窗口以recording_fixture作用域验证真实传输、L4/L3控件行为、Body、统一闸、hand与释放，控件效果另记fixture_effect，game_effect始终unverified。它不能写教程事实或上传到游戏视觉模型。计划采集至少30个暖路径输入样本，与真实WoW只读采样及首个交谈的一次实测分开报告。当前尚未执行这些输入验收。

用户恢复RDP并确认窗口就绪后，先用新源码/配置重新只读核对身份、客户区、DPI、当前界面和角色。普通输入保留前台校验；恢复点击保留完整可见区域、落点归属、>5s空闲、无用户持鼠标及有限取消释放检查。缺独立对话框关闭证据保持unknown；不得把NPC名字与交谈提示当成对话框关闭。首交谈仅认输入后的独立新图、配对NPC标题和对话控件证据，不接受下一任务。

正常退出不能外推真实持键断链、执行器强杀或整个WSL重启恢复。完成首个交谈或遇到需用户处理的阻塞即停止，保留输入回执和独立效果原件。
