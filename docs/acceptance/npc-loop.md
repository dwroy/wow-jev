# NPC 小闭环现场验收

2026-10-05。用户目标是按已知攻略扫任务、打怪和拾取，以自主升级。当前先验收“已经选中且靠近 NPC → 有限互动 → 新截图确认对话”，尚未完成自主找路或升级。

## 本轮真实结果

通过已登录 Battle.net 的 `--exec=launch WoW` 启动正式服，以有限 Enter 进入角色。实际窗口 `0x1300668` / PID 28356，客户区 3840×2160，客户端版本 retail/midnight/12.1.0/69933/cn/zh_CN；窗口身份仅适用于本次进程，后续必须重新枚举。

负责人辅助选择“森德拉克斯”、执行短移动并采集打开/关闭对话。准备正图来自 G 后再执行 S 的过程，不证明单次 G 因果，更不算程序自主导航。准备操作与随后用户手动游戏分别记录。

`out/acceptance/npc-loop-1/automatic-local-1` 是实际自动入口，不调用模型。运行耗时 6949ms，目标名字/签名和关闭对话证据返回 unknown，执行大脑等待后以 `npc_target_evidence_unavailable` 停止。真实输入 0、效果确认 0、释放 confirmed，独立严格回放通过。它是保留的失败，不能称互动成功。

## 已定位的校准问题

同一捕获的原生日志与 SHA 校验后的落盘图、同一份冻结 v1 校准对照：

| 输入 | 字形墨迹数 | 全局字形距离 | 局部字形距离 | 名字结果 |
| --- | ---: | ---: | ---: | --- |
| 在线原 Bitmap | 555 | 0.196780 | 0.292683 | unknown |
| 同一帧 JPEG90 离线回读 | 456 | 0.032468 | 0.093750 | 森德拉克斯 |

WinEye 对原 Bitmap 做 CV，但落盘 JPEG90。压缩改变严格字形 mask，JPEG 模板自匹配不能证明在线原像素准确率。证据为 `out/acceptance/npc-loop-1/calibration-prep/compression-npc-same-capture-v1-evidence.json`。原 Bitmap 未落盘，不能声称恢复了其完整像素或逐像素压缩距离。

v2 收紧对话 ROI 到彩色头像并补充近处关闭背景，阈值和陌生字形限制不变。它在开发图离线通过；旧关闭留出已经明确转为 v2 训练，不能继续计算留出成绩。名字模板仍来自 JPEG，v2 尚未证明直播有效。下一轮要用真实 NPC 的无损图建模板，冻结后重新采集独立关闭/打开画面。

只读 WinSnap PNG 的文件名 `current-npc-lossless-1.png` 表示最初采集目的。实际截图时用户已离开 NPC、升级到12级并打怪；该图没有被作为 NPC 正例，也没有加入 NPC 模板。它的当前目标被名字库拒绝，combat=true，不能误报 NPC 身份。

## 运行方式与下一步

当前目标的固定程序可不调用模型：窗口截图 → 同帧 CV 检查目标、存活、战斗与对话 → 执行大脑批准代码步骤 → Windows 手执行一次 G 100ms 并释放 → 新观察验证同 NPC 对话 → 记录效果。按键回执只证明输入，不直接证明对话成功。

距离目前仍 unavailable，不从关闭对话或旧错误提示推导 range=false。`interact_npc` 最多一次有限探测；不能据此自动重复 G 或靠近。NPC 选择和导航、任务进度识别、战斗/拾取及按攻略组织任务路线仍需后续构建。

发现用户重新操作游戏后，负责人停止输入，仅采集 `manual-combat-readonly-1` 的30秒用户手动游戏：27次观察、26张图、0动作，Eye严格回放通过。独立标签复核另存该 run 的 `readonly-review/`；这不是自动打怪或自动升级证据。

只读复核取得1个新的4K死亡目标选择事件，未看到存活到死亡的新击杀。26张图中，target.present已知正确21、错误0、unknown5；player.in_combat已知正确26、错误0。target.dead只对真值已知20张计分：已知正确15、错误0、CV unknown5；另6张视觉unknown单列未评分。原统计把这6张遮蔽在CV unknown中，旧汇总保留，正确口径为`readonly-review/summary-v2.md`。全部15张连续死亡图只计1个事件，不是总体准确率或用户确认金标准。

无损存档支持和旧JPEG启动兼容已以34ff5e8/6d4fd96审查合入。agent完整266项TS、typecheck及6组Windows实际codec/配额通过；负责人重建主目录四原生模块并通过typecheck。实际PNG observe尝试未检测到可用WoW窗口，失败保留，不能称同帧游戏实测通过。300个必要产物及SHA归档在`out/acceptance/npc-loop-1/lossless-integration-1/implementation-artifacts.tar.gz`与manifest，工作树正常移除、分支保留。

下次只读校准入口加`--save --artifact-format png`，`system observe/live`也支持该格式；默认仍为JPEG，PNG暂不与Seed组合。NPC自动互动仍待新现场条件和真实无损模板，不能把本轮标为完成。
