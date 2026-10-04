# Windows 只读截图与 CV

`WinEye.exe` 使用 C# 5 / Windows .NET Framework 4。通过 `bash native/windows/build.sh` 构建；不注册输入 mutex、热键，不发送输入或切换焦点。

## 实时服务

```text
WinEye.exe serve --window 0xHWND --expected-pid PID --session <规范小写 UUID> [--calibration <Windows绝对路径/calibration.json>] [--export-dir <Windows绝对路径或UNC目录>]
```

启动时绑定 HWND、PID 和目标进程启动时间。ready 的 `capture_pid` 是截图程序自己的 Windows PID；它与游戏 PID、WSL 桥接进程 PID 不同。采样前后校验目标身份和客户区尺寸，尺寸改变时拒绝该帧。截图启用 Per-Monitor V2，使用 `PrintWindow(PW_CLIENTONLY | PW_RENDERFULLCONTENT)`；检查 API 返回值，不使用整个桌面截图兜底。

stdin UTF-8 JSONL：

```json
{"protocol":"wow-eye","version":1,"type":"command","session_id":"01234567-0123-4123-8123-012345678901","id":"frame-1","op":"sample","save":false}
{"protocol":"wow-eye","version":1,"type":"command","session_id":"01234567-0123-4123-8123-012345678901","id":"frame-2","op":"sample","save":true}
{"protocol":"wow-eye","version":1,"type":"command","session_id":"01234567-0123-4123-8123-012345678901","id":"stop-1","op":"shutdown"}
```

每个 sample 请求实际获取新帧，单在途；并发请求返回 `sample_busy`。最多记录 4096 个请求 id，重放拒绝；容量达到后仍可 shutdown。EOF 和 shutdown 释放进程内资源并退出，采样线程有界等待，后台线程不会阻止进程退出。响应每行限 64 KiB，有界输出队列，不传原始位图。

位图在 Windows 进程内用于 CV。`save:true` 才写 `%LOCALAPPDATA%\WowJevEye\<session>\capture-<UUID>.jpg`，JPEG 质量 90；每会话上限 128 个文件及 128 MiB，单文件最多 64 MiB。响应附真实 SHA256、尺寸、Windows 路径。拒绝目录重解析点，异常写入删除未完成文件；文件按会话留给负责人归档，不自动清理其他会话。

Windows 本地 AppData 路径即使可用，也不能据此推断 WSL `/mnt/c` 中可读。显式 `--export-dir` 支持 `\\wsl.localhost\Ubuntu\...`：仅 `save:true` 的低频 JPEG 以 CreateNew 语义复制到该目录，回执前核对长度与 SHA。ready 的 `export_root` 为目录或 null；artifact 只有成功导出才附 `exported_windows_path`，`windows_path` 保留本地源文件证据。导出失败返回错误，清除本次创建的未完成文件，不覆写既有文件，也不把文件缺失说成可读取。

源时间来自 Windows QPC：`started_qpc_ms/finished_qpc_ms/local_clock` 只在该域比较。WSL 运行时保留原始源时钟，并使用请求开始到完整响应的保守捕获窗口，不能直接用 Windows QPC 减 WSL 单调时间。

`mean_luma/variance_luma` 为最多 64×48 缩略图统计；`frame_delta` 为同尺寸相邻有效帧亮度绝对差均值除以 255。它们只描述图像，不推断移动、血量或战斗。近乎全黑帧及无结构均匀帧为 unavailable，未知检测值为 null。

## 背包 ROI 校准

使用 `tools/eye_calibrate.py` 生成 `calibration.json + open.png + closed.png`。原生加载检查版本、尺寸、ROI 边界、阈值、PNG 模板尺寸和来源哈希格式。模板间 RGB 距离小于 `min_margin` 时拒绝整个校准。

ROI 每通道绝对差均值除以 255；两个类别分别计算距离。只有胜者距离不大于 `max_distance`，且类间分数差不小于 `min_margin`，才返回 known true/false。尺寸不同不缩放模板，返回 unknown/null；超出阈值或分差不足也为 unknown/null；无校准为 unavailable/null。reason.message 保留两个 distance 和 margin 供复核。

known 的 `confidence=1-winning_distance` 是相似度指标，**不是统计准确率或概率**。同尺寸中的 UI 缩放、位置、皮肤及场景变化仍需独立数据验收，不能从短场景 holdout 外推全部游戏界面。

## 离线回放

```text
WinEye.exe classify --image <Windows绝对路径/JPEG或PNG> [--calibration <Windows绝对路径/calibration.json>]
```

单次输出独立 `offline_result` 并退出，含图像 SHA、尺寸、metrics 与 detectors。没有实时 window/capture 元数据，不冒充 PrintWindow 新采样。协议结构定义在 `protocol/native-eye-v1.schema.json`。

在 WSL 复测已记录的第 1 阶段数据与反例：

```bash
python3 tools/eye_native_check.py \
  --exe native/windows/bin/WinEye.exe \
  --calibration /home/dai/Projects/wow-jev/out/acceptance/stage-2/calibration/retail-bag-v1/calibration.json \
  --stage1-dir /home/dai/Projects/wow-jev/out/acceptance/stage-1/game/probe-1
```

该入口标明两张参考图与九张 holdout；反例检查无校准、尺寸改变、黑帧、均匀空帧、不可分模板、非法阈值、越界 ROI、距离超限和分差不足。只读取已授权本地图像，不调用模型 API、不发送键鼠。
