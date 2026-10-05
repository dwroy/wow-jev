# WoW 游戏数据库设计与跨机器交接

日期：2026-10-05。交接对象为继续实施 wow-jev 的开发 agent。用户要求将已讨论的设计写入仓库并推送远端，供其它机器接续。目标是让 Agent 依据已知攻略扫任务、自主打怪升级，并从实际执行中沉淀可验证的经验。

本文件固化数据库设计与实施计划。新世界数据包、运行学习库和批量导入器尚未实现；本次没有下载 TDB 大包、调用认证 API 或导入插件数据库。调研事实、拟实施结构和验收要求分别说明。

## 接续入口

- 接续分支：`codex/agent-system`，远端 `origin` 为 `git@github.com:dwroy/wow-jev.git`。本文件和最新 `HANDOFF.md` 随该分支推送；不要只拉默认 main。
- 先读 `AGENTS.md`、本文件、`HANDOFF.md`，再读 `docs/game-database.md` 和 `docs/four-layer-agent-design.md`。
- 实施使用项目内独立工作树，主 checkout 用于集成和验收。不要覆盖其它机器或会话的未提交工作。
- 用户已授权项目负责人组织 agent、研发测试与本地合并；本轮明确授权推送交接内容。后续推送仍遵守 `AGENTS.md` 的当前会话授权要求。
- 下一步优先实现下面的里程碑一；数据库离线研发不需要 WoW、模型、OAuth 或可交互 Windows 桌面。

## 已有实现与缺口

| 部分 | 当前已实现 | 本轮设计需要补充 |
| --- | --- | --- |
| 游戏库 | `game_database/` Python SQLite；`agent/src/game-data/` TypeScript 只读桥 | 规范实体、任务图、空间与来源版本模型、世界包构建 |
| v1 数据 | `assertions`、`applicability`、`imports`、`client_profiles`；实体种类 creature/quest/item/spell/zone | 成就、副本、角色进度、日志索引、攻略与经验表 |
| 来源与查询 | SHA、原子幂等导入、六维精确版本匹配、同名歧义与冲突保留 | 字段级冲突、许可、源提交版本、覆盖报告 |
| 初始内容 | 11条巨龙岛断言，全部 `reference_only`，可从 Git 中的 seed 重建 | 当前客户端已核实内容；完整任务目标/前置/地点 |
| 四层执行 | L1时间线、L2人物动作、九类L3行为、三类L4任务及日志/回放入口 | 数据库查询到L4任务的适配、世界包版本引用 |
| 学习 | 既有 eye/code_play/jev/brain 日志到知识快照与评估流程 | `layers.jsonl` 证据适配、经验适用性扩展 |

交接前代码基线为 `dcbf332`。此前该机器完成335项TS测试、typecheck、四个Windows原生程序构建及六行为模拟闭环；这些是历史证据，不等于新机器或新数据库已经验收。见 `docs/acceptance/four-layer-runtime.md`。

现有库只读查询仍返回 `automatic_action_eligible=false`。数据库知识不能代替当前目标、距离、战斗状态、焦点和按键释放证据。11条 seed 对当前69933精确查询返回 `not_found` 是预期结果，不能为了得到 found 而改成自动跨版本匹配。

## 存储设计

采用两个SQLite存储域加内容寻址文件，先保留现有v1接口与知识快照格式。

| 存储 | 内容 | 写入与发布 |
| --- | --- | --- |
| 不可变世界包 | 实体、任务关系、地图、成就、副本、攻略、原始断言与适用性 | staging构建并校验；发布后只读，按manifest SHA固定 |
| `agent.sqlite` | 角色进度、日志索引、局部实测断言、经验候选、评估与知识版本注册 | WSL单写服务；规划使用WAL |
| 内容寻址文件 | 来源原件、JSONL、PNG/视频、模型回答、配置与已发布知识快照 | SHA引用、去重、容量管理；不把大媒体塞入数据库 |

建议布局，属于待实施路径：

```text
out/runtime/world/retail/dragon-isles/<release>/world.sqlite
out/runtime/world/retail/dragon-isles/<release>/manifest.json
out/runtime/world/classic-era/<release>/world.sqlite
out/runtime/agent.sqlite
out/runtime/artifacts/<sha256>
out/runs/<run_id>
knowledge/<knowledge_release>
```

世界包按产品分支和内容范围组织。角色进度、日志索引和经验注册放同一运行库，以避免依赖跨数据库写事务。跨世界包的实体引用保存包SHA和强类型实体键，并由导入/查询层验证；SQLite不会跨独立文件提供这些外键保证。

任务图与路线使用关系表，图搜索由代码执行。暂不引入PostgreSQL、Neo4j或独立向量数据库。大量历史统计后续可从验过的日志派生Parquet，用DuckDB离线分析；语义检索可作为攻略/经验召回补充，不能取代实体与适用性检查。

## WSL Windows 与数据库运行时

可写运行库放在WSL本地文件系统，由同一个写连接管理写入和checkpoint。Windows高频CV与输入继续在本地执行，通过JSON通道提交观察/回执；不要让Windows经共享路径与WSL同时打开同一个可写WAL文件。Windows如需本地查询，复制已发布世界包并核对SHA。

调研机器Python实际使用SQLite 3.45.1，现有v1库为DELETE journal模式。正式启用新WAL运行库前检查Python连接使用的库版本，不以系统sqlite3 CLI版本代替。SQLite官方披露WAL-reset竞争问题，3.51.3及以后已修复，另有部分旧版回补；新运行库应固定到已修补运行时。单写者与checkpoint归属仍须明确。[WAL官方说明](https://sqlite.org/wal.html#walreset)

世界包发布前完成checkpoint，转为适合只读发布的文件，再计算文件SHA。活动运行库通过Backup API或一致性快照备份，不能只复制主文件而遗漏尚未checkpoint的WAL。[SQLite备份说明](https://sqlite.org/backup.html)

## 数据来源与导入优先级

资料于2026-10-05核查。固定tag/commit、记录代码/数据/图像各自许可与第三方来源；公开源码不自动等于数据可任意转换分发。

| 来源 | 已核实内容 | 首批定位与边界 |
| --- | --- | --- |
| ATT AllTheThings | 按区域/资料片/副本组织任务、NPC地点、成就criteria、收集关联；根仓库MIT | 优先静态种子源。保留上级节点条件、时间线及第三方输入来源；不是完整任务正文/目标数量/刷新库 |
| TrinityCore TDB | master支持12.1.0.69933，发布TDB1210.26091；有任务/NPC/spawn/POI结构 | 可下载候选，GPL-2.0。匹配客户端build不证明与当前官方国服数据一致；巨龙岛行数和覆盖率尚未查 |
| WoWDBDefs和DBCD | 按BUILD/LAYOUT定义和读取DB2、hotfix；客户端地图与表基础 | 精确build提取工具。DBCD MIT；WoWDBDefs definitions CC-BY-SA4、code BSD3。定义不是完整表数据，工具许可不代表游戏资产许可 |
| 官方Game Data API | 有任务、成就、Journal等接口家族 | 补实际可获取的名称/描述/关联。没有进行当前认证调用，不保证完整NPC/spawn/前置条件；namespace不是历史build证明 |
| MDT Legacy | 巨龙时代副本的地图层、怪物组、克隆点位、巡逻和部分技能 | 副本候选，GPL-2.0；巨龙时代位于Legacy，不能只下载现行MDT主包 |
| BtWQuests Dragonflight | 任务图、分支条件与独立NPC/Objects/语言表 | 结构参考；发布页All Rights Reserved，默认不转换分发 |
| HandyNotes Dragonflight | 稀有/宝藏/成就点位、多个位置、巡逻、追踪任务 | 地图模型参考；All rights reserved，默认不批量转换分发 |
| WoW-Pro | 攻略步骤DSL及任务目标/旅行/使用物品/条件 | L4到L3表达参考；Addons AND Guides CC BY-NC-ND3，不默认改写导入 |
| Questie和QuestieDB | 实体schema、基础表加版本correction、前置/替代/互斥模型 | 借鉴模型；当前数据面向Classic，不能混入正式服巨龙岛。新拆分库许可需单独核对 |
| DBM和LittleWigs | 首领/技能/阶段/职责/难度/事件与提示 | 副本机制模型参考，逐文件核许可和当前可用事件；不将旧计时当当前机制保证 |

ATT首批固定提交：`1d34d9051ac597b150636314467e3cc6a5946f25`。其Retail配置 `DataPhase=MID`、`DataPatch=[12,1,0,69933]`，仍包含巨龙岛历史内容。导入器按该提交的实际目录 `.contrib/.db/standard/` 编写，搜索引擎旧缓存的 `.contrib/Parser/DATAS` 路径不能作为接口。

ATT苏醒海岸的真实作者记录：任务69911关联来源任务70125/69910、NPC193362和百分比坐标76.6/33.7。来源数组的AND/OR语义必须核对作者编译规则，不能直接扁平化。任务70197/70198同时带加入10.0.2与移除于TWW的时间线，需保留历史移除条件。[固定提交任务源码](https://raw.githubusercontent.com/ATTWoWAddon/AllTheThings/1d34d9051ac597b150636314467e3cc6a5946f25/.contrib/.db/standard/02%20-%20Outdoor%20Zones/14%20Dragon%20Isles/The%20Waking%20Shores/Quests.lua)

TDB1210.26091压缩包约149MB，发布资产标示SHA256 `fc5513334d7534a19f533124a95910193c8150379e5ed8d0db3e547ac2c5a3f5`。本次只核查发布页，未下载核验；实施时重新核对资产名、发布校验值和下载字节，再抽样判断可激活字段/区域。[发布页](https://github.com/TrinityCore/TrinityCore/releases/tag/TDB1210.26091)

## 实体身份与版本

实体键采用产品命名空间、实体类型与原生ID；自定义服务器另加独立namespace。名称与别名只是带locale的文本，不能按名字合并NPC、阵营任务或不同产品同ID实体。

必须分别保存以下版本：

| 版本 | 字段或内容 |
| --- | --- |
| 客户端上下文 | 保留 `branch/expansion/patch/build/region/locale` 六维 |
| 内容归属 | `content_expansion=dragonflight`，不等同10.x运行客户端 |
| 来源版本 | 源Git提交/插件版本/API namespace/客户端提取build/抓取时间/转换器版本 |
| 世界包版本 | 来源集合、schema、解析规则、覆盖和校验报告、manifest SHA、SQLite文件SHA |

已核实的安装样本为retail/midnight/12.1.0/69933/cn/zh_CN；配置文件zhCN需显式规范化。目标机器重新核实客户端，不沿用旧HWND/PID、安装profile或online标志。服务端热修、位面、阵营、难度、赛季和角色条件另行限定适用性。

每个字段断言保存实体、predicate、值/状态、适用条件、原始文件SHA/locator、源版本、源观察时间、入库时间与核实状态。保留unknown、unsupported、明确不存在；字段冲突在相同条件下处理。不同来源补充不同字段不应令整个实体不可用。

解析结果必须确定性输出状态、采纳的assertion IDs、来源和规则版本；无法按证据规则解决的同字段冲突返回conflict，不能按导入先后覆盖。被run或已发布经验引用的旧世界包与证据一起固定保留，新包发布不触发其删除。

v1精确查询保持原语义。v2可把无语言数值和locale文本分开以减少重复，但完整查询仍执行显式适用性校验。允许一个世界包声明多个已核实build，不自动选择最近build。每次run冻结世界包SHA，更新在任务边界选择新版本，旧日志仍引用原包。

## 游戏实体与关系表

| 领域 | 主要表 | 关键关系 |
| --- | --- | --- |
| 发布与来源 | source_revision/source_artifact/import_batch/world_pack/assertion/applicability/conflict | 每字段能追到原件、许可和版本 |
| 基础游戏 | entity/localized_text/creature/game_object/area_trigger/item/spell/faction | 稳定ID与名称、描述、别名分开；Object/触发区域可关联任务 |
| 任务 | quest/quest_objective/quest_giver/quest_reward/quest_relation/condition_expr | starter/finisher可为NPC/Object/Item；目标类型、ID、顺序、数量、kill-credit分开 |
| 地图 | ui_map/world_map/map_floor/map_transform/location/objective_area | 坐标域、楼层、位面、精度与变换版本 |
| NPC | creature_location/npc_service/patrol_path | 模板与多个候选位置/功能/巡逻条件分开 |
| 成就 | achievement/criteria_tree/criteria/achievement_reward | AND/OR条件树、统计量与角色/账号范围 |
| 副本 | instance/difficulty/encounter/enemy_pack/mechanic | 首领、怪物组、技能、阶段、职责、难度与赛季 |
| 攻略路线 | guide_step/route_node/route_edge/objective_strategy | 执行条件、旅行模式、能力要求、耗时、风险和验证记录 |

任务前置使用受控条件AST，支持AND/OR/NOT、替代、互斥、阵营/职业/等级/声望、账号解锁、战役跳过与位面条件；以true/false/unknown三值求值。导入保留原表达，不执行远程任意Lua。官方category列表次序不保证任务链顺序。[官方回复](https://us.forums.blizzard.com/en/blizzard/t/quest-attributes/8892)

NPC模板ID、来源数据库spawn ID、实际游戏GUID与屏幕track ID分开。OCR名称只能形成候选链接并返回resolved/ambiguous/unresolved；相同名字指纹不代表GUID。

位置必须包含coordinate_space、typed map reference、floor、x/y/z、phase条件、transform revision、accuracy和source。UI地图、世界地图、Journal实例、挑战地图和插件编号不能共用无类型map_id。MDT蕨皮山谷同时有内部编号48、挑战地图405、UI地图2096/2106以及插件纹理坐标，这是必须保留命名空间的真实例。[MDT源码](https://github.com/Nnoggie/MDT_Legacy/blob/main/Dragonflight/BrackenhideHollow.lua)

地点线索不等于可通行路线或navmesh。路线边保存方向、地面/平稳飞行/驭空术/交通模式、解锁条件、能力要求、耗时与危险成本、最后验证、失败反例；未核实通路不可直接用于盲目长输入。副本机制同样按build/difficulty/season/phase/role保存。

## 角色操作与学习表

| 领域 | 主要表 | 规则 |
| --- | --- | --- |
| 角色上下文 | character/account_scope/capability/unlock | 账号与角色身份、职业/专精、等级、移动能力和模式 |
| 当前进度 | quest_progress/objective_progress/achievement_progress | 来源、观察时效、完整性、角色/账号范围；没有记录不等于未完成 |
| 运行索引 | run/event_index/decision/action_intent/receipt/effect | 观察、决策、实际输入、释放与后续效果分别关联 |
| 学习 | episode/experience_candidate/evaluation/knowledge_release | 可追溯片段、样本、反例、适用性、评估与不可变发布版本 |

原始JSONL与截图是权威证据，SQLite索引可重建。避免依赖原始日志和索引两个存储同时提交成功；通过run/seq/event SHA幂等补入索引，缺口明确标记。世界包内容和角色当前事实分开，任务从栏中消失不直接判定交付完成，尸体截图不能累加为自己的击杀。

run冻结world pack、代码、prompt、knowledge、键位和视觉校准SHA；保存actor/task/revision/epoch、observation/action/receipt/effect IDs、真实或模拟模式、input_count_scope、源时钟与接收时钟。QPC、WSL单调时间、游戏日志时间没有对时映射时不可相减；迟到结果不能按入库时间刷新观察时效。

学习流程：

```text
严格回放原始run
→ 按目标生成episode
→ 提取observed事实与inferred建议
→ 经验候选，保留样本、反例和适用条件
→ 评估
→ 发布knowledge/prompt/code版本
→ 后续任务固定引用
```

模拟与真实效果分别统计；连续多帧同一事件去重。经验适用性至少含客户端、职业/专精、等级/能力、键位、UI/calibration、任务/路线revision。实测修正作为独立覆盖层，不覆盖外部原始断言；候选可以更新，已发布知识保持不可变。被经验或验收引用的证据不得被容量清理误删。

必须新增 `layers.jsonl` 到learner的来源适配；同时扩展 `RuntimeVersion`、schema/validation/registry/manifest/replay，使世界包与知识SHA贯穿执行与学习。只创建新表不代表闭环已接通。

## 检索导入与迁移

在线查询先过滤版本与角色条件，随后按区域/ID/别名查实体、目标、地点和策略。大脑收到小型结构化结果及证据引用；高频即时字段留在内存，数据库记录变化与动作关联。现有TS桥每次启动Python，适合低频；扩充批量API或常驻只读服务后再评测延迟。

名称做规范化与别名索引，中文文本使用固定版本分词/双字预切索引；FTS5 trigram补充三字以上子串，不能独自满足两字查询。RTree只筛空间候选，楼层、位面、距离与可达性再检查。[FTS5](https://sqlite.org/fts5.html)、[RTree](https://sqlite.org/rtree.html)

导入流程：固定来源与许可→原件SHA→受控适配器→统一中间格式→ID/关系/坐标/版本/许可/覆盖校验→staging数据库及索引→完整性报告→manifest及文件SHA→原子发布只读包。失败不发布半包。增量保留added/changed/removed/withdrawn；源文件删除记录不自动证明实体在游戏中不存在。

TDB dump使用受控SQL适配/隔离暂存，只提取所需表与字段；不把任意来源SQL直接执行到业务库或现有v1库。

保留现有v1库与接口；先在新路径实现v2 schema、派生实体/关系和manifest，不就地覆盖旧库。旧assertions和SHA不重写，v1→v2转换保存映射及迁移版本。规范核心列使用强类型，条件/少量扩展字段用经过schema验证的JSON；任务全文/本地化文本独立存放并记录许可来源，不受旧facts小字段模型约束。

## 实施里程碑与验收

| 里程碑 | 实施范围 | 必须验收 |
| --- | --- | --- |
| 一 基础库 | v2 schema、世界包manifest/staging构建、运行库、v1兼容迁移、批量只读查询 | 原子/幂等导入、篡改拒绝、缺字段、跨版本隔离、备份恢复、旧接口回归 |
| 二 巨龙岛种子 | 固定ATT/TDB版本、四主区地图层次；集中苏醒海岸一段任务区域 | 选20–50任务核验前置/阵营、NPC、目标、点位；报告许可、冲突和字段覆盖 |
| 三 角色与任务 | 可接条件、解锁、进度、路线候选、代表性成就/副本样例 | AND/OR/跳过、角色/账号范围、楼层/位面、事件去重、unknown阻塞、中文短词检索 |
| 四 执行与学习 | 世界包到L4任务、layers证据学习、经验评估与版本发布 | 接取→执行→交付→经验沉淀可追溯；模拟不污染真实统计；换包后旧run回放与回退 |

逐阶段报告参考覆盖与当前客户端已核实覆盖；记录not_found、unsupported、unknown、冲突和缺失字段，不用总行数替代质量。ID/区域/中文查询分别量测p50/p95及冷/热缓存；性能目标在基线测量后确定，不把设计数字当实测。

## 在其它机器恢复环境

以下命令以Linux/WSL为例，使用机器自己的项目路径。已有checkout先检查工作状态，通过fetch和ff-only更新，不使用reset覆盖本地工作。

Node.js最低版本为18.18，npm依赖通过已提交的lock文件安装。数据库Python最低3.10，建议3.12；默认不安装OCR模型或调用云模型。

```bash
git clone --branch codex/agent-system git@github.com:dwroy/wow-jev.git
cd wow-jev
git status --short
git log -5 --oneline
npm --prefix agent ci
npm --prefix agent run typecheck
```

数据库运行部分使用Python标准库；建议Python3.12。源码使用3.10及以上语法；TS定向测试目前固定调用 `/usr/bin/python3`，其它平台需使用模块提供的pythonExecutable配置并核对模块cwd。

在新机器自己的运行路径重建v1参考库，不复制本机安装profile当目标机器运行或在线证据：

```bash
python3 -B -m game_database.cli --db out/runtime/game-data.sqlite import game-data/seeds/dragon-isles-reference-v1.json
python3 -B -m game_database.cli --db out/runtime/game-data.sqlite stats
python3 -B -m game_database.cli --db out/runtime/game-data.sqlite query --version game-data/profiles/retail-cn-12.1.0.69933.json --kind quest --id 70123
python3 -B -m game_database.cli --db out/runtime/game-data.sqlite references --branch retail --locale zh_CN --kind quest --name 练手材料
```

预期：11条reference_only；精确query为not_found；references返回同名不同任务ID/不同来源断言。这份version JSON是查询上下文样例，不证明新机器安装或登录了该客户端。

不启动Windows或模型的四层演示：

```bash
npm --prefix agent run layers -- demo
# 用输出中的绝对run_dir，不用旧机器的目录
npm --prefix agent run layers -- replay --run-dir /本次输出的绝对目录
```

预期：六个行为完成、real_inputs=0、game_effect=unverified、scenario_effect=confirmed。模拟完成不能当正式服升级验收。

本次交接在原机器实际复核了上述seed导入、精确查询、同名references与demo/replay；另通过19项数据库Python测试和2项TS桥接测试，零跳过。Python测试使用项目现有venv，目标机器仍需按下面步骤安装自己的pytest。此次复核没有Windows输入或模型调用，也不代表其它机器已验证。

数据库定向测试：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install pytest
.venv/bin/python -m pytest -q tests/test_game_database.py
./agent/node_modules/.bin/tsx --test agent/tests/game-data.test.ts
```

完整 `npm --prefix agent test` 含真实Windows离屏Bitmap等测试，不能宣称在无Windows机器上全部可用。Windows/WSL机器先 `bash native/windows/build.sh`；不操作桌面的离线原生测试与实际键鼠/游戏效果分别验收。

新阶段建议分工：一个agent负责schema/世界包与迁移，一个负责ATT/TDB适配与覆盖，一个负责运行索引/角色进度/经验来源；负责人维护共同schema、验收和本地合并。各模块单一编辑负责人，先通过里程碑一再导入大范围内容。

## 随Git传输和留在本机的内容

随分支传输：源码、schema、prompt、设计/验收文档、11条参考seed、旧机器profile样例和已提交知识快照。`out/`、SQLite运行库、原始截图/日志、构建EXE、node_modules、venv和模型权重被忽略，不随此次Git推送传输。

历史335项测试及238个原始验收产物位于原机器 `out/acceptance/four-layer-runtime/worktree-archive-1/`。其它机器不能仅凭文档声称已拥有这些证据；需要原始证据时另行传输并核对archive-manifest SHA，新阶段重新生成自己的验收记录。

本轮没有读取或同步凭据。Seed游戏截图上传授权保留于项目规则；数据库离线开发无需读取Seed或Battle.net凭据。模型与认证API启用时由对应模块按实际配置读取，不把token放入Git、来源URL、数据库或交接文档。真实输入仍要求有限持续时间、焦点/身份校验、取消与释放；不要因数据库目标存在便绕过执行闸。

## 调研资料

- [ATT许可](https://github.com/ATTWoWAddon/AllTheThings/blob/master/LICENSE)、[固定Retail配置](https://raw.githubusercontent.com/ATTWoWAddon/AllTheThings/1d34d9051ac597b150636314467e3cc6a5946f25/.contrib/.db/standard/.config/retail/retail.config)。
- [TrinityCore master](https://github.com/TrinityCore/TrinityCore)、[TDB1210.26091](https://github.com/TrinityCore/TrinityCore/releases/tag/TDB1210.26091)、[world SQL模型](https://github.com/TrinityCore/TrinityCore/blob/master/sql/base/dev/world_database.sql)。
- [BtWQuests Dragonflight](https://www.curseforge.com/wow/addons/btwquests-dragonflight)、[任务图](https://github.com/Breeni/BtWQuestsDragonflight/blob/mainline/TheWakingShores.lua)。
- [QuestieDB任务模型](https://github.com/Questie/QuestieDB/blob/master/src/meta/questMeta.lua)、[NPC模型](https://github.com/Questie/QuestieDB/blob/master/src/meta/npcMeta.lua)、[迁移来源](https://github.com/Questie/QuestieDB/blob/master/PROVENANCE.md)。
- [HandyNotes巨龙时代](https://github.com/zarillion/handynotes-plugins/tree/master/plugins/10_Dragonflight)、[许可](https://github.com/zarillion/handynotes-plugins/blob/master/LICENSE)。
- [MDT Legacy](https://github.com/Nnoggie/MDT_Legacy)、[HereBeDragons坐标模型](https://github.com/Nevcairiel/HereBeDragons/blob/master/HereBeDragons-2.0.lua)。
- [WoW-Pro步骤语法](https://github.com/Ludovicus-Maior/WoW-Pro-Guides/wiki/Addon-Syntax)、[许可](https://github.com/Ludovicus-Maior/WoW-Pro-Guides/blob/main/License.md)。
- [WoWDBDefs](https://github.com/wowdev/WoWDBDefs)、[分项许可](https://github.com/wowdev/WoWDBDefs/blob/master/LICENSE.md)、[DBCD](https://github.com/wowdev/DBCD)。
- [Blizzard Game Data API](https://community.developer.battle.net/documentation/world-of-warcraft/game-data-apis)、[任务链顺序限制](https://us.forums.blizzard.com/en/blizzard/t/quest-attributes/8892)。
