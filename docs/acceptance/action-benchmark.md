# 联盟战士离线动作基准与现场准备验收

2026-10-06。接续`05c7b48`，实施树`.worktrees/action-benchmark`；用户当前授权完整离线实施、验收后普通推送codex/agent-system。客户端安装中，未授权Windows桌面只读取证，本轮不执行现场阶段。

## 已实现范围

- 同候选、同输入闸/复采样/动作时长/效果判定的single与layered策略；真实BodyRuntime和Brain/BehaviorJev选择协议，带源身份视觉摘要实际进入Brain上下文。
- 可选Eye/Body/Jev/Brain sidecar埋点；native可选精确QPC capture/CV/artifact及首次成功SendInput调用区间；旧protocol格式和日志回放不放宽。
- 指定成本、0模型成本敏感性、正常及unknown/身份漂移/失焦/取消/无进展反例；固定seed成对AB/BA、指标分解、源快照与独立语义回放，virtual/实测wall/真实输入与游戏效果分别报告。
- 联盟战士两起点准备：教程未完和已进入苏醒海岸。实际固定本地包30张参考卡、4张明确联盟候选、26排除；37条unknown前置边和9组同名歧义保留。当前适用0、规范目标23unsupported/1unknown、已核实giver角色0，不提升reference/local_only。
- 固定argv现场脚本：prepare/validate纯离线；显式独立授权后readonly discovery及已校准只读；再独立授权有限v1可逆背包输入/模型paired基准。真实task v2仍拒绝，模板未知版本/角色ID/窗口/PID均null。

方案与指标口径：[action-benchmark.md](../action-benchmark.md)。任务数据：[warrior-dragon-isles-start.md](../warrior-dragon-isles-start.md)。现场脚本/检查单：[action-benchmark-field.md](../action-benchmark-field.md)。

## 独立审查与原始失败

重hash伪造负wall跨度曾通过独立回放；现跨span壁钟起止/原始observe/input因果核验拒绝`wall_clock_evidence`，重新执行语义及重算summary均不接受该负值。原负例与修复后拒绝在主`out/acceptance/action-benchmark/audit/`归档。

现场对时使用整数SampleBracket而trace保留QPC小数，曾漏掉量化误差；现优先精确native capture，coordinator接收上沿+1ms、旧remote下沿再-1ms，保存原始bracket/量化/有效期。现场trace协调器使用同origin的performance小数，纯Windows端到端保留SendInput两个边界，不假精确跨域。

原生产SeedClient/SeedBrainClient配零回复Node worker，100ms期限实际约101/109ms返回timeout，10ms取消约11/12ms返回closed，busy=false；NativeInputClient配零release ACK mock约103ms返回unconfirmed，未发execute。审查没有读取凭据/调用模型/输入或桌面。默认沙箱子进程初次环境失败保留，同一命令正常权限审查后复跑，与程序失败或审批拒绝区分。

单模块定向结果：benchmark35/35、field13/13、trace13/13；Python任务数据24/24、field wrapper8/8。当前C#四native/JevCapture/NpcClassify源码编译成功，只编译和离屏，不能由此宣称现场或物理输入通过。最终全量及主固定CLI结果见下方。

## 完整验收及固定主checkout入口

全量回归全部exit0，原始日志/JUnit/命令/cwd/环境留主`out/acceptance/action-benchmark/checks/`：

- Python收集695项：692passed、3原有strict xfail（gamma1.1反例）、0skip/失败。使用当前源码构建的WinEye和NpcClassify显式环境变量，原生离屏测试全部实际纳入。
- 原始完整`npm --prefix agent test`：498/498passed、0fail/skip/cancel/todo。保留旧437项，新增61项；Python保留旧660passed，新增32项。
- `npm --prefix agent run typecheck`及`git diff --check`通过；没有删/跳用例、选择子集或改变全量脚本。

固定提交后运行default/all场景、zero-model以及两倍模型成本成对基准并独立replay，实际本地包prepare、field prepare/help；主checkout集成结果将保存`main-acceptance.json`并补记。完整回归期间源码冻结，后续记录只改文档。

离线体验：

```bash
npm --prefix agent run benchmark -- run --run-dir out/bench/run-01 --repeats 4 --seed 42 --scenario all
npm --prefix agent run benchmark -- replay --run-dir out/bench/run-01
python3 tools/action_benchmark_field.py prepare --run-dir out/bench/field-kit
```

阶段完成后停下等安装和用户现场授权。模拟的11个有效动作是fixture后观察验证，不是游戏完成；所有离线真实模型调用/输入为0，game_effect=unverified，不能报告当前正式服更快。缺真实可重置任务/typed identity/技能校准及独立效果证据仍是后续现场边界。
