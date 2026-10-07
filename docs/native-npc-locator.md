# 当前帧 NPC 定位

`UiSkillVision.LocateNpc(currentBgra, width, height, nameMask, maskWidth,
maskHeight, exactName)` 在当前完整客户区寻找绿色姓名板，再从姓名板下方的黄色
轮廓两侧导出身体内侧落点。原参考图只提供字形与样本，不提供输入坐标。多个
姓名板、缺少黄色轮廓、遮挡或错字形均返回 `unknown`。

此最小实现仅允许审核过的 `tutorial_talk_jaina` 候选；不是技能晋升或通用 NPC
跟踪验收。绿色字形沿用 v3 的既有阈值，RGB 指令和身体色彩阈值均保持原值。
源和新帧的显著行起点采用同一规则，排除姓名板周围零散海水绿色像素对定位
原点的影响。黄色两侧轮廓可以不连通；只有高度重合、横向靠近且处于唯一
姓名板下方的轮廓才合并，落点需要两侧黄色边界且其 5×5 内侧无黄色边界。

知识签名可显式加入：

```json
{"npc_locator":{"method":"current_nameplate_yellow_outline_v1",
"name":"吉安娜·普罗德摩尔","anchor_index":1}}
```

要求 `feature_policy` 为 `talk` / `talk_jaina_layered`，正式服且审核通过，主
签名为 `chroma_surface_v1`、该姓名板 anchor 为 `green_glyph_tolerant_v3`，另有
独立 RGB 指令 anchor；所有特征均要当前匹配。`Regions` 增加一块
`learned-ui-npc-current-view` 完整客户区内存 ROI。原姓名板位置用于样本相对
位移，主色彩 patch 随当前姓名板位移；动作点由当前黄色轮廓计算。

宿主调用 `Match(rois, regions, scope, memoryFrame)`，输出 match 的
`current_point`、`current_rect` 与 `location`。`location` 包含当前
`frame_id/source_qpc_ms/layout_id`、该完整 ROI 的真实 SHA、知识校准 SHA、姓名板
当前矩形和完整字形分数。没有 memoryFrame 的旧调用不会产生动态候选。
输入消费者应独立核对上述身份和 ROI、有限动作及统一执行闸；感知不发送输入。

纯离线入口：

```bash
bash tools/npc_locator_build.sh
out/acceptance/native-governance/locator/NpcLocatorFixture.exe SOURCE.png LIVE.png 1723 414 373 52 --checks
# Load → Regions → Match（保存的快照、保存的图与对应 frame DTO）
out/acceptance/native-governance/locator/NpcLocatorFixture.exe --match SNAPSHOT.json LIVE.png MEMORY_FRAME.json
```

2026-10-07 保存的 `jaina-orient-07/frame-3-evidence-12.png` 与
`jaina-talk-03/frame-1-evidence-3.png` 验证了独立姿势的新帧、整体平移正例，以及
缺姓名板、缺黄色轮廓、遮挡、重复目标和错字形五类反例，共 8 项通过。
完整生产 Match 保存图验证的身体 TV 为 0.025390625，指令 RGB 平均误差
1.990234375，姓名板原 IoU 0.6982935、双向覆盖 0.9728；当前身体点为
`(1874,625)`。这些数字仅描述保存图测试，不是当前游戏输入授权、效果确认、
真实延迟或 active 反射资格。全已知状态负例、匹配裕度置信度、未知模态和
晋升 sidecar 验收仍由独立治理阶段完成。
