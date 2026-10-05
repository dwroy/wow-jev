# NPC 固定布局感知

更新：2026-10-05。`NpcVision.cs` 是 Windows 侧只读感知模块，`NpcClassify.cs` 是独立离线分类工具；没有模型调用、桌面截图或键鼠输入。

## 两类证据

`npc_dialog_open` 识别明确标注的 NPC 对话界面模板。已知 `true` 只说明该布局下匹配到对话 UI；是否是这次动作打开、是否属于期望 NPC、是否完成接/交任务，必须由同源目标、动作及后续观察关联确认。对话关闭不说明 NPC 超出交互距离。

`npc_in_interaction_range` 的被动校准只接受 `evidence_kind: "target-interaction-indicator"`：可见指示本身必须明确表示当前选中目标可交互或不可交互。配置必须绑定 `target_name` 和 `target_signature`，运行时要求同帧 CV `target_present=true`、名字和稳定模板签名均已知且完全匹配。来自模型、上一帧或先前目标的值不能传入该上下文。世界坐标中的人物大小、地图任务距离、技能施法距离、没有显示对话，都不属于这类证据。

目前尚未获得真实正反交互距离指示，实际校准只应配置对话检测器；距离保持 `unavailable`。屏幕上遗留的“距离过远”等错误文字未作为被动距离检测类型开放。交互探测路线可以在有限动作后确认新打开的对话；若没有打开，仍不能据此输出 `range=false`。未来加入错误提示时需要新鲜截图、具体动作及同一目标的关联记录，并作为动作结果证据处理。

## 校准和接入契约

源规格示例：

```json
{
  "version": 1,
  "id": "retail-npc-dialog-layout-1",
  "detectors": {
    "npc_dialog_open": {
      "roi": {"x": 30, "y": 220, "width": 590, "height": 860},
      "positive": ["/absolute/open-dialog.jpg"],
      "negative": ["/absolute/closed-dialog.jpg"],
      "max_distance": 0.12,
      "min_margin": 0.04
    }
  }
}
```

源图必须为有界本地 PNG/JPEG，尺寸一致；ROI 为严格整数，位于客户区，至多 1,000,000 像素。每类 1–16 张源图，模板原样截取；输出记录每张源图和 PNG 模板的 SHA256。两类不可分、未知配置字段、布尔数值、符号链接源图和已有输出目录都会拒绝。

```bash
.venv/bin/python -m tools.npc_calibrate --spec /absolute/spec.json --out-dir /absolute/bundle
bash tools/npc_fixture_build.sh
out/npc-tools/NpcClassify.exe "$(wslpath -w /absolute/frame.jpg)" "$(wslpath -w /absolute/bundle/calibration.json)"
```

离线工具参数为 `NpcClassify.exe <image> [<calibration> [<target-context-json>]]`，所有路径为 Windows 绝对路径。第三个参数仅供离线测试当前图像的 CV 上下文：

```json
{
  "target_present": {"status": "known", "value": true},
  "target_name": {"status": "known", "value": "明确原文 NPC 名字"},
  "target_signature": {"status": "known", "value": "稳定名字模板签名"}
}
```

在线接入使用 `new NpcCalibration(path).Detect(image, combatFields, captureFailure)`；`combatFields` 必须是相同 `Bitmap` 得到的原生 CV 结果。返回两个字段，每个字段都采用现有 CV 形状：`status/value/confidence/reason/calibration_id`。没有校准为 `unavailable`；错误尺寸、模板距离超限、分类 margin 不足、目标绑定不成立为 `unknown`；黑帧和明确 capture failure 为 `unavailable`。感知模块不保存目标上下文。

`WinEye.cs`、消息 schema、bundle 冻结和 TypeScript 状态接入由协调器统一处理。此分支没有修改它们。不能把离线工具传入的人工上下文当作真实在线 CV。

## 验证范围

新增 42 项测试已通过：19 项 Python 规格/来源校验和 23 项真实 Windows .NET 离线分类测试。覆盖目标名字/签名变化、目标不存在、目标字段未知、黑帧、遮挡、客户区尺寸变更、margin 边界、缺少 range 校准、对话关闭不推断范围、旧 kind/version、模板 SHA 改写、路径越界和无效模板。用来验证分类/拒绝机制的图片为人工构造，不能外推正式服准确率。

运行：

```bash
bash tools/npc_fixture_build.sh
WOW_NPC_CLASSIFY_EXE="$PWD/out/npc-tools/NpcClassify.exe" .venv/bin/python -m pytest tests/test_npc_calibrate.py tests/test_npc_native.py -q
```

后续需新的当前客户端 NPC 正负样本、布局/版本绑定、源图人工复核及事件组独立留出。历史 `quest-assist-1` 的任务辅助操作不等于 NPC 自动任务已验收。
