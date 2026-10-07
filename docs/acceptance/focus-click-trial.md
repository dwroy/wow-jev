# 单次背景focus_click试验

2026-10-07，用户明确授权：可见WoW安全背景点仅尝试一次focus_click，若SendInput失败或前台复核非WoW立即停止，不再其它方法。开发独立manual-first-task树、稳定业务40c1650；只读和所有原件主out/acceptance/focus-click-trial-20261007。

会话1 inputDefault/UOI_IO=true，WoW身份未变、2560×1440物理/DPI144。点(1536,360)归一化(.6,.25)、屏幕(2148,773)，每个5×5点命中WoW，避开重连(.5,.5)/登出(.5,.603)/公告及右下按钮，不在PowerShell矩形内。当前光标CURSORINFO flags2/handle0，原普通可见光标闸会拒绝；这次固定助手仅区分系统抑制与未知/鼠标捕获，独立核验两目标GUI线程无capture、无人持鼠标键、空闲严格>5s。不修改普通生产输入闸，不调用SetForegroundWindow/AttachThreadInput/后台消息，不改设置或提权。

沿用原输入准入mutex、LeaseStore在DOWN前flush登记、原WinInputWatchdog独立守护/租期/热键释放，动作有限60ms、cancel文件前后检查，失败只释放，不再点击。真实MOVE+LEFT_DOWN的SendInput返回2/2（raw GetLastError0）；UP返回1/1；最终空持键账本、release_confirmed=true、watchdog_exited=true。实际窗口激活复核失败，foreground_after=0x3607de管理员PowerShell而非0x904a6。只执行一次focus_click，3个鼠标事件插入，未发普通游戏输入、重连或后续任务。

| 项目 | 实测 |
| --- | --- |
| PowerShell外框 | (141,152)-(1893,1088) |
| WoW外框 | (601,368)-(3183,1864) |
| WoW客户区 | (612,413)-(3172,1853) |
| 首个SendInput调用 | 2.306ms，Windows QPC |
| focus效果 | 未确认，前台仍PowerShell |
| 首教程任务/模型调用 | 未完成/0 |

SendInput返回值只报告插入事件数，不能据此推断激活或唯一认定/排除UIPI原因；[微软SendInput定义](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)。真实input/UP与focus效果分开，未报告L4/L3 E2E或p50<150ms目标。

本轮临时任务创建且删除并GetTask80070002回查：

- WowJev-Resident-f280f52d5809446d8041ea4ee22d1603
- WowJev-FocusClickTrial-b6272b1f3c494d0a8c968bf2b3ad54c0


原源/EXE/watchdog SHA、原始returns、完整before/before_send Windows API证明与生命周期均保留。C#编译与本次真实试验，不冒充软件全量/强杀/WSL重启验收。用户要求失败立即停，本轮没有其它焦点恢复尝试。仅本地分步提交与ff-only主集成，未推送。
