# 联盟战士流放者离岛第一个任务：现场前置阻塞

2026-10-06。代码基线`1292d7f`。用户明确授权本次Windows桌面截图取证、低频视觉及有限输入；先只读确认窗口/物理客户区/DPI/当前任务/键位，再有限输入，只尝试教程第一个任务，完成或遇阻塞停止。最新限制是焦点失败禁止输入、不抢前台，遮挡/最小化状态如实记录。

## 恢复后的最新结果

用户明确不做后台方案，恢复原前台规则，并允许当前登录用户的一次性/IT任务启动session1执行端，任务用完删除。以下结果覆盖下方最初会话0阻塞历史；没有改AGENTS、PostMessage/WGC或原NativeInput焦点/释放设计。

新增只读probe编译为无控制台winexe避免显示控制台抢焦点；Task Scheduler采用TASK_LOGON_INTERACTIVE_TOKEN、当前XDWIN\XD、least privilege、无Triggers、15秒执行上限，固定本项目只读payload/SHA/PID/start/输出。没有密码、最高权限、服务/注册表/组策略或安装操作。Python取消只写本次cancel文件，Windows监督者响应后走精确任务finally；没有输入端口或按键所有权。不可从正常清理外推强杀清理。

| 本次一次性只读任务完整名称 | 结果与清理 |
| --- | --- |
| WowJev-FirstQuest-Readonly-a2e2bbf64497436183a32ce0836a3404 | winexe无控制台时OutputEncoding异常（.NET原记录已定位），任务删除 |
| WowJev-FirstQuest-Readonly-5fae44f1ab184d938fa323fae8740fbb | 实际进入session1，旧类名假设拒绝，任务删除 |
| WowJev-FirstQuest-Readonly-15701cffe8e243ef85d63b1570ea429c | 实际只读取图成功，任务删除 |

`tasks-deletion-verified.json`另外逐个GetTask确认三者都不存在（HRESULT0x80070002），不是只相信脚本deleted摘要。原始XML/参数/编译SHA/原失败全部保留；之前readonly Host限制没改。

第三次helper PID12036/session1：Wow PID22072/启动ticks与前次一致，唯一窗口HWND0x904a6、class=`waApplication Window`（不是旧Gx名称），客户区2560×1440物理像素，GetDpiForWindow=144，未最小化。只读记录实际类名不授予输入；图前图后PID/开始时间/HWND/类/尺寸/DPI一致。`interactive-readonly-03/client.png` SHA=`a38066a414ee46e31f9f4b6cbe18bab59a19e227bb60160578a33f53000e4a6f`，原图复核为有效WoW场景、1级“小啊”在联盟船上，提示“与吉安娜·普罗德摩尔交谈”、黄色可接图标。单帧不证明连续刷新或遮挡状态，occluded仍unknown；未打开对话读取任务标题/ID，未核实键位。

采前/采后focused=false，GetForegroundWindow=0x0。此执行端无法确认游戏前台，不能将用户“窗口已置前”声明提升为闸门证据，也不能反过来据0断言用户当前窗口失焦。根据原规则停止：截图有效不代表输入允许。没有创建NativeInput或watchdog，没有游戏输入/抢焦点/开始下个任务；第一个任务未完成，game_effect=unverified。

| 最新实测环节 | 值与时钟 |
| --- | --- |
| PrintWindow捕获 | 76.636ms，同Windows QPC |
| 完整只读观察（包含身份检查及PNG保存） | 764.976ms，同Windows QPC |
| 临时任务注册/运行/等待/删除往返 | 2632.632ms，协调器monotonic |
| CV/Seed模型/决策→输入/观察→输入/效果确认 | unknown，未启动；不能记录0ms |
| Seed API调用 / 助手图像复核 / 游戏输入事件 | 0 / 1 / 0 |
| 程序按键持有与释放 | 0；未启动输入器，无物理release ACK可报告 |

原始QPC/协调器区间以现有`TraceRecorder`生成`readonly-latency.jsonl`/summary，native和bridge分开，不混减、也不相加嵌套区间。`resumed-summary.json`标live_precondition/foreground_focus_cannot_be_confirmed。所有source/raw/helper失败、任务生命周期、截图、时间记录位于主`out/acceptance/exiles-first-task-20261006/`。

C#编译通过，实际Windows非法input参数、任意输出路径、路径穿越三项在任何桌面API前被拒绝；新增Python八项离线身份/输出/固定最低权限task/清理失败反例通过，无测试注册Windows任务或发输入。最初测试文件字符串语法错误已修复，正式8/8 exit0；不声称本轮完整旧软件套件或物理释放已重验。本地提交与ff-only集成记录，不推送。当前需解决的是交互执行端的焦点可观测性，再从只读重新核验；不会自动继续该任务。

## 实际取证

主`out/acceptance/exiles-first-task-20261006/context-probe.json`及stdout/stderr保存原始PowerShell只读结果。没有打开桌面或启动输入端口。

| 项目 | 当前实测 |
| --- | --- |
| 客户端 | Wow.exe PID22072，session1 |
| 进程启动 | 2026-10-06 19:25:44.3062278 Asia/Shanghai；UTC 11:25:44.3062278；start_ticks639268827443062278 |
| 路径及版本 | C:\Program Files (x86)\World of Warcraft\_retail_\Wow.exe，FileVersion12.1.0.69933 |
| 调用环境 | PowerShell PID32172，session0，XDWIN\XD |
| 桌面Explorer | PID12544，session1 |
| 调用环境所见 | game MainWindowHandle=0x0，GetShellWindow=0x0，GetForegroundWindow=0x0 |
| 客户区/DPI/任务/键位/实际焦点 | 尚未取得，unknown |

角色联盟战士及教程路线属于用户声明；未拍到当前画面，不猜第一个任务的名称、ID、数量或完成状态。调用环境中的0句柄是跨会话不可见的证据，不能证明session1游戏失焦/最小化/无窗口。客户端六维仅实际path/version得到retail/12.1.0/69933，region/locale未核实，不注册为完整当前客户端profile。

## 阻塞与停止

`tools/HostLaunchProbe.cs`接口只允许特定SHA的WslRestartAcceptance.exe默认只读预检；不是可以替换payload的通用桌面执行桥。Explorer启动实现还要求当前GetShellWindow可见。仓库未发现已验收的跨会话NativeEye/NativeInput stdin/stdout transport。因此本轮既不能校验session1实际窗口/焦点，也不能进入有限输入；用户把WoW切前台不会改变调用方session0。

按“遇到阻塞就停下”停止；未改Host参数限制，未注册临时Windows任务、创建服务、调整身份权限、重启客户端或WSL。没有抢前台，没有尝试下一个任务。后续必须先在session1启动项目执行入口或补齐可信的受限交互桥，再从只读取证开始；桥成功也不自动证明截图、焦点、输入及释放验收。

## 实测延迟及计数

| 环节 | 结果 |
| --- | --- |
| 协调器→只读上下文探针→协调器 | 586.049ms；同一个Python monotonic时钟往返 |
| capture/CV/视觉/决策 | unknown，未开始 |
| 观察→输入发出、输入→效果确认 | unknown，未开始；不能记为0ms |
| 截图/模型调用/输入命令/输入事件 | 全部0 |
| 输入执行器/程序持有按键 | 未创建/0 |
| 第一个任务与游戏效果 | 未完成、unverified；任务状态未观察 |
| 释放 | 不适用：未取得输入所有权；没有物理释放ACK，不推断其它人的按键状态 |

`summary.json`明确runtime_environment阻塞、0真实输入/模型及上述unknown边界。没有实际观察、决策或Native输入时间戳，所以本次没有分层端到端延迟样本，也不能拿586ms元数据探针替代动作延迟或进行单层/分层速度比较。原始失败/结果逐文件SHA保留在`sha256.json`。

本轮仅验收记录变化，`git diff --check`通过，不改已完成498TS/692Python+3strict xfail的源码，不重复软件套件代替现场取证。按项目工作树规则本地提交及ff-only集成记录，未推送。
