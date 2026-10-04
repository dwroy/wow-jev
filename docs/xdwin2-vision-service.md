# xdwin2 本地视觉与视频服务

服务已部署并完成真实 CUDA 推理、Windows SSH 隧道及家里 WSL 回环访问验证。服务代码位于 `deploy/vision-service/`，主 WoW agent 尚未切换视觉提供方。游戏识别准确率须另行核对，不能以接口成功代替。

## 模型与运行边界

- 目标：`iem@172.26.203.214`，Windows 上的 WSL Ubuntu，RTX 3090 24GB。
- SSH 使用 Windows OpenSSH：`/mnt/c/Windows/System32/OpenSSH/ssh.exe`，由 Windows 默认身份与 ssh-agent 认证。
- 独立目录：`/home/iem/Services/wow-vision`；Python 3.14 venv、Pillow 12.1.1，FFmpeg 8.0.1 用于有限抽帧。
- 复用既有 CUDA 架构 86 的 llama.cpp，精确 commit `c8cda8b4fe3f2217793eb68e6df2e93a0a1a73c1`，不更新驱动/已有引擎。
- 原模型为 [Qwen/Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B)。部署文件采用 [Unsloth 社区 GGUF 量化](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/tree/3885219b6810b007914f3a7950a8d1b469d598a5)，Q4_K_M 加同仓库的 F16 mmproj；精确文件、大小、LFS SHA256 在 `models.lock.json`。不是 Qwen 官方发布的量化权重。
- 上下文 8192、一个生成 slot、默认关闭思考、最多 256 个输出 token。GPU 显存和速度以真实验收为准。

视频实现为 **MP4 均匀抽帧后，携带采样位置的有序图片理解**。没有音频、原生视频时间编码或逐帧轨迹。最多 4 帧、12 秒；视频时间戳是请求 seek 的位置，不能声称精确原始帧 PTS。

## 启停与访问

在目标 WSL 中运行：

```bash
bash /home/iem/Services/wow-vision/code/service.sh start
bash /home/iem/Services/wow-vision/code/service.sh status
bash /home/iem/Services/wow-vision/code/service.sh stop
```

`wow-vision` tmux 会话中的 supervisor 管理本次服务的 gateway 与 backend；任一子进程退出，另一进程也会停止。stop 核对 `/proc` 中的命令身份后只给自己的 supervisor 发信号。tmux 保持进程在 SSH 断开后运行；机器/WSL 重启后的自动启动尚未配置。

Gateway 只监听 `127.0.0.1:18790`，backend 只监听 `127.0.0.1:18791`，均不直接开放公司网络。backend 和 gateway 共用仅用户可读的 `runtime/token`，命令行只包含文件位置，不包含凭据值。

从当前 WoW 机器使用 Windows SSH 隧道：

```bash
/mnt/c/Windows/System32/OpenSSH/ssh.exe -N \
  -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:18792:127.0.0.1:18790 iem@172.26.203.214
```

随后请求本机 `http://127.0.0.1:18792`。不使用无认证公开监听，也不需要改防火墙。家里 WSL 到 Windows 回环隧道须真实验证，不能直接套用办公室 mirrored 网络条件。WoW 客户端凭据位置由负责人配置在本机受限 `out/runtime/vision-service/client-token`；不提交、打印、复制到验收证据或放入 manifest。

## HTTP 契约

`GET /health` 返回 `ready`、模型别名、忙碌状态和是否需要重新启动。健康接口只证明 backend 就绪，不能替代实际视觉推理。

`POST /v1/chat/completions` 需要 `Authorization: Bearer <token>`，兼容有限的 OpenAI 图片请求：

```json
{
  "model": "wow-vision-qwen",
  "messages": [{"role": "user", "content": [
    {"type": "text", "text": "读取画面；看不清的字段返回未知，只输出JSON。"},
    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<base64>"}}
  ]}],
  "stream": false,
  "max_tokens": 192,
  "response_format": {"type": "json_object"},
  "chat_template_kwargs": {"enable_thinking": false}
}
```

仅接受 JPEG/PNG data URL，不下载远程 URL、不访问客户端给的文件路径。最多 4 张图片；单张输入不超过 2MiB、4096 边长、16777216 像素。单图缩放至最长边 1280、多图至 768。完整请求最多 24MiB、文字最多 8192 字符。`system` / `user` 为支持的消息角色；没有历史累积、工具执行或流式输出。

`POST /v1/analyze` 使用相同认证，短 MP4 请求：

```json
{
  "prompt": "按时间顺序描述背包状态变化，只输出JSON。",
  "video_b64": "<裸MP4 base64，不带data前缀>",
  "max_frames": 3,
  "max_tokens": 128,
  "response_format": {"type": "json_object"}
}
```

均匀取各区间中心。例如 3 秒视频、3 帧取 0.5/1.5/2.5 秒。MP4 编码后不超过 16MiB，时长最多 12 秒、边长不超过 4096。FFmpeg 只可读取临时本地文件，禁用网络输入协议；本次临时媒体在请求完成后删除。

也可由客户端提供已抽取的帧，`frames` 和 `video_b64` 二选一：

```json
{
  "prompt": "比较两帧，只输出JSON。",
  "frames": [
    {"timestamp_ms": 500, "image_b64": "<JPEG或PNG裸base64>"},
    {"timestamp_ms": 1500, "image_b64": "<JPEG或PNG裸base64>"}
  ],
  "max_tokens": 128
}
```

帧时间戳须为有限数字、严格递增、位于 0..12000ms，最多 4 帧。没有填补未输入的时刻或提升状态可信度。

响应保留 OpenAI `choices`、`usage`、llama.cpp `timings`，并增加 `vision_service`，记录源媒体 SHA、原尺寸、实际缩放尺寸、采样规则/位置、抽帧与预处理耗时、backend 往返和总耗时。日志只记录请求 ID、状态、帧数和时长，不记录 prompt、图片、model content 或 token。

## 超时与过载

读取请求体期限 5 秒，总请求期限 30 秒。最多一个推理请求；忙碌时立即 429，没有排队陈旧游戏画面的隐藏队列。FFmpeg 子进程有有限解码期限，超时后杀死并回收。

若 backend 推理超时或连接中断，gateway 关闭连接并进入失效状态；后续推理返回 503，需 stop/start 恢复。不能把连接关闭说成已证明 GPU 生成取消，因此不会在超时后自动并发发下一次请求。状态未知和模型错误应由主 agent 的时效/执行闸处理。

## 部署与验证记录

模型下载脚本只下载锁定的两个公开文件；大响应读超时后改为 4 路 32MiB Range 下载，在完整长度和 SHA256 均匹配后才写 manifest。不会从社区仓库执行 Python 模型代码。

本地与远端 Python 3.14 的 `test_gateway.py` 同组 13 项 HTTP 契约与边界测试均已通过。这些使用假 backend，验证认证、远程 URL 拒绝、JSON/媒体限额、帧序、超时和过载，以及模型语义错误时验收非零退出，不能代表实际 GPU、OCR 或视频理解效果。

真实服务初测记录在 `out/acceptance/vision-service/remote-smoke-1`。640×480 的合成大字 BLUE 三次均正确：首次 875.6ms、热请求 292.7/294.5ms；red→blue→red 三帧顺序判断正确，899.2ms。这些是简单合成图测试，不能外推为 WoW HUD 刷新速度。

初测 GPU 峰值 8037MiB，利用率 99%。`remote-cuda-proof.json` 将精确 backend PID142548 对应到 NVIDIA compute-app，与它映射的 `libggml-cuda`、WSL `libcuda`、动态库 SHA、实际引擎版本及 CUDA86 构建对应；WSL 的每进程显存统计显示 N/A。默认日志未打印逐层 offload 数量，因此不把构建配置当作逐层实测。`remote-ssh-detach.json` 证明之前启动/测试 SSH 退出后，相同 supervisor/backend/gateway PID 仍存活且健康；没有测试整个 WSL 重启。

Windows 隧道进程 PID8984，精确命令在 `remote-tunnel.json`，本机 `127.0.0.1:18792/health` 已由当前家里 WSL 实际请求成功。启动和探测 SSH 连接关闭后，该隧道与远端服务仍运行。

`remote-lifecycle-1.json` 验证正常 stop 使原 supervisor/backend/gateway 三进程全部退出；哈希期间启动的 supervisor144201 也能立即 stop，尚无模型子进程，PID 文件清理；正常重启后同模型服务恢复健康，新的 supervisor/backend/gateway 为144210/144212/144213。早期 PID/信号登记、分块哈希取消检查已实现。没有测试 supervisor 的 SIGKILL 恢复；强杀监督进程不保证子进程回收，不把正常 stop 验证外推为这一场景。

负责人 `home-probe-1` 的三张真实游戏截图单图 2.37–2.85 秒，目标栏均误判不存在，关闭背包有两次未知；接口/schema/hash/视频成功不能算游戏识别通过。三帧 MP4 约1.75秒，背包顺序正确。原错误保留，后续 prompt 对照由负责人单独记录，当前不自动据此执行游戏动作。

首次服务启动曾在私有凭据创建阶段遇到 `Path.open(opener=...)` TypeError，尚未启动子进程；改用标准 `open` 后恢复。该事实在 `remote-first-start-failure.json` 记录；后续监督日志追加保留。原始下载读超时、分段恢复和最终全 SHA 记录仍在目标 `logs/`，没有改写为一次成功。

负责人补充对照：位置假设修正后完整7字段仍有unknown置信度格式错误，严格拒绝；精简5字段3张游戏图的15个标注值均正确，单图1.60–1.91秒，输出53token。两类任务内容不同，不能归为引擎加速或长期准确率。完整记录及体验命令见 [验收记录](acceptance/vision-service.md)。
