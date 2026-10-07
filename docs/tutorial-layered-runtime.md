# 教程局部证据到四层执行

2026-10-07。当前角色已纠正为联盟战士“小呵”，首个行为目标是“与吉安娜·普罗德摩尔交谈”。这是当前可见教程步骤，不伪造原生quest ID、NPC GUID或任务接取/交付。最新用户授权允许交谈后自主继续接交任务和教程；本页旧版单次交谈入口的效果确认结束仍是一个行为边界，后续任务另走分层路径、当前帧与统一闸。最新停止条件和治理以[AGENTS.md](../AGENTS.md)及[本次验收](acceptance/ui-skill-governance-v2.md)为准，历史单任务限制不再是全局授权限制。

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

阶段二提供接线 API；阶段三增加 `tools/layered_tutorial.py` 的现场 driver，见下文。旧 live 文件闸仍要求实际截图 artifact。新 WGC memory 分支只接受 Resident 当前连接私有登记的原消息、原括号时间、完整映射后的受控 clone 与同一个 `MemoryFrameRegistry.verify`，原生发送前再次核验当前帧/意图/目标。JSON proof 或宽松 verifier 回调不能授权来源。`artifact=null`、`artifacts=[]` 保留其内存性质，不伪造 file SHA 或将 WGC 标成 PrintWindow。共享识别核心通过显式 `file_screenshot|resident_memory_roi` source proof 复用，ROI SHA 绝不填入整图 capture SHA。

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

## 阶段三入口与独立来源

`tools/layered_tutorial.py readonly|run|bootstrap|cancel` 是固定入口。Python 只转发字面 argv 和取消信号到项目 TS，不持有桌面/输入端口。`run` 先调用既有冷恢复命令，冷恢复确认可玩世界即停；随后仅一次 `/IT` 启动常驻宿主，热循环走 Resident JSON 通道。教程只允许一次最长150ms的交互（当前计划60ms），`max_actions=1`，普通输入要求前台、窗口身份与当前源闸；热入口不另做 focus click。恢复入口仍按 AGENTS 的空闲/完整可见/一次点击例外独立管理。登录、凭据、验证码、协议、更新等保留原恢复阻塞。

现场配置必须包含精确 `target`（PID/start/HWND/class/executable/session1）、`client_version` 六维、`client_probe_path` 与整个 probe SHA、冻结世界路径/manifest/SQLite SHA、运行库路径、教程校准路径/SHA，以及1000–300000ms预算。可选 `absence_calibration_path` 与其 SHA 必须成对。`readonly_single=true` 只有显式模型上传授权才可启用。没有默认客户端 profile、原生角色 GUID、键位或对话缺席值。

客户端 probe 格式为 `wow-tutorial-client-probe` version1：

- `target` 与本轮 Resident 的精确进程实例绑定；`client_version` 六维全部已核实。
- `metadata` 只允许 pid/proc/exe/start_ticks/file_version/branch/region/text_locale。原件来自固定只读 FileVersionInfo 与 Config.wtf 的 portal/textLocale 白名单，不能复制整个 Config.wtf、账户或凭据。
- `metadata_source={path,sha256,scope:"session0_readonly_process_file_metadata",captured_at}` 指向原始只读结果；TS/Python 重新哈希原件并语义比较。UTC 是该独立采样的注记。
- `window_source={target_scope:"retail_wow",frame_id,seq,windows_clock_id,source_qpc_ms,client_width,client_height,dpi}` 来自真正 session1 WGC 证据，保留原 QPC。仅与同 QPC/同进程布局的新帧比较，窗口源参考最大300s；与元数据 UTC 不相减。
- `review={reviewer:"root",reviewed_at,expansion_verified:true}` 为独立审核；资料确认扩展不能冒作 CV。未核实 expansion/build/locale/region 或源缺失即 blocked。

输入路径严格接受 `HostReady.target_scope` 与 `memory_frame.target_scope` 的 `retail_wow`。`recording_fixture` 和缺 scope 都在教程、局部事实和 Seed 构造前拒绝；Native身份 target 本身不混入 scope，原 LocalSession exact schema保持不变。角色标识为本会话用户指定的联盟战士“小呵”，没有从窗口推导账户/角色原生ID。

`readonly` 取得当前低频完整 PNG 和 Native CV，原图SHA/FrameID/QPC/校准、snapshot和客户端probe核验后，由单写 Python 将真正观察条目存到 agent.sqlite；只读宿主没有输入执行器。`run` 同样登记局部步骤，低频编译原验证的 L4 计划后，重新取得新 hot sample，再经既有任务链执行。`collect(true)` 也只采内存 ROI，不能偷偷编码PNG。动作结束后 `collectEffect` 显式采独立新完整PNG+OCR；只有原 OCR 的中文完整 NPC 标题与左侧关联控件几何配对才登记 `conversation_open`。Python 再从原 `native_evidence.ocr` 重算配对并核对派生 source/time/proof，不相信 caller 改写的 dialog.open。CV 写入也重查原校准JSON/资产SHA、归一化比例/锚点/offset/阈值和 Native ROI 覆盖。

每轮保存实际源码清单SHA和Git HEAD、配置原件SHA、三类prompt原件SHA，以及实际 `knowledge.json` SHA；该最小清单范围是冻结世界参考和局部断言规则，无已注册学习知识快照。世界包SHA不冒作knowledge版本。Native二进制/原协议/校准payload哈希与一次任务生命周期在 `resident-host/task-lifecycle.json` 保留。实际局部断言SHA关联计划和贯穿各层的trace。

```bash
python3 tools/layered_tutorial.py readonly --config CURRENT_CONFIG.json --run-dir /home/dw/Projects/wow-jev/out/CURRENT_READONLY
python3 tools/layered_tutorial.py bootstrap --snapshot CURRENT_SNAPSHOT.json --image ORIGINAL.png --review ROOT_SAME_SOURCE_REVIEW.json --output /home/dw/Projects/wow-jev/out/CURRENT_ABSENCE.json
python3 tools/layered_tutorial.py run --config CURRENT_CONFIG.json --run-dir /home/dw/Projects/wow-jev/out/CURRENT_RUN --finite-input-authorized --recovery-authorized --target-character 小呵
python3 tools/layered_tutorial.py cancel --run-dir /home/dw/Projects/wow-jev/out/CURRENT_RUN
```

`bootstrap` 只生成审核过的精确参考，不产生新观察或输入许可。当前 absence 实验方案要求左45%×90%全部BGRA(alpha255)与审核图精确相等，Native wire ROI 为 `dialog-absence-dialog_absence`。海水/旗帜/角色动画大概率使后续帧不相等，结果保持unknown，不能保证动态世界一键完成。稳定可用的方案仍需现场独立静态对话框正/反校准与覆盖验证；未取得前，默认不发交谈输入。不能以NPC+hint推absence，不能将模型或人工审核改写成fresh CV；不可用时保存原图并blocked。

可用 Ctrl+C 取消；独立 cancel 命令仅在两次核对协调器 PID、Linux start_ticks 和原 cmdline SHA后发SIGINT，防止PID复用。取消信号经既有层和 Resident.cancel 发原生释放，租约/EOF看门狗独立兜底。退出时再要求真实release回执、Native ledger空/执行器退出/capture释放以及计划任务删除后回查，任一缺失不得从 exitCode0 推定成功。只读 `no_executor_acquired` 与物理按键释放证明分开报告。完成首交谈或任一阻塞即返回 summary，不执行下一个任务。

只读single端口只能调用现有Seed视觉与大脑worker，不持有hand/Body/native；凭据由worker按需读取，fixture从上传前排除。同一初始图的原源时间保留，依序记录分层代码决策和single决策的协调器耗时，`count_scope=decision_only,n=1`。未配置、调用失败或取消明确unmeasured。代码实际帧→首次SendInput在WindowsQPC域另记p50/p95；这两个范围不能相减或报加速倍数。输入已发出与独立效果确认分别记录，首交谈n≤1的有效动作/分钟仅描述单次窗口，不作为持续吞吐量；recording fixture n30另行验收。

本轮离线新增20项TS教程Resident/来源/取消/cleanup/时钟、冷/热计数与跨Python→TS完整链专项，连同旧21项教程测试41/41通过；新增32项Python事实/原OCR/probe/校准/冻结包/幂等、原件重查与完整Native schema边界专项通过，typecheck通过。正路径使用明确contract fixture并通过实际Native唯一schema，不是实际Native/WGC现场样本；真实WGC采样、初始局部事实、视觉调用、首交谈与实际延迟均pending。RDP断开后不再轮询、不启动Windows任务、不发输入；完整集成数字和推送由主checkout验收记录。

收尾专项实际151/151 TS（上述教程41加恢复/Body/L3/L4/memory闸回归）、68/68 Python（新32加旧局部断言36）、typecheck通过，失败/取消/跳过0；原始日志在 `out/acceptance/layered-tutorial-20261006/stage-3-tutorial/`。这组数字只表示指定专项，不代替主checkout完整回归。原本将模板/probe列为额外artifact但reader只重查顶层图片/JSON的缺口已修复：LocalAssertions读/写均重查原event的全部索引artifact字节。

独立 Python register 入口在落库前用固定离线 Node/Ajv bridge 复用 `assertResident`、实际 resident/native 两份唯一schema，完整验证原sample/evidence字段及源时钟/窗口/帧约束，不另写字段白名单当schema。缺字段、错类型、extra字段直接拒绝，验证器/依赖环境故障与原源schema拒绝分开记；不启动Windows、模型或输入。Python contract fixture也包含完整合法DTO。

summary的 `input_counts.cold|hot|total` 分开记录尝试、已发命令与known/lower_bound范围。冷恢复已经发点击后blocked/cancelled的原terminal结果仍保存，不能因exit1丢掉计数。stdout损坏先查原冻结summary；已启动但无法取得终态时0仅为已知下界。热链原Native execute回执即使后续Task异常也保留，重复回执不双计；未取得终态回执的尝试保持lower_bound。顶层input_issued为冷+热总数，真实教程QPC延迟只统计hot；确认交谈效果独立，不把恢复点击当有效游戏任务动作。

恢复现场时的验收顺序：先取得用户重新连接且窗口准备好的通知，再运行独立只读Resident确认WGC新帧/客户区/DPI/焦点/Native cursor，并补客户端probe的真实windowSource；身份或源未知停止。审核当前完整截图的教程指令与独立对话缺席覆盖；exact参考在动态场景不匹配时停止并安排静态对话正反校准，不尝试输入来“证明”缺席。只读模式与明确cancel/lease/任务删除的现场证据在前，有限一次交互在后。输入后只采独立效果图并核对标题/控件配对；源不配对时unknown并保存图，交谈确认或阻塞都停，不点接受、不进入下一项任务。
