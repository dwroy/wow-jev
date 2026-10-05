# 真实游戏中的学习改进评估

`tools/retail_learning_eval.ts` 只读比较基线与新版的真实运行目录，不调用模型、不发送键鼠、不发布或切换版本、不改日志或知识文件。每个来源先通过 `verifyLearningRun`，内部按 actor 复用 Eye、CodePlay、Jev、System/Brain 的严格回放，复核原图、观察、请求、执行与效果的完整绑定；没有审计通过的统计不参与收益比较。

## 预先冻结比较条件

两个版本开始运行前，应给 live CLI 相同 `--evaluation-context` JSON，使以下对象进入 manifest 的 config/hash，而不是在运行结束后补写：

```json
{
  "scene_id": "wingrest-safe-flat-panel-v1",
  "layout_id": "retail-3840x2160-default-ui-v1",
  "task_kind": "panel_cycle",
  "target_kind": "none",
  "skill_profile": ["open_panel", "close_panel"],
  "applicability_conditions": {"capture.available": true, "window.focused": true},
  "data_refs": {},
  "initial_state": {"ui.inventory_open": false}
}
```

`data_refs` 可填写实际固定游戏数据库/客户端证据等 SHA；空对象表示未引用额外数据，不能捏造 hash。`initial_state` 与 `applicability_conditions` 的字段值必须在各自第一份真实观察里为 known 且匹配。NPC 任务另填 `target_name_scope` 为对应可见目标类名字；我们没有实体 GUID，不能声称证明了同一只实体。

`config.client_version` 必须含已知 branch、expansion、patch、build、region、locale，六维匹配才能比较。上下文、实际客户区尺寸、目标政策、技能允许范围、bindings、时限、步数、观察时效、输入授权、原生程序与校准 hash 都必须匹配。game_effect 比较发生校准或原生程序变化时拒绝；单独评估视觉变化应使用 perception scope。场景 ID 是实验者预先指定的条件，需要真实截图/录像支持，工具不能由同一个文字标签证明游戏位置相同。

来源 events SHA、run ID 重复会被拒绝。game_effect 还拒绝共享图片 SHA 和共用 capture session，避免把同图重复推理、连续战斗相邻帧包装为独立游戏事件。此规则偏保守：完全相同的静态图也可能来自独立采集，仍不足以作为本工具的独立游戏样本。每个对照需要新事件、新录制。

## 运行与报告

```bash
agent/node_modules/.bin/tsx tools/retail_learning_eval.ts \
  --baseline out/acceptance/example/baseline-1 --new out/acceptance/example/candidate-1 \
  --baseline out/acceptance/example/baseline-2 --new out/acceptance/example/candidate-2 \
  --scope game_effect \
  --registry out/acceptance/stages-5-7/iteration-1/registry \
  --out out/acceptance/example/comparison.json
```

目录名为说明用占位符，需替换实际来源。提供 registry 时，工具实际读取 current pointer、验证已批准冻结包的源码/知识/prompt hash，并比对运行中的冻结引用；before/after 指针与变化记录进入报告，工具本身不执行 activate/rollback。未使用已发布冻结包的 inline runtime 可比较观察结果，但不能因运行版本名字存在就宣称通过了该 registry 的发布/切换验收。

每条来源记录：实际原生输入命令和插入事件数、动作释放、confirmed/unknown/failed 效果、等待、拒绝/失败/取消、顶层任务结果、未知/不可用字段量、每次模型回复角色/ID/耗时/token，以及代码、prompt、知识和源日志 hash。字段未知量是状态覆盖统计，不是识别准确率；模型 token 缺失保留 null，不当作零。

结论规则：

- `incomparable`：来源回放失败、模拟混入、未知客户端版本、缺少或错配实验条件、重复来源、共享游戏样本等。
- `cannot_conclude`：不足两对独立对照、任一效果/释放未确认、收益与退步并存，或只是视觉/候选协议对照。
- `observed_improvement`：至少两对满足全部条件与效果确认，实际输入/模型调用/失败等可观察成本有减少且没有其它对应成本退步。只适用于这些已匹配有限案例，不声称一般性或因果的学习效果。
- `observed_regression` / `no_observed_difference`：在同样有效条件下，实际成本退步或没有观察到区别。

版本标签变化、一次网络延迟下降、离线 CV 重分类和模拟通过均不构成游戏收益。NPC 界面打开与未知移动效果分别报告；只要待比较的游戏效果仍 unknown，本工具保持 cannot_conclude。默认 `minimum-pairs=2`，可以提高，不能降低到 1。

`--scope perception` 允许相同原图的固定视觉对照，仅统计结果覆盖与开销；没有独立真实标注时不能报告准确率。`--scope candidate_protocol` 统计真实模型候选回复及成本；均不提升为 game_effect。代码单元测试中的统计 fixture 也不是游戏验收证据。

## 验证

`agent/tests/game-comparison.test.ts` 覆盖版本标签无收益、真实效果前提、未知/释放/冲突阻断、版本与条件错配、来源/原图/连续 session 重复、模拟、视觉与协议范围、最小独立样本与成本取舍；公共入口还实际启动三层模拟生成完整日志，独立严格回放通过后拒绝其游戏收益，再删除父层条件确认原始日志审计失败时不生成统计。
