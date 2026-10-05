# Jev 小脑入口

Jev 在当前目标下，从本地生成的有限候选里选择一个 ID。选择回来后，协调器重新采样并重建候选；目标、窗口、尺寸、字段来源或条件变化时改为等待。通过复核的单步计划交给 CodePlay，继续经过统一执行闸和 Windows 手。

这是第4阶段的工程入口。当前4K战斗 CV 和有限正式服 Jev 动作仍待验收，不能据此认为自动打怪或任务大脑已可用。

## 先体验纯模拟

在 WSL 仓库根目录运行：

```bash
cd /home/dai/Projects/wow-jev
npm --prefix agent run jev -- demo --decisions 5
```

默认模拟活目标，生成短前进、左右转向和等待候选；确定的模拟选择器依次选出4个动作和1次等待。程序不启动 Windows、模型或凭据读取。输出 run_dir 和 session_id；最后的真实输入数量为0，游戏效果确认数量也为0。

```bash
npm --prefix agent run jev -- replay --run-dir /absolute/run_dir
```

回放重新计算候选、校验选择和复核来源，再从已批准候选推导单步计划。不能用修改日志中的计划或模型答案来增加动作。

## 只读游戏观察

先列出当前游戏 HWND/PID，每次重启后重新枚举：

```bash
npm --prefix agent run input -- list
npm --prefix agent run jev -- observe --window 0xHWND --pid PID --decisions 3
```

observe 只截图、选择和等待，不启动输入执行器。默认模型关闭；以下开关启用已获授权的 WoW 客户区图上传：

```bash
npm --prefix agent run jev -- observe --window 0xHWND --pid PID --decisions 3 --seed --allow-game-image-upload
```

观察目标只产生 wait，所以该模式适合验证 Windows/WSL 截图、Seed 选择协议和日志关联。它不能验证移动选择或动作效果。可附加 `--calibration FILE` 和 `--combat-calibration FILE`；程序先冻结模板，再让 Windows 使用冻结副本。当前4K背包校准只覆盖B同时开闭全部背包；2048战斗模板在4K会返回 unknown。

## 有限练习

live 必须明确 `--live --role-scene-confirmed --goal FILE --combat-calibration FILE`。goal JSON 必须完整：

```json
{
  "id": "practice-target",
  "revision": 1,
  "description": "在指定目标附近练习短移动和转向",
  "mode": "practice",
  "allow_movement": true,
  "allowed_action_slots": [],
  "target_signature": "当前校准CV输出的64位小写SHA256"
}
```

上面的签名是占位说明，需替换为当前 CV 的实际值。没有匹配签名，或者 capture/focus/target.present/target.dead/target.signature/player.in_combat 任一条件不可靠，只能等待。签名由目标名称黄色字形得到，不是游戏 GUID；同名目标可能相同，不能证明仍是同一个实体。

```bash
npm --prefix agent run jev -- live --window 0xHWND --pid PID --live --role-scene-confirmed --goal /absolute/goal.json --combat-calibration /absolute/calibration.json --seed --allow-game-image-upload --decisions 5
```

候选限定为E前进100ms、右键拖动±40物理像素/200ms、显式许可且已配置的技能槽100ms，或等待250ms。默认技能槽映射为空；现有角色为ESDF，不能把W/A作为默认移动。不会推断敌我、距离、朝向或技能就绪。这里的“前进”也不保证一定接近目标。

默认5次决策，最多20次；整轮默认60秒、最多120秒。模型单次最多15秒，观察最多750ms；模型回答的源图自然可能过期，因此输入前必需重新采样。Seed迟到、格式失败或候选失效会等待。输入事件完成和实际效果分别记录；当前运动效果仍 unknown。

live 会启动绑定窗口的 Windows 输入会话，即使最终只等待也不会产生输入。程序只等待用户手动聚焦，不抢焦点；焦点等待期间按 Ctrl+C 会取消，正在进行的枚举最多约2秒超时。

## 状态和取消

用启动时输出的 session_id，从另一个 WSL 终端执行：

```bash
npm --prefix agent run jev -- status --session-id UUID
npm --prefix agent run jev -- cancel --session-id UUID
```

取消作用于整轮决策，关闭选择 worker，并取消当前 CodePlay 或释放 Windows 手。之后的迟到截图或模型答案不能再执行。等待步骤不生成 ActionIntent/输入回执；取消等待能立即结束。释放没有得到 ACK 时保持 unconfirmed，不能报告成功释放。

## 证据

日志在 out/jev，包含冻结 schema、Jev prompt、配置、代码/原生程序指纹、截图、候选哈希、原始回复、重新采样结果、决策关联的计划/意图/回执和后续观察。`actor=jev` 的动作必须有 decision_id。

运行中的日志只是追加。异步记录失败会锁存取消并释放；失败发生时可能已有一次有限输入发出，该轮不能被报告为完整成功。固定样例、真实 Seed 离线 probe、模拟、原生 mock 和正式服实测的范围分别记录在 [acceptance/stage-4.md](acceptance/stage-4.md)。
