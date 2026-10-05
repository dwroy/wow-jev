# 正式服闭环增补验收

2026-10-05。本轮按用户授权继续五项未完成的正式服工作，并增加多版本本地游戏数据库。工程检查、真实只读录制、有限辅助操作与自主动作验收分别记录；本轮全部五项尚未完成。

## 工程与真实证据

| 项目 | 已完成 | 尚待真实验收 |
| --- | --- | --- |
| 4K目标身份 | name-bank稳定可见名字标识、陌生局部字形拒绝、同帧存在/死亡/名字/签名绑定；旧日志保持兼容 | 新独立战斗及死亡正例；同名签名不代表同一个游戏实体 |
| Jev动作闭环 | 冻结prompt字节、有限候选、模型答复后重新采样、既有CodePlay闸与手；实际只读整链可运行 | 正式服非wait选择与动作效果；旧观察模式三次wait不代替主动验收 |
| NPC感知与大脑 | 新NPC对话/目标绑定交互指示协议、PNG冻结/回放；明确interact_npc目标最多一次100ms探测；G独立键GUI已设置 | 当前NPC名字/对话现场校准、独立样本、实际打开对话；没有可靠距离不能自动接近 |
| 学习与迭代 | 实际旧日志知识与提案流程、多条件真实收益比较器；模拟/重复/未知效果拒绝计为改进 | 两对独立同条件live基线/新版、当前知识实际消费与真实收益；批准源码的live冻结启动正在接入 |
| 长跑与WSL恢复 | 十分钟真实只读录制通过，快速轮换复测通过；Windows外部重启工具与26组模拟边界通过 | 外部Host脱离WSL job的真实启动、共享Ubuntu重启许可、整发行版重启与物理释放/新会话验收 |

集成回归：249项TypeScript及typecheck通过；109项Python/真实Windows感知与数据库回归无跳过。新增录制退出轮询修复后，27项录制/长跑机制回归通过。Eye/NPC独立审查另复核了旧正式服25动作日志和旧Seed观察日志，无新增输入或模型调用。

## 当前客户端与数据库

实际运行 `_retail_/Wow.exe` 为12.1.0.69933，配置CN/zhCN，客户端3840×2160；来源字节和SHA在 `out/acceptance/retail-closure/client-version-1.json`。数据库规范版本为retail/midnight/12.1.0/69933/cn/zh_CN，不与旁边classic-titan产品混用。本地安装/运行元数据不冒充在线服务端版本。

SQLite与TypeScript查询桥按branch、expansion、patch、build、region、locale六维精确隔离，保留原始资料SHA、来源、采集时间、适用版本证明及冲突。公开资料首批11条任务/怪物断言因build未知作为reference_only，69933精确查询返回not_found；不取最近版本，不按名字合并阵营任务。详细使用见 [../game-database.md](../game-database.md)。

负责人已实际初始化主目录 `out/runtime/game-data.sqlite`：11条参考断言、1次导入、1份安装profile；当前版本精确任务查询正确not_found，独立参考检索可用。初始化及查询原始结果见 `out/acceptance/retail-closure/game-database-initialization-1.json`，数据库属运行产物，不进入Git。

`brain-seed-observe-2` 实际游戏截图→冻结Brain prompt→Seed→重新采样→Brain严格回放通过，21条日志/2张图片/0输入。模型返回有效complete-observe选择，耗时1808.847ms，输入2280/output79 tokens；知识为空，没有效果或学习收益声明。最初一次相对profile路径因npm运行目录位于agent而在模型调用前被拒，改用绝对路径后完成。

## 实际只读长跑

`out/acceptance/retail-closure/soak-10m-1`：十分钟任务已封存，7段退出0并逐段严格回放；492次capture全部ok、491张图491个不同SHA、0原始输入记录/0出站输入命令，前后客户端PID/启动ticks与版本一致。所有样本focused=false，说明当前营地场景在非前台可读取变化画面。不能推广到最小化或所有后台渲染模式。

六个轮换缺口实测5.053–5.627秒，原证据保留。发现录制器5秒退出轮询后改为250ms；`soak-rotation-fast-1`真实185秒两段回放通过，159个ok样本/158张不同SHA图/0输入，唯一轮换缺口1520ms。两轮均不声称无缝或严格1fps。详见 [../retail-soak.md](../retail-soak.md)。

## 启动和辅助设置

computer-use初始化在本WSL任务报 `sandboxCwd is not a local file URI`，没有通过插件点击Battle.net。实际使用已登录Battle.net启动入口 `--exec=launch WoW` 打开正式服，原生手在当前游戏窗口发送一次Enter进入既有Dwroy11角色；没有操作认证或充值。

后续通过既有受焦点/PID检查的原生手设置“与目标互动”为G，GUI显示成功，保留E/S/D/F移动绑定。证据 `game-setup/bindings-evidence.json` 明确缓存尚未写出新绑定、功能交互未验证。设置过程的输入回执完整释放；视觉人工复核与自主NPC大脑验收分开。当前失焦时不发送输入、不抢焦点。

## WSL真实重启准备

默认只读preflight/export已实际核对Windows primary与WSL UNC导出长度/SHA。实际Host由WSL interop启动时IsProcessInJob=true；工具在这种启动链路下、任何fixture输入或terminate之前拒绝。另检测到acehr共享进程，不能把本项目授权自动扩展成中断其它项目。具体工具与记录见 [../wsl-restart-acceptance.md](../wsl-restart-acceptance.md)；尚未执行实际重启。
