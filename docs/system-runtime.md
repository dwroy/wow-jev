# 第5–7阶段入口

执行大脑、日志学习和版本迭代已有可运行入口，并已接通正式服只读和有限live运行、版本核对、名字/NPC感知协议、冻结源码启动。4K独立战斗样本、Jev主动动作、当前NPC现场校准/交互和新版本游戏收益尚待实测，状态见[acceptance/retail-closure.md](acceptance/retail-closure.md)。

## 正式服只读入口

先枚举当前窗口，每次重启或重新打开都需复核HWND/PID：

```bash
npm --prefix agent run input -- list
npm --prefix agent run system -- observe \
  --window 0x当前HWND --pid 当前PID \
  --client-profile /home/dai/Projects/wow-jev/game-data/profiles/retail-cn-12.1.0.69933.json \
  --run-dir /absolute/new-observation-run
```

observe核对实际客户端并采样，不创建输入执行器。加`--seed --allow-game-image-upload`可启用已授权游戏截图的Seed规划；默认不调用模型。正式服live入口需要`--live --role-scene-confirmed --goal FILE`及适用的校准/键位，游戏输入要求前台。`interact_npc`只允许一次100ms互动探测，不能从未知距离推出自动移动；当前NPC模板与功能仍待实测。完整已批准版本的真实启动见[frozen-live-runtime.md](frozen-live-runtime.md)。

## 体验三层执行

在WSL仓库根目录：

```bash
cd /home/dai/Projects/wow-jev
npm --prefix agent run system -- demo
```

演示使用明确标记的模拟环境。大脑将接近步骤交给Jev，Jev生成有限计划交给CodePlay；模拟世界随后产生“可交互”和“对话打开”观察。正常结果为completed、2个模拟输入、0真实输入，game_effect始终unverified。程序不启动Windows或模型、不读取凭据，不能把这个演示当成真实NPC任务完成。

```bash
npm --prefix agent run system -- demo --scenario target-lost
npm --prefix agent run system -- demo --scenario unknown
npm --prefix agent run system -- demo --scenario cancel
npm --prefix agent run system -- demo --goal-kind panel
npm --prefix agent run system -- replay --run-dir /absolute/run_dir
```

目标丢失和距离未知升级处理；取消终止旧控制权并等待释放。正常完成退出码0，升级/取消退出码1，参数或回放失败退出码2。演示保存冻结代码指纹、知识、prompt、目标版本、观察、规划、控制权交接和底层输入回执。回放从可信候选重建代码计划，嵌套Jev仍严格核验来源和大脑附加条件。

执行大脑运行开始时冻结目标、运行版本和知识，任务中修改目标会先取消旧执行并完成版本屏障，旧回答不能复活。知识只影响规划或收紧候选，不能创建键位或输入权限。Eye已提供可选的名字bank/NPC对话/显式目标交互指示接口；真实NPC路线需要现场可靠校准及当前同帧证据。缺失时等待/升级；未知距离支持明确目标下的一次有限互动探测，自动接近仍需要可靠距离证据。

## 学习真实日志

```bash
npm --prefix agent run system -- learn \
  --run-dir /absolute/existing-run \
  --knowledge-dir /absolute/knowledge-version \
  --out-dir /absolute/new-review-directory
```

可重复指定run-dir；相同源不会重复累计。程序先严格回放代码/Jev/Brain/Eye日志及截图引用，再切片任务、计划和目标遭遇，生成知识与复盘草稿。源日志不被修改。知识是不可覆盖、按内容hash命名的canonical JSON；derived slices/reviews放独立目录。

只有真实confirmed和源观察才能成为效果事实。unknown、失败、取消、部分输入和模拟结果分别保留；模型读到的名字是“报告的UI名字”，不会生成实体GUID、击杀、怪物等级或掉落率。推断建议与观察统计分开。当前复盘是规则提取，不是无约束LLM生成知识。

`knowledge/baseline-v1`已沉淀第一批历史真实知识。把其中knowledge JSON通过`--knowledge-file FILE`传给demo，可以看到日志中的consulted_fact_ids；当前4K运动经验使NPC路线升级处理，0模拟输入。这展示经验实际影响了后续决策，不表示学会了导航。

```bash
npm --prefix agent run system -- inspect --knowledge-file /absolute/knowledge.json
npm --prefix agent run system -- demo --knowledge-file /absolute/knowledge.json
```

## 迭代与版本

先为已审查的代码、知识和提示注册基线：

```bash
npm --prefix agent run system -- baseline --registry /absolute/registry \
  --knowledge-file /absolute/knowledge.json --version-id baseline
```

修改提案是数据：真实问题、知识fact/evidence引用、基线commit、受限文件路径、原文件SHA和完整新内容。模型不能提供执行命令。prepare在独立工作树应用修改，evaluate运行固定typecheck、回归与prompt断言。输入、评估与版本启动层不在自动修改范围。只有工具签发的通过报告和未发生变化的候选才能publish。

```bash
npm --prefix agent run system -- stage --proposal /absolute/proposal.json \
  --knowledge-file /absolute/knowledge.json --candidates-root /absolute/candidates --registry /absolute/registry
npm --prefix agent run system -- evaluate --candidate-id ID \
  --candidates-root /absolute/candidates --registry /absolute/registry
npm --prefix agent run system -- publish --candidate-id ID --evaluation-id ID --version-id VERSION \
  --candidates-root /absolute/candidates --registry /absolute/registry --activate
```

发布包冻结实际源码、知识和prompt，旧版本保留。`--registry`会加载已批准源码副本并启动新的任务，校验源码、依赖锁文件与知识/prompt hash；原始包不被写入，运行中的任务继续使用旧快照。新任务日志始终保存到持久目录。

```bash
npm --prefix agent run system -- version --registry /absolute/registry
npm --prefix agent run system -- demo --registry /absolute/registry --goal-kind panel
npm --prefix agent run system -- rollback --registry /absolute/registry --version-id baseline
```

本轮发布验收范围为离线回归与有限模型协议对照，不是替代动作的游戏收益评估。新版本的真实收益必须在相同任务条件下独立验证。详细接口见[brain-runtime.md](brain-runtime.md)、[learning-runtime.md](learning-runtime.md)、[iteration-runtime.md](iteration-runtime.md)，证据见[acceptance/stages-5-7.md](acceptance/stages-5-7.md)。
