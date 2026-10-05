# 四层执行入口与首版范围

设计：`four-layer-agent-design.md`。执行代码从 `agent/src/layers/runtime.ts` 连接 L4 TaskRuntime、L3 BehaviorRuntime/BehaviorJev、L2 BodyRuntime 和 L1 NativeTimeline。原有 `system`/`jev`/`play` 入口保留。

## 模拟体验

```bash
cd /home/dai/Projects/wow-jev/agent
npm run layers -- demo
npm run layers -- demo --scenario unknown
npm run layers -- demo --scenario no-progress
npm run layers -- demo --scenario cancel
npm run layers -- replay --run-dir /绝对路径/运行目录
```

正常场景执行移动→交谈→接任务→击杀→拾取→交付六个行为。每个行为内可多次使用人物动作；唯一有效候选本地选择，不调用模型。`real_inputs=0`，观察全部标记simulated；模拟成功不证明游戏效果。其它场景展示状态未知、没有移动进度或取消时停止。

每条输入意图保存body profile/hash、任务revision/epoch、原观察、条件和时间线；`layer_command_link`关联高级命令与长度受限的原生命令ID。输入结束和游戏效果独立。原生终态回执丢失时`input_count_scope=lower_bound`，计数是已知下界，不报告“确定没有输入”。

## 真实游戏开发入口

```bash
npm run layers -- validate --task /绝对路径/task.json --body-profile /绝对路径/body-profile.json
npm run layers -- live \
  --window 0x当前HWND --pid 当前PID \
  --task /绝对路径/task.json \
  --body-profile /绝对路径/body-profile.json \
  --client-profile /绝对路径/client-profile.json \
  --region-profile /绝对路径/regional-profile.json \
  --region-context /绝对路径/regional-context.json \
  --live --role-scene-confirmed
npm run layers -- status --session-id 日志给出的UUID
npm run layers -- cancel --session-id 日志给出的UUID
```

当前入口从本项目C#源码复制构建四个原生程序，记录源码/二进制SHA并验证，再读取实际进程的build、客户端分支、region、locale与启动身份。它是本地开发入口；现有发布版本registry仍由`system`入口管理，不把本地开发源码伪标为发布版本。

Body profile的`source.build`在此入口使用数字build的字符串形式，locale与client profile一致；区域scope必须与客户端六维版本一致，layout_id同时匹配。地域/DPI、UI缩放、字体、插件组合和元素锚点均由区域profile约束。输入前要求当前原图CV证据；手动配置和Seed不能冒充实时运动模式或技能ready。

真实模式不默认配置键位/技能，也不自动把画面坐标当世界坐标。未识别的运动模式、导航destination/progress/heading、交谈元素、任务数量和奖励证据返回blocked；未绑定动作返回unbound，未支持的飞行模式返回unsupported。需先按真实游戏截图和键位校准profile，不能将demo文件直接用于正式服。可加已有`--calibration`、`--combat-calibration`、`--npc-calibration`。

游戏须保持前台；入口等待用户聚焦，焦点/PID/窗口尺寸变化由闸门与Windows执行器拒绝。动作最多5秒，行为/任务各有预算。Ctrl+C、控制socket cancel或Windows Ctrl+Alt+F10停止；释放回执缺失不标confirmed。现有独立Windows看门狗保留。

真实Eye日志在运行根目录，四层日志在`layer-journal/`，该子目录传给layers replay。回放验证顺序/hash链、模式、终态和输入计数；它验证留存证据，不重新操作游戏。原帧用PNG，Seed派生图片见区域模块；此live CLI首版不调用模型。多候选行为通过`createLayerExecution({chooser})`注入`StructuredBehaviorChooser`，模型只在选择边界运行。

## 首版能力与仍需校准的部分

- L1同步时间线与L2语义动作可编译和执行；输入完成不等于走了多少米、转了多少度或技能命中。
- L3九种反馈状态机已定义。`kill_target`支持本地技能优先级和明确条件；能力类型/职业完整循环仍由profile/策略扩展。
- L4 sequence、kill_count、deliver_quest可编排；kill_count读取关联任务数量，交付要求交任务及奖励证据，截图出现尸体不计一只新击杀。
- 区域CV/OCR框架需要实际布局/模型素材；可识别的字段来自检测证据。通用扫图导航、可靠GUID关联、全部职业与驭空术控制并未由框架自动完成。
- 战斗日志只读旁路已实现，原时间未对齐前仅补历史，游戏落盘延迟需另外实测。

工程测试、专用窗口输入和正式服效果分别记录在阶段验收文件；不能用其中一项替代另两项。
