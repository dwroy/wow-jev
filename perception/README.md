# 低频 Seed 与离线校准

高频截图与局部 CV 留在 Windows。此目录只提供串行模型 worker、版本化 prompt 和结果格式；不发送任何键鼠输入。

## Seed worker

```bash
python -m perception.seed_worker --serve
```

默认 `disabled`：不读取图片或凭据，不进行网络调用。运行层只有在具备对应游戏图上传授权时才传 `--allow-game-image-upload`。凭据在第一次有效 JPEG 请求时从 `~/.config/wow-jev/api.env` 懒读取，路径可用 `--env-file` 指定；仅接受指定的 `doubao-seed-2-0-mini-260428` 模型配置。不安装 OpenAI SDK。

输入 JSONL：

```json
{"id":"look-1","op":"look","image_path":"/绝对/本地/截图.jpg","prompt_version":"eye-retail-v1"}
```

输出以 [seed-result-v1.schema.json](schemas/seed-result-v1.schema.json) 为唯一格式来源。成功必须提供完整七字段；`disabled/failed` 的 `fields` 为空且有原因。每个结果带 prompt SHA、版本、模型和 token 用量。`raw_text` 保留有界的 assistant 原文，即使模型 JSON 无法解析也保留安全原文；不保存 HTTP头、错误 body、凭据、图片 data URL 或长 base64 回显。

模型正文必须符合 [model-eye-retail-v1.schema.json](schemas/model-eye-retail-v1.schema.json)，不补括号、不提取 Markdown 内片段、不修复类型。重复键、额外字段、bool 等级、不明确目标被转换成 false、未知值非 null 均拒绝。`known` 是模型提供了一项观察，不表示结果已经核实；置信度也没有当作校准准确率。血量百分比不交给模型估算。

[eye-retail-v1.txt](prompts/eye-retail-v1.txt) 将游戏画面中的文本限定为观察数据。只问头像框名字与等级、明确目标框、明确战斗标识、可见背包窗口和简短场景；看不清或没有明确标识就输出 unknown。

传输使用标准库 HTTPS，一次非流式 Chat 请求，固定官方主机和路径，不跟随重定向或重试。[方舟 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh) 与[图片理解文档](https://docs.volcengine.com/docs/ark/image-understanding?lang=zh)提供对应接口格式。`--timeout` 必须大于0且不超过15秒，默认15秒。

外层 deadline 到期后会关闭已建立的 socket，返回失败并拒绝后续上传，避免尚未结束的旧请求与新请求重叠。DNS/TLS连接若无法及时中断，其 daemon 线程返回连接后先检查取消状态，不继续 POST；worker应重启再调用。错误只输出稳定码，不打印异常原文。图片限定绝对路径、本地常规 JPEG、最多8MiB和16M像素；原文16KiB、HTTP成功 body 64KiB、stdout行64KiB。

结果完成时间只用于耗时记录。字段的采集时间、来源观察与 artifact 身份由调用方绑定到原始截图，不得用 Seed 完成时间刷新状态。

## ROI 校准工具

```bash
python tools/eye_calibrate.py \
  --open-image /绝对/背包打开截图.jpg \
  --closed-image /绝对/背包关闭截图.jpg \
  --roi 1740,1413,235,36 \
  --out-dir /绝对/新的校准目录 \
  --id inventory-retail-v1
```

工具离线读取 PNG/JPEG，不上传图像。同尺寸截图裁切显式客户区 ROI，RGB像素保持原值，不缩放、模糊或修改颜色。生成 `open.png`、`closed.png` 和 `calibration.json`，provenance 中的 SHA256 对完整来源图片字节计算。

`max_distance` 默认0.12、`min_margin` 默认0.04，可分别配置；两者都必须大于0且不超过1。模板间归一化RGB平均绝对距离若小于 min_margin，会拒绝这组校准。ROI须为严格整数并在客户区内，bool、浮点、尺寸不一致均拒绝。输出目录必须是不存在的绝对路径，防止覆盖已有校准。

上述 ROI 只适用于对应2048×1536布局示例。其他尺寸或界面布局应重新选定区域并校准，不能强制缩放匹配。工具不自动推断哪张图是打开或关闭；这些标签来自实际操作记录与人工核对。能分离两张来源模板也不等于在不同场景下已经验证。

## 离线验证

```bash
python -m pytest -q tests/test_seed_worker.py tests/test_eye_calibrate.py
```

测试只使用合成图片、临时假凭据和 mock transport，另有真实子进程的默认禁用模式检查。真实游戏识别质量、模型延迟和窗口布局泛化由负责人另行验收；这些测试不调用真实 API。
