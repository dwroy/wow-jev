# L3 行为与 L4 任务首版运行契约

记录日期：2026-10-05。实现位于 `agent/src/behavior/`、`agent/src/tasks/`；参数唯一格式来源是 `protocol/layer-behavior-v1.schema.json`，共用人物动作与结果来自 `agent/src/layers/contracts.ts`。本模块没有读取凭据、调用网络或发送游戏输入。下述验证为明确模拟端口，不代表正式服游戏效果、飞行、导航或职业轮转已验收。

## 调用入口

```ts
const behavior = new BehaviorRuntime(ports, {
  maxFieldAgeMs: 1000,
  maxObservationAgeMs: 1000,
  // 默认仅 cv/window；经过独立验收的 OCR 字段可显式增加 local_ocr。
  trustedSources: ['cv', 'window'],
});
const jev = new BehaviorJev(ports, optionalChooser);
const selected = await jev.select(candidates, executionContext, {
  id: 'boundary-1', timeoutMs: 5000,
  isCurrent: () => taskRevision === executionContext.task_revision && epoch === executionContext.run_epoch,
});
if (selected.status === 'selected') {
  await behavior.run(selected.candidate!.behavior, executionContext, { isCurrent });
}
const task = new TaskRuntime(ports, behavior, jev);
await task.run(taskSpec, taskContext, { isCurrent });
```

`BehaviorPorts` 提供协调器时钟、观察、`executeBody(BodyAction, Observation, ExecutionContext)`、释放和异步日志。感知与选择端口不发送输入。执行端口必须遵守人物动作执行闸、模式、有限原生期限、取消信号和独立释放看门狗。JS 租约不能代替 Windows 在协调器死亡后的物理释放。

`ExecutionContext` 包含 command/task ID、task revision、run epoch、live/simulated、进入条件与 AbortSignal。只读模式由外层入口执行观察/选择而不调用执行端口；行为和任务执行严格只接收 shared `live | simulated`，不能在 live 入口将原观察改名为 simulated。`isCurrent()` 在每次动作前后检查，也在异步端口等待期间每 25ms 检查；此数字是本地取消轮询配置，不是实测 CV 或游戏控制频率。

`BehaviorRuntime.run(spec, context, {isCurrent?})` 返回共享行为结果并补充 `input_count_scope: known | lower_bound`。同 task/revision/epoch/mode/行为 ID 的重复请求复用同一 Promise，不重复动作；同 ID 不同参数/条件返回 conflict。同一 Runtime 同时只运行一个行为，另一个不同 ID 的并发请求 busy 且不释放原 owner；任务 Runtime 同样串行。取消不会复活，恢复应由任务编排创建新的控制身份。

`BehaviorJev.select(candidates, context, {id,timeoutMs?,isCurrent?})` 返回 status、reason、chooser_calls、request、selection、candidate 与重验证观察。唯一有效候选由本地直接选择；多个有效候选需要注入 `BehaviorChooser`，未配置时 blocked。整个边界选择，包括选前观察、异步日志、模型等待与重新观察，共用默认 5 秒、最多 15 秒租约。request 包含任务 revision/epoch、原观察 ID、候选 SHA256 和 deadline；只接受同 request ID 的已列 candidate ID。模型不能修改参数或生成键鼠动作。

`StructuredBehaviorChooser(transport)` 接收 `(prompt, AbortSignal) => Promise<unknown>` 的结构化文字模型适配。它拒绝额外字段、重复 JSON 属性（含转义重复属性）、错误 request ID 和未知 candidate ID。`behavior-choice-v1` 与固定 prompt SHA256 进入边界日志。此首版不内置 Seed 凭据读取或 HTTP worker；集成层可注入既有环境读取模块提供的文字 transport，未配置不伪造模型调用成功。长行为内部没有 chooser 循环。

`TaskRuntime.run(task, TaskContext, {isCurrent?,checkpoint?,verifyCheckpoint?})` 返回行为结果列表、chooser_calls、输入计数与范围、释放/效果状态、checkpoint。checkpoint 包含任务内容 SHA256、身份、模式、下一行为、已完成行为、任务源计数、证据 ID、已用时间和已尝试行为数。外部 checkpoint 必须匹配同 revision/epoch/mode/内容，且 `verifyCheckpoint(checkpoint,freshObservation)` 明确验证日志来源与当前可恢复状态；否则 blocked/failed，不直接按 JSON 跳过任务。剩余时间与行为预算继承 checkpoint，已取消的当前实例仍由幂等缓存拒绝重发。

## 参数与有限状态机

所有 params 严格拒绝额外字段；ID 为 1–256 字符。行为最长 120 秒、最多 256 次动作；动作片段默认 200ms，允许 1–1000ms；任务最长 600 秒、最多 512 个行为。wait 同样占动作预算。执行动作前还要求该片段完整放入剩余行为期限。

| kind | 必需 params | 本地状态机与完成证据 |
| --- | --- | --- |
| kill_target | target_signature；attack_ability 或 skill_priority | 新鲜同绑定目标存活 → 本地技能策略 → 动作后新鲜同目标死亡。初始尸体 blocked；死亡观察不证明本角色击杀贡献 |
| loot_target | target_signature | 尸体与可拾取 → interact → 同目标 loot.completed 新证据；已拾取可幂等完成 |
| talk_to | target_signature | 已知对话关闭 → interact → 同 NPC 对话打开；已打开可完成 |
| accept_quest | target_signature、quest_id | 打开对话 → 唯一明确任务 accept 元素 → click → 新 quest.accepted；关闭窗口不算接受成功 |
| turn_in_quest | target_signature、quest_id、reward_policy | 任务完成 → 打开对话 → 明确 reward（若需要）→ complete/turn_in → 新 turned_in 与 reward_received |
| move_to | destination_id | 确定定位/模式 → 校准 next_turn_dx 修正 → 方向对齐后有限 move → arrived；连续三步无进展 blocked |
| fly_to | destination_id、flight_mode | 已定位的 steady_flight 沿已校准航向片段前进 → arrived；taxi/skyriding 显式 unsupported 状态原因，不盲按空格 |
| avoid_hazard | 无 | 新鲜 hazard.active → 已验证 safe_axis 短移动 → 默认两个新观察确认安全；未知安全方向停止 |
| recover_stuck | destination_id | 已知 ground/stuck/safe-space → 最多默认三次有限后退、横移、跳跃（可扩至五次转向、前进）→ 新进展且 stuck=false |

目标行为可选 `target_instance_id`；输入时条件包含 target.signature 和该 instance ID。target.signature 仅可见签名，可能是姓名/分类；不能称 GUID。target.identity_ambiguous 明确 true 立即 blocked；同名目标如有不同可靠 instance/track ID 则阻塞。没有可靠 instance ID 时，只能确认可见绑定目标的状态变化，仍不能证明实体唯一性或击杀归属。

`kill_target.skill_priority` 最多 16 项，每项 `ability、category、conditions`。category 为 damage/interrupt/control/defensive/heal；非 damage 必须至少一条显式条件。每步按列表寻找所有条件与当前 CV ready=true 的第一项，未知/过期条件跳过。兼容 attack_ability 作为末位 damage fallback。全部已知未 ready 时有限 wait；没有可信 ready 数据时 blocked。category 仅表示本地策略，不推导技能瞬发、读条、引导、目标类型或移动相容性；这些由 L2 ability profile 校验。

`turn_in_quest.reward_policy` 为 none 或 explicit。explicit 必须带 reward_id；none 不得带 reward_id，遇可选奖励时 blocked。点击选奖励只表明输入发出；explicit 须有点击后的 selected_reward_id 匹配，并在终态由 received_reward_id 核对确切奖励。最终须有任务交付与奖励收到证据，已交付但奖励未知时不再次点击交付。元素歧义、不同任务页、按钮不可用或坐标越界不点击。

所有行为遇新鲜 hazard.active=true 可在本地先释放，然后按明确 safe_axis 躲避并继续原行为；不会等待 Jev。危险操作同样消耗原行为预算。行为绑定已变或任务版本已变时终止；它不是对未知危险方向的猜测。

## 原子观察字段

以下键为 `Observation.fields` 的直接键，不是 JSON 嵌套路径。每项使用既有 ObservedField：status、value、source、captured_at_ms、source_observation_id、可选 capture_window。字段源时间在协调器时钟内；不能直接从 Windows QPC 换算。

默认 live 只信 cv/window。即使加入其他 trustedSources，Seed、manual、simulated 也不能授权 live 行为；navigation/hazard/combat 及目标生死/敌对/可攻击条件只接收 cv/window，技能 ready 进一步必须同帧 cv。local_ocr 保留独立来源，不冒充 cv；对话/任务 OCR 必须先有独立验收并显式在 trustedSources 列入。unknown/unavailable、缺少、过期、未来时间、无源 ID、错误捕获时间窗都不能满足进入/效果条件。当前帧要求 source_observation_id=observation.id；效果字段还要求源捕获时间不早于相关动作完成时间。

| 字段 | value 契约与用途 |
| --- | --- |
| window.focused | boolean，同帧 window；live 还校验 window token/hwnd/PID/物理客户区尺寸连续不变 |
| target.signature | string，明确可见目标绑定；绝不直接解释为实体 GUID |
| target.instance_id / target.identity_ambiguous | 可选可靠 string 实例身份；boolean 明确歧义，true 阻塞 |
| target.dead / target.alive | boolean，至少一项同帧可信；dead=false 可确定性反相为 alive=true，冲突 blocked；目标存在不推导 alive |
| target.hostile / target.attackable | boolean，均必须已知 true 才发战斗技能 |
| combat.ability.&lt;ability&gt;.ready | boolean，live 必须同帧 cv；映射/cooldown/GCD/资源的确定证据由上游提供 |
| target.lootable | boolean，尸体交互前必须 true |
| loot.target_signature / loot.completed | string 与 boolean，结果同绑定；动作后必须新捕获 |
| dialog.open / dialog.target_signature | boolean 与 string，按钮页和 NPC 对话绑定 |
| dialog.elements | 数组，每项 `{id,role,quest_id?,reward_id?,x,y,enabled}`；role 为 talk/accept/turn_in/reward/complete，x/y 为客户区物理整数像素，enabled 必须 true；按 role+quest+reward 唯一匹配 |
| quest.&lt;questId&gt;.accepted / completed / turned_in / reward_received | boolean；交任务结束同时需要 turned_in 与 reward_received，不以面板关闭替代 |
| quest.&lt;questId&gt;.selected_reward_id / received_reward_id | string，explicit 奖励点击后的选中项及终态实际收到的奖励必须匹配配置 reward_id |
| quest.&lt;questId&gt;.count | 非负安全整数，关联该任务目标的权威进度；kill_count 只读此源值，不累加死帧 |
| navigation.destination_id / mode | string 目标及 ground/steady_flight/skyriding/taxi 模式；定位器明确提供 |
| navigation.arrived / progress | boolean 到达与非负有限 number 累计定位进度；不是输入时间或场景光流的别名 |
| navigation.heading_aligned / next_turn_dx | boolean 与已校准、有符号非零整数鼠标像素（绝对值≤500）；不把 dx 当角度 |
| navigation.stuck / recover_safe | boolean；脱困须证明当前卡住且允许有限恢复动作的安全空间 |
| hazard.active / safe_axis | 同帧 boolean 与 forward/backward/strafe_left/strafe_right，安全方向已验证；不由文本模型猜 |

任务 sequence 顺序组合行为；kill_count 只接受 kill_target 行为候选，读取已关联 quest.count 的绝对源值并要求行为后新鲜增加，未知、回退或不增长即阻塞；deliver_quest 可由 move_to/fly_to/talk_to/turn_in_quest 组合，最后必须是匹配同 quest/reward 策略的 turn_in_quest。任务完成必须所有相关释放 confirmed，输入范围 known。任务字段与行为完成分别记录。

## 取消、日志与实测边界

RunLease 覆盖观察、模型、日志与身体端口；期限和外部取消会中止等待并向身体端口传 AbortSignal。每次结束独立尝试 release；释放与最终日志各自最多等待 1 秒，超时留为 unconfirmed/failed。异步日志失败会停止行为并释放。日志关联任务/epoch、行为/command、候选/版本、源观察、输入回执与新效果证据。

身体提交后若 terminal receipt 不回来，real_inputs 只保留已知下界，input_count_scope=lower_bound；不能报告零真实输入已确认或 completed。release confirmed 与效果 confirmed 分别保存。原生 port 必须拒绝终止 lease 后的迟到输入，不能仅靠协调器 finally；本模块模拟测试没有证明强杀、WSL 重启或原生看门狗恢复。

可运行验收：

```sh
cd agent
npm run typecheck
./node_modules/.bin/tsx --test tests/behavior-task-runtime.test.ts
```

测试用例明确模拟：一次 chooser 对应多个施法；唯一行为零模型调用；防御→打断→输出；严格 JSON/hash/参数；目标死亡和同名切换；CV/Seed/模拟来源隔离；定位/飞行模式；对话/奖励/拾取；危险抢占/有限脱困；挂起端口取消、epoch变化、预算和释放；kill_count 新源进度；checkpoint 可信恢复及预算。真实缺口包括目标实体唯一性、职业资源与 GCD 数据、导航/飞行定位、对话任务/奖励检测、端口中断后的物理释放和正式服闭环效果。

2026-10-05 本模块验收：TypeScript typecheck 通过；上述行为/任务专测 26/26 通过，包含明确模拟的多个身体动作与一次 Jev 选择；完整 agent 回归 292/292 通过。真实游戏输入 0 次，模型 API 调用 0 次，未读取凭据。正式服效果、强杀/WSL 重启释放及上述真实缺口仍未由本模块验收。
