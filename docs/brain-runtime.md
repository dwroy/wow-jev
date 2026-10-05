# 第5阶段：执行大脑与工作记忆

执行大脑把目标分成有限阶段，并独占协调代码 play 与 Jev。工程入口是 `agent/src/brain/execution/runtime.ts` 的 `ExecutionBrain`；本轮 CLI 由系统入口提供，只有模拟模式。真实 NPC 距离/对话框感知与正式服输入验收仍需后续补录，不能从这些测试外推。

## 可执行目标

目标经过 `parseBrainGoal` 完整字段校验，不接受任意计划、坐标或按键。

```json
{"id":"observe","revision":1,"kind":"observe","description":"收集观察"}
```

```json
{"id":"panel","revision":1,"kind":"panel_cycle","description":"背包打开后关闭","panel":"inventory"}
```

```json
{"id":"npc","revision":1,"kind":"approach_npc","description":"接近已选任务员并交互","target_signature":"已观察的目标指纹","target_name":"已观察的NPC名称","allow_movement":true,"interaction_slot":null}
```

默认没有交互键。只有目标的 `interaction_slot` 和 `bindings.action_slots` 都显式配置时，交互才可能使用现有 `use_action_slot`。

NPC 每次主动行动要求同截图的新鲜 `capture.available=true`、焦点、目标存在、指纹与名称匹配、目标未死、玩家不在战斗。`npc.in_interaction_range=false` 才提供 100ms 前进候选；该字段或对话框开闭状态未知则等待，连续缺证据后升级。字段为 true 才提供交互槽位候选。对话完成只依据随后新鲜的 `ui.npc_dialog_open=true` 和同目标证据；输入回执、运动次数或模型推断都不表示到达。

## 接口与独占

`new ExecutionBrain(ports, options)`，然后调用 `run(goal)`。工作记忆包含 epoch、目标 revision、阶段、等待次数、有限移动次数、最近观察和已完成阶段。版本对象、知识、绑定在构造时深复制冻结，不热更新。

Ports 提供 `now/collect/append/planner/executeCode/executeJev/release`，不向大脑暴露 native 手。执行端必须：

1. 复用 context.revalidated 作为第一次 CodePlay/Jev 观察。
2. 给编译器追加 context.conditions。
3. 每次启动/发送前校验 context.signal 和 context.isCurrent()。
4. 释放时取消当前 CodePlay/Jev，并等待其结束与输入释放。

`updateGoal` 仅接受同目标 ID 的递增 revision。旧 epoch 的 AbortSignal 先失效，端口释放和旧 runner 收束均受总计 3 秒约束；只有 confirmed 后才生成新 epoch。无法收束时停止运行。模型回复的 ID/revision/观察/知识引用必须全部对应当前请求；迟到回复不执行。`cancel` 粘滞且释放幂等，同实例不能重新开始。BrainResult 分开记录控制结果、`release` 和 `game_effect`；任何 simulated run 的游戏效果均为 unverified。

## 本地规划与 Seed

本地构造有限 routes：code 单步骤计划、受限 Jev goal、wait、complete、escalate。`DisabledPlanner` 不创建进程、不读取图片或凭据、不请求 API；大脑在这一明确禁用模式中选择本地第一个安全候选。失败或超时模型不会自动提升为行动候选。

`SeedBrainClient` 使用串行 `perception/brain_worker.py`，显式 `allowGameImageUpload` 才启用上传和凭据加载。沿用 seed_worker 的凭据、JPEG校验、固定 HTTPS运输、超时中断和错误码清洗。默认凭据位置仍是 `~/.config/wow-jev/api.env`，模型为 `doubao-seed-2-0-mini-260428`。这里只上传已有WoW客户区截图；worker不操作Windows。

候选 prompt 使用协议 ID `brain-retail-v1`，真正版本由 RuntimeVersion 与 SHA 区分。`promptFile/promptSha256` 传至 worker 的 `--prompt-file/--prompt-sha256`；文件必须有界、regular、非符号链接且哈希匹配。回复必须是精确JSON，包含 request_id、plan_revision、route_id、evidence_observation_id、consulted_fact_ids、reason。模拟规划端口可明确使用 model=null；live 和实际 SeedBrainClient 仍要求固定 Seed 模型，不能伪装模型调用。多键重复、代码围栏、未知路由和自行添加键鼠都拒绝。

## 知识与回放

系统先通过学习模块加载并校验 KnowledgeSnapshot，Brain 再按目标、技能阶段、目标名、场景、窗口布局、校准以及来源完整性查询。完整 live 经验可以在模拟中咨询，但来源模式仍为 live；live 运行拒绝 simulated 经验。`journal_complete` 与 `mode` 是来源约束，`panel`、布局与校准是场景约束。游戏目标默认 test_target=false，专用输入测试窗口的 true 经验不进入游戏决策。仅 goal_kind、target_name、scene、layout、calibration_id、skill、panel、test_target 用作适用范围；inventory_open_after 等历史结果和 name_source 等来源说明保留为资料，不能被当作当前观察条件或键鼠授权。observed 事实和 inferred 建议在请求中保留 certainty，审批另记 inferred_fact_ids。保守建议只能关闭运动、收紧移动次数或延长有限等待，不能增加技能或键鼠授权。

每个 brain.request 和 brain.approval 都记录实际 consulted_fact_ids、完整 consulted_facts 与 knowledge_sha256；版本清单不能代替这一实际消费记录。知识文件使用统一 canonical JSON 字节 SHA，无尾部换行。

`replayBrainRun(directory,{verifyJev?})` 要求日志 manifest.config 含 mode、bindings、brain_goal、runtime_version、knowledge_snapshot，并建议保存 frozen_knowledge_file=`knowledge.json` 与 frozen_runtime_version_file=`runtime-version.json`。它核文件SHA、对象、冻结prompt、schema和源观察，重新生成 routes/知识查询/阶段，再默认调用 `replayPlayJournal` 验证各code宏。每decision的plan ID独立，日志任意计划不可信。

Jev宏由系统提供完整 Jev journal 验证回调，收到 `{directory,journal,records,goal,conditions,firstObservationId,result,decisionId}` 并返回 `{complete,real_inputs,simulated_inputs}`。无该回调不能认证Jev宏。取消日志可以严格回放，但不会标记 complete；旧runner的终态必须在 brain.finished 之前，晚到日志不能补成成功。

## 本轮验证

`cd agent && npm exec -- tsx --test tests/brain-*.test.ts`；`npm run typecheck`。

`/home/dai/Projects/wow-jev/.venv/bin/python -m pytest tests/test_brain_worker.py -q`。

覆盖实际串行Pythonworker禁用/候选prompt边界、严格模型JSON、失焦/目标丢失/死目标/战斗/缺距离/缺交互绑定、计划切换屏障、粘滞取消、迟到回复、知识实际影响、真实CodePlay模拟journal与多种日志篡改。编译、模拟和真实游戏验收分开报告。本模块没有进行当前正式服NPC实测，也没有读凭据或网络调用；真实Seed离线probe由负责人单独留存。
