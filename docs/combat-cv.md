# 校准战斗 UI CV 与目标上下文

本模块只读客户区像素，不发送输入、不修改焦点、不读取模型凭据。`WinEye classify` 是本地图片离线分类；不能把其结果当作当前游戏观察。

## 接口

`wow-eye` v1 的 `detectors` 保留必需 `inventory_open`，新增可选 `target_present`、`target_dead`、`player_in_combat` 和 `target_signature`。前三项 known 的 value 是 bool，签名是64位小写 SHA256。其余状态 value 为 null。新原生程序总输出新增字段；旧日志缺字段时保持原状态重建行为。

有校准的字段保留 calibration_id，尺寸不符返回 unknown，捕获失败返回 unavailable。`target_dead` 和 `target_signature` 只有同一源图中的 target_present known=true 时才允许 known。无校准的 unavailable/null-id 不阻断原有只读 Seed 观察；执行器应要求新鲜且当前校准的 CV。

状态映射为 `target.present`、`target.dead`、`player.in_combat`、`target.signature`。源时间仍取协调器捕获区间开始值，并保留 Windows QPC、来源 observation 和可用截图 artifact。CV 启用后 known、unknown、unavailable 都不能被 Seed 覆盖。

目标签名是名称区域的黄色字形 mask SHA，不是 GUID。血条变化不会直接成为签名的一部分；相同外观、同名目标仍可能共享签名，遮挡、文字颜色变化或 JPEG 差异也可能造成保守失效。不能据此证明持续追踪同一实体。

`EyeState.seedSourceContext()` 返回可选 `target_context:{epoch,signature,status,present}`，由调用方在请求源图时冻结到 SourceImage。目标变化、无目标、签名 unknown、窗口/尺寸改变、失图会立即清空既有 Seed 目标字段。迟到的 target.* 模型结果需要来源 context 与当前匹配，且双方 present 和 signature 均 known；其它角色字段仍按各自源时效融合。

## 校准

背包参数仍为 `--calibration`；战斗 bundle 独立使用 `--combat-calibration`。运行时应传日志冻结的 bundle 路径。NativeEyeClient 新选项为 `combatCalibrationWindowsPath`。

校准 spec 是严格 JSON：version=1、id、detectors，以及可选 signature。每个 detector 设置 roi 对象和 positive/negative 各1..16个绝对源图路径，允许 max_distance/min_margin（默认0.12/0.04）。所有源图尺寸相同。目标死亡或签名配置依赖目标存在配置。

```json
{
  "version": 1,
  "id": "my-layout-combat-v1",
  "detectors": {
    "target_present": {
      "roi": {"x": 1505, "y": 1071, "width": 6, "height": 43},
      "positive": ["/absolute/path/target-visible.jpg"],
      "negative": ["/absolute/path/no-target.jpg"],
      "max_distance": 0.12,
      "min_margin": 0.04
    }
  },
  "signature": {
    "roi": {"x": 1545, "y": 1046, "width": 150, "height": 23},
    "mask": "yellow-mask-v1",
    "min_ink_pixels": 8
  }
}
```

上述坐标仅是2048×1536既有 UI 的示例，不能直接用于4K。必须选明确标注的正负例，分别覆盖战斗/非战斗、存活/死亡、遮挡、无目标和不同目标框。

```bash
python -m tools.combat_calibrate --spec /absolute/spec.json --out-dir /absolute/new-bundle
```

输出 `calibration.json` 固定 version/kind/id/客户区尺寸，每个 detector 有 roi、thresholds 和 templates.positive/negative。各模板条目为 `{file,sha256,source_sha256}`，PNG 是原图 ROI 的原样 RGB。Native 校验 basename、模板尺寸与 SHA、类间可分性。模板距离超限或 margin 不足返回 unknown；不会拿最接近类强行分类。

离线比较命令见 `python -m tools.combat_cv_evaluate --help`。输出同时报告全部图和未使用为模板的事件组，unknown 纳入覆盖率和已知标签召回率。

## 当前证据与限制

2026-10-05 的源数据沿用 `out/acceptance/vision-evaluation` 中46张真实图及两名 agent 盲标后的冻结标签，不是用户确认的人类金标准。模板来自 combat-01/02 共20张图对应的事件组；其它8个组共26张未用于模板。初轮 v1 原始结果完整保留；死亡检测在两个训练组边界图上输出不应有的 known=false，于是 v2 仅根据训练组收紧 max_distance=0.02、min_margin=0.06。

| 字段 | 全部46图 | 未用作模板的26图 |
| --- | --- | --- |
| target.present | 42 known正确、4 unknown；覆盖91.3% | 22 known正确、4 unknown；覆盖84.6% |
| player.in_combat | 46 known正确；覆盖100% | 26 known正确；覆盖100% |
| target.dead | 11 known正确、35 unknown；21个已知标签召回52.4% | 2 known正确、24 unknown；10个已知标签召回20% |

v2 没有观察到错误 known/原 unknown 标签被提升为 known，但死亡覆盖率不足。不能将42/42的条件准确率写成46/46总体通过，不能据此声称达到此前95%完整门槛。未知边界需要补录，现有材料不能代表所有布局、悬停或面板遮挡。

完整证据在主 checkout `out/acceptance/stage-4/cv-1`。三张第3阶段真实4K图的离线兼容复核中，背包保持 known，所有战斗字段因尺寸不符返回 unknown 且保留校准 ID；没有把2048校准外推到当前4K。当前模块的验收范围为编译、协议/融合/校准边界测试、真实 Windows 离线分类和旧日志严格回放，未进行4K战斗在线验收。
