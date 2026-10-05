# Ubuntu 重启的 Windows 外部验收

更新：2026-10-05。工具已编译并通过模拟边界校验；仅运行了只读 preflight，尚未执行真实发行版重启或专用窗口输入。

`WslRestartAcceptance.exe` 默认只读查询正在运行的 Ubuntu、列出 PID/PPID/comm/cwd/启动 ticks，冻结本项目二进制、生产 `NativeInputClient` 和 schema 的 SHA，再写 Windows 本地准备记录。它不读取进程命令行、环境变量或凭据，不开启记录窗口、不发送输入、不自动启动已停止的 Ubuntu。只有同时出现 `--run --confirm-distro-restart Ubuntu` 才执行真实重启；其它发行版会拒绝。

## 准备与共享影响

```bash
bash tools/wsl_restart_fixture_build.sh
out/restart-tools/WslRestartAcceptance.exe --self-test
```

preflight 的 `--out` 必须是新的 Windows 本地绝对目录。`--export-dir` 明确指定新的 Ubuntu UNC 目录；Windows 本地 primary 日志和 WSL export 分别记录实际域，不能用不可见的 `/mnt/c/AppData` 推断没有写入。本机已实测 Windows 文件存在但该 WSL 映射不可读，显式 UNC export 经长度/SHA 比较后才生成 ACK。

```text
WslRestartAcceptance.exe --distro Ubuntu
  --out C:\Users\dai\AppData\Local\WowJevAcceptance\restart-preflight-NEW
  --native-root \\wsl.localhost\Ubuntu\home\dai\Projects\wow-jev\native\windows\bin
  --repo-wsl /home/dai/Projects/wow-jev
  --export-dir \\wsl.localhost\Ubuntu\home\dai\Projects\wow-jev\out\acceptance\retail-closure\restart-preflight-NEW
```

2026-10-05 只读 preflight 实际观察到 71 个 Ubuntu 进程，清单完整；除了本项目与 Codex 进程，`/home/dai/Projects/acehr` 有 `node_repl.exe` PID 425015。项目负责人必须保存/停止本项目任务，审查最新 preflight 中其它项目的共享影响，再取得具体的 Ubuntu 重启授权。该 PID/cwd 是当次快照，不能当成之后仍然有效的状态；本工具不会停止这个进程。

## 审查后的实际运行

Windows Host 必须从 Windows 本地副本启动，不能从 Ubuntu UNC 路径直接运行长期观察器。preflight 已把主程序、controller、有限 lease gate、原生二进制与 schema 打包到 primary 的 `native` 目录。实际 run 使用全新的 primary/export 目录和原生产 native 路径；在 Windows PowerShell 里启动，避免协调器跟着 WSL 退出：

```powershell
$taskTool = 'C:\Users\dai\AppData\Local\WowJevAcceptance\restart-preflight-c019a03f852542a68d2484a67f6e9316\native\WslRestartAcceptance.exe'
$taskRun = 'C:\Users\dai\AppData\Local\WowJevAcceptance\restart-run-20261005-01'
Start-Process -FilePath $taskTool -ArgumentList @(
  '--run', '--confirm-distro-restart', 'Ubuntu',
  '--out', $taskRun,
  '--native-root', '\\wsl.localhost\Ubuntu\home\dai\Projects\wow-jev\native\windows\bin',
  '--repo-wsl', '/home/dai/Projects/wow-jev',
  '--export-dir', '\\wsl.localhost\Ubuntu\home\dai\Projects\wow-jev\out\acceptance\retail-closure\restart-run-20261005-01'
) -PassThru
```

上面的 Host 程序路径来自已完成的实际 preflight 包；如重新构建，先生成新的 preflight 包再替换该路径。运行时会再做 preflight；所有原生程序和生产 client 源码均冻结 hash，在旧/新 controller 启动前再次检查。运行代码引用现有 `NativeInputClient`、默认 launcher 与同一生产 `WinInput.exe` 路径；执行器按原有 `serve --watchdog` 机制自行启动看门狗，Host 没有替换或预启动它们，也没有通过 detached guardian 掩盖 WSL interop 的生命周期。

实际流程仅打开新建的专用 `InputRecorder`，要求最初物理键鼠全部 UP、目标 HWND/PID/进程启动身份一致且仍在前台。WSL controller 通过原 client 长按 W、上限 5000 ms；Host 只读跟踪这个 UUID 的 Windows lease、真实 `GetAsyncKeyState` 和记录窗口事件。然后 Windows 主机执行 **`wsl.exe --terminate Ubuntu`**，不是 `wsl --shutdown`，并保留旧 controller、executor、watchdog 的 PID/启动 ticks 与终止前后采样。

本场景使用既有 `InputLeaseTestGate` 临时锁住本次自己的 lease mutex 1500 ms，让常规 EOF/finally 清理不能在发行版终止前抢先释放，从而暴露守护程序是否被 WSL job 连带杀死。它不发送输入，生命期有限；这是故障注入场景，会让本来 100 ms 的 mutex 等待或 750 ms 心跳请求超时，不等于日常重启行为，也不能把其结果外推为全部普通场景。若终止耗时超过锁定窗口、看门狗已因 StopRequested+释放正常退出，`after_alive=false` 不能直接证明被 job 杀死；本工具保留时间线和实际 exit code，报告 `production_watchdog_survival_unconfirmed`，不报告生产守护存活通过。

Host 观察到 lease 清零、停止原因和至少三次真实 UP 后，才恢复 Ubuntu。验收比较 `/proc/1/stat` 的 init 启动 ticks 与 kernel boot ID 的组合；仅杀 Node、重用旧 init 实例不能通过。旧 token 有持久消费标记，恢复后实际重放同一 token 必须在启动输入执行器之前拒绝。新会话须获得自己的 native ready/watchdog，执行一次 W 100 ms，完整收到 2 个输入事件并再次释放；旧/新输入阶段在原始记录窗口日志中分别核对。

## 结果与失败

`preflight.json` / `ready-plan.json`、`lease-old.jsonl` / `recorder.jsonl`、旧/新 controller/native 消息、PID 与启动 ticks、完整或 partial facts、`restart-summary.json` 都先写 Windows primary。controller 交换文件在显式 export 的 `controller/` 子目录，重启前关键版本/ready/命令与日志快照已校验复制至 primary，不能用 WSL 停机期间的 UNC 写入替代外部证据。重启恢复后 export 再比较长度/SHA；失败保留 primary，不覆写历史失败，也不把没有 ACK 的复制当成功。

等待与输入各自有有限期限，正常测试整体预算 90 秒，清理及恢复/export 有独立短期限。任何未知释放、源日志校验失败、原 production watchdog 存活不可确认、旧 token 可复活、新输入不完整，都保持 failed/unconfirmed。Host 兜底最多释放已明确归本次测试所有的 W/lease UP，只清理本程序新建的进程与窗口；`host_fallback_release_used=true` 绝不计入生产看门狗验收通过。

Root 可以从 Windows 本地 `--verify <primary-directory>` 独立校验 raw recorder、lease、fresh-native 与 facts。校验 synthetic 结果只在 `--self-test` 输出 `scope=synthetic_mock_trace`，不会标成实测。

本模块目前完成：Windows 编译、24 组机制/原始日志模拟边界（含错误发行版、旧 init、旧 controller 仍在、守护被杀、Host 兜底、实际键未 UP、源 hash 改写、新会话部分输入）、3 项 durable token/跨模式重放测试，以及 TypeScript typecheck。真实只读 preflight+长度/SHA export 已通过；真实 restart run 尚未执行。

本次最终准备包 Windows primary：`C:\Users\dai\AppData\Local\WowJevAcceptance\restart-preflight-c019a03f852542a68d2484a67f6e9316`；可回读 export：`/home/dai/Projects/wow-jev/out/acceptance/retail-closure/restart-preflight-c019a03f852542a68d2484a67f6e9316`。`export-ack-preflight.json` 已核验每项长度/SHA；本记录只证明只读预检与导出链路，重启未执行。
