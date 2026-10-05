# 四层架构首版工程验收

日期：2026-10-05。设计经用户确认并授权落盘/实施。三个独立工作树负责动作、感知、行为/任务，负责人维护契约、日志旁路和整链入口，审查后本地集成；未推送。

## 已实现

| 部分 | 首版代码能力 | 证据边界 |
| --- | --- | --- |
| L1 | 成对键鼠down/up、press/长按、双击/拖动、有限同步timeline | 真实Windows参数校验；本轮没有物理输入 |
| L2 | 语义绑定、移动/曲线/转向/跳跃/骑乘/飞行/技能/互动/元素点击，统一闸门、取消与释放 | 编译/调度/协议与mock回执；不推导距离、角度、命中或挂载成功 |
| 眼 | 版本/DPI/布局scope、区域树、锚点、遮挡、血条/颜色/模板/label/几何原子、缓存与来源 | 真实离屏Windows Bitmap/PNG；未验证正式服泛化精度或20Hz |
| OCR/Seed路由 | 常驻多ROI OCR协议、可配置权重、原解析来源、ROI JPEG派生、预算/去重 | 未配置OCR权重返回unsupported；fake OCR明确标记；未测真实模型精度/云usage |
| L3 | 九种有限反馈行为、技能优先级、危险抢占、目标/状态/期限检查、Jev只在边界选择 | 模拟含一次chooser连续防御→打断→输出；不是正式服战斗结果 |
| L4 | sequence/kill_count/deliver_quest、任务进度证据、奖励身份、检查点与不重置预算 | 数量不从死亡截图累加；未知数据阻塞 |
| 整链 | task→behavior→body→timeline、同观察关联、版本日志、开发live入口、控制socket、严格回放 | 六行为模拟闭环；当前没有新游戏实测 |
| 日志旁路 | Windows共享尾读/UTF8半行/截断/轮换/EOF停止、V22版本头、文件代际+offset去重 | 真实Windows文件I/O；游戏落盘延迟/时间映射/视觉GUID关联未知 |

## 验证

- 最终TypeScript全量 **335/335**、零跳过；typecheck通过。新四层整链、取消、未知、无进展、并发观察隔离、回放篡改/模拟原生回执反例通过。
- 四个C#原生程序重建成功；真实复制源码构建helper核对全部源/二进制SHA。仍保留四个默认EXE，战斗日志reader单独构建。
- 原生无输入时间线：**2有效、9无效**，覆盖排序/配对/事件数/整数/客户区边界。
- Windows文件尾读：EOF附着、跳过既存半行、中文UTF8跨次追加、截断后一次补写超过旧offset、文件身份轮换、stdin EOF停止，共6项。
- 真实Windows截图codec/导出/配额6组：原PNG像素不变；区域fixture验证血条、锚点失效、遮挡、DPI/build失配、缓存与关键字段每帧重解析。
- 真实PNG→JPEG helper生成10×2图，核对母图/JPEG SHA、ROI、origin/scale和坐标映射；6个篡改/越界/尺寸/resize反例非零退出且不留输出。
- CLI正常demo和独立replay通过：移动→交谈→接任务→击杀→拾取→交付，real_inputs=0、chooser_calls=0；模拟效果与真实game_effect分开。只读日志CLI通过真实Windows→TS协议链，事件eligible_for_current_state=false。

首次全量331项通过后，第二轮新增测试的332项中，旧Jev等待回放出现`wait_post_observation_early`。实际100次10ms Node timer探针发现一次floor elapsed=9ms/performance elapsed=9.208ms，单次timer完成不能证明完整等待。修复按协调器截止时间补足剩余等待，早源capture仍拒绝；3项确定性反例及最终335项通过，未修改回放门槛。原失败保留。

日志CLI第一次使用npm入口的相对路径，因npm工作目录为agent而报`combat_spawn_failed`；改用输出提示的绝对路径后通过。属于路径使用问题，原失败保留，不标模型或权限失败。

## 留存与接续

原始证据归档到主checkout `out/acceptance/four-layer-runtime/worktree-archive-1/`，含负责人/动作/区域证据、CLI运行及回放、失败记录、原生源码与二进制SHA。`archive-manifest.json`逐文件记录SHA；回放保留冻结schema和来源，不依赖当前源码冒充当时版本。

体验见 `docs/layers-runtime.md`。本轮只读枚举没有检测到可用WoW窗口，没有抢焦点或启动游戏。下一步需真实游戏布局/profile与OCR权重校准，再验收有限物理时间线、角色动作/技能/任务效果；通用导航、驭空术、完整职业策略、自主升级，以及四层任务/学习日志与既有大脑入口直接接入仍有实际工作。强杀及完整WSL重启不能从编译、模拟或正常退出推断通过。
