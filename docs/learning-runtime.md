# 第 6 阶段：离线学习与版本知识

学习器只读取既有 run，不启动 Windows、模型 worker 或输入执行器，不读取凭据。每个来源先按日志类型复用 Eye、CodePlay 或 Jev 的严格回放，验证冻结 schema、源截图与哈希、观察重建、动作关联、输入计数、计划终态；验证失败时整次学习报错，不把损坏记录静默变成事实。合法 failed/incomplete 日志可学习，来源仍保留 `complete=false`。

## 可运行入口

在项目 `agent/` 下执行：

```bash
npx tsx src/learner/cli.ts learn \
  --run-dir ../out/acceptance/stage-3/retail-3/run \
  --run-dir ../out/acceptance/stage-3/retail-2/run \
  --knowledge-dir ../knowledge \
  --report ../out/learning-report.json
```

`--run-dir` 可重复；`--report` 是新建的派生报告，包含 task/plan/target encounter 切片与规则复盘草案，已有文件不会覆盖。输出包括知识版本 ID、SHA 和绝对路径。原始日志只读，CLI 不生成验收标签。眼历史日志的 `observe`、`record-action` 映射为真实来源模式；CodePlay/Jev 保留 `live` 与 `simulated` 的区别。

```bash
npx tsx src/learner/cli.ts query \
  --file ../knowledge/knowledge-文件SHA.json \
  --sha256 文件SHA \
  --scope '{"goal_kind":"approach_npc","layout":"3840x2160","skill":"move_for"}'
```

## 集成 API

```ts
import { learnRuns, verifyKnowledgeEvidence } from './learner/index.js';
import { loadKnowledgeSnapshot, writeKnowledgeSnapshot,
  knowledgeSha256, queryKnowledgeWithEvidence } from './knowledge/index.js';

const learned = await learnRuns([retail3Run, retail2Run], { previous: oldSnapshot });
const version = await writeKnowledgeSnapshot(knowledgeDirectory, learned.snapshot);
const sourceDirectories = Object.fromEntries(learned.snapshot.sources.map(source =>
  [source.id, source.run_id === retail3RunId ? retail3Run : retail2Run]));
const snapshot = await loadKnowledgeSnapshot(version.file, version.sha256,
  { sourceDirectories });
const consulted = queryKnowledgeWithEvidence(snapshot, {
  mode: 'live', certainty: 'observed',
  scope: { goal_kind: 'approach_npc', layout: '3840x2160', skill: 'move_for' },
});
// 在线决策日志记录 consulted.fact_ids 与 consulted.knowledge_sha256。
```

`learnRuns` 返回 `snapshot/slices/reviews/duplicate_sources`。同 run ID 或同 events SHA 不重复累计；相同 run ID 的内容变化会报冲突。增量 `previous` 必须先来自严格加载的已审核版本；如果要重新审计其原始证据，可调用 `verifyKnowledgeEvidence` 并传所有来源目录。

`loadKnowledgeSnapshot` 总是核对完整文件 SHA、canonical JSON 字节、精确类型字段、快照 ID、来源唯一性、样本与证据数量、模式隔离，以及路径各级无 symlink、普通文件和 64 MiB 上限。传入 `sourceDirectories` 时，还会重新严格回放全部来源，逐条确认 record seq 绑定的 receipt/result/观察和 artifact；一个动作的 receipt 与 step result 不可冒充两次样本。未传目录的加载依赖已审核且固定 SHA 的知识版本，不能作为原始证据审计的替代。

`writeKnowledgeSnapshot` 使用 `knowledge-<文件SHA>.json` 内容寻址、独占创建和只读权限；同内容可复用，已有同名异内容文件报错。文件字节无换行，等于递归键排序的 canonical JSON。`knowledgeSha256(snapshot)`、写入返回的 SHA、严格加载得到的文件 SHA 和 RuntimeVersion 的知识 SHA 使用同一口径。

## 证据与适用范围

- `game_fact` 只提取真实来源里 `effect=confirmed`、前后源观察和截图齐全的有限背包变化。已发输入、步骤 completed、already_satisfied、运行 complete 都不替代游戏效果。
- `test_target=true` 的专用输入记录窗口只形成独立经验，不能产生游戏事实或怪物统计，默认游戏检索不咨询其内容。
- `experience` 保留 confirmed/unknown/failed、拒绝、取消、partial 输入和 already_satisfied 的分别计数。运动 unknown 是“不能证明到达、转向完成或击杀”，不是运动失败或成功。`avoid_movement`、`recommended_wait_ms`、`requires_arrival_evidence` 是单独的 inferred 建议，不是 observed 事实，也不增加授权。
- `monster_statistic` 只统计已有观察中的目标栏报告名字与死亡 UI 读数；名字来源保留，源观察重复出现不再计样本。不创造实体 GUID、独立怪物数量、等级或掉落率；不把 target.dead 解释成由本动作击杀，不把镜头/目标栏丢失解释成死亡。
- 每条事实包含真实来源 ID、seq、观察/截图引用、sample_count、counterexamples、skill/layout 和可用的校准范围。合法未完成来源与完整来源分别聚合，避免 failed 反例污染在线 complete 来源筛选。
- `queryKnowledge` 默认只返回 live/observed，默认排除含未完成来源的条目。`includeIncomplete:true` 用于反例复盘；模拟来源只有显式 `mode:'simulated'` 时可见。事实中非空的 goal_kind/target_name/scene/layout/calibration_id 是必要适用条件；事实缺少某条件表示没有该约束，查询传 skill 时额外过滤。返回副本，调用者不能改写快照。
- 任务切片是运行目标，计划切片是动作日志区间，target encounter 是可见 UI 指纹的连续区间；均不宣称游戏任务已完成，也不等同实体遭遇去重。

规则复盘只有带已有 EvidenceRef 的草案。当前未调用学习模型、自动修改代码或 prompt，也没有根据历史回放证明替代动作的游戏收益。真实第一批知识与在线咨询的验收产物由负责人运行生成；本模块单元测试的 native/图像夹具属于合成协议测试。

## 验证

```bash
npm run typecheck
npx tsx --test tests/learner.test.ts tests/knowledge.test.ts
```

覆盖未知不升级、伪 confirmed 与源图篡改、partial/failed 保留、模拟隔离、增量与单事件去重、来源 seq/观察/图绑定、canonical SHA、不可变文件冲突、路径 symlink 和文件大小上限。真实效果验收仍以各阶段原始运行与截图为准。
