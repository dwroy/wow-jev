# WoW Agent 当前交接

更新：2026-10-06。用户最新授权和项目规则见 `AGENTS.md`，实施计划见 `docs/agent-roadmap.md`。历史3.3.5a像素桥任务原文已保留在 `docs/handoff-pixel-bridge.md`；当前测试目标为用户指定的正式服客户端。

## 最新决定与下一阶段

**2026-10-06 里程碑二，步骤2a完成：参考文本的语言隔离。** 双语ATT/TDB源准备发现按ID references会把同一实体中英文name误判为同字段冲突。已按source locale筛选name/alias/description，未知locale保留原候选但不采纳为请求语言，数值字段参考与六维精确query不变；Python与TS字段采纳校验同步。84Python/14TS及typecheck通过，无skip；尚未发布M2实源种子。

source适配器在 `.worktrees/game-db-seeds` 实施，固定原件每次正式导入重新核完整父SHA，SQL原tuple摘取逐byte-range比对，不执行Lua/SQL。并行独立 `.worktrees/game-db-queries` 准备M3三值条件、角色/账号、中文短词与空间候选，集成验收仍按二→三顺序。源provider不推为已核starter/finisher，uint64位掩码保留十进制字符串；TDBcredit不推为杀怪，unsupported不冒称作者withdrawn或游戏不存在。

**2026-10-06 里程碑一完成：运行库、批量桥与基础库联合验收。** 在独立工作树集成APSW单写WAL运行库、run/event缺口索引、严格原观察绑定的角色/账号进度、经验候选/评估/不可变注册、Backup API备份恢复及runtime CLI；新增schema-v2和固定世界SHA的TS批量只读桥。83项Python、13项TS（含旧v1回归）全部通过无skip，typecheck通过；真实WAL未checkpoint备份、第二writer拒绝、SIGKILL后恢复和CLI恢复均验证。经验注册仍需里程碑四接通layers/既有知识快照，不宣称执行学习闭环已完成。

独立桥审查复现“字段/断言同时改写而沿用旧SHA”和“conflict总状态冒充found”已修正；精确canonical字节SHA、source绑定、规则版本和总状态均核验，覆盖Python1.0/Unicode及有效重复键反例，不以JS重序列化字节冒充Python原SHA。主checkout已验收世界包46Python；本步骤按ff-only集成后复核83Python/13TS。体验与证据见 `docs/game-database-v2.md`、`docs/acceptance/game-database-v2.md`。

接下来里程碑二：ATT固定提交及TDB1210.26091已只读准备；TDB实际156449334字节与完整发布SHA核验一致。24任务有24模板/zhCN名、23任务54目标、24任务97POI，但starter/ender、苏醒海岸spawn与当前国服已核实覆盖均0；目标Type0不能推为击杀。未执行来源Lua/SQL；原件在 `.worktrees/backups/source-audit/`，默认local_only，不分发/推送。生产适配器尚未实施；继续保持缺字段unknown、移除时间线/阵营/前置语义和字段覆盖报告，不根据总行数判完成。

**2026-10-06 里程碑一，步骤1a完成：v2世界包与v1兼容迁移。** `.worktrees/game-db-foundation` 新增受控中间格式/关系schema、字段级冲突解析、固定manifest SHA的只读批量Python查询、原子staging发布、来源原件校验及v1映射。独立审查发现的本地证明SHA未绑定、孤立资产分发标记、迁移来源/条件及保留谓词语义问题均修正并有反例；旧库19+世界包27=46项Python通过，无skip。运行库/TS批量桥尚在独立树实施，里程碑一整体尚未验收。

实际重新导入11条seed并迁移，得到9实体/27字段，全部reference_only；当前69933 query仍not_found，references保留来源冲突。没有注册旧机器安装profile为新机器证据。体验入口见 `docs/game-database-v2.md`；验收见 `docs/acceptance/game-database-v2.md`。步骤0已在主checkout fast-forward集成并再次通过19Python/2TS/typecheck；本步骤将按同样流程集成验收。不读取凭据、调用模型、发送游戏输入或push。

**2026-10-06 新机器接续：准备完成，里程碑一实施中。** 主 checkout `/home/dw/Projects/wow-jev` 已 fetch 并安全切到 `codex/agent-system`（远端起点47423e8）；旧的未跟踪 HANDOFF.md 与目标分支冲突，已完整移到 `.worktrees/backups/pre-agent-system-20261005/HANDOFF.md`，SHA `6f35f53b9a9a8aea7de885390e16d160386735aed57fb87c6823c6db23c117d7`。未跟踪 `wow-jev.bundle` 保留原位，SHA `7a6ebc4daef3a421d357ff2ab41a659e605e5954c7c20cb5d2e65256ff6c1931`；既有 pixel-bridge 工作树未修改。

已读 AGENTS、本交接、数据库交接及要求的 game-database/four-layer-agent-design/agent-roadmap。实施工作树 `.worktrees/game-db-foundation`（共同schema/世界包/迁移/桥）、`.worktrees/game-db-runtime`（运行库）分别有单一负责人；来源和学习链路只读核查已完成。依赖按 lock 安装；本机旧库19项Python、2项TS整链及typecheck通过。沙箱网络/tsx IPC拒绝经同一命令正常权限审查后运行，保留首次环境失败，不作为程序失败或测试通过。未读取凭据、调用模型、操作游戏或推送。

本机CPython3.14.4，标准库SQLite3.46.1未包含WAL-reset修补；新增 `database` 依赖组固定 APSW3.53.4.0，实测其SQLite3.53.4。v1保持标准库接口，新的可写运行库使用已修补运行时并自检，不默默在旧SQLite启用WAL。当前只完成恢复与基线，里程碑一尚未验收；按交接四个里程碑逐步实施，每个完成步骤更新本文件并提交。验收入口与证据将记在 `docs/acceptance/game-database-v2.md`。

**2026-10-05 数据库设计交接（最新）**：用户已要求将讨论后的设计保存并推送远端，交由其它机器继续研发。先读 `docs/handoff-game-database.md`，在 `codex/agent-system` 接续；优先实施v2规范schema、不可变世界包、运行/经验索引及v1兼容迁移，再以ATT固定提交和TDB12.1抽样构建巨龙群岛种子库。设计已落盘不等于新数据库已实现：目前只有11条reference_only，尚未下载TDB/批量导入或接通layers→learner/world pack版本。完整跨机器命令、依赖、许可、数据边界及四个里程碑在该文档。

本轮推送范围为当前分支源码与文档；`out/`运行数据库、截图/原始日志、EXE、依赖和凭据不随Git传输，新机器按交接命令重建或单独核SHA迁移证据。该文档是后续数据库阶段的设计入口，以下四层与旧正式服记录作为已完成/未验收历史保留。

**2026-10-05 四层实施（当前轮）**：用户已确认L1基础输入、L2人物动作、L3高级行为、L4任务，并明确要求记录设计和实施代码；此前“不要新增架构规划文件”的临时限制已被本次授权替代。设计在 `docs/four-layer-agent-design.md`。负责人工作树 `.worktrees/four-layer-foundation`；独立实施工作树 actions-v2、behaviors-tasks、regional-eye，由负责人审查后本地集成，不推送。

本轮已在负责人分支完成L1/L2、区域CV/OCR框架、九个L3行为、三类L4任务及四层demo/live/replay/cancel入口的审查集成。最终335项TS全通过、无skip，typecheck和四个Windows原生程序构建通过；2有效/9无效时间线原生参数校验、6项真实Windows日志文件条件、6组无损codec/配额、真实离屏区域Bitmap与PNG、真实PNG→JPEG裁切映射及6项拒绝反例分别通过。模拟六行为小闭环完成，实际输入0、chooser0、scenario_effect=confirmed、game_effect=unverified；模拟回放通过。旧Node timer早醒导致wait回放失败已复现并修复，不放宽回放条件；原失败保留。

体验：`npm --prefix agent run layers -- demo`，其输出给运行目录；`npm --prefix agent run layers -- replay --run-dir /绝对路径`。真实开发入口需匹配客户端/profile/区域校准和角色场景，未知定位/运动模式/技能状态会阻塞；详见 `docs/layers-runtime.md`、`docs/acceptance/four-layer-runtime.md`。本轮未检测到可用WoW窗口，未进行新时间线的物理输入/释放、正式服布局、真实OCR权重效果、区域Seed token成本、导航/飞行与自主升级验收。战斗日志仍只回填历史；四层任务到既有执行大脑及学习迭代入口的直接接入也待后续。没有读取凭据、调用云API、推送或重启WSL。

最终主目录已fast-forward合入至3ddb3a8，主目录四原生重建、typecheck、六行为demo/replay及原生时间线参数校验通过。238个必要ignored产物逐SHA验证归档至out/acceptance/four-layer-runtime/worktree-archive-1；检查工作树clean及无活动测试进程后，本轮四工作树正常git worktree remove，分支保留，其它历史工作树未清理。后续直接使用主checkout及上述体验命令。

**最新用户目标与小闭环**：用户明确以已知攻略扫任务、自主打怪/拾取快速升级；先体验 NPC 互动小闭环。已通过 Battle.net 正常入口启动12.1.0.69933并进入角色，辅助选中/靠近森德拉克斯并取得真实对话图。`out/acceptance/npc-loop-1/automatic-local-1` 是0模型调用的实际程序运行：6949ms、名字/关闭对话证据unknown、等待后停止、0输入/0效果/释放confirmed，严格回放通过，未证明自动互动。相同捕获/冻结校准对照确认原Bitmap字形555与对应JPEG90字形456，在线unknown、JPEG离线known；不能把JPEG模板自匹配当直播准确率。v2对话头像ROI改进已冻结但名字仍为JPEG，下一轮必须取真实NPC无损源图。用户随后手动打怪；此时停止输入，补录30秒只读27观察/26图/0动作，独立复核取得1个新的4K死亡目标选择事件（非新击杀），全部相邻帧只计1事件。target.dead仅真值已知20图评分：known正确15/错误0/CVunknown5，另6图视觉unknown不计准确率；旧错误汇总与纠正summary-v2均保留。

无损WinEye存档和旧JPEG启动兼容补丁已负责人审查，以34ff5e8/6d4fd96合入；agent完整266项TS、typecheck及6组Windows实际codec/配额通过，主目录四原生模块重建和typecheck通过。主目录尝试真实PNG observe时未检测到可用WoW窗口，保留原失败，未截游戏/未发送输入；同帧游戏PNG实测及NPC自动G仍待现场。300个必要实施产物/SHA归档到out/acceptance/npc-loop-1/lossless-integration-1，确认无活动进程/工作树clean后正常remove，分支保留；没有push。用户最新要讨论整系统架构/运行流程，正在对话中解释；不要新增架构规划文件。已异步请求用户方便时回NPC旁准备约30秒，不依赖无回复继续输入。详见docs/acceptance/npc-loop.md、lossless-eye.md。

**当前交付（18:40后）**：本轮增补已由负责人以bbd76b9本地合入codex/agent-system，f4a4937的版本probe修复也已接入；最终docs补充d16cef8。主目录四个Windows原生模块重建、typecheck和main-demo-1纯模拟/严格回放通过；集成260项TS全量通过，109项Python/真实Windows感知与数据库、27项录制/长跑回归、34组Windows重启机制模拟及Host helper13项边界分别通过。冻结启动独立审查关闭已发现P1，真实259源码只读两轮各21条/2观察/0输入，首编译→缓存复用、四exe同SHA；最终f4窗口补测因旧HWND/PID消失拒绝，不能冒充通过。没有推送，没有执行实际WSL重启。

多版本SQLite实际在out/runtime/game-data.sqlite（11条reference_only/1安装profile）。十分钟只读录制7段492ok/491不同图/0输入完整结束；快速轮换复测将唯一缺口缩到1520ms；Seed实际只读规划也通过。全部原始证据主out/acceptance/retail-closure，独立审查out/acceptance/runtime-closure，当前状态和体验见docs/acceptance/retail-closure.md、docs/system-runtime.md、docs/game-database.md。

**仍未完成五项最终正式服验收**：独立4K战斗/死亡正例、Jev非wait主动动作、当前NPC现场校准/对话闭环与可靠距离、两对同条件真实学习收益、整Ubuntu重启/物理释放/新会话恢复。长跑部分已过。当前已检测不到可用WoW HWND/PID，前台准备问题未回复；此前G已持久为INTERACTTARGET，原E/S/D/F不改。computer-use仍有WSL sandboxCwd错误，先前实际用战网正常启动入口进入过角色，没有插件点击或认证操作。外部Host只读breakaway/Explorer/Documents均job=true，不能直接run；Ubuntu有acehr共享进程，真实重启还需具体授权/外部启动条件。

本轮五个实施工作树已在检查无活动进程/保存代码后正常git worktree remove，分支保留，146个必要ignored产物及SHA归档到out/acceptance/retail-closure/worktree-archive-1。未清理其它历史工作树。以下为本轮过程记录，旧的“运行中/未合入”描述不覆盖上述当前交付。

用户进一步授权继续完成五项：4K可靠识别、正式服动作闭环、NPC任务感知、真实学习迭代效果、长期/WSL重启恢复；允许必要时用computer-use打开WoW测试，并新增多版本本地游戏/怪物数据库要求。当前在四个项目内工作树并行：retail-identity-v2、versioned-game-data、retail-npc-perception、负责人retail-runtime-closure；主目录暂未合入这些代码，不推送。本轮尚未完成全部五项，不能标整体验收通过。

已实现并分别提交：848f978稳定名字bank/局部陌生字保护（51项Python+真实Windows测试），8e1b5ef NPC对话/显式目标绑定交互指示（42项），efc6c7f多版本SQLite/TS查询桥（19项Python+2项整链），2386eab真实同条件效果对照（9项边界，模拟/重复/错版本/unknown不算收益），soak driver8c4d8bd及真实日志检查f58bf67/Windows元数据4b5f51d修复。负责人工作树已cherry-pick这些工程与JeV冻结prompt修复d715d64；ab37147提交可选target_name/NPC协议、模板冻结回放、system/live.ts及显式一次interact_npc探测，09b28e0忽略工作树依赖链接。集成236项TS/typecheck和109项Python/真实Windows回归无跳过，原误填不存在测试路径的失败保留，修正后42项审查回归通过。真实只读brain-observe-2版本核对→新bank→大脑→严格回放通过（21条/2图/0输入）；这不是NPC动作验收。独立Eye/NPC审查在codex/eye-npc-review、真实批准源码启动接入在codex/frozen-live-runtime，均尚未合入负责人分支。

当前客户端证据：正式服_retail_/Wow.exe，file/build/UI版本12.1.0.69933，product=wow，配置portal CN/textLocale zhCN，数据库规范locale zh_CN、branch retail/expansion midnight；旁边_classic_titan_为另一产品3.80.2.69874，不能混用。来源原字节/SHAs在out/acceptance/retail-closure/client-version-1.json（94951e43…ca6d）及新game-data/provenance。11条公开网站任务/怪物断言因build未知隔离reference_only；不同ID/历史任务数量保留，精确69933 query正确not_found，不把网页资料冒充当前游戏事实。

computer-use技能已读并尝试初始化/重试/重置，均因sandboxCwd is not a local file URI: file:///home/dai/Projects/wow-jev失败，没有用插件操作桌面。直接Wow.exe启动曾停初始提示；用户指正应从战网“进入游戏”，负责人实际用已登录Battle.net.exe --exec=launch WoW启动新正式服并按一次Enter进入既有Dwroy11，不处理认证/充值。当前真实游戏 HWND0x340894/PID18128/3840×2160；旧0x12c0892/PID25160不能复用。角色在营地安全平地、满血、骑坐骑，任务状态已变化，不能继续把原三任务当当前唯一目标。原生输入保持focus/identity/有限释放；菜单首次焦点探测超时未输入，game-menu-2重试成功，GUI已把“与目标互动”设为G（延迟重绘才显示，后续F7没有替换G），E/S/D/F原移动不改；缓存文件尚未显示此新键、功能交互未验证，不能当NPC验收。设置证据及bindings-evidence在out/acceptance/retail-closure，最后只读截图已无设置面板，游戏目前非前台，不抢焦点。异步人工进入角色问题已由战网启动解决；新前台准备问题仅用于接下来有限NPC输入。

十分钟只读长跑soak-10m-1已封存accepted=true：7段逐段严格回放、492次capture ok、491张不同SHA图、0输入、前后同一PID/启动ticks/版本；所有样本focused=false。负责人复核每段首尾仍在营地角色场景，后台画面在本场景可变化，不推广最小化/所有遮挡模式。六个轮换缺口5.053–5.627秒；定位到5秒退出轮询后b0a54e1改250ms并通过27项录制回归，随后真实185秒soak-rotation-fast-1两段159ok样本/158图/0输入、唯一缺口1520ms。不能称无缝或严格1fps。

新的brain-seed-observe-2实际客户区截图→冻结prompt→Seed→重新采样→严格Brain回放完成：21条/2图/1个有效模型回复（1808.847ms，2280input/79output tokens）/0输入，知识为空、game_effect=unverified；只证明只读规划链路。主out/runtime/game-data.sqlite已实际建立：11条reference_only断言、1次导入、1份安装profile；精确69933任务query not_found，初始化报告在retail-closure/game-database-initialization-1.json。

负责人审查后集成Eye/NPC追加436263b（root1968677）和learning模板预检查138d80c，249项TS/typecheck通过。WSL外部重启工具58030bd/3a07ad5与安全审查修复eaeb516/7130cbc已在负责人分支（最近5cecb7e）集成，实际34组Windows机制模拟通过，0fixture输入/0重启；所有模块尚未合入主目录。独立审查已去掉凭历史mask释放全局W的P1，并补fresh raw receipt/session绑定、原lease期限前真实UP、export最终失败口径。外部Host默认interop IsProcessInJob=true；真实breakaway创建虽成功仍在job，不能当脱离。agent继续一次只读Explorer broker探测。Ubuntu还发现acehr外项目node_repl.exe PID425015，真实terminate仍需要具体共享进程授权，不自动执行。

18:13以后最新只读截图已回到角色选择界面、Dwroy11仍被选中；原因未确认，不能继续沿用之前role-scene-confirmed条件。独立互动G已在bindings-cache.wtf实际持久为INTERACTTARGET（sha8dc57d…c6a7），E/S/D/F保持原移动；功能交互仍未验收。新游戏前台准备问题仍未收到回答。冻结live接入与独立审查在frozen-live-runtime进行，原生缓存初次执行前字节校验、--repo-root替换依赖loader两个实际P1正在修；不发布带已知问题版本，尚未正式frozen observe验收。阶段记录工作树docs/acceptance/retail-closure.md。

接下来：把全部接入变化保存并完成负责人审查/无跳过回归；当前bank同名35–37/43稳定、39/40另一类，但仍缺独立名字/死亡正例；补当前NPC名字/对话校准与显式有限交互、新独立战斗实测、两对同条件真实版本效果+知识消费/迭代/回退、10分钟实际录制。Windows外部WSL重启host工具由retail_npc_perception继续准备，尚未执行；只有Ubuntu一个发行版且并行agent/其它项目可能活跃，真实terminate前需完成本项目保存/停进程/影响预检，再决定是否需用户针对共享进程的明确授权。杀Node不能当整发行版重启。源码/原失败/必要Windows产物清理前必须归档。

用户先明确“先做后面，继续5–7”，随后准备好游戏恢复第4阶段实测。第5–7工程已接通并以8e71665本地合入：执行大脑/工作记忆/有限阶段规划/控制权交接，严格真实日志学习与内容hash知识库，证据提案→独立工作树→固定回归→签名发布→冻结源码启动→任务边界切换/回退。入口docs/system-runtime.md，分项证据docs/acceptance/stages-5-7.md及主out/acceptance/stages-5-7。当前system CLI只提供模拟/离线，不操作游戏；真实NPC名字、距离和对话感知尚未接上，不称正式服任务已验收。主目录219项TS/68项Python/typecheck及模拟/冻结v3启动已通过，本轮7个实施/候选工作树正常清理，必要证据和未发布候选快照保留；没有清理其它历史工作树。

四个独立真实/模拟来源学习出25facts（19 observed/6 inferred，19经验/4背包事实/2报告UI名字统计）、14slices/13reviews；重复retail-3去重。knowledge/baseline-v1中的canonical JSON SHA为5134f31f6ac964d4ca50ecfa5f7968075b7f00f43753acf4e76c8d2b4a6910b8。完整4K运动效果unknown保留；实际Brain咨询两条move_for经验后升级处理，0输入。UI名字仅为Seed报告，不生成GUID/击杀/等级/掉落率。Brain/CodePlay/Jev严格嵌套回放和Brain来源学习也已实现。

真实Seed规划协议probe基线3/3有效；v2曾凭空输出request_id，worker拒绝、实际rollback baseline。v3补强复制规则，三次重新对照全部有效（约1.86–2.61s，均wait，两条fact IDs正确）；未证明动作收益或总体质量改善。v2(5ccd113)和失败记录保留，v3(5f5bc81)经隔离回归/模型probe后发布为movement-evidence-runtime-v3，知识/prompt/完整源码均冻结。task-boundary-1实际运行基线任务期间切换版本，旧任务保持baseline，新任务用v3，实际rollback后恢复v3。SDK首次误拒Python缓存已修，原失败完整保留；模拟modelnull误识别、知识scope匹配问题也保留原始失败。

用户在战斗素材对照后决定继续使用Seed。在线视觉方案沿用Seed+CV，本地Qwen不接入在线状态，优化暂缓；xdwin2既有服务或隧道未停止。代码play与纯模拟仍不调用模型；新Jev入口仅在显式Seed+上传开关时启用选择worker。

第4阶段工程已实现并集成候选/选择/重新采样/CodePlay/严格多计划回放与可取消wait；三个模块在stage-4-cv/choice/runtime工作树并行，负责人stage-4-jev统筹。五次纯模拟4动作+1等待通过，真实Seed离线probe3/3选择符合预期、耗时1349–1737ms；该probe观察/候选人为构造、零输入，不能当在线CV或正式服动作验收。入口docs/jev-runtime.md，分项验收docs/acceptance/stage-4.md，原始证据主out/acceptance/stage-4。

工程分项155项TS、75项Python/真实Windows离线测试（无跳过）、typecheck和四模块构建通过；负责人以129bf78本地合并至codex/agent-system，主目录已重建并完成main-demo-1与独立回放，manifest Git dirty=false。旧retail-3的CodePlay与Eye两条严格回放仍通过（514条/50观察/25动作/10confirmed）。8份本轮实施/校准二进制与哈希、原始失败、全量日志保留在out/acceptance/stage-4/integration-1；本轮四个工作树已正常移除，分支保留。本轮没有发送任何游戏输入。

当前战斗CV使用旧2048×1536语料46图，两名Agent盲标且不是用户确认人类金标准。训练combat-01/02为20图，独立留出26图；目标存在42/46 known正确（留出22/26），战斗46/46。死亡v1的两个误判保留，v2紧阈值留出召回2/10；v3仅训练组选黄色死亡字形+独立绿血条证据，规则/代码/原生程序先冻结后评估，留出7/10已知标签正确召回、未输出错误known且16个unknown保持unknown。仍未满足95%完整门槛，不能自动打怪。

上轮capture-4k-1未检测到窗口的原记录保留。本轮capture-4k-2已完成60秒只读补录，51张3840×2160图、51次capture ok/51个不同图像hash，独立Eye回放260条/51观察/0动作通过。源图包含玩家鬼魂→复活、坐骑收藏/行走、一段战斗；两个Agent独立逐图三字段标签153/153一致（非用户确认人类金标准）。选中活目标5张、死目标仅第43张、无目标45张；玩家战斗35–41。35–43整个连续战斗保留一个事件组，不能拆相邻帧充当独立留出，仍缺独立死亡/战斗正例事件。

真实只读retail-observe-4k-1已接通游戏截图→Seed候选ID→重新采样→有限等待→严格回放：三次真实模型回复有效（2518/2410/1608ms，均wait），9张源图、85条日志、0真实/模拟输入、0效果确认。observe只允许wait，不能据此宣称识别准确率或主动动作选择通过。此次51张录制全为前台样本；源码截图不以焦点为前提，但后台渲染是否更新尚未实测。最小化不支持；黑帧/截图失败不可用，静态非黑后台停更检测未验收。输入仍要求前台且失焦停止，禁止抢焦点。

当前4K候选战斗校准cv-4k-2已完成一次冻结后的真实Windows离线分类：存在43/51 known正确、8unknown；战斗51/51正确；死亡6个有效目标标签4known正确、2unknown，45无目标均保持unknown。死亡唯一正例是自身模板训练重代入。30张独立负例留出存在26正确/4unknown、战斗30false正确、死亡30unknown；没有独立战斗/目标死亡正例留出。名字mask四次known得到四个不同SHA，连续同名外观签名稳定性未通过；这是离线JPEG结果，在线原图稳定性未验收，不能绕过身份复核发输入。阈值沿用旧v3、未按留出修改/复跑，源图/标签/配置/二进制SHA均冻结。仍需稳定身份依据和新独立正例再做有限真实Jev动作；旧2048模板在4K返回unknown且不降级为Seed执行条件。本轮只读测试已经结束，已告知用户可以正常操作，不要求继续保持键鼠空闲。

第0–3阶段已按各阶段有限范围验收。第3阶段CodePlay/统一gate/有限技能/CLI/跨终端cancel/严格计划回放已实现：106项TS测试+typecheck、25步模拟回放、真实专用窗口五轮25动作、已满足零输入、跨终端取消与失焦实际停止/物理释放/回放。正式服最终retail-3在3840×2160完成五轮25动作、127/127事件且全released，10次背包变化confirmed、15次运动效果保持unknown，关闭释放与独立严格回放均通过；保存50张前后源图。接口见docs/play-runtime.md，证据及真实失败修复见docs/acceptance/stage-3.md与主out/acceptance/stage-3。

正式服retail-1（2048×1536）最后背包仍开，用户确认有人工操作且冒险指南遮挡；retail-2标题头ROI在转向后背景变化导致unknown，第四轮open在输入前拒绝。两次原始failed记录保留。新retail-bag-4k-buttons-v2使用底部固定小背包按钮并集ROI(3455,2005,300,50)，保持max_distance=0.12/min_margin=0.04；负责人Windows原生离线复核retail-2全部36张独立视觉标注图正确，再做retail-3真实补测通过。此校准只限当前4K布局与B同时开闭全部背包，独立单包/悬停/其它布局未外推。

用户随后要求接取面前三个游戏任务，负责人逐次截图/有限点击，已接“原始龙害”“探险者遇险”“练手材料”，均有游戏聊天与追踪确认，用户也确认完成。证据quest-assist-1；这是负责人辅助操作，不是自动任务大脑验收。用户明确后续继续项目研发和验收，游戏任务的打怪/救援尚不属于本轮自动完成内容。

原始native-1在输入前拒新fixture候选已修；native-2失焦原生failed与后续断连cancel造成计划/步骤终态冲突已修，focus-retest-1通过且不改写关闭ACK缺失(unconfirmed)。原失败保留。90秒录制轮换、整WSL重启、真实游戏移动效果和自动弹窗检测仍不外推。

第4阶段已补战斗CV实现与来源失效，当前布局的独立正例覆盖仍需上述实测。任务对话补录按用户“稍后补任务”安排；第5–7工程已按最新决定完成，后续为Jev有限输入验收、NPC可靠感知及三层系统的正式服效果与经验应用验证。

## 当前增补：xdwin2 视觉服务

服务已在 `iem@172.26.203.214`（DESKTOP-PHTQGNQ，3090）部署并通过负责人真实GPU/图像/有限MP4/本机隧道和生命周期验收。用户要求使用Windows SSH：`/mnt/c/Windows/System32/OpenSSH/ssh.exe`。Windows既有身份可用，不能把WSL key被拒外推为整个登录授权缺失。

远程目录 `/home/iem/Services/wow-vision`；Qwen3.5-9B Q4_K_M与配套F16 mmproj固定Unsloth revision、官方HF LFS SHA，复用既有llama.cpp c8cda8b、CUDA架构86。两份文件全SHA已核验，没有升级驱动/硬件；初期CDN大响应超时，分段并行续传后完成，失败记录保留。

Gateway/backend仅绑定回环18790/18791，默认关闭思考、ctx8192、单生成slot、最多256输出token；MP4最多4帧/12秒，属于有序抽帧理解，不是原生视频流。通过本机Windows SSH隧道18792访问；当前隧道Windows PID8984，精确命令在out证据。远程当前supervisor/backend/gateway=144210/144212/144213。SSH断开存活、正常stop、校验期间取消启动与恢复ready已实测；没有开机自起、强杀监督进程或整个WSL重启恢复验证。

本机凭据在 `out/runtime/vision-service/client-token`，父目录700/文件600。凭据不进git、acceptance、manifest或日志。原始证据在 `out/acceptance/vision-service`；固定3图人工标签和3秒闭开闭合成视频不是准确率基准。

完整7字段图像识别约2.4–2.9秒，修正目标框位置假设后目标原文读对，但2/3结果unknown置信度0.5导致严格schema拒绝。精简5字段profile三图15个标注值均正确，单图1.60–1.91秒，视频1.90秒；这是任务减少的性能对照，不是引擎对照，仍不能作为长期可靠性或1fps承诺。WoW主程序默认继续Seed+CV；本地服务尚未接入在线状态。后续接入须解决格式与时效，并扩大游戏样例；ROI/OCR和短输出先优化，再按相同任务比较引擎。

使用见 `docs/xdwin2-vision-service.md`；验收见 `docs/acceptance/vision-service.md`、`tools/vision_service_probe.py --compact`。本地/远端同13项HTTP边界测试与本地46项视觉/客户端回归通过。实施分支codex/xdwin2-vision-service（0df5a2c、6ec8fd2）及负责人集成均已留存，必要忽略产物归档后清理本轮工作树。

Seed与本地Qwen已按相同3张图/五字段题面各重复3轮，串行交替先后，每家9次响应均有效，45个标注值均正确；中位端到端延迟Seed1.382秒、Qwen1.802秒，Seed本轮低23.3%。源图相同但预处理不同，本地缩到1280×960；只有3张独立截图，不能推为总体准确率或复杂场景能力。证据在 `out/acceptance/vision-service/seed-qwen-comparison-1`，可复用 `tools/vision_compare.py`。完整7字段与在线接入限制仍保留。

用户要求先验证动态识别效果再考虑优化Qwen。实际只读录制191图：第一段128张配额退出，负责人恢复延迟造成缺口；第二段63张因window_unavailable退出，两个源片段合计约204秒，不能称完整十分钟。现封存complete=false；90秒轮换录制工具已补齐有限停止和封存反例，但未重录真实十分钟。用户最新选择“先完成战斗对照，稍后补任务”。

从这批素材盲选46图/10事件组，两名Agent逐图看源图标注，负责人复核关键状态和错误（不是用户确认的人类金标准）。两家同prompt各95次单帧识别，基础五字段Qwen187/216=86.6%、Seed212/216=98.1%；目标存在39/46对45/46、无目标误报6对0、死亡8/21对20/21。双方JSON95/95有效；玩家战斗标记双方大量unknown，不能用于可靠执行条件。当前本地Qwen未通过效果门槛；没优化模型或预处理。任务仅负例、数值血量未显示、多帧视频未测。证据out/acceptance/vision-evaluation，详见docs/acceptance/vision-battle-evaluation.md；复用tools/vision_record.py、vision_corpus.py、vision_evaluate.py。需要先补真实任务对话；若继续本地路线，分辨率/固定UI裁切与模型能力的差异需另测，暂不转入速度优化。

## 已完成

- 第0阶段工程基线、第1阶段真实键鼠执行已完成并合并。Windows独立释放看门狗与焦点检查已实测，原始记录在 `out/acceptance/stage-1`。
- 第2阶段眼与状态日志已通过负责人真实整链验收和最终回归（TypeScript54/Python42），完成本地集成。Windows截图/CV、显式UNC图片导出、Python异步Seed、TypeScript状态融合、录制与回放已接通。
- 正式服 `game-run1` 六次B开关全部获得完整输入计数、released与效果confirmed；每轮离线回放通过，背包恢复起始关闭。10秒观察含72个原生样本、4个真实Seed结果，删动作关联/伪造观察均被拒绝。
- Seed第三次结果漏看实际存在的目标栏，原始错误保留。模型字段仅为带来源的模型观察，目标/战斗读数尚未独立稳定核验，当前不用于执行闸。背包效果确认使用校准CV。

## 环境与体验

主checkout为 `/home/dai/Projects/wow-jev`，分支 `codex/agent-system`；第3阶段在独立工作树实施、负责人验收后，以7074f90本地合入。主checkout四个Windows模块已重建，typecheck及一轮5步纯模拟/独立回放通过；必要测试二进制、106项回归日志和全部实际证据保存在out/acceptance/stage-3，本轮四个工作树已正常清理，分支与失败记录保留。用户已授权负责人组织并行agent、研发测试、验收和本地合并；不推送远端。

WSL运行TypeScript编排和Python低频视觉，Windows运行C#5/.NET4截图、CV、键鼠和释放看门狗。不能将WSL调度器中断测试外推为整个发行版重启恢复。

本轮第4阶段重新枚举的游戏 HWND `0x12c0892`、PID `25160`，客户区3840×2160；旧第3阶段身份为`0x6407cc`/`6932`，retail-1为2048×1536后切4K。身份不能跨重启复用，分辨率或布局变化需重新校准。角色移动绑定ESDF，E前进；W/A不能作为默认WASD移动键，需按实际技能/坐骑栏处理。禁止程序抢焦点。

用户明确授权上传所有WoW游戏截图至火山方舟；只限游戏客户区，不包括其它应用/桌面。新worker默认不启动模型；显式Seed+上传开关才读取 `~/.config/wow-jev/api.env`，不输出凭据。配置固定 `doubao-seed-2-0-mini-260428`。

使用说明见 `docs/eye-runtime.md`。验收与限制见 `docs/acceptance/stage-2.md`；原始证据在主checkout `out/acceptance/stage-2`，包括真实图、JSONL、冻结schema/校准/代码与二进制指纹。不得改写失败的native-run1/native-run2为通过。

## 接续

第3阶段可按`docs/play-runtime.md`体验纯模拟与当前4K正式服有限代码序列，眼单独观察仍见`docs/eye-runtime.md`。第4阶段可按`docs/jev-runtime.md`体验纯模拟与只读入口；第5–7工程可按`docs/system-runtime.md`体验三层模拟、真实日志学习与版本切换。用户已明确先推进后续工程，后续补第4阶段正式服及NPC感知/动作验收。actor=jev必需decision_id，模型只选候选ID、返回后重新采样，再复用统一CodePlay与手。默认真实槽位为空，未知字段只wait/escalate；不能把离线模型probe的人为观察用于live动作。

对移动、跳跃、转向暂不自动确认游戏效果；背包CV仅在已验收布局适用。个人长期记忆按 `/home/dai/agent-memory/SPEC.md` 操作，进度只写项目文件。
