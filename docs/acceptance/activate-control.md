# 通用控件激活与 recording fixture 结果边界

`activate_control` 是 L3 的通用 UI 行为，复用已有 Body `click`、统一执行闸和 hand。它不把录制窗口当 NPC，不引入教程交谈特例。

## 契约

行为参数仅为 `target_signature`、`control_id`、可选 `action_duration_ms`（1–150ms），`max_actions=1`。坐标来自当前 CV `ui.elements`，不能在参数中填坐标、fixture 标志或 target_scope。

```json
{
  "id": "activate-once",
  "kind": "activate_control",
  "params": {
    "target_signature": "<当前原生控件目标签名>",
    "control_id": "fixture-click",
    "action_duration_ms": 10
  },
  "max_duration_ms": 2000,
  "max_actions": 1
}
```

需要的同源当前字段为 `target.signature`、`ui.layout_id`、`input.mouse_mode=ui`、`ui.elements` 和 `ui.control_state`。控件行严格包含 `{id,x,y,layout_id,enabled}`；状态严格包含 `{control_id,activation_count,state_token,frame_nonce,layout_id}`。L3 只在唯一、启用、客户区内、布局一致的当前 CV 控件上编译一次有限左点击。缺状态或没有可验证激活计数的 UI 返回 unknown/blocked，不从输入回执生成计数。

原生 recorder 可将实际 `click_count` 映射为 activation_count，state_token 为其字符串；frame_nonce 来自独立渲染帧。scope 是 Native HostReady/memory_frame 的 `target_scope`，不来自模型或 public params。控件、状态和范围字段在可信适配器完成之后一起登记 MemoryFrameProof，不修改冻结世界包，也不写教程/世界事实或调用 Seed。

## 原生作用域核验

`BehaviorOptions.targetScopeVerifier(observation)` 是运行时注入的可信来源能力，返回 `BoundTargetScope`：

- `scope`: `retail_wow` 或 `recording_fixture`。
- 当前 source_observation_id 与窗口 token/HWND/PID。
- 已认证原生目标和通道生成的稳定 native_target_id（64 字符的十六进制 SHA 字符串）。

生产 resolver 必须找到该 exact observation 的原 Collected，核验 `registry.owns`、当前活连接、原源 scope 与固定原生进程身份，再返回证明。不能直接读取任意 JSON 的 `window.scope` 并把它当权威。参考稳定标识为 hash([memory_frame.target_scope, memory_frame.target, channel_generation, host_start_ticks])。

L3/L4 在观察刚到达、原生 source 仍有效时立即核验并冻结初始 scope/身份。后帧覆盖 client current slot 后，仅核验新的原生 source 并对比初始身份，不重新给旧 sample 续期。scope 字段必须属于当前 observation，live 来源为 window，并与可信 proof 一致。

现有 **无作用域标记** 的 live/sim 行为继续原路；任何明确标记作用域却没有 native verifier 的观察都拒绝。`activate_control` 总是要求 verifier。参数自称 fixture、JSON 复制或错 target/native identity/window proof 都不能分类或授权。

## 输入与效果分开

点击前保存真实激活计数、状态 token、渲染 nonce 与布局。Body 输入完成和释放 ACK 只表示输入已结束。之后必须使用独立后观察：不同 ID、更大的 observation_seq、字段采集下界不早于 Body 回执结束时刻，且 target/scope/原生身份/布局保持一致。

只有 activation_count **恰好加 1**、state_token 改变、frame_nonce **严格增加** 才确认控件激活。只 nonce/token 变化、计数跳跃、旧图、重复帧、迟到旧字段或释放不确认均停止；此行为不重试，也不会因 hazard 改发游戏移动。

`recording_fixture` 的行为和任务结果始终 `game_effect=unverified`，真实控件证明放在独立 `fixture_effect`。fixture 只允许 control 行为/sequence，不进入 NPC、战斗或任务交付流程。任务汇总要求所有本轮 control 的 fixture_effect 已确认；不凭 public 已完成 checkpoint 宣称测到了 fixture 效果。日志失败、Body/最终释放不确认均清除 fixture 确认。

新字段是兼容性的可选结果字段。旧无标记行为/任务保持原结果结构与 simulated scenario_effect 规则。一个有界控件流程在 **已核验的 retail_wow** UI 上可报告实际 UI game_effect，fixture_effect 保持 unverified；没有自然控件状态计数的真实 UI 仍拒绝执行，不虚构遥测。

## 本步验证与尚未验收项

最终专项 **90/90 TS，通过；失败/跳过 0；typecheck 通过**。其中新控件专项 16 项，另覆盖旧行为/任务、layer 集成、教程与 memory proof 回归；旧测试未删除或跳过。

专项实际经过 L4 sequence → L3 activate_control → Body click → memory 统一执行闸 → mock hand → 独立后帧的完整链。反例包含错范围/目标/原生身份、假/禁用/重复元素、Seed/旧字段、仅 token/nonce 变化、计数跳跃、nonce 回退、旧帧、布局/作用域切换、Body/最终释放不确认，以及录制窗口误作 NPC/战斗任务和 public checkpoint 伪造。

软件 fixtures 的 mock receipt 只检验公共组件语义，**本步真实 Windows 操作、游戏输入、模型调用、Windows 计划任务均为 0**。不能把软件计数当作真实游戏动作或真实原生输入性能。

用户已明确要求先完成离线工作、全绿推送后停止。RDP 当前断开；本步没有轮询现场。真实 recorder 的 WGC/有限输入性能、held 输入 EOF/lease 看门狗释放、正常/强杀生命周期及首个游戏交谈全部按各自实际证据保持 pending；不得为达到 p50 <150ms 放宽闸门。

日志：本工作树 `out/acceptance/activate-control/{tests-final.log,typecheck-final.log}`。Native DTO/schema 以对应 owner 的共享版本为编译依赖；最终全量发布验收由 root 在三个模块共同 Git 快照上执行。

复跑：

```sh
cd agent
node_modules/.bin/tsx --test tests/activate-control.test.ts tests/behavior-task-runtime.test.ts tests/layers-integration.test.ts tests/tutorial-layered.test.ts tests/memory-frame-gate.test.ts
npm run typecheck
```
