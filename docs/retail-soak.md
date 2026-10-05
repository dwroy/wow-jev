# 正式服只读长跑验收

`tools/retail_soak.py` 是 `vision_record.py` 的外部驱动，不改变现有录制实现。默认运行有界十分钟，仍按现有原生进程每段不超过 90 秒轮换，截图配额仍为每段 128 张。感知链路不启用 Seed，也不启动输入执行器。

```bash
.venv/bin/python -m tools.retail_soak \
  --repo "$PWD" \
  --out "$PWD/out/acceptance/retail-followup/soak-1" \
  --window 0x当前HWND --pid 当前PID \
  --client-profile "$PWD/game-data/profiles/retail-cn-12.1.0.69933.json"
```

输出必须是新的绝对目录，不能覆盖先前失败。版本 profile 沿用游戏数据库的六字段 `branch/expansion/patch/build/region/locale`；本工具是当前正式服的验收入口，所以 `branch` 必须为 `retail`，未知 build、patch、region、locale 会拒绝。它在录制前后只读查询实际 `Wow` 进程、进程启动 ticks、exe 文件版本、`_retail_` 目录、配置中 portal/textLocale；不复制完整配置或进程命令行。文件版本、地区、语言与 profile 必须匹配，进程不能在录制中被另一个相同 PID 实例替换。profile 原始字节冻结到验收目录；这些检查确认本地客户端和配置，不能外推在线服务器版本。

`driver.json` 保存冻结 profile 哈希、实际客户端身份、驱动和录制工具哈希、期限、退出、取消和清理状态。`recording/` 保存原始分段日志与截图；`summary.json` 独立回放每段后分析每个源图哈希、源图与原生 sample 的对应、PID/HWND、每段配额、样本与源图数、native 输入命令数、退出码和缺失段。失败也保留已有段和缺口。

边界缺口使用同一 Windows 机器的 `windows-qpc` 捕获结束/下一次捕获开始计算，不拿 WSL 单调时钟、UTC 或 Linux 启动 ticks 与 QPC 相减。十分钟任务完成代表有限任务完整结束，不代表每毫秒都有录像；`continuous_capture_claimed` 固定为 false，分段缺口逐个输出。相同 hash 的最长连续次数只供检查静态画面，不能单独把静止场景判成后台渲染停更。

窗口消失、客户端变更、非零退出、日志/源图校验失败或无法严格回放不会成为验收成功。外部期限最多为请求时间加 45 秒；取消或超期只给本次创建的录制进程组发信号，并等待原录制器清理其独立段进程组。若最后被迫强杀父进程，不能据此断言 Windows 截屏进程已正常退出，需结合原始段关闭记录复核。没有输入的判断限于录制链路，用户同时手动玩游戏仍会产生人工输入。

2026-10-05：新增 23 项外部驱动机制测试与既有 3 项录制生命周期反例全部通过（26 项）。旧 `capture-4k-2` 的 51 张源图实际独立回放和分析通过，0 输入；这是既有一分钟证据的工具复核。

真实十分钟 `out/acceptance/retail-closure/soak-10m-1` 已封存，驱动 accepted=true；7段退出码均为0、每段独立严格回放通过。492个原生样本全部 capture=ok，491张图像有491个不同SHA，0原始输入记录/0出站输入命令；每段图数79（最后17），未碰128配额。录制前后同一PID18128/启动ticks/窗口0x340894、3840×2160，实际客户端12.1.0.69933/CN/zhCN与冻结profile相符。

全部492个样本 focused=false：当前营地角色场景能在非前台时采到持续变化的画面，尚不能推广到所有后台遮挡/最小化/渲染模式；此轮也没有验证输入。六次分段缺口使用同机QPC实测为5586、5627、5577、5626、5053、5540毫秒，最大5627毫秒。因此通过的是有界十分钟分段录制与配额/身份/日志生命周期验收，不是无缝或严格每秒一张；后续应缩短轮换关闭和启动间隔。

零输入检查直接拒绝原始 `native_input` 记录和 `action_intent/execution_receipt/action_link`；`mode=observe`、`config.action=null` 或回放 actions=0 都不能替代此检查。输出分别统计原始输入记录与出站 execute 命令。

PowerShell 客户端查询使用 UTF16LE `-EncodedCommand` 并关闭进度记录；只解码有界 UTF-8 stdout JSON。非零退出或缺失元数据会拒绝，ANSI/CLIXML stderr 不会作为版本证据。已在真实新 WoW PID 18128/HWND 0x340894 上只读复核版本 12.1.0.69933、CN/zhCN、3840×2160。
