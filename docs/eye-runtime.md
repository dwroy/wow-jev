# 眼运行时与录制回放

Windows 的 `WinEye.exe` 只截取绑定窗口的客户区，在本地做 CV；TypeScript 保存统一状态和证据，Python 在启用后异步调用 Seed。感知程序不发送输入，也不改变焦点。

## 只读观察

先构建，再列出当前游戏窗口；游戏重启后 HWND/PID 可能改变。

```bash
bash native/windows/build.sh
npm --prefix agent ci
npm --prefix agent run input -- list

# 把 HWND/PID 换成 list 输出。默认不上传图片，不发送输入。
# 执行后5秒内手动切回游戏，避免最小化时启动捕获失败。
sleep 5
npm --prefix agent run eye -- observe \
  --window 0xHWND --pid PID --duration-ms 10000 --save \
  --calibration out/acceptance/stage-2/calibration/retail-bag-v1/calibration.json
```

输出含 `run_dir`，日志在该目录的 `events.jsonl`。`ui.inventory_open` 为 `known` 时，true/false 分别表示打开/关闭；`unknown` 或 `unavailable` 不等于关闭。未支持的血量字段保持 unavailable。

目前背包校准只适用于本次验收的 2048×1536 客户区、HUD位置和背包图标布局。改变分辨率/UI后需要用确认过的打开、关闭截图重建校准；相似度与模型自报置信度都不是准确率。

```bash
/usr/bin/python3 tools/eye_calibrate.py --help
```

游戏需进入角色场景并保持可见。最小化、黑帧或窗口身份变化会导致 unavailable 或运行失败，程序不会抢焦点。

## Seed 看图

在 observe 参数后增加以下开关，才会把该 WoW 窗口的低频 JPEG 发送至火山方舟。凭据由 Python 在运行时读取 `~/.config/wow-jev/api.env`，日志不记录密钥。

```bash
--seed --allow-game-image-upload --python /usr/bin/python3
```

截图默认至少间隔 1 秒，Seed 至少间隔 3 秒且单次请求；高频 CV 不等待模型。模型结果沿用源截图时间，过期或乱序结果被拒绝。背包优先采用可用的校准 CV 结果。本轮模型曾漏看实际存在的目标栏；目标与战斗读数仍需要进一步验证，当前不作为动作执行条件。

## 一次有限动作与回放

`record-action` 必须显式指定 `--live`。运行前手动切回目标游戏，保持前台；失焦会停止输入，Ctrl+Alt+F10 为急停。下面示例需要起始背包关闭：

```bash
npm --prefix agent run eye -- record-action \
  --window 0xHWND --pid PID --live \
  --action '{"kind":"key","keys":["B"],"duration_ms":100}' \
  --expect-inventory-open true \
  --calibration out/acceptance/stage-2/calibration/retail-bag-v1/calibration.json
```

此命令只按一次 B，随后有限等待界面变化，不重复发送动作。日志分别记录实际输入回执和效果：完整输入计数与 released 只证明执行和释放；效果 confirmed 还需要一致校准的前后观察。其他动作的游戏效果本阶段保持 unknown。

```bash
# 替换为运行输出中的 run_dir；回放只读日志，不输入、不上传。
npm --prefix agent run eye -- replay --run-dir /absolute/path/to/run
```

回放检查 schema/校准/截图哈希、源引用、原始 CV 与观察一致性，以及每个动作的回执和关联证据。每次运行创建新目录；已有输出目录不会被覆盖。

Windows QPC 只作为原生来源时钟保留。字段时效使用 WSL 采样请求到接收的区间下界，模型完成时间不会刷新采集时间。
