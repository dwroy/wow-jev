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

## 当前4K只读实测

用户打开游戏并进入角色场景后，重新枚举HWND `0x12c0892`、PID `25160`，不复用旧窗口身份。`capture-4k-2`请求录制60秒，每次保存间隔1000ms；实际51张3840×2160客户区图，首末采样约0.23–60.1秒，采样/收尾总时长约65秒。不是精确每秒一张的60帧。51次capture均ok，图像hash均不同；Eye独立严格回放260条记录/51观察/51图/0动作通过。

`corpus-4k-2/label-a`、`label-b`两名Agent分别逐图看全图和原像素HUD，三字段标签153/153一致，冻结来源与分组在`adjudicated`。仍是Agent视觉标签，非用户确认人类金标准。0–11是玩家鬼魂，12起复活；不得标为目标死亡。35–37/39–40选中活目标，43选中死亡目标，其余45张无目标，target.dead保持unknown；35–41玩家处于战斗。35–43为一个连续战斗事件，不能拆相邻帧制造独立留出。只有一个死亡正例，尚不足独立死亡验收。

真实游戏只读Jev/Seed在`retail-observe-4k-1`完成三轮，模型固定doubao-seed-2-0-mini-260428，回复均有效且选择wait；耗时2518/2410/1608ms，共5652输入/203输出token。9张真实源图/观察、重新采样、有限wait和85条日志独立严格回放通过，source_verified=true，真实/模拟输入和效果确认均0。此入口候选只有wait，只验证实际截图、模型选择协议、来源关联和等待回放，不验证主动选择、识别准确率或动作效果。

51张录制全为游戏前台，不能当后台稳定性证据。WinEye代码允许非前台客户区PrintWindow，要求窗口非最小化并能渲染；API失败/近黑图不可用。非黑静态画面不能仅凭hash不变推断停更，后台渲染暂停检测尚未验收。真实键鼠仍须前台，失焦停止且不抢焦点。录制与上述只读模型验收均已结束，用户可正常操作。

当前4K候选模板`cv-4k-2`仅从ghost-travel及整个combat-sequence-01训练组选择ROI/模板；存在和战斗阈值沿用.12/.04，死亡沿用旧v3的.02/.04及独立绿色血条证据。配置、原生程序和来源hash在分类前冻结，真实Windows离线仅运行一轮，没有用留出结果调整阈值。全量51图：存在43known全部正确、8unknown；战斗51known正确；死亡6个有效目标标签中4known正确、2unknown（39/40存在未确认），45无目标均保持unknown。唯一死亡true是43自身模板训练重代入，不能称独立死亡准确率。

四组30图负例留出：存在26known正确/4unknown，战斗30false正确，死亡30unknown正确弃判；没有活目标、死目标或战斗true的独立留出。名字掩码四次known输出四个不同SHA，35–37连续可见同名外观也不同，签名稳定性未通过。这是保存JPEG上的离线结果，不能直接外推原生实时位图，但也不能据此允许live动作。需要稳定且有时效的目标身份依据；可见名称仍不是实体GUID。完整结果与限制在`cv-4k-2/analysis.json`，本轮不改变工程源码、不发送输入。

## 剩余实测

当前4K录制及只读在线Jev/Seed已完成，原未检测窗口的`capture-4k-1/summary.json`保留。当前布局候选校准仅检查训练重代入及无目标/非战斗负例留出，仍需修复目标签名稳定性、补新独立战斗事件中的活目标/选中死目标正例和unknown边界，再进行用户准备好场景后的有限真实动作验收；不把训练样本、只读等待或人工接任务报告为自动游戏任务完成。

运动效果自动确认、同名目标区分、任务对话、敌我/距离/技能就绪均未在第4阶段实现。执行大脑、离线学习和版本迭代的后续工程已按用户要求完成，范围见[stages-5-7.md](stages-5-7.md)，不能替代上述正式服验收。整WSL重启恢复仍需独立验收。
