# 联盟战士流放者离岛第一个任务：现场前置阻塞

2026-10-06。下面保留基线`1292d7f`起的历次现场记录。最新用户授权A/B/C允许完整可见、空闲>5s且身份确认后的单次焦点恢复点击，普通输入仍前台；恢复/启动与安全边界见[session-recovery](../session-recovery.md)。

最新基线`4844f61`已完成A/B/C实现与全量软件验收：TS546/546、Python729passed+3原有strict xfail、0fail/skip、typecheck通过。两轮现场仅只读，最新正确识别断线WOW51900319，但未激活且上方HWND0x400ce区域与客户区相交，焦点恢复闸在点击前停止。输入/效果均0，第一个交谈未完成；4项一次性任务删除且回查不存在。Windows QPC截图API320.613ms、CV1274.770ms、OCR562.182ms，协调器整轮12065.231ms；没有观察→输入/效果样本或成对跑分。完整分域数据、清理任务名、原件SHA及需用户移开遮挡的结论见[本次恢复验收](session-recovery.md)。以下旧“不抢前台/用户手动进入”限制已被最新明确授权替代，不作为当前实现边界。

## 激活恢复后只读复核：角色选择界面阻塞（2026-10-06 21:01—21:03）

用户明确要求立即继续第一个教程任务“与吉安娜·普罗德摩尔交谈”，并给出session1现场复查前台0x904a6/PID22072、Default、非锁屏/无屏保；用户确认旧零句柄根因是游戏窗口在最上层但未激活，非RDP断开。下面旧诊断中的RDP最小化/显示抑制仅属当时未证实候选；按新事实修正当前结论。焦点闸门和有限输入/取消/释放要求保持不变。

本轮只读/IT helper PID18088确实在session1执行。采前/采后GetForegroundWindow均0x904a6，focused=true，Wow PID22072、start_ticks639268827443062278、正式服路径和window class均未变；物理客户区2560×1440、DPI144、未最小化，窗口移动后客户区屏幕原点612,413。PrintWindow flags3原图保存`out/acceptance/exiles-first-task-20261006/foreground-restored-readonly-01/client.png`，SHA2564390bfd2ac283781d678bb06a342f056b51d34cb87d181b717f463aab8995069。

原图独立人工复核：当前是角色选择界面，已选“小啊”、等级1战士、联盟标记，底部“进入魔兽世界”按钮；未进入当前教程现场。画面没有吉安娜、船上教程提示或任务窗口，当前任务与游戏内键位仍unknown。不能把之前船上的旧图或用户的目标名作为当前观察，不能套用旧NPC/任务按钮坐标，也不能将客户端前台恢复说成任务完成。按用户“完成或遇阻塞停止”，本轮停在只读核验，不自动发送登录/进入世界输入或继续教程。后续需要用户手动进入“小啊”的游戏世界并保持WoW激活，再重新确认当前任务和交互方式。

唯一临时任务`WowJev-FirstQuest-Readonly-52ed32a9cca246d5bac3ac437119209d`创建、执行、删除，生命周期deleted=true/LastTaskResult0；独立回查GetTask HRESULT80070002不存在，清理原件`foreground-restored-cleanup.json`。未创建输入执行器/看门狗、未持有按键/按钮，没有物理释放ACK可报告；真实输入0、Seed云调用0、助手原图复核1，无AGENTS/系统配置/原焦点或输入设计改动。

| 本轮实测 | 时间及边界 |
| --- | --- |
| PrintWindow捕获 | 85.461ms，Windows QPC |
| 完整只读观察 | 697.609ms，同一Windows QPC，包含身份检查及PNG保存 |
| /IT任务注册/执行/等待/删除 | 1895.437ms，同一协调器monotonic往返 |
| CV/Seed/Jev/执行大脑决策→输入、观察→输入 | unknown，未启动，不能填0ms |
| 输入已发出 / 游戏效果已确认 | 都没有样本；角色选择图是独立只读证据，不是程序输入效果 |

使用原TraceRecorder生成`foreground-restored-latency.jsonl`/summary；Windows捕获及run与协调器bridge保持不同domain/id，嵌套跨度不相加，未尝试对时或跨域相减。摘要/源码版本/原件SHA在`foreground-restored-summary.json`与`foreground-restored-sha256.json`。本轮仅更新交接/验收文件，git diff --check通过；未重跑源码不变的旧套件（最近309e858源码验收TS498/498、Python702passed+3原有strict xfail、0skip、typecheck通过），不把旧数字冒充本轮现场输入验收。本地提交并ff-only集成，不推送，阻塞后等待用户。

## RDP与输入桌面只读诊断（2026-10-06 20:21—20:25）

用户补充quser显示XD经RDP登录session1，控制台session2停在LogonUI，要求只读诊断后停止。本节是最新结论，下面恢复截图与session0阻塞作为历史保留。本轮没有截图、模型调用、游戏输入、抢前台、切换/附着桌面或修改系统配置，也没有改AGENTS及焦点规则。

两轮固定只读payload、当前XDWIN\XD、最低权限、无触发器、15秒上限的/IT任务进入session1，各三次500ms间隔采样（两轮各约1秒，不能证明窗口外的全部历史状态）。第二轮补充WTSSessionInfoEx锁定状态及OpenInputDesktop句柄的UOI_IO；结构实际/预期均232字节、level1/session1/连接状态一致。CIM确认实际Windows11 10.0.26300，不将无新版manifest的.NET报告6.2.9200当真实版本。原始记录在主`out/acceptance/exiles-first-task-20261006/rdp-desktop-diagnostic-01/result.json`与`02/result.json`。

| 检查项 | 六次采样一致结果（注明仅第二轮项） |
| --- | --- |
| 执行端 | session1；第一轮PID23028/thread27808，第二轮PID15720/thread23632 |
| GetProcessWindowStation | WinSta0；GetLastError0 |
| GetThreadDesktop(本线程/WoW线程) | Default，各轮内借用handle一致（第一轮0x120、第二轮0x11c，不跨进程比较句柄数值）；GetLastError0；UOI_IO=false |
| OpenInputDesktop(0,false,DESKTOP_READOBJECTS) | 成功，Default，GetLastError0；所有新打开句柄CloseDesktop成功；第二轮UOI_IO=false |
| GetForegroundWindow | 0x0；该API没有文档化的NULL扩展错误码 |
| GetWindowThreadProcessId(前台0) | thread0、PID0、GetLastError1400；是空HWND的查询错误 |
| GetGUIThreadInfo(0) | FALSE，cbSize72，GetLastError0；无Active/Focus句柄 |
| GetGUIThreadInfo(WoW thread18008) | TRUE，GetLastError0；Active/Focus0，不能据此批准输入 |
| WoW HWND0x904a6 | PID22072/thread18008/class=waApplication Window，IsWindowVisible=TRUE、IsIconic=FALSE；进程path/start_ticks不变 |
| WTS session1 | XDWIN\XD，RDP-Tcp#0，ClientProtocolType2，WTSActive0 |
| WTSSessionInfoEx session1（第二轮） | SessionFlags1=unlocked；last-input FILETIME134357623313472917，约本地20:12:11.347（仅同WTS FILETIME可比较，空闲不能证明最小化） |
| WTS session0/2 | Services/WTSDisconnected；Console/WTSConnected且无登录用户；第二轮active-console=2 |

原始GetLastError立即采集。WTS连接状态/用户等查询成功但raw error1008，不将成功调用后的错误槽值当作失败/权限拒绝；EnumWindows的成功raw error1400来自回调中的空HWND查询，同样不当失败。GUITHREADINFO的输出在FALSE时不解释为有效窗口信息，GetGUIThreadInfo指定游戏线程成功时的空Active/Focus才独立列出。

结论：执行端与游戏的会话/命名桌面一致，采样时RDP连接且未锁定，WoW自身可见未最小化。已排除这几类直接原因；控制台session2登录屏不会使session1变成session0。实际障碍是RDP会话未提供可验证的输入桌面/前台（UOI_IO=false、前台0）。客户端最小化/显示抑制是候选，但无法仅凭这些服务端API唯一证明客户端窗口状态，也不假定错误出在用户操作。微软文档说明[UOI_IO](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getuserobjectinformationw)判断接收用户输入的桌面，[WTSActive](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ne-wtsapi32-wts_connectstate_class)属于连接状态，[SessionFlags](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w)另行报告锁定；[RDP窗口最小化可能影响UI自动化](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/desktop-flows/ui-automation/uipi-issues)，是候选解释的资料依据，并非本场景最小化已实测。未执行资料中的任何注册表/UAC建议。

需要用户：恢复本机的RDP客户端窗口并保持可见、不最小化/断开，确认远程桌面未锁定/无安全提示，在远程桌面仅点WoW标题栏后告知；若本来如此，补充客户端类型和有无嵌套RDP。后续经用户回复再进行恢复前后只读对照，前台可验证之前禁止输入。本轮诊断完成后停止，不自动恢复教程任务。

| 本轮创建并删除的完整任务名称 | 清理证据 |
| --- | --- |
| WowJev-FirstQuest-Readonly-a9f5349c633842029fa0c8aa6e9682f7 | 生命周期deleted=true；独立GetTask回查HRESULT80070002不存在 |
| WowJev-FirstQuest-Readonly-c787ab9325954a92b8be87661b13e82c | 同上 |

两轮Windows QPC完整只读过程分别1059.239/1059.751ms（包含主动500ms×2采样间隔）；协调器monotonic任务注册→运行→等待→删除分别2873.537/2872.410ms，不能与Windows QPC起点直接相减或相加嵌套区间。没有观察→输入、输入发出或效果确认样本。`rdp-diagnostic-latency.jsonl`/summary以既有TraceRecorder从原始数据生成，采样API为revalidate，完整run和协调器bridge分域记录；归一化协调器0点仅表示往返耗时，不代表与QPC对时。

C#只读工具编译通过；Python全量收集705项：702passed、3原有strict xfail（gamma1.1反例）、0skip/失败，新增10项只读参数/清理/捕获与诊断status不混报检查纳入。Windows WinEye/NpcClassify与旧解码器均由当前树源码编译，完整原生离屏测试实际执行，未取现场图。TS首轮497passed/1failed/0skip，为固定`.venv/bin/python`在新树缺失导致的运行环境故障（brain-planner真实串行worker测试），补上主树同一Python环境后重跑全部498/498passed，0fail/skip/cancel/todo；没有改、删或跳过测试。typecheck exit0、git diff --check通过。首轮/重跑原始日志、Python XML及完整测试数字保留在`rdp-diagnostic-*`，第二轮实际源码/EXE归档`rdp-diagnostic-source/manifest.json`并核对任务SHA；第一轮EXE只保留SHA，不声称已归档旧二进制。本地提交并ff-only集成，不推送。

可重跑只读诊断入口：在独立工作树先`bash tools/interactive_readonly_build.sh`，再运行`python tools/interactive_readonly_once.py --pid <重新核实PID> --expected-start-ticks <重新核实ticks> --out /home/dw/Projects/wow-jev/out/<全新证据目录> --diagnose-desktop`。该标志只读取API，不拍图、不发输入；默认不加标志仍为原只读截图，两类status不会混报。每次临时任务自动删除并保留完整生命周期，不从正常清理外推强杀情况。

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
