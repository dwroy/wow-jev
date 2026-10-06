# 教程局部证据到四层执行

2026-10-07。首个目标只涉及当前正式服联盟战士“小啊”的“与吉安娜·普罗德摩尔交谈”。这是当前可见教程步骤，不将其伪造为已核实的原生 quest ID、NPC GUID 或任务接取/交付。完成交谈后停止，不点击“接受”或执行随后训练目标。

## 恢复与游戏任务的边界

`recover` 与 `launch` 均只负责启动、选角、断线、进世界和受限焦点恢复。兼容旧命令，但不再执行 NPC 交谈。当前同源 HUD 校准可向恢复提供只读世界场景与安全焦点锚点；它不返回教程动作或交谈完成。其它世界场景需要独立已核验的场景提供者或精确同图审核；未知画面不视为已进世界。

教程执行复用 `createLayerExecution`：局部数据编译 L4 `sequence` → `TaskRuntime` / `BehaviorJev` 边界 → L3 `talk_to` → `BodyRuntime` → 原统一 `evaluateGate` → hand 时间线。模块没有直接原生输入入口。唯一有效行为由代码选择，多个熟悉行为才需要已配置的 Jev；未配置模型或未知条件阻塞，不能假报模型命中。用户给定的首个目标无需虚构执行大脑调用。

## 世界包与 agent.sqlite 局部断言

现有冻结包覆盖苏醒海岸参考数据，尚无已核实的这个教程原生任务 ID。保留原世界包 manifest/SQLite SHA 和客户端六维，不改包来迎合现场。`agent.sqlite` 的 `LocalAssertions` 使用现有 `RuntimeDatabase` 单写连接；Windows 不打开可写 SQLite。

新增独立 `wow-local-assertion-v1` 扩展表与共享格式 `game_database/local-assertion.schema.json`。原 `runtime-schema.sql`、base v2 元数据和 `PRAGMA user_version=2` 不变。只读旧库缺扩展时返回 `extension_absent`，不自动迁移；写入端显式 `LocalAssertions(runtime, create=True)` 添加扩展。查询核对 wire/SQL SHA 和实际表、索引、不可变触发器定义。

断言保存：

- `local_key`、`tutorial_step|visible_npc`、predicate、known/unknown/unsupported/not_present、值。`exiles-reach.talk-jaina` 是局部步骤键，不能当原生任务 ID。
- 冻结 world manifest/SQLite SHA、精确 client version、注册 actor ID、session 1 的 PID/start/HWND/类/路径。actor 可为本次运行的角色会话标识，不能称游戏 GUID。
- 原 run/seq/event SHA、observation ID、源 clock domain/ID/unit/ticks、观察时间、截图和校准 SHA、生产者与规则版本。

`put` 要求原 run 为 readonly/live、原事件为明确 `live_field` observation，原事实唯一且完全匹配，角色/会话/时钟/图片/校准/生产者同源。模拟来源拒绝。查询重新验证原事件和原件字节；不同世界、客户端、角色或进程实例隔离；跨时钟不做差，未来/过期或同源时刻冲突保持 unknown。历史行不可更新/删除；使用原 Backup API 保留扩展和证据，原受保护 artifact 索引已经包含其 source event。

Python 返回原 canonical 字节与断言 SHA；TS 先哈希原字节，再比较解析值，避免两语言的浮点 JSON 表示差异。只读桥入口为：

```bash
.venv/bin/python -B -m game_database.local_assertions --database out/runtime/agent.sqlite < query.json
```

`compileTutorialPlan(LocalAssertionsClient, query, worldSqliteSha256)` 仅消费已验证的低频桥结果，固定局部断言、客户端、角色会话和世界包身份，生成一个 `talk_to` 行为的 L4 顺序任务。计划仍为 `executable=false`、`automatic_action_eligible=false`；数据只提供候选，有限输入授权与当前安全证据分别由执行层核验。现场入口还须调用既有 `verifyWorldPackage` 验实际冻结包字节，不仅接受配置中的 SHA。显式模拟 compiler 标记 `simulated_fixture`，live 入口拒绝该计划。

## 当前目标、鼠标与效果

文件识别入口 `recognizeTutorial` / `tutorialFields` 接受同源图片，核对 observation ID、客户区尺寸、PNG SHA、校准/参考 SHA 与 ROI 结果。初始 NPC 名字和交谈提示只生成可见名字签名、当前屏幕点和提示。它们不证明对话关闭，不推导键位、原生实体身份、光标自由状态或任务进度。

L3 在独立同帧 `dialog.open=false` 与 CV `dialog.absence_coverage_complete=true` 后，才能使用 `target.screen_interaction`。通用 `screen_interact` L2 动作明确表示世界屏幕目标的有限右键交互，最长150ms；不把 NPC 假扮 UI，也不注入 `input.mouse_mode=ui`。Body 要求同帧 CV 目标签名/点位/布局，以及 Windows 来源 `input.cursor_free=true`、`input.mouse_buttons_held=false`。来源缺失、布局/坐标改变或鼠标状态不明就拒绝。宿主仍须在实际按下前重核窗口身份、焦点、帧、落点和释放所有权。

`talk_to` 发出一次动作后只进入效果确认，不根据迟到结果再生成第二次交互或危险移动。输入已发出仍由原 `NativeReceipt.input_timing` 的 Windows QPC 首次发送边界记；它不意味着对话成功。

`collectEffect()` 是可选低频端口，由 Body 返回后下一次 L3 观察调用。它必须从新请求取得独立新图，可以保存 PNG 并做本地 OCR；不能返回旧缓存图而刷新时间。OCR 当前左侧 NPC 完整标题与几何关联的对话控制成对才构成对话打开证据，保留 `local_ocr` 来源和原图范围；泛“接受”或背景 NPC 标签不够。该证明用于交谈效果，绝不点击“接受”。不匹配则 unknown，可保存原图供负责人复核，不能宣布首任务完成。

普通观察、进入条件、候选选择和输入字段仍以750ms检查；Body 的输入闸不变。仅已发动作后的只读交谈终态确认可显式设置 `maxEffectFieldAgeMs`，教程默认5000ms，并要求同观察、源时间晚于 Body 完成、目标/对话/窗口焦点匹配。该分支不会发输入。OCR 用时不会改写 capturetime；效果确认与输入延迟分开。

## 基准接口和阶段边界

`runTutorial` 暴露 `Collected`、`BodyHand`、当前任务身份、`collectEffect` 和现有 trace。L4/L3 span、代码/Jev 边界、Body 编译/闸、首次原生输入、独立效果与释放关联同一计划和局部断言。Windows QPC 与协调器时钟仍独立，未对时不能相减，嵌套 span 不相加。

`compareTutorialDecision` 复用 `chooseBenchmarkCandidate`，针对同一原观察和相同安全候选先跑分层代码决策，再跑 single 的视觉+大脑只读决策。它没有 Body/hand/native 能力，input/effect 计数为0。一次只读决策不是成对游戏动作性能测试；模型未配置或未实际调用时不能报告模型延迟。多个样本、有效动作/分钟和 QPC 域观察→发送 p50/p95 留给常驻宿主现场采样。

本阶段只有可接线 API 和离线验收，没有可运行的现场任务 driver，没有 Windows 桌面/模型/游戏输入，也没有把旧图写成当前实测断言。`saveObservations=false` 和 `bindSource(Collected,intent,context)` 已供后续宿主使用：source 回调接收副本，回调后再次检查统一闸。**旧 live 闸仍要求实际截图 artifact**；无 PNG 的 memory frame 需要阶段三独立协议、原帧登记与验证，不能伪造 file SHA 或把 WGC 标成 PrintWindow。当前文件识别也不能把 ROI SHA 当整图 capture SHA。阶段三再接共享识别核心的显式 file/memory 证明、常驻通道和现场 driver。

可重复专项检查：

```bash
npm --prefix agent run typecheck
cd agent
./node_modules/.bin/tsx --test tests/tutorial-layered.test.ts tests/recovery-orchestrator.test.ts tests/actions-body.test.ts tests/behavior-task-runtime.test.ts tests/layers-integration.test.ts
cd ..
.venv/bin/python -m pytest tests/test_local_assertions.py -q
```

阶段二新增21项 TS 教程测试与36项 Python 局部断言测试。专项 TS 合计110/110通过，包含原45项恢复测试，未删除/跳过测试。跨 Python→TS 用真实只读进程验原件篡改、SQL行/源 run/角色/原事实变动、版本/会话隔离和时钟不匹配；执行端为明确 fixture，不能当游戏效果或速度实测。typecheck通过。完整回归及集成提交由主 checkout 记录。

## 完整Git快照验收（2026-10-07）

候选9208675提交后完整回归：TS567/567（旧546+新增21），Python765passed+3原有strict xfail（旧729+新增36，收集768，失败/跳过0），typecheck通过。首次未提交schema导致14项共享Git归档before-hook失败，原始日志保留；专项110TS/73Python并不替代上述完整运行。主证据out/acceptance/layered-tutorial-20261006/stage-2。实际Windows执行/内存frame统一闸/无PNG热输入与现场局部断言写入尚待下一阶段，不报告第一个任务成功。
