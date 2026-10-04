# WoW Agent 协议 v1

这是第 0 阶段的跨语言协议，覆盖观察、动作意图和执行回执。唯一的动作是 `simulate_noop`：不截图、不调用模型、不发送键鼠输入，也不确认任何真实游戏效果。

结构定义以 [`protocol/agent-v1.schema.json`](../protocol/agent-v1.schema.json) 为准，使用 JSON Schema draft-07。现有 [`protocol/schema_v1.json`](../protocol/schema_v1.json) 仍是 JevBridge 像素桥载荷定义，不属于同一版本体系。像素桥以后经过感知适配器转换成本协议的 Observation，不改动原有二进制协议。

## 1. 消息与时间域

跨进程使用 UTF-8 JSON Lines：每行一个完整 JSON 对象；stdout 只输出协议消息，诊断写 stderr。日志可以沿用相同消息。生产者不得产生重复对象键；原始重复键检测暂未实现，`JSON.parse` 会保留最后一个同名键。验证器拒绝非有限数字、错误版本和未声明字段，不做隐式数字、布尔值或动作名转换。

每种消息都必须有以下字段：

| 字段 | 含义 |
|---|---|
| `protocol` | 固定为 `wow-agent` |
| `version` | 固定为整数 `1` |
| `type` | `observation`、`action_intent` 或 `execution_receipt` |
| `id` | 本次运行内唯一消息 ID；1–128 个 ASCII 字符，限字母、数字、点、下划线、冒号和连字符，首字符为字母或数字 |
| `run_id` | 一次运行及其协调器时钟域；重启或回放创建新 ID |
| `at_ms` | 协调器本次运行内的单调时钟毫秒数，非负整数 |

`at_ms` 是消息进入统一运行日志的时间。观察字段另有 `captured_at_ms`，表示来源画面或来源事件的采集时间。两者都属于同一个 `run_id` 的协调器时钟域，整数上限为 JavaScript 的最大安全整数。

Windows QPC、游戏 GetTime 和 WSL 的单调时钟不共享起点。未经对时，不能相减或直接拿来计算时效。原始值可以存入字段的 `source_clock: {domain, value_ms}`，其 `domain` 必须标识具体生产者和时钟实例。原始游戏计时器回绕、游戏重启或进程重启后不能继续当作原时钟实例。

感知请求可以在协调器发起时标记采集时间，并将该时间沿截屏、识别和返回链传递。后续如果需要更精确的跨进程采集时间，再记录对时偏差和误差范围。不能先假定同机就是同一时钟。

Schema 验证消息的结构；以下关系必须由运行层检查：

- `captured_at_ms <= Observation.at_ms`，且字段时效使用当前协调器时间减去采集时间。
- 动作的 `deadline_ms >= ActionIntent.at_ms`；到达截止时间后不再开始执行。它不是允许持续按键的期限。
- 非空的 `started_at_ms <= finished_at_ms <= Receipt.at_ms`；未开始可将开始时间设为 `null`，仍在执行可将完成时间设为 `null`。
- 跨消息 ID、观察证据、动作、计划和回执属于同一运行。外部旧运行数据只能作为知识或回放来源重新导入，不能作为本次执行的即时状态。

JSON Schema 不能比较两个属性的数值、验证跨消息引用、证明真实效果或确认 Windows 当前焦点。格式通过不等于动作可以执行。

## 2. Observation：统一观察

除公共字段外，必须有 `observation_seq`、`window`、`fields` 和 `artifacts`。

- `observation_seq` 是本次运行内协调器分配的非负递增序号，与像素桥 u16 `seq` 分开。
- `window` 是 `null`，或 `{token, hwnd, pid, client_width, client_height, focused}`。没有绑定游戏窗口的模拟运行使用 `null`。
- `fields` 是以明确字段路径为键的映射，例如 `scene`、`player.hp`、`ui.chat_focused`。条件使用完整键精确查找，不自动遍历嵌套对象。
- `artifacts` 是证据附件列表，每项为 `{id, kind, path, sha256?}`。`kind` 为 `screenshot`、`raw_observation` 或 `log`。路径由日志生产者管理，读取时解析并验证存在性；消息接收本身不触发文件读取。

每个观察字段必须有：

```json
{
  "value": null,
  "status": "unknown",
  "captured_at_ms": 0,
  "source": "simulated",
  "source_observation_id": "obs-demo-1"
}
```

`source` 为 `cv`、`seed`、`pixel_bridge`、`window`、`simulated` 或 `manual`。可选 `confidence` 范围为 0–1，可选 `artifact_ids` 引用证据附件；必须能够通过 `source_observation_id` 追溯到源观察。人工或模拟数据同样要标明来源。

字段状态的区别：

| 状态 | 含义 | 值的约束 |
|---|---|---|
| `known` | 来源明确提供了这个值 | 可以是 JSON 值，包括明确的 `null` |
| `unknown` | 尚未看清或还不能判断 | 必须为 `null` |
| `unavailable` | 当前来源或配置没有提供这个字段的能力 | 必须为 `null` |

例如 `target` 的 `known + null` 表示明确没有目标；`unknown + null` 表示不能判断目标。未提供字段也表示未知，不能补成 0 或 false。`known` 表示有观测结果，不表示推断永远正确。

Seed 返回时间晚于截图时，字段继续使用原截图的 `captured_at_ms`。同一字段融合时先比较采集时间，不能让迟到结果覆盖更新的值。同一时刻不同来源冲突时，根据经过验证的字段来源规则处理，或保留未知；不能把模型自报的置信度当作校准准确率。

像素桥 `caps` 为 false 的字段映射为 `unavailable`，不能把载荷里的 0 当真值。像素桥低 32 位目标 GUID 只保存为来源片段，不冒充完整目标身份。

窗口 token 是绑定会话的身份，不能直接等于 HWND。窗口重新绑定或进程更换时生成新 token，并核对进程身份，防止 Windows 复用句柄。客户区宽高使用物理像素。未来的坐标动作还需明确截图缩放、裁剪变换和界面版本，不能仅凭尺寸相同复用旧点击位置。

## 3. ActionIntent：动作意图

必填字段：

| 字段 | 含义 |
|---|---|
| `plan: {id, revision}` | 当前计划身份及版本；revision 从 1 开始 |
| `based_on_observation_id` | 作出决定时使用的观察 |
| `actor` | `code`、`jev` 或 `brain` |
| `mode` | 第 0 步固定为 `simulated` |
| `window_token` | 本动作绑定的窗口会话；无窗口模拟时为 `null` |
| `action` | 第 0 步仅为 `{"name":"simulate_noop","args":{}}` |
| `deadline_ms` | 最晚允许开始执行的时间 |
| `conditions` | 本动作需要满足的观察条件列表，可为空 |

每项条件为 `{field, op, max_age_ms, value?}`，`op` 为 `eq`、`ne`、`exists`、`gte` 或 `lte`。

条件在执行前的最新统一观察上检查；只校验与动作有关的字段，不比较整个状态指纹。所有条件都要求字段存在、状态为 `known`、采集时间没有在未来，并且没有超过 `max_age_ms`。未知不能通过 `ne` 条件。

- `eq`、`ne` 必须带 `value`，按 JSON 值比较，不做类型转换。
- `gte`、`lte` 必须带数值 `value`，字段值也必须是数值；布尔值不算数值。
- `exists` 不带 `value`，检查字段是否提供了非空的已知值。明确空目标不能通过这个条件。

运行层还应检查当前计划 revision、窗口会话和必要的执行前置条件。新计划生效后，旧大脑回答和待执行动作失效。未来真实键鼠动作必须有非空窗口身份，并由 Windows 侧再次核实实际焦点；先前的 `focused: true` 不是持续有效的保证。

本阶段 schema 不接受真实动作名、任意 `args` 或 `mode: live` 的 ActionIntent。新增技能或输入动作时，先扩展动作注册表、schema 和验证，再接执行器。

## 4. ExecutionReceipt：输入与效果分开

必填 `action_id`、`revision`、`mode`、`input`、`effect` 和 `timing`。不设置顶层 `status` 或 `phase`，每次回执包含输入和效果的当前状态。

同一动作可以产生多个回执，每个回执有独立消息 ID，`revision` 严格递增。更新只能推进已知状态，不能用旧回执覆盖新回执。

`input` 必须有 `status`、`events_requested` 和 `events_inserted`；事件计数为非负整数。

| input.status | 含义 |
|---|---|
| `simulated` | 模拟器处理完成，零真实输入事件 |
| `rejected` | 执行前校验拒绝，没有提交输入 |
| `sent` | 请求的事件已进入系统输入流；不代表游戏接受或动作完成 |
| `partial` | 仅部分事件进入系统输入流，不自动重试 |
| `failed` | 执行失败，保留已提交事件计数 |
| `cancelled` | 已取消；如果先前存在长按，仍需完成释放 |
| `released` | 本动作持有的键或按钮已释放；不代表游戏效果成功 |

`rejected`、`partial`、`failed` 和 `cancelled` 必须有 `reason: {code, message?}`。`simulated` 和 `rejected` 的两个事件计数固定为 0。运行层检查 `events_inserted <= events_requested`；`sent` 的两者相等且大于 0；`partial` 为 `0 < events_inserted < events_requested`。计数覆盖本动作已请求的输入事件，包括后续释放事件。

`effect` 必须有 `status` 和 `evidence_observation_ids`：

| effect.status | 含义 |
|---|---|
| `pending` | 仍在等待效果观察 |
| `confirmed` | 后续观察支持本动作的预期效果，必须有证据观察 ID |
| `failed` | 观察到预期效果没有达成或明确失败，必须给原因 |
| `unknown` | 无法确认，包括观察超时，必须给原因 |
| `not_applicable` | 该流程没有真实游戏效果验证；证据列表为空 |

非空证据列表仅证明存在引用。运行层还要确认观察存在、属于同一运行、发生在实际输入之后，且包含能支持预期效果的字段。不能仅因为画面变化就确认成功。

第 0 步成功的模拟回执必须是：

```json
{
  "input": {"status": "simulated", "events_requested": 0, "events_inserted": 0},
  "effect": {"status": "not_applicable", "evidence_observation_ids": []}
}
```

Schema 为后续阶段保留 `mode: live` 的回执形状，当前没有合法的 live ActionIntent 或真实执行器。模拟模式强制零输入计数，效果固定为 `not_applicable`，不能生成 `sent` 或 `confirmed`。执行被拒绝的模拟回执同样没有真实效果验证。

## 5. 执行生命周期约束

以下是后续键鼠 adapter 必须实现的约束，本阶段仅定义契约，不宣称已有 Windows 实测：

- 一个 action ID 最多派发一次动作。重复同一请求返回既有回执；同 ID、不同内容拒绝。取消和释放是原动作的生命周期操作，不是重新派发。
- `partial`、确认超时或断连后先重新观察，不自动重复技能、点击或其他输入。
- 长按需要有限持续时间、输入所有权和 Windows 侧释放期限。执行开始 deadline 与按住期限分别管理，不开放无期限的 `key_down`。
- 失焦、取消、断连和急停释放本程序持有的键与按钮。释放不能被场景闸或焦点闸拒绝。取消不等于已经释放。
- 独立看门狗覆盖执行进程被强杀的场景；进程内 `finally` 无法保证这种情况下松键。
- 输入调度器统一管理重叠动作的键和按钮占用，防止一个动作结束时松开另一个动作仍持有的键。
- Record、Replay、Shadow 和模拟模式不能转发真实输入。真实执行通过明确的 adapter 和运行模式启用。

## 6. 正反例与验证边界

[`protocol/examples/`](../protocol/examples/) 按文件名前缀区分预期结果。反例是测试材料，不是可以发送的协议消息。

| 文件 | 预期结构验证结果 |
|---|---|
| `valid-observation.json` | 接受：模拟场景、未知目标、不可用的聊天焦点字段 |
| `valid-action-intent.json` | 接受：模拟 no-op，scene 条件 |
| `valid-execution-receipt.json` | 接受：零输入，真实效果不适用 |
| `valid-rejected-receipt.json` | 接受：超过 deadline 的模拟拒绝回执 |
| `invalid-unknown-value.json` | 拒绝：unknown 被填写成 0 |
| `invalid-action-name.json` | 拒绝：第 0 步尝试使用 move_for |
| `invalid-args.json` | 拒绝：no-op 携带键盘参数 |
| `invalid-simulated-sent.json` | 拒绝：模拟模式声称真实输入已发送 |
| `invalid-confirmed-without-evidence.json` | 拒绝：保留的 live 回执确认效果但没有证据 |
| `invalid-extra-field.json` | 拒绝：原始 tick_ms 直接进入公共时间域 |

前三个正例组成一个结构与引用自洽的模拟片段；第四个是同一动作的另一次“超时拒绝”示例，不能与成功回执一起重放成一次执行。

第 0 步验收包含 schema 检查、正反例检查和单消息语义检查：未知值、时间先后关系、输入事件计数以及模拟模式约束。超龄条件闸、旧计划、跨 run 引用和动作判重由后续执行闸或回放层实现；本阶段不宣称已完成。真实键鼠事件、窗口失焦、独立释放看门狗和正式服效果确认属于第 1 步及以后实测。

本文件列的是协议契约与预期结果。只有实际运行对应验证器或测试后，才能报告它们已经通过。
