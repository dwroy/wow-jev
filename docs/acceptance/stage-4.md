# 第4阶段 Jev 小脑验收

2026-10-05。负责人按战斗CV/状态融合、候选与Seed选择、调度/回放三模块在工作树并行实施，并集成独立 CLI。工程实现可模拟体验；第4阶段整体尚未通过正式服验收。

## 已实现

- Windows 独立战斗校准：target.present、target.dead、player.in_combat 和目标名称字形签名；已启用CV的未知结果不能被Seed覆盖。目标变化/未知会清空旧Seed目标字段，迟到回答携带冻结来源上下文。
- 本地有限候选：目标为observe或没有足够新鲜CV时只有等待。practice模式按明确目标、键位与槽位生成有限短移动/转向/技能槽，Seed只能返回候选ID。
- 串行Jev闭环：选择后重新截图、重建候选、复核目标/窗口/尺寸/条件，再交CodePlay。整轮和单次回答有期限；取消锁存，迟到回答不能恢复执行。
- wait步骤是真实可取消的有限等待，不生成动作意图、输入或模拟回执。observe/demo不启动手；live需显式场景、目标和战斗校准，仍不抢焦点。
- 严格多计划回放：从审计候选推导计划，核验决策ID、原始回复、候选hash、冻结prompt/schema、截图来源和执行回执；真实Jev输入绑定此前native ready的窗口、尺寸与session。

## 真实 Seed 离线 probe

使用已授权的旧WoW截图和人为构造的观察/候选，真实调用 doubao-seed-2-0-mini-260428。它验证模型选择协议和画面判断，不能代替在线CV、当前游戏观察或实际动作效果。

| 场景 | 返回ID | 端到端耗时 | 输入/输出token |
| --- | --- | --- | --- |
| 无目标，只有等待 | wait | 1737ms | 1768 / 34 |
| 活目标，前进或等待 | move-forward | 1349ms | 2009 / 40 |
| 死亡目标，转向或等待 | wait | 1648ms | 2222 / 33 |

3/3回复和选择均有效，均在15秒期限内；总5999输入/107输出token。原始回复、截图SHA、worker/prompt/schema/工具快照和后验校验在 `out/acceptance/stage-4/seed-probe-1`。没有调用native hand或发送输入。无目标例是wait-only，不能当多候选能力证据；总共3张图不能推断广泛准确率。

## 战斗 CV 离线证据

46张旧2048×1536真实截图、10个事件组来自冻结战斗对照语料；标签由两名Agent盲标，尚不是用户确认的人类金标准。combat-01/02两个事件组20图用于训练，另8组26图留出。

存在检测全体42/46 known且正确，留出22/26；战斗标记46/46、留出26/26。死亡v1曾在两张训练边界图误输出known=false，原始失败保留。v2仅根据训练收紧阈值，死亡留出已知标签召回2/10。

glyph-v3只用训练图选择规则：匹配黄色死亡字形确认true；false还需独立绿色生命条证据，没有死亡字但生命条不足时unknown。代码、配置、原生程序和数据分组先冻结，再做一轮留出评估，没有根据留出修改规则。死亡全体18/21已知标签正确召回，留出7/10；所有输出known均正确，留出16个原unknown标签保持unknown。依然没有达到此前95%完整门槛。

各轮证据在 `out/acceptance/stage-4/cv-1`，v3在 `death-glyph-v3`。3张第3阶段4K截图使用2048战斗bundle时返回unknown并保留校准ID；背包校准仍正常，不能把尺寸不符绕过为Seed条件。详细接口见 [combat-cv.md](../combat-cv.md)。

## 工程验证

纯模拟demo-1完成5次决策（4个模拟动作、1次等待），74条日志，独立回放通过；真实输入/真实效果确认都是0。证据在 `out/acceptance/stage-4/demo-1/run`。CLI另验证无授权参数/模拟上传在创建日志和进程前拒绝、跨终端取消等待以及取消终态独立回放。取消回放的complete=false表示目标未完成，status=cancelled，不能改成成功完成。

协议/候选/worker/循环/回放与原生mock覆盖目标漂移、过期字段、窗口/计划变化、候选外答案、重复JSON键、超时、取消、来源篡改、错误native ready/session和冻结文件损坏。mock只能证明对应链路逻辑，不能代替Windows真实输入或游戏效果。焦点等待取消另覆盖探测前/探测中/等待间隔，旧入口兼容。

最终集成155项TypeScript测试、75项Python/真实Windows离线分类测试、typecheck和四模块原生构建均通过；Python原生用显式WOW_COMBAT_EYE_EXE运行，未跳过。结果保存在 `out/acceptance/stage-4/integration-1`；运行方法见 [jev-runtime.md](../jev-runtime.md)。旧CodePlay日志保持可回放，第3阶段正式服证据仍是其原有有限范围。

负责人以129bf78本地合并工程分项至codex/agent-system；主目录四模块重新构建，main-demo-1五次决策及独立回放通过，冻结代码dirty=false。旧retail-3分别经新CodePlay/Eye严格回放通过，514条日志、50观察、25旧动作、10旧confirmed；这些是既有动作证据，本轮实际游戏输入为0。工作树正常清理、分支保留；8份必要二进制已归档并记录SHA。

集成命令：`npm --prefix agent test`、`npm --prefix agent run typecheck`、`bash native/windows/build.sh`；Python用项目.venv执行 `pytest tests/test_jev_worker.py tests/test_seed_worker.py tests/test_combat_calibrate.py tests/test_combat_native.py -q` 并指定本轮构建的WinEye。测试首次把取消日志的complete误断言为true，失败记录保留；按既有语义修正为false/status=cancelled后通过，没有改写运行器取消结果。

## 剩余实测

当前未检测到可用WoW窗口，只读4K战斗录制未开始，记录在 `capture-4k-1/summary.json`。需要当前布局的选中/清除目标、打怪、死亡后保留目标样本，建立独立4K校准并验证unknown边界。随后先做只读在线Jev/Seed，再进行用户准备好场景后的有限真实动作验收；不把离线样本选择或人工接任务报告为自动游戏任务完成。

运动效果自动确认、同名目标区分、任务对话、敌我/距离/技能就绪、执行大脑与学习大脑均未在第4阶段实现。整WSL重启恢复仍需独立验收。
