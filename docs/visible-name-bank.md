# 固定布局可见名字 bank

正式服目标名字 ROI 的逐帧黄色像素哈希会受 JPEG、抗锯齿与战斗闪光影响。`name-bank-v1` 用明确标注的名字模板识别可见 UI 名字类别；同类命中返回稳定 `target_signature`，同时返回 `target_name`。它不识别实体 GUID，不证明两个画面是同一只怪，不证明击杀归属。截断名字只登记实际可见文本，不补全后缀，不能直接当游戏数据库的 entity ID。

旧 `yellow-mask-v1` 校准与输出形状保留。只有明确配置 `name-bank-v1` 时才新增 `target_name`；没有 bank 不会推断名字。

`tools.combat_calibrate` 的 spec 中，`signature` 使用以下契约：

```json
{
  "roi": {"x": 2545, "y": 1571, "width": 175, "height": 30},
  "mask": "name-bank-v1",
  "pixel_mode": "yellow-glyph-v1",
  "min_ink_pixels": 64,
  "tile_width": 24,
  "thresholds": {"max_distance": 0.12, "max_local_distance": 0.25, "min_margin": 0.1},
  "names": [{"name": "实际可见名字", "sources": ["/绝对路径/已标注源图.jpg"]}],
  "reject_sources": ["/绝对路径/陌生名字或无目标源图.jpg"]
}
```

bank 必须依赖同一校准中的 `target_present`。要求 1–32 个不同显式名字，每类与拒绝类均有 1–16 张源图，所有源图客户区尺寸一致。同一源图不能同时作为两个名字或拒绝类。输出 bundle 将源图裁剪为 PNG，保存每张 PNG 与原始源图 SHA256；源图不在运行时读取。

输出 `signature.names[]` 为 `{name, signature, templates:[{file,sha256,source_sha256}]}`，`reject_sources` 改为 `reject_templates`。`signature` 精确等于 UTF-8 字节串 `wow-visible-name-v1`、一个 NUL 字节、显式名字的 SHA256。原生加载器重新计算并核对这个绑定，拒绝重复名字、类间不可分、文件路径越界、符号链接、损坏 SHA、错误 ROI 与不支持字段。

识别首先提取黄色字形，再用墨迹异或数 / 墨迹并集数计算距离。此距离不让大块空背景稀释不同名字。固定宽度列块还逐块检查局部字形距离，防止很长共同前缀掩盖一个陌生字。空白块仅在两边都没有墨迹时跳过；整个空白名字不能命中。全局与局部门槛都必须大于 0 且不超过 0.25。

只有墨迹足够、至少一个同类模板同时通过全局和局部距离、且对其他名字及拒绝类有足够 margin，才同时报告两个 known 字段。缺图、布局变化、目标未确认、陌生字形、歧义都返回 unknown/unavailable，不保留上一帧值。结果 reason.message 留下全局/局部/拒绝距离、margin 与墨迹数量，供复核。

相同可见字符串、相同截断前缀、或视觉上无法区分的陌生名字仍可能共享类别；视觉模板没有发现所有未知名字的数学保证。需要扩展名字库时，重新冻结训练与独立留出组，不能用留出样本调门槛。客户端版本、UI 布局与版本数据库 entity ID 应由运行配置独立绑定；不得把本类别哈希当跨版本实体主键。

验证入口（Windows 离线分类，不打开窗口、不发送输入、不调用模型）：

```bash
WOW_COMBAT_EYE_EXE=/绝对路径/WinEye.exe .venv/bin/python -m pytest -q \
  tests/test_name_bank.py tests/test_combat_calibrate.py tests/test_combat_native.py
```

相关测试包含同名像素扰动、可见名字切换、未登记名字、相似短名字 margin、长前缀中改变一个字形、无目标、布局与黑帧、bank 篡改，以及旧签名输出兼容。
