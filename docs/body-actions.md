# L1/L2 有限输入与人物动作

实现日期：2026-10-05。入口为 `agent/src/actions/index.ts`。这轮验证包括 TypeScript、离线假手和 C# 无输入解析；同步时间线的专用窗口实测、正式服输入和游戏效果验收另行记录。

## L1 输入

`new TimelineBuilder(duration_ms)` 接受 1..5000ms。`down(ref, at_ms, lease_ms)` 与 `up(ref, at_ms)` 在同一个命令内配对；不会创建跨命令持有。`ref` 为 `{key:'E'}` 或 `{button:'right'}`。支持 `press(keys, at_ms, duration_ms)`、`presslong(keys, duration_ms, at_ms)`、`click`、`doubleclick`、`drag`、`relativeMouseMove`、`absoluteMouseMove` 和 `build()`。

```ts
const action = new TimelineBuilder(400)
  .presslong(['E'], 400)
  .down({button: 'right'}, 0, 400)
  .relativeMouseMove(20, 0, 100)
  .relativeMouseMove(20, 0, 200)
  .up({button: 'right'}, 400)
  .build();
```

NativeAction 增加 `kind:'timeline'`、`duration_ms`、`events`。事件为 `key_down/key_up`、`button_down/button_up`、`relative_mouse_move` 与 `absolute_mouse_move`，各自带 `at_ms`。协议源仍是 `protocol/native-input-v1.schema.json`。结构校验后，`assertNativeTimeline` 与 Windows 解析器补充配对、事件顺序、正租约和同时间同资源排重校验；最多256个事件，所有UP不晚于总期限。绝对坐标先按client physical pixels检查，发送时再次检查客户区。

Windows 以QPC调度相对本命令起点的事件，同时间事件按数组顺序成为一个SendInput批次。DOWN在发送前将账本落盘；UP仅在该批次完全插入后清除账本。部分批次保持保守持有集合，异常路径释放本owner。沿用取消、失焦、管道EOF、控制器心跳和独立看门狗。最终回执记录已请求/已插入事件数及释放，不证明游戏效果。

Ready增加可选 `capabilities.timeline`。旧Ready缺少此字段仍能解析，但客户端在发送timeline前拒绝，旧key/mouse命令保持可用。新增L2编译器统一使用timeline；旧原生版本不会被自动当作支持同步动作。旧日志回放继续使用各日志保存的schema。

## L2 Profile 与编译

`parseBodyProfile(json)` 严格检查 protocol/version/id/revision、角色/布局身份、来源build/locale、绑定artifact SHA、绑定内容SHA、能力、运动模式、修饰键、mouse-look和技能移动条件；解析结果深冻结。`bodyBindingsSha256({bindings,abilities})` 计算绑定SHA。`profileFromBindingsCache(cache,meta)` 解析每个角色实际的 `bind`、`unbind`、`unbindall`，映射MOVEFORWARD等语义，不假定WASD。已知实际E/D/S/F/G缓存可直接导入；不存在的跳跃、骑乘、飞行、技能映射保留unbound。

Profile基本形状：

```ts
{
  protocol:'wow-body-profile', version:1, id:'retail-character', revision:1,
  character_id:null, layout_id:'actual-layout', bindings_sha256:'<computed>',
  source:{build:'<actual build>', locale:'zhCN', binding_artifact_sha256:'<cache sha>'},
  mode_field:'player.movement_mode', mouse_mode_field:'input.mouse_mode',
  bindings:{forward:{keys:['E'],modes:['ground'],conditions:[]}}, abilities:{},
  capabilities:['ground_move'], mouse_look_button:null, mouse_look_modes:[]
}
```

合法模式为ground、mounted、swimming、steady_flight、skyriding、vehicle；状态未知/未支持时阻塞。`fly`需要steady_flight/skyriding及该具体模式的显式绑定，不将mounted或SPACE长按推导为已能飞行。turn/arc要求mouse-look能力和world鼠标模式；arc在同一timeline叠加forward。cast使用abilities里的keys/modes/conditions/movement，stationary要求新鲜 `player.moving=false`。interact要求目标签名条件。按键时长、鼠标像素、骑乘按键与施法按键都只描述输入。

click要求 `ui.layout_id` 匹配profile，当前 `dialog.elements` 或 `ui.elements` 包含 `{id或element_id,x,y,enabled:true,layout_id}`，与当前观察、当前布局源时间关联；x/y必须精确匹配此元素，且在客户区内。任意坐标不能绕过element_id。界面点击要求ui鼠标模式，mouse-look要求world模式。

## BodyRuntime

```ts
const body = new BodyRuntime({
  profile, runId, hand, collect: (save) => eye.collect(save), now,
  currentIdentity: () => ({task_id, task_revision, run_epoch}),
  expectedWindow: {token, hwnd, pid}, append
});
const outcome = await body.execute(action, executionContext);
```

`ExecutionContext`来自共享层契约，包含command/task/revision/epoch/mode/conditions/signal。每个command_id只消费一次。每次执行采样、合并调用者与profile条件、复用evaluateGate，并在意图日志落盘后再次检查；任务、epoch、profile、action或context变化都不能继承旧控制权。执行中取消或身份变化会请求释放。live关键movement/mouse/layout/元素/技能字段必须当前采样的raw CV，Seed/manual/simulated不能冒充；未获这些字段的真实截图按blocked交付。

`collect`需要返回当前Collected并在live模式保留截图证据。若行为接口已经提供before观察，可将它对应的Collected作为首采样返回，但必须仍在源TTL内，后续采样重新取帧。`append`记录body_action_intent、body_native_receipt、body_action_outcome/body_release；调用者可写入自己的新层日志，不能交给旧play专用回放宣称它理解新body结构。

完成只证明操作结束。outcome包含before/after源ID、native receipt、release、真实输入命令数和game_effect；本实现始终返回game_effect=unverified，高级行为根据独立后续观察另行确认。simulation没有原生回执、real_inputs=0。live有效终态的events_inserted>0计为1个真实命令，详细事件数在receipt。运输失效时real_inputs只能作为已确认下界，input_count_scope=lower_bound，failed且释放unconfirmed；无确认不能宣称0真实输入。

## 无输入验收入口

```sh
bash native/windows/build.sh
agent/node_modules/.bin/tsx tools/actions/validate-fixtures.mts
cd agent
npm run typecheck
node_modules/.bin/tsx --test tests/actions-*.test.ts tests/hand.test.ts tests/protocol.test.ts tests/play-gate.test.ts
```

工具仅调用 `WinInput.exe validate-timeline`，该分支在调用任何Windows输入/焦点API前返回。校验客户区800×600是fixture参数，不能证明真实DPI、客户端尺寸或输入结果。输出在 `out/acceptance/actions-v2/`，保留JSONL、退出码、fixture/源码/二进制SHA和验证时间。2条有效与9条拒绝样本涵盖同步弧线、双击、未配对、乱序、零租约、越界、非法键、未知字段、非整数和事件超限。

这轮无SendInput实测，没有失焦/EOF/强杀/WSL重启后物理释放证明。源码继续复用现有防线；真实时间线与原有单动作的物理释放证据不能互相替代。
