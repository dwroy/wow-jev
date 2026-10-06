# 常驻 WGC 内存帧执行闸验收

热路径不再要求为了输入闸先编码 PNG。旧 Eye-v1 与新 resident 内存帧使用两种明确证据，统一执行闸、动作期限、焦点校验、有限输入与释放语义保持。

## 两条证据路径

旧 `EyeSample` 仍是 `wow-eye`、`capture.method=printwindow`，需要原截图 artifact、SHA、尺寸及 Observation artifact 关联；新 callback 不会替代这些条件。旧 inventory 效果确认也保留文件证据要求。

`ResidentMemorySample` 属于独立 `wow-resident` 协议，`capture.method=wgc`，sample/Collected 的 artifact 均为 null、Observation artifacts 为 []。`memory_frame.roi_sha256` 是规范 ROI 组合哈希，各 ROI 另带矩形、像素 SHA、校准 ID 与 SHA；`full_frame_sha256=null` 表示没有计算整帧哈希。不得把 ROI SHA 写成完整截图 SHA，不生成假 PNG 或假的 PrintWindow 记录。低频证据图与 OCR 可以另取，并保留其真实来源帧及独立图像哈希。

`SampleBracket<T>` 默认允许这两个明确 sample 类型。NativeEyeClient、旧 EyeRuntime、旧 benchmark 及对应 fixture 显式使用 `EyeSample` 泛型；EyeState 仅接收 Eye-v1，运行时也拒绝 resident。新采集器不能把 WGC 改标为 Eye-v1 来复用旧分支。

## 原源登记与可信适配

`MemoryFrameRegistry` 的 owner 由当前 resident client 实现。`validateOriginal` 以私有 WeakMap 验证从已通过 schema 的当前通道收取的原始 sample 及其完整指纹；原源对象先被修改、未收取的数据、旧连接 generation 和结构克隆都不能首次登记。

Client 在观察/证据请求时记录真实协调器请求与接收时刻，`validateBracket(sample, pair)` 验证原 pair。Windows QPC 与协调器时间分别登记，不跨时钟域相减。WGC source QPC 必须不早于当前 Windows 请求接收 QPC，不能用新请求时间给缓存旧帧续期。

`register(bracket, trustedMapper)` 在调用项目的固定原生/教程适配器前后均核验原源及 bracket。Mapper 先产生完整 Observation，最后再登记指纹；登记后补字段也构成篡改。Mapper 是项目代码中的可信适配步骤，不能从模型/外部 JSON 获取一组字段再改标 `source=cv`。具体教程事实须由适配器检查 raw CV 的来源帧、ROI 哈希、校准与目标身份；通用 registry 不从名字字符串推断任务或游戏事实。

核心还直接核对：窗口与 sample 身份、物理尺寸、DPI/矩形、session 1 目标、采样时钟顺序、原 ROI 布局与校准、capture.available、window.focused 及原生 cursor/buttons。已知 CV 字段必须属于该当前 source observation；不能沿用旧 Seed observation ID。原生 cursor/buttons 不能由 mapper 伪造为可操作。已登记指纹包括完整 raw sample、bracket、Observation 和全部 fields。

## 受控复制与最终执行闸

`createLayerExecution` 为历史不可变保留复制 Collected，Body 为 source binding 再复制一次；这两处现在统一调用 `cloneCollectedForRuntime`。只有原 WeakMap 登记、指纹未变且仍属于活连接的对象才能生成新的受控副本。普通 JSON/structuredClone 不会保留注册身份，无法用于 live 输入。旧文件采样仍使用原普通复制。

GateContext 与 BodyRuntimeOptions 传同一 `memoryProofVerifier=registry.verify`。统一闸先核对 private registry 归属与该 verifier 的函数身份，再验证活连接原源；调用者提供的 `()=>({ok:true})` 不能代替原 owner。删除 public proof、修改协议试图进入旧文件分支、替换 callback、复用旧 generation、关连接、淘汰原生帧或修改任何已登记字段均拒绝。

所有原有 run/plan/observation、目标 HWND/PID/尺寸、焦点、协调器期限、来源年龄和条件校验仍执行。Body 在日志前、dispatch 前以及异步 bindSource 后再次过同一闸。bindSource 只绑定已经批准的 intent 到原生帧，不能授权新动作或改写条件。

只读低频效果证据可以超过 750ms 后登记，仍保留原 captured_at/request 下界；owner 至多按连接/原登记帧保留只读证据。**输入**使用 Body 的 750ms 来源年龄上限，Windows 再查原 QPC frame age 与目标状态；只读证据的较长保留不延长输入期限。L3 独立效果确认按其策略处理，输入回执不能宣称交谈完成。

## 专项验证及范围

本模块工作树 `out/acceptance/resident-memory-gate/tests-final.log`：**77/77 TS 专项通过，失败/跳过 0；typecheck 通过**。其中新 `memory-frame-gate.test.ts` 21 项，另包含旧统一闸、Body、layers、EyeState/runtime 与 legacy field 回归。没有删测试或降低旧断言；只将几个确为 Eye-v1 的测试 helper 标成 file-only 泛型。

新检查覆盖 JSON/普通结构克隆、原源/观察/窗口/DPI/布局/frame/时钟/ROI/SHA/校准/完整字段变更、首次 bracket 刷新、mapper 修改 bracket、假原生 cursor/buttons、旧来源 CV 误标、断连/旧 generation/原帧淘汰和 callback 替换。

集成正例实际运行 `createLayerExecution` retained clone → Body 编译/统一闸 → bindSource clone → mock hand → 独立 after observation；没有为了通过单独 callback 而绕开真实架构。连接在 intent 日志后撤销、bindSource 后 generation 改变及 collector 返回非法 clone 的负例均在 mock dispatch 前停止。

这些是离线软件测试。mock native receipt 只用来检验共同组件的输入/释放状态机，**物理游戏输入、Windows 任务、模型调用均为 0**，游戏效果保持 unverified。本模块不证明 WGC 实际捕获、常驻生命周期/断连物理释放或观察→输入 p50 <150ms；那些由常驻宿主共同验收另报。

复跑（从 `agent/`，项目依赖已经存在）：

```sh
node_modules/.bin/tsx --test tests/memory-frame-gate.test.ts tests/play-gate.test.ts tests/actions-body.test.ts tests/layers-integration.test.ts tests/eye-state.test.ts tests/eye-runtime.test.ts tests/benchmark-field.test.ts
npm run typecheck
```

本工作树借入 Native 负责人当前 `agent/src/resident/protocol.ts` 与 `protocol/resident-session-v1.schema.json` 作编译依赖，不将它们冒充本模块发布验收或单独提交。最后全量测试需在包含 Native/client/tutorial 的共同 Git 快照上执行。
