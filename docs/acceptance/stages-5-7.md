# 第5–7阶段工程验收

2026-10-05。用户明确要求先推进5–7；第4阶段4K正式服验收继续待补。本轮验收范围为执行大脑工程、真实历史日志学习、离线版本迭代与冻结代码启动，实际游戏输入为0。正式服NPC任务和新策略游戏收益均未验收。

## 第5阶段：执行大脑

已实现严格目标类型、工作记忆、有限阶段候选、Seed规划接口、控制权交接、旧目标版本屏障、取消与释放。NPC路线必须有当前同源捕获、焦点、目标名字/签名、存活/非战斗、交互距离和对话状态；模型不能生成任意动作。输入回执不能代替完成证据。

normal-2模拟完成Brain→Jev→CodePlay的接近、交互、观察闭环，2个模拟输入、0真实输入、game_effect=unverified；独立嵌套严格回放通过。target-lost-1升级处理（1个已发生模拟输入），unknown-1升级处理（0输入），cancel-1取消（0输入），均未宣称游戏成功。

真实Seed协议probe使用同一张既有正式服4K图和三个人为模拟规划请求：请求/候选来源明确不是在线CV。基线3/3有效，耗时1864–2579ms，均选wait；能逐项正确引用两条真实经验ID。仅证明规划协议与保守选择，不证明NPC识别、接近或画面准确率。

normal-1初次把mock的model=null按真实Seed验证而退化为等待；修复仅允许simulated控制器接受mock，真实Seed客户端继续要求固定模型，原运行保留。learned-1初次因事实scope.test_target未匹配而未咨询知识；修复后learned-2实际咨询两条4K/live/完整来源运动经验，触发保守升级、0模拟输入。历史结果属性与名字来源说明也已与实时前置条件分开；咨询历史背包事实不能覆盖未知CV。

## 第6阶段：经验与知识

learning-1输入retail-3、retail-2、Stage2 with-seed、Stage4 main-demo-1，并重复retail-3检验去重。四个独立来源生成25条知识、14个片段、13条复盘草稿；重复来源不增加样本。

知识中19条观察、6条推断；按用途为19条经验、4条已确认背包事实、2条报告的目标单位UI名字统计。名称来自Seed的报告，不是实体GUID或人工金标准；等级、击杀、独立实体数和掉落率保持null。失败来源及模拟来源分别保留，默认游戏查询排除它们。完整retail-3的运动效果15项unknown没有升级成游戏成功。

版本文件为 `knowledge/baseline-v1/knowledge-5134f31f6ac964d4ca50ecfa5f7968075b7f00f43753acf4e76c8d2b4a6910b8.json`，SHA与文件名一致。每条事实保留来源manifest/events hash、实际记录seq、观察/截图ID、样本数、反例、技能与布局；外部引用重新绑定实际样本，不接受清空来源或伪造样本数。知识加载可重新回放原来源，Brain请求及审批日志记录实际consulted_fact_ids/knowledge SHA。Brain模拟日志也通过严格嵌套回放后进入学习，仍只有simulated经验。

当前学习实现是独立离线规则提取与复盘草稿，尚未开放LLM直接写事实或自主更新怪物行为模型。

## 第7阶段：版本迭代

真实问题来自完整retail-3运动输入已结束而效果unknown的5个move_for样本。提案引用fact-23027f06…及其源证据，在实际独立Git工作树修改Brain prompt；固定typecheck、全部tracked TS回归与prompt断言均通过。评估报告签名绑定候选清单与源码hash，发布前再次核对；源码、知识、prompt及旧版均保存。

最初评估把正常Python缓存误判成额外源码，发布没有进行；原失败保留。修复仅允许被Git实际忽略的普通Python/pytest缓存，未知源码/输出仍拒绝；评估禁写Python字节码。原候选重新评估通过，含后续scope修复的候选独立重新评估。

v2发布为movement-evidence-runtime-v2（commit5ccd113），真实模型对照首例却输出了不存在的request_id=system-demo-request。worker严格拒绝该回答，负责人实际回退baseline；没有输入。v3进一步明确逐字复制请求与证据关联，重新跑隔离回归，再做三次真实Seed对照全部有效（1862–2613ms，均wait，两条经验ID正确引用），才发布movement-evidence-runtime-v3（commit5f5bc81）。v2、错误响应和回退记录完整保留。

上述模型样例是开发协议对照，不能证明准确率、收益或新prompt优于旧版；三例没有体现动作收益改善。prompt逻辑协议仍为brain-retail-v1，修订由不同SHA和RuntimeVersion ID标识。

task-boundary-1实际启动冻结代码副本：基线任务运行期间切换指针，旧任务继续baseline，新任务使用v3；源码hash分别3b2e7f…/71d47f…，随后实际rollback再恢复v3。任务日志在持久目录，临时源码删除后仍可回放。frozen-baseline-1、frozen-v2-1及边界probe保留各版本加载证据；子任务去除凭据环境，校验源码、依赖锁与知识/prompt hash。代码版本不会只改日志标签。

## 记录与后续

最终集成219项TypeScript测试（0失败/跳过）、68项Python模型worker回归、typecheck均通过；源码未修改Windows模块，因此本轮没有重做Windows真实输入验收。命令为 `npm --prefix agent test`、`npm --prefix agent run typecheck`、项目.venv的 `pytest tests/test_brain_worker.py tests/test_seed_worker.py tests/test_jev_worker.py -q`；原始结果在integration-1。签名候选评估另实际执行整套tracked回归，结果/输出hash保留在iteration-1。

原始证据位于主checkout `out/acceptance/stages-5-7`；模型probe所有失败与模拟失败均保留。工程入口见[system-runtime.md](../system-runtime.md)，详细接口见[brain-runtime.md](../brain-runtime.md)、[learning-runtime.md](../learning-runtime.md)、[iteration-runtime.md](../iteration-runtime.md)。

正式服还需要第4阶段当前4K战斗校准，以及目标名字、交互距离、NPC对话的可靠感知。当前缺失字段时等待/升级；没有开展实际NPC走近、交互、任务或新prompt游戏收益验收。整WSL重启恢复仍待独立测试。
