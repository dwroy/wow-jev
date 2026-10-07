# 原生 UI 识别与反射资格

2026-10-07 最新授权取消人工预审前置：self/Seed 可自主采纳和执行，active 由
独立后图、全状态负例、至少两次跨 run 确认、最近成功率等客观条件决定；用户
撤销仍生效，self 不能绕过。

本模块只读取当前像素。识别结果、代码反射资格和输入效果分别记录；没有
Native 回执及独立后图时不会生成游戏成功证据。

`Load(canonical, sha)` 校验快照并识别候选，永不授予 `active_qualified`。
`LoadVerified(canonical, sha, negativeCanonical, negativeSha)` 还核验 DB 导出的
完整负例 sidecar：

- sidecar 原字节 SHA、协议、原知识 SHA、算法与完整 corpus 原字节 SHA；
- 该技能的 scope/state/immutable signature SHA、原正例和其它全部已知状态
  的每个源图 SHA；每个负例恰出现一次、实际比较为不匹配且通过；
- 客观确认历史（至少两次、至少两个 run、最近 issued/released 尝试成功率 ≥80%）、
  没有用户撤销、无冻结，以及所有比较状态的模板已装入（pending/self/Seed 模板可识别当前像素，识别不授予 active；多个状态匹配为歧义）；
- `source_skill_canonical/source_skill_sha256`、
  `signature_original_canonical` 原字节 SHA；逐项比原 RGB、阈值、bbox、anchors、
  element/action、review、modal guard。compact 不能保留旧 SHA 却替换素材；
- self/Seed 来源可以客观晋升，不再要求人工报告批准；报告只做抽查与撤销追溯。
  当前支持的反射算法为 RGB32×16 加独立 anchor。共享 logo 单独一块、不支持
  的派生算法、固定 NPC 元素、缺模态 guard 都保持慢路。NPC 另走当帧定位方法。

compact 使用 `source_knowledge_sha` 绑定原 DB 快照；sample 输出
`source_knowledge_sha256`，二者是不同消息中的字段名。sidecar 的
`snapshot_sha256` 总是原 DB canonical SHA。主 canonical、sidecar 各有限
262144 字符，Host/Relay 控制请求整行有限 1 Mi 字符；握手、回复与旧输入协议
继续各自的边界。超过边界明确拒绝，不缩减负例 corpus。

原生结果提供 `recognition_status`、`confidence_basis='match_margin_v1'`、
`match_margin`、`route_eligibility`、`modal`、各匹配的 `active_qualified` 与
`eligibility_reason`。confidence 是匹配裕度，不是模型概率：正距离为所有
特征的最大归一化误差，接受阈值是 1；confidence 是正裕度乘最近其它状态的
距离间隔（最多 1）。边界或其它状态也匹配时退慢路，不能补写恒定 0.95。
代码反射还要求正距离小于 1、其它状态距离大于 1、间隔至少 0.05。

硬停止模板不受审批状态、名字或 state 标签过滤。只要当前实际模板及 anchors
匹配就输出 hard stop；改名不会绕过。单条无效签名隔离并报告，其它条目继续
识别。旧通用 `in_world` 教程签名只供对比，不识别通用世界状态，后续须独立
世界识别方法；它不会输出“与吉安娜交谈”作为通用进世界证明。

Host 接收可选 `intent.ui_skill={skill_id,route,knowledge_sha256}`，route 只能
`reflex` 或 `slow_path`。反射时核当前技能、知识、active 资格、模态 clear、
实际状态裕度，以及同一已绑定 primitive。UI 鼠标只能原 element 当前布局的
有限点击，ESC/ENTER 键技能不授予鼠标输入；换点、换键或时长拒绝。慢路也要
当前唯一匹配该技能。缺此 tag 的旧普通/人工路径保留既有有限输入闸，不计作
受治理的原生反射。焦点、源时效、窗口身份、取消、释放与看门狗仍由原本执行
路径检查。

## 已知场景的模态检查范围

`neutral_panel_components_v1` 在当前完整客户区的 8×8 tile 内每 2 像素取样，
找中性色、低纹理、较大的居中矩形组件（暗面板和亮面板均检查）。完整算法串
及 SHA 在 `UiSkillVision.ModalAlgorithm` / `ModalAlgorithmSha()`；当前 SHA：
`3abbcfc4623027b9d89e1745259e350c80a2fde1b2851a03a4c2dd0e13a3f55c`。

guard 本体由源 PNG 与模态反例建立。review 可选，若有只记录来源，不授予资格：

```json
{
  "method":"neutral_panel_components_v1",
  "algorithm_sha256":"<固定算法 SHA>",
  "source_capture_sha256":"<原签名 PNG SHA>",
  "expected_panels":[{"x":0.3,"y":0.3,"width":0.4,"height":0.3}],
  "negative_artifacts":[{"path":"<独立原 PNG>","sha256":"<原件 SHA>"}],
  "review":{"status":"approved","reviewer":"self","report_sha256":null}
}
```

actual panels 必须与原参考的 expected panels 逐一匹配 IoU≥0.85；新增、
缺失、扩张或歧义面板输出 present。没有 guard 记 unsupported/unknown。证据
绑定当前完整 ROI 的真实 SHA、知识校准 SHA、frame/QPC/layout，不依赖全动画
背景的 exact RGB。

这不是通用模态消失证明：小面板、彩色/高纹理/透明面板或客户端边缘面板不在
该启发式可靠范围。每个场景需独立原图正反例与客观验收；未经场景验收只能
慢路。RGB signature 遮盖也会令场景 unknown。没有实际画面验收，不报告所有
模态都可检测或已经达到零模型反射。

## 离线验证

```bash
bash tools/ui_skill_governance_build.sh
out/acceptance/native-governance/UiSkillGovernanceFixture.exe
```

2026-10-07 的 31 项纯合成故障测试通过，覆盖完整/缺失/失败的负例、self客观采纳、用户撤销、
冻结、素材/动作/guard 替换、未知明暗模态、匹配裕度、改名硬停、坏条目隔离、
固定 NPC 与 primitive 绑定等边界。另有保存图 locator 8 项回归及完整
WinInput/Watchdog/ResidentHost/Relay 编译通过。fixture 元数据是显式离线输入，
不证明真实 DB 活跃资格、Windows 桌面、真实动作、游戏效果或实测延迟；本轮
该治理模块没有运行桌面/API/模型/实际数据库或发送输入。
