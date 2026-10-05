# WoW Agent 当前交接

更新：2026-10-05。用户最新授权和项目规则见 `AGENTS.md`，实施计划见 `docs/agent-roadmap.md`。历史3.3.5a像素桥任务原文已保留在 `docs/handoff-pixel-bridge.md`；当前测试目标为用户指定的正式服客户端。

## 最新决定与下一阶段

用户在战斗素材对照后决定继续使用Seed。在线视觉方案沿用Seed+CV，本地Qwen不接入在线状态，优化暂缓；xdwin2既有服务或隧道未停止。代码play与纯模拟仍不调用模型；新Jev入口仅在显式Seed+上传开关时启用选择worker。

第4阶段工程已实现并集成候选/选择/重新采样/CodePlay/严格多计划回放与可取消wait；三个模块在stage-4-cv/choice/runtime工作树并行，负责人stage-4-jev统筹。五次纯模拟4动作+1等待通过，真实Seed离线probe3/3选择符合预期、耗时1349–1737ms；该probe观察/候选人为构造、零输入，不能当在线CV或正式服动作验收。入口docs/jev-runtime.md，分项验收docs/acceptance/stage-4.md，原始证据主out/acceptance/stage-4。

工程分项155项TS、75项Python/真实Windows离线测试（无跳过）、typecheck和四模块构建通过；负责人以129bf78本地合并至codex/agent-system，主目录已重建并完成main-demo-1与独立回放，manifest Git dirty=false。旧retail-3的CodePlay与Eye两条严格回放仍通过（514条/50观察/25动作/10confirmed）。8份本轮实施/校准二进制与哈希、原始失败、全量日志保留在out/acceptance/stage-4/integration-1；本轮四个工作树已正常移除，分支保留。本轮没有发送任何游戏输入。

当前战斗CV使用旧2048×1536语料46图，两名Agent盲标且不是用户确认人类金标准。训练combat-01/02为20图，独立留出26图；目标存在42/46 known正确（留出22/26），战斗46/46。死亡v1的两个误判保留，v2紧阈值留出召回2/10；v3仅训练组选黄色死亡字形+独立绿血条证据，规则/代码/原生程序先冻结后评估，留出7/10已知标签正确召回、未输出错误known且16个unknown保持unknown。仍未满足95%完整门槛，不能自动打怪。

本轮当前未检测到可用WoW窗口，4K只读战斗补录未开始（capture-4k-1）；需用户打开游戏后录选中/清除目标、打怪、死亡后保留目标，建立独立当前4K战斗校准，再验收只读在线Jev/Seed和有限正式服输入。2048模板在4K返回unknown且不降级为Seed执行条件。第4阶段整体尚未验收，第5步执行大脑暂未进入实现。

第0–3阶段已按各阶段有限范围验收。第3阶段CodePlay/统一gate/有限技能/CLI/跨终端cancel/严格计划回放已实现：106项TS测试+typecheck、25步模拟回放、真实专用窗口五轮25动作、已满足零输入、跨终端取消与失焦实际停止/物理释放/回放。正式服最终retail-3在3840×2160完成五轮25动作、127/127事件且全released，10次背包变化confirmed、15次运动效果保持unknown，关闭释放与独立严格回放均通过；保存50张前后源图。接口见docs/play-runtime.md，证据及真实失败修复见docs/acceptance/stage-3.md与主out/acceptance/stage-3。

正式服retail-1（2048×1536）最后背包仍开，用户确认有人工操作且冒险指南遮挡；retail-2标题头ROI在转向后背景变化导致unknown，第四轮open在输入前拒绝。两次原始failed记录保留。新retail-bag-4k-buttons-v2使用底部固定小背包按钮并集ROI(3455,2005,300,50)，保持max_distance=0.12/min_margin=0.04；负责人Windows原生离线复核retail-2全部36张独立视觉标注图正确，再做retail-3真实补测通过。此校准只限当前4K布局与B同时开闭全部背包，独立单包/悬停/其它布局未外推。

用户随后要求接取面前三个游戏任务，负责人逐次截图/有限点击，已接“原始龙害”“探险者遇险”“练手材料”，均有游戏聊天与追踪确认，用户也确认完成。证据quest-assist-1；这是负责人辅助操作，不是自动任务大脑验收。用户明确后续继续项目研发和验收，游戏任务的打怪/救援尚不属于本轮自动完成内容。

原始native-1在输入前拒新fixture候选已修；native-2失焦原生failed与后续断连cancel造成计划/步骤终态冲突已修，focus-retest-1通过且不改写关闭ACK缺失(unconfirmed)。原失败保留。90秒录制轮换、整WSL重启、真实游戏移动效果和自动弹窗检测仍不外推。

第4阶段已补战斗CV实现与来源失效，但当前布局/覆盖率尚需上述实测。任务对话补录按用户“稍后补任务”安排，后续仍为Jev验收、执行大脑、学习/经验、代码与prompt迭代。

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

本轮重新枚举的游戏 HWND `0x6407cc`、PID `6932`；retail-1为2048×1536，随后用户切为3840×2160。身份不能跨重启复用，分辨率或布局变化需重新校准。角色移动绑定ESDF，E前进；W/A不能作为默认WASD移动键，需按实际技能/坐骑栏处理。禁止程序抢焦点。

用户明确授权上传所有WoW游戏截图至火山方舟；只限游戏客户区，不包括其它应用/桌面。新worker默认不启动模型；显式Seed+上传开关才读取 `~/.config/wow-jev/api.env`，不输出凭据。配置固定 `doubao-seed-2-0-mini-260428`。

使用说明见 `docs/eye-runtime.md`。验收与限制见 `docs/acceptance/stage-2.md`；原始证据在主checkout `out/acceptance/stage-2`，包括真实图、JSONL、冻结schema/校准/代码与二进制指纹。不得改写失败的native-run1/native-run2为通过。

## 接续

第3阶段可按`docs/play-runtime.md`体验纯模拟与当前4K正式服有限代码序列，眼单独观察仍见`docs/eye-runtime.md`。第4阶段可按`docs/jev-runtime.md`体验纯模拟与只读入口；待当前4K战斗补录、独立校准与有限正式服Jev验收后再进入第5步。actor=jev必需decision_id，模型只选候选ID、返回后重新采样，再复用统一CodePlay与手。默认槽位为空，goal observe或字段未知只wait；不能把离线模型probe的manual观察用于live动作。

对移动、跳跃、转向暂不自动确认游戏效果；背包CV仅在已验收布局适用。个人长期记忆按 `/home/dai/agent-memory/SPEC.md` 操作，进度只写项目文件。
