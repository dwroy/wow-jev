# 四个离线里程碑之后：世界任务适配与执行大脑

日期：2026-10-06。接续基线`23a18c3`，用户第3步授权。四个数据库离线里程碑已闭合；本轮补`four-layer-agent-design.md`所列大脑直接编排L4任务的接口。真实场景及来源决定遵守用户本轮限制。

## 剩余工作及顺序

| 顺序 | 工作 | 边界 |
| --- | --- | --- |
| A | 抽离固定世界提示→有预算的L4候选 | 离线，不生成输入授权 |
| B | 既有ExecutionBrain调用有限世界任务编排，独立episode日志/严格回放 | named synthetic场景，0输入/0模型 |
| C | 当前客户端、角色/阵营、选定任务及数据/感知身份取证 | 先由用户决定，不能沿用旧HWND/PID或安装profile |
| D | v2只读→有限接取/执行/交付，校准/取消/物理释放 | 现场授权后实施，保持原执行闸 |
| E | 真实日志学习、知识消费及同条件效果比较 | 模拟不能证明游戏收益 |
| F | 可达路线/导航/飞行、职业策略和副本/成就/来源扩充 | 桌面、OAuth、大包下载、许可分别等用户决定 |

当前实际Eye尚无typed `target.entity_key`、世界断言/ordinal对应的objective_ref/count或对话quest/reward身份生产端；这些不能由姓名或模板唯一命中猜出。M2仍仅参考：当前正式服核实覆盖0，starter/finisher已核实0，规范目标23unsupported/1unknown。`layers`严格学习、运行库索引与版本发布已经接通，不重复列为待实现；v2真实入口仍明确拒绝。

## 阶段A：可复用任务适配

独立工作树`.worktrees/world-task-planning`，模块分别由编译器负责人和集成负责人编辑，先验收再本地集成。新增`agent/src/game-data/world-task-compiler.ts`实际调用`WorldTaskClient`读取固定包，不接受外部伪造hint或未冻结的动态context/runtime。每批要求显式world/client/quest绑定；starter/finisher按role与typed entity匹配，目标按ordinal与typed entity匹配，不用数组顺序/同名NPC猜绑定。

输出有预算的接取、逐目标、交付候选，全部保留`executable=false`和`automatic_action_eligible=false`。未知、参考、不支持、缺绑定、目标错配保持blockers且整批零候选；跨包/客户端/任务绑定、错误shape、无界预算或取消拒绝。参数在await前快照，返回深冻结。首版仅支持已核规范kill_credit目标、creature giver与明确none奖励策略，其他语义不猜测。

原`world-demo.ts`不再手写task数组，使用此编译器并保持原task/behavior身份、有限预算、两个同NPC目标的独立ordinal/count；仍仅允许指定合成世界。新增只读`world-task-cli candidates`接受`--bindings`、`--budget`，拒绝执行flag、动态输入或references提升。

全量验证（原始输出在主`out/acceptance/world-task-planning/stage-1/`）：

- 全部Python：663项，660passed/3原有strict xfail/0skip，exit0。当前源码构建JevCapture、WinEye、NpcClassify并显式配置离屏Python测试路径；不操作桌面。
- 完整`npm --prefix agent test`：397/397passed，0fail/skip/cancel/todo，exit0。旧382项保留，新增13项编译器与2项实际CLI测试。
- `npm --prefix agent run typecheck`、`git diff --check`：exit0。
- 实际现存M2包SHA`5f762a251e9fb301ee3c8e50d9bbbc31fefc8bf2a67b686a60ef8360bb1c2774`，70124配版本示例通过实际CLI返回`current_status=not_found/status=blocked/candidates=[]`，不冒称新机器实际客户端证据。`reference-candidates.json`保留原输出及blockers。

首次编译器篡改fixture直接写只读发布SQLite报EACCES；修正临时fixture为替换文件后13项通过，生产只读/SHA约束不改。默认tsx沙箱IPC故障经同命令正常权限审查运行；不作为程序失败或成功。

可体验入口：`npm --prefix agent run layers -- world-demo`仍是纯模拟；用每个输出run绝对路径运行`layers -- replay`。只读候选入口：

```bash
./agent/node_modules/.bin/tsx agent/src/game-data/world-task-cli.ts candidates \
  --world-dir PACK --manifest-sha256 MANIFEST_SHA --sqlite-sha256 SQLITE_SHA \
  --version VERSION_JSON --namespace NAMESPACE --quest-id QUEST_ID \
  --bindings BINDINGS_JSON --budget BUDGET_JSON
```

bindings字段为world_pack_sha256/client_version/quest_key、starter/finisher（typed entity+target_signature或null）、objectives（ordinal/entity/target_signature/attack_ability）、reward_policy:none；budget明确task/behavior期限与次数、action_duration_ms。绑定配置是候选配方，不是当前目标/距离/焦点/对话/效果证明。现存M2示例配置在本阶段out中，运行仍blocked。

阶段A源提交冻结后再在主checkout执行新demo与四个严格回放，结果另存同证据目录；本文全量数字只指已经实际完成的检查。阶段B和真实场景尚未据此宣称完成。
