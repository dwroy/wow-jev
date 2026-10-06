# Windows 交互会话常驻执行端

驻留入口只创建一个当前登录用户、最低权限、无触发器的 `/IT` 任务，在会话 1 拉起 `ResidentSessionHost.exe`。会话 0 的固定 `ResidentRelay.exe` 将 JSONL 标准输入输出转接至本机 named pipe。管道只允许当前用户 SID、拒绝远程连接、限定一个实例，并核对双方 PID、启动时间、会话、固定可执行文件路径及 SHA。握手 nonce 不进入普通 trace。没有 TCP、服务、注册表修改、SDK 安装或后台游戏输入。

WSL 互操作创建的 relay 进程曾拒绝来自会话 1 的进程查询。修补只合并 relay 自有进程 DACL 中当前用户的 `PROCESS_QUERY_LIMITED_INFORMATION`（`0x1000`）ACE，保留其它 ACE、无继承；不授予读取内存、修改内存、终止、调试或写 DACL 的对外权限。进程退出后对象及该 ACE 消失。`relay-access.json` 记录前后 ACE 数、实际增加的权限及 SID 哈希；对端仍必须独立查询 PID 对应的路径、SHA 和启动时间。失败时停止。依据为微软的 [GetCurrentProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getcurrentprocess)、[SetEntriesInAcl](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setentriesinaclw) 和 [SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo) 文档。会话身份从已拥有的管道句柄读取，不依赖跨会话的 `ProcessIdToSessionId` 查询权限。[GetNamedPipeClientSessionId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientsessionid)

WGC 使用按 HWND 创建的 capture item、常驻 `CreateFreeThreaded` 帧池和 D3D11 staging ROI。帧保留在 Windows 内存；每次采样只读描述的 ROI，以明确的 top-down BGRA、alpha=255 计算 ROI 哈希。ROI 哈希不是完整截图哈希，`full_frame_sha256` 保持 null。客户区坐标均为 DPI aware 的物理像素；客户区到 WGC 纹理的映射必须精确匹配客户区或 DWM 外框，否则停止。[WGC HWND interop](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)、[CreateFreeThreaded](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded)

热采样无 PNG 编码、无 OCR。显式 `evidence()` 才从同一 checked-out GPU 帧读取完整客户区、同步按需保存 PNG，并可选择低频 Windows 本地 OCR。这是低频抽样取证，尚不是异步 PNG 编码。只有经过验证的低频完整图才提供 screenshot SHA。普通 `sample(true)` 中遗留的 save 参数不启用这些操作。

每次热请求等待源 QPC 晚于 Windows 接收请求的新帧，最多 500ms，不对缓存帧更换 ID 以伪装新观察。WGC `SystemRelativeTime` 是 compositor QPC；原 WinInput 回执的 first successful SendInput 起止也是 Windows QPC。在同一启动时钟身份下可统计帧源到输入发出区间，不能与协调器单调时钟直接相减。[SystemRelativeTime](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframe.systemrelativetime)

输入仍经过 L3、Body、统一执行闸及原 WinInput。宿主只接受绑定原 frame、布局、ROI、计划、意图和批准 action SHA 的有限动作；每个动作最多 150ms。Windows 再检查源 QPC 年龄不超过 750ms、目标身份、布局、前台、首 DOWN 前自由光标和人类按钮状态，以及鼠标落点归属。普通动作不允许后台输入。焦点恢复仅保留 AGENTS 中已授权的单次例外，完整可见、空闲严格超过 5 秒等条件没有放宽。

`cancel` 和 `release_all` 对应原 WinInput 控制回执，保留连接和后续采样；`shutdown`、EOF、750ms 控制心跳到期及总预算到期才关闭宿主。输入模式长期复用一次原 WinInput 与独立 watchdog、ledger；不把它们放入协调器的强杀组。关闭结果必须有匹配会话的 release_all 实际回执、空 ledger、输入器退出和 capture dispose，再另核对计划任务删除及 GetTask 不存在。只读模式不取得输入器，报告 `no_executor_acquired`，不能据此声称已验证 held-key 断连释放。

只读验收命令如下，配置目标必须来自当前现场身份；输出目录必须不存在。

```bash
bash native/windows/build.sh
bash tools/resident_build.sh
python3 tools/resident_readonly.py --config readonly-config.json \
  --run-dir /home/dw/Projects/wow-jev/out/acceptance/resident/readonly-01 \
  --count 10 --interval-ms 100 --evidence true
```

只读配置包含 `version=1`、精确 target 的 pid/start_ticks/hwnd/class/executable/windows_session_id=1，以及 `authorized_input=false`、`focus_recovery_authorized=false`、`max_actions=0`、`duration_ms=60000`。它不会启动输入器、读凭据、调用模型或处理游戏对话框。

原件包括 `task-start.json`、`task-lifecycle.json`、`host-ready.json`、`channel-peer.json`、`channel-sid.json`、`relay-access.json`、`resident.jsonl`、`stopped.json` 及显式证据图片。失败原件包含准确 stage、异常类型、Win32 NativeError、HResult 和堆栈，不能把 API 访问拒绝笼统记成游戏退出。高频日志先留 Windows 本地；释放后才作有限时长的 WSL 导出，UNC 写入不是释放条件。

冻结前运行 `python3 tools/resident_source_manifest.py --out NEW_FILE`，记录全部 native C#、实际构建脚本、共享 CV/OCR、schema、校准、TS/启动器和固定 payload 的 SHA。历史仅保存部分源的失败采样不能追认来源完整。编译、纯 fixture、项目记录窗口实测、WoW 只读分布和 WoW 实际交谈分别报告；性能目标 p50 小于 150ms 尚需真实同域数据确认，不能用模拟输入或重复点击 NPC 填充样本量。

## 2026-10-07只读取证与待验项

负责人实际执行六轮只读启动，游戏输入始终为 0。跨会话身份链曾分别在 .NET 模块枚举、`ProcessIdToSessionId` 和 limited process open 处失败；relay 自有进程的最小 ACE 后，现场成功核对身份。SID 相同，宿主为会话 1、medium integrity（8192），relay 为会话 0、high integrity（12288）；不能把同用户等同于同一有效 token 或同一进程 DACL。

第六轮记录 `OnFrame=0 / frames_received=0`、MTA、无 callback exception。现场 `WTSConnectState=4 (Disconnected)`、thread desktop `Default`、`OpenInputDesktop` 返回 5、前台 HWND 为 0；同一 WoW 仍可见、未最小化，物理客户区 2560×1440、DPI 144。当前结论是 RDP 已断开，没有可用的新渲染帧。STA/MTA delegate marshalling 是先前可检假设，不能据这轮数据断言它曾是根因或已经修好。没有放宽新帧源时间要求，没有设置后台帧率或系统参数。

正常只读关闭已经现场确认：同一会话的 stopped ACK、capture disposed、`no_executor_acquired`、launcher exit 0，以及 owned task 删除和 GetTask 返回 `0x80070002`。第六轮任务为 `WowJev-Resident-6184fc51c1f84595bd29f5b73bc215bf`。这只证明无输入器时的关闭，不证明 held-key EOF/心跳/强杀释放。原件及各轮完整来源固定由负责人保存在验收目录；01–04的有限来源固定不能追认完整。

用户本轮要求完成离线工作后推送并停止。尚未实测 WoW hot-path 分布、记录窗 30 次实际输入、held-input EOF/强杀释放、同场景单层模型只读对照或第一个交谈；没有这些数据就不报告 p50 目标达成或任务成功。以后需用户重新连接 RDP、确认窗口和授权，再按分阶段清单操作。

## 独立记录窗口基准入口

记录窗口、生产 WoW 严格区分 `target_scope`。生产仍仅正式服 Wow.exe；fixture 仅项目固定 `ResidentRecordingWindow.exe` 的路径、SHA、类名 `WowJevResidentRecordingWindowV1`、PID/start/HWND/session1。fixture 禁用焦点恢复、OCR、教程数据库和截图模型；样本及 L3 效果都不能改成游戏任务成功。

离线入口如下，prepare/validate不调用Windows：

```bash
python3 tools/resident_fixture_benchmark.py prepare --run-dir out/benchmark/fixture-plan
python3 tools/resident_fixture_benchmark.py validate --config fixture.config.json
```

以后用户授权记录窗口实测、RDP有效时，才能运行：

```bash
python3 tools/resident_fixture_window.py --out out/benchmark/recording-window.json \
  --duration-ms 180000 --recording-window-authorized
# 用户自己点击记录窗口使其成为前台；窗口ShowWindow不请求激活。
python3 tools/resident_fixture_benchmark.py run \
  --config out/benchmark/recording-window.config.json \
  --run-dir out/benchmark/fixture-input-01 --count 30 \
  --finite-input-authorized --fixture-target-authorized
```

记录窗本身不调用 SendInput，只在收到实际鼠标 DOWN/UP 后增加计数，绘制可只读确认的 counter/nonce。ESC或自身截止时间关闭；创建它的一次性任务登记在 ready 后删除，并明确窗口仍有自己的有限寿命。基准复用同一常驻 WGC、来源登记、L4 sequence、L3 `activate_control`、Body、统一执行闸及原 hand，最多 64 次有限 20ms click。它只确认 `fixture_effect`，`game_effect` 始终 unverified。失焦或来源未知不发输入；不会强行激活记录窗。

输出按 Windows QPC 分别统计 source→first successful SendInput、ROI、CV 的 n/p50/p95，另报实际输入和独立 fixture effect 数、包含清理的每分钟有效 fixture 动作数、代码/Jev/大脑调用与 trace。不到 30 项有效输入时，p50<150ms 目标保持 unknown；单个游戏首任务样本也不能混入记录窗分布。
