# Windows 外部 Host 的只读启动探测

更新：2026-10-05。当前没有证明可用的独立 Host 启动链路；真实 Ubuntu 重启没有执行。

`tools/HostLaunchProbe.cs` 只启动 SHA256 冻结的 `WslRestartAcceptance.exe` **默认只读 preflight**。它不接受 `--run` 或 `--confirm-distro-restart`，不创建 InputRecorder，不发送键鼠，不执行 terminate/shutdown。每次 primary 和 Ubuntu UNC export 必须全新，拒绝路径穿越和重解析目录；原始失败目录保留。返回 0 表示探测完成，是否满足独立 Host 前置只看 `host_detachment_proved`，不能用退出码替代。

## 构建与接口

```bash
bash tools/wsl_restart_fixture_build.sh
bash tools/host_launch_probe_build.sh
out/host-launch-tools/HostLaunchProbe.exe --self-test
```

CLI 必填 `--host-source`、`--host-sha256`、`--out`、`--export-dir`、`--native-root`；`--method` 为 `breakaway` 或 `explorer`，默认 breakaway；`--repo-wsl` 默认 `/home/dai/Projects/wow-jev`。source 只能名为 WslRestartAcceptance.exe，长度受限且 SHA 精确匹配；同目录的 controller 与有限 lease gate 复制至本次自己的 Windows 包。source SHA、本地 SHA、helper SHA、请求路径、实际文件句柄路径、PID/启动时间和 job 记录均保留。

下面只是重复只读探测的入口；目录 NEW 必须替换为新的本次 UUID。它永远不会升级为 restart run。

```bash
task_host_sha=$(sha256sum out/restart-tools/WslRestartAcceptance.exe | cut -d' ' -f1)
out/host-launch-tools/HostLaunchProbe.exe \
  --host-source "$(wslpath -w out/restart-tools/WslRestartAcceptance.exe)" \
  --host-sha256 "$task_host_sha" \
  --out 'C:\Users\dai\Documents\WowJevAcceptance\host-launch-NEW' \
  --export-dir '\\wsl.localhost\Ubuntu\home\dai\Projects\wow-jev\out\acceptance\retail-closure\host-launch-NEW' \
  --native-root '\\wsl.localhost\Ubuntu\home\dai\Projects\wow-jev\native\windows\bin' \
  --repo-wsl /home/dai/Projects/wow-jev --method explorer
```

## 两条受限启动路径

breakaway 路径使用 `CreateProcessW(CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED | CREATE_NO_WINDOW)`，先从真实子进程 handle 读取 job/PID/创建 FILETIME/映像路径，再 ResumeThread，最长等待 25 秒。只在自己的 handle 超时后终止本次新建的 probe 子进程，不操作已有进程或 job。标志被操作系统接受也不能证明全部 job 已脱离；job 可以嵌套，继承与 breakaway 取决于各层限制。[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

Explorer 路径先通过 GetShellWindow 找到现有桌面 Explorer，记录其 PID/启动时间/job/映像。通过桌面 ShellWindows → IServiceProvider → IShellBrowser 获取 ShellView 的 automation，并核对 browser HWND 仍属于刚才的 Explorer PID，然后调用其 Application.ShellExecute，参数固定为当前的只读 preflight。没有 UIAutomation、桌面 Run/终端操作、UAC、认证或用户身份修改。此方式参考 Microsoft 的既有 Explorer automation 用法；ShellExecute 的隐藏窗口参数只是显示建议，不能单凭此调用外推出 job 脱离或 Ubuntu 终止后存活。[Microsoft Explorer automation example](https://devblogs.microsoft.com/oldnewthing/20131118-00/?p=2643/), [IShellDispatch2.ShellExecute](https://learn.microsoft.com/en-us/windows/win32/shell/ishelldispatch2-shellexecute)

Host 在 Main 入口、任何 wsl.exe 查询之前保存 `host_job_at_entry`，preflight 查询后保存 `host_job`。只有两次 known=true/in_job=false，且 PID/启动 ticks 一致、完整 preflight 的 tool SHA 与本次 source 相同，才有 `host_detachment_proved=true`。即使如此，真实重启存活还需实际 before/after 证据。IsProcessInJob 没有识别 job 来源或终止策略，in_job=true 不能证明一定属于 WSL job或一定会被杀；目前 run 采用保守前置拒绝。

## 本机实际只读结果

所有下述场景 `restart_executed=false`、fixture 未创建、输入 0；没有停止共享 Ubuntu 或用户程序。

| 场景 | 真实观察 | 独立 Host 前置 |
| --- | --- | --- |
| breakaway，AppData | CreateProcessW 成功，Win32 error 0；子 PID 24760 挂起时、完成后及 Host 自报均 job=true | 未证明 |
| Explorer，AppData | 现有 Explorer PID 9388 job=false；Host PID 12176 查询后 job=true | 未证明 |
| Explorer，AppData，增加入口观察 | Host PID 26660 入口和查询后 job=true | 未证明 |
| Explorer，全新 Documents 项目目录 | 请求路径等于实际路径；Host PID 11912 入口和查询后 job=true；Explorer 仍 job=false | 未证明 |

Documents 的真实 source SHA 为 `11b536184474e249cb27f51ffcedf0a66ccb319506c3b8732ac40ad19e66171f`；执行 probe 二进制 SHA 为 `d1b812462cb2a6eec33237abaf9d48cb1ac476c549e3cd5eb768b446b267c29b`，字段保留在原始记录。之后 helper 只补了失败记录留存；当前源码已重编译并通过边界测试，没有再进行启动探测。

可回读的项目 export 根：

- `out/acceptance/retail-closure/host-launch-breakaway-7eea4aa7096a42d9ba95b529d1781c7f/launch-probe.json`
- `out/acceptance/retail-closure/host-launch-explorer-79f596e669be4bf2ac9f766ea01b0222/launch-probe.json`
- `out/acceptance/retail-closure/host-launch-explorer-entry-1d494da81fad422994176d603c4b8092/host-preflight/preflight.json`（该次 helper 最终结果未完成，preflight/export ACK 已留存；不计完整 probe 成功）
- `out/acceptance/retail-closure/host-launch-explorer-documents-7dc5f5f355654ee2aee76b4850d88ac7/launch-probe.json`

AppData 请求路径在本运行环境实际映射到 Codex 包的 `Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local`。工具用文件句柄只读解析 actual path，同时保留 requested path，不搬走旧记录或把该映射推断为未写入。负责人另行授权了一次显式 Documents 独占目录来排除该路径因素；Documents 结果同样 job=true，故不继续无依据切换启动方式。

当前验证：Windows C# 编译通过；helper 10 个纯离线参数/路径/Win32 转义用例及 3 个实际 CLI 拒绝 run/confirm/重复参数用例通过；restart harness 34 个模拟机制/证据边界通过。真实独立 Host 生存、WSL 重启、原生产 guardian 生存和释放仍未验收。生产 NativeInputClient、WinInput 和 watchdog 没有 detach 或被 Host 预启动替代。
