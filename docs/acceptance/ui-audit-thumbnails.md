# UI 审计 HTML 缩略图验收

2026-10-07，基线 `331eea4`，独立工作树 `.worktrees/ui-audit-thumbnails`。

HTML 使用 SHA 核验过的原 PNG 生成 RGB JPEG 预览，长边最多 640 像素，quality 78；原图不修改，原图路径、SHA 和链接保留。输入元素框仍使用原始归一化坐标，在缩略图容器内按宽高分别映射。JPEG 有损压缩用于浏览；精确像素审核应打开原 PNG。

新 HTML 名称为 `ui-skill-audit-<报告SHA>.thumb-v2.html`，与旧 `.html` 分开；同版本文件已存在且字节不同时拒绝覆盖。JSON 原证据逐字节复制并保留原 SHA。渲染过程只在单次调用中缓存同一原图的缩略图；下一次调用重新核验原图 SHA。

已有报告的离线入口如下，不打开 `agent.sqlite`：

```bash
.venv/bin/python -B -m game_database.ui_skill_audit \
  --report out/acceptance/ui-skill-learning-20261007/audit-report/ui-skill-audit-b2ff1380b4e4d4e55ba0b1328a690f43cc11f722213e346379e84ec7787147d2.json \
  --report-sha256 b2ff1380b4e4d4e55ba0b1328a690f43cc11f722213e346379e84ec7787147d2 \
  --out out/acceptance/ui-skill-learning-20261007/audit-report-thumbnails-v2
```

原 `--database <agent.sqlite> --out <目录>` 入口继续以只读连接生成当前报告；两种来源互斥。输出返回 `html_bytes`、`html_sha256`、`render_version` 和缩略图参数。原图链接采用相对输出目录的路径，HTML 与项目目录关系应保持不变。

真实报告 SHA `b2ff1380b4e4d4e55ba0b1328a690f43cc11f722213e346379e84ec7787147d2` 的结果：

| 项目 | 实测 |
| --- | --- |
| 旧 HTML | 199,711,810 字节 |
| 新 HTML | **6,986,882 字节**（6.986882 MB，6.663210 MiB） |
| 体积减少 | 96.5015% |
| 原 JSON | 241,834 字节，复制前后逐字节一致 |
| 保留内容 | 16 个技能、84 条负例、9 次尝试、全部审核链及隔离记录 |
| 图像与原图链接 | 151 张 JPEG，长边均 ≤640；151 个链接均指向存在的原件 |
| 新 HTML SHA | `8cd7eb395689a0d4eff7c909056171b941498c2137d731570d3a71356466c2cb` |
| 旧 HTML SHA | `c687ca6b7a29bc219eb44301b50e5a08581a7e187fe1d81ce0b5440e979e4127` |

新文件在主 checkout `out/acceptance/ui-skill-learning-20261007/audit-report-thumbnails-v2/`。旧 HTML 与 JSON 保留在原 `audit-report/`；没有更新治理数据、观察时间或资格状态。

专项执行 `tests/test_ui_skill_audit_html.py` 与 `tests/test_ui_skill_audit.py`：**27 passed，9.43s**。覆盖 JPEG 尺寸及来源 SHA、缩略框映射、带空格原图链接、完整负例/尝试/审核链、原 JSON 和旧 HTML 保留、同版本不可覆盖及跨调用原图篡改拒绝。专项日志与实际尺寸核验在独立树 `out/acceptance/ui-audit-thumbnails/{critical-tests.log,real-report-render.json,real-report-size-check.json}`。本步骤离线渲染现有 JSON，游戏输入和模型调用均为 0。
