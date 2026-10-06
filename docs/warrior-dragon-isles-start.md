# 战士巨龙岛起始流程：离线资料与现场待填项

2026-10-06 核对的暴雪新玩家指引是：先进行 Exile’s Reach 新手体验，再进入 Dragonflight 升级故事至 70 级，随后进入 The War Within。该结论来自[当前新玩家指南](https://news.blizzard.com/en-gb/article/24266319/new-players-starter-guide-welcome-to-world-of-warcraft)，以及[11.2.7 新玩家与回归玩家流程说明](https://news.blizzard.com/en-us/article/24226733/new-or-returning-take-your-character-to-the-next-level)。后者还区分老玩家可选择其它练级路线、回归体验可改变角色当前引导。两篇资料只用于研究引用，没有导入新的世界数据来源。

本轮采用用户明确选择的联盟战士，目标是当前正式服流程中进入苏醒海岸后短小、可明确验证的地面交互/战斗步骤。种族、等级、账号新旧、教程完成状态、所选战役及当前客户端版本尚未知。联盟/战士记录为 `user_declared`，不代替实际角色身份观察。必须同时准备 Exile’s Reach 未完成和 Dragonflight 苏醒海岸已进入两条路径，现场再核对选用。客户端安装完成、用户授权只读取证后，实际任务日志和引导优先于离线假设。这里不自动建号，不要求旧 2022 首发等级与港口前置，也不套用龙希尔专属起始流程。

## 已固定的本地证据

只读取现有 M2 包。`WorldPack` 验证完整 manifest 字节、SQLite、schema/rules、所有小证据原件 SHA，并以 `mode=ro&immutable=1` 打开 SQLite；准备过程不读取完整大包，不下载、不申请 OAuth、不调用模型或观察 Windows。

| 身份 | 固定值 |
| --- | --- |
| manifest SHA256 | `5f762a251e9fb301ee3c8e50d9bbbc31fefc8bf2a67b686a60ef8360bb1c2774` |
| SQLite SHA256 | `a6bce3f92b7566824cd2267da90acae7d1048b805a6fb13b5e6f47700d185391` |
| 范围 | `retail/dragon-isles/waking-shores-prologue-chapter-one` |
| 世界包覆盖 | 129 实体、779 断言，779 个 reference、当前适用 0 |
| 本次任务卡 | 30 个：24 个选定任务和 6 个依赖引用；本地缺失 0 |
| 联盟 source reference 候选 | 只采用 faction 明确且不冲突的联盟到达/后续候选；其余仅参考 |
| 选定 normalized objectives | 23 unsupported、1 unknown |
| 已核 starter/finisher 角色 | 0 |
| 发布范围 | `local_only`，不授权执行 |

源 ATT 的 sourceQuests、timeline、provider、坐标仍是作者结构；provider 不等于已核 starter 或 finisher。TDB 的原始 Type、Amount、ID、Order、StorageIndex、Flags、Flags2、VerifiedBuild 与 typed target 分别保留。Type 0 是 creature credit/event，不能直接解释为 kill_credit。旧 build 的目标数量不是当前任务进度；同名任务也不能代替 typed quest 身份。源 build、locale、revision 与证据 SHA 逐断言保留，不能拼成一份虚构当前客户端记录。

## 分支与候选任务链

机器场景为 `game-data/scenarios/warrior-dragon-isles-start-v1.json`。它只提交 ID、来源引用、流程假设和取证字段，不提交 ATT/TDB 原文摘取。完整名字、原始目标、前置作者记录和 locale 证据在生成的 ignored `out/` 报告中。报告中 `candidate_quest_cards` 仅含本轮联盟 source faction 明确、没有冲突的到达/后续候选，始终不可执行；`quest_cards` 保留全部参考及同名不同源/部落卡。source faction 缺失、未知或冲突一律排除候选，不因候选在“联盟后续列表”中就猜它属于联盟，亦不把共享后续未知阵营资料伪装为已核联盟资料。

| 阶段 | 当前假设 | 离线已准备 | 现场缺口 |
| --- | --- | --- | --- |
| 识别角色 | 联盟战士由用户声明 | 空客户端/角色/能力模板 | 六维版本、实际阵营/职业、种族、等级、教程与战役 |
| 路径 A：教程未完成 | 当前角色还在 Exile’s Reach | 新教程路径卡、当前官方流程 | 修订教程的确切任务 ID、交接与到达事件；本地包无对应精确链 |
| 路径 B：已到苏醒海岸 | 当前角色已经进入 Dragonflight | 联盟候选、部落同名参考、历史入口引用 | 实际提供、已接、已完成和可接条件；不强制历史入口 |
| 短任务对照 | 选一个双方方案可公平比较的当前步骤 | ordinal/raw count 取证清单 | 目标身份、计数变化、战士技能/键位、输入与效果证据 |
| 有限输入 | 只读证据通过后另行授权 | 取消/释放与预算待验项 | 真实本地释放、失焦、心跳/管道中断，以及动作效果 |

两条路径的 `selection` 均为 `pending_live_evidence`；教程完成状态保持 unknown。路径 A 先只读确认当前教程任务与完成/转移/到达证据，不能自动跳过教程；路径 B 先只读确认苏醒海岸 typed zone/phase 及当前已接/已完成进度，不重做首都或港口任务。两条路径随后都要求同一套能力、动作效果、取消/释放证明，再由用户单独授权有限输入。

本地历史/reference ID 关系如下。箭头表示 sourceQuests 引用；实际可接和是否必须仍为 unknown，保留阈值及过滤规则，不重写成扁平 AND/OR，不声明路径可通行。

- 联盟入口参考 `67700`，到达候选组 `{70122, 70124, 70123}`；后续作者引用涉及 `70125 → 69911 → 69912 → 69914 → 65760`。
- 部落入口参考 `65444`，到达参考组 `{65452, 65451, 65453}`；后续作者引用涉及 `69910 → 69911 → 69912 → 69914 → 65760`。这些部落卡保留同名与不同源冲突参考，不纳入本轮候选。
- 三项到达候选是并列组，不能当作必须依序进行的路线。`69912` 的多个 sourceQuests 原候选和 threshold 均保留在报告图中。
- 双阵营各有同名任务。举例 `70124` 与 `65451` 的 raw Type 1 数量分别为 12 与 20，item ID 也不同；不能按显示名合并计数、目标或完成状态。
- 当前教程转移可能绕过历史首都/港口前置。`66596/65439/70197/70198` 的旧依赖与 timeline 不自动用于强制当前新玩家路线。具体首个现场任务以当前任务日志为准。

## 复现入口

在仓库根目录运行；目录已经存在时工具拒绝覆盖，请选新的验收目录。两个 SHA 必须同时等于机器场景的固定值。

```bash
python3 -B -m tools.warrior_start_prepare \
  --world-dir out/runtime/world/retail/dragon-isles/source-v2/5f762a251e9fb301ee3c8e50d9bbbc31fefc8bf2a67b686a60ef8360bb1c2774 \
  --world-sha 5f762a251e9fb301ee3c8e50d9bbbc31fefc8bf2a67b686a60ef8360bb1c2774 \
  --sqlite-sha a6bce3f92b7566824cd2267da90acae7d1048b805a6fb13b5e6f47700d185391 \
  --output-dir out/acceptance/action-benchmark/warrior-alliance-start
```

输出为 `reference-report.json`、`field-profile.template.json` 和 `preparation-manifest.json`。manifest 绑定场景、源世界包和 SQLite，并列出两份文件字节数及 SHA；同输入结果确定，没有把准备时间伪造为观察时间。报告包含 source 原摘取，继续 `local_only` 放 `out/`，不要提交或向外分发。本工具只做本地证据整理，不作新的许可判断。

能力模板中 interact、select_target、primary_attack、charge、loot、ground_movement 均 disabled/unknown。spell ID、可用等级、按键、持续时间、冷却和目标条件不猜测。`class_intent=Warrior` 与 `faction_intent=Alliance` 只是用户声明；现场 character.class/faction 仍需自己的证据。该模板不能直接启用现有输入 profile；先填取证事实并由既有校验流程生成实际运行配置。

## 只读取证待填表

每个事实记录源观察时间、源时钟 domain/id/unit、capture/observation ID、artifact SHA、提取程序和 code/prompt/model 版本。source time 与接收 time 分列；不能把 WSL 单调时钟、Windows QPC 和游戏时间直接相减。所需字段列表也在 JSON 场景中，现场脚本可引用。

| 项目 | 必需证据 | 当前状态 |
| --- | --- | --- |
| 客户端 | branch/expansion/patch/build/region/locale 各自证据 | 未知 |
| 角色 | stable identity、class/faction/race/level/spec；教程与战役状态 | 联盟/战士为用户声明，实际观察均未知 |
| 所在区域 | typed map/zone、floor、phase、客户区物理像素和 DPI | 未知 |
| 任务 | offered/accepted quest key、当前完成与交付状态、奖励身份/策略 | 未知 |
| 目标 | 当前 target typed key 与 signature；starter/finisher 的独立角色证据 | 未知 |
| credit | objective assertion 与 ordinal、current/required count、缺失/unsupported 区分 | 未知 |
| 战士能力 | 当前已学且可用的 spell 身份、observed bindings、cooldown/target 条件 | 未知 |
| 效果 | input issued 独立事件；后续 progress delta/可核效果 source 事件 | 未知 |
| 释放与取消 | 有限预算、失焦/取消、独立 watchdog、心跳/EOF、中断恢复实测 | 未验 |

现场基准不能串行做一次性任务后拿不同起始进度冒充公平重复。先只读确定可重复步骤，或由用户准备匹配角色/任务状态；否则对照公平性与每分钟有效动作数应报告不可比。输入已发出计数与效果已确认计数分开，任务 UI 消失不能独自证明交付，视觉模型返回的旧帧不能冒充新观察。

## 离线验证

`python -m pytest tests/test_warrior_start.py -q` 覆盖 raw Type/count/source locale/build 保留、名字歧义、用户声明与观察分离、两条路径持续待定、联盟候选筛分、部落/未知/冲突 source faction 不采纳、空能力模板、manifest/SQLite/artifact 篡改、缺包、双 SHA 与 scope 不一致、跨产品 source 拒绝、不同 build 的 reference 不合并、不覆盖输出以及实际 CLI。模拟 fixture 不读取真实客户端，不申请数据源、不跳过测试。

真实固定本地包 CLI 已实际运行，生成 30 张任务卡以及完整前置引用图，统计与上表一致。游戏动作、模型调用、Windows 桌面取证均为 0；这次验收证明离线准备可复现，不证明当前新手任务可以自动执行。
