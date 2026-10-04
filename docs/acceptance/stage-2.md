# 第 2 阶段：眼、状态与日志

2026-10-04：负责人验收通过，完成本地集成。体验入口见 [眼运行时](../eye-runtime.md)。

## 交付

- Windows常驻 `WinEye`：只截绑定客户区，检查HWND/PID/尺寸/可见性，输出原生QPC与采集状态。本地CV测背包开闭与帧变化；高频原图留Windows内存。
- 显式低频UNC导出：WSL实际读取JPEG后核SHA，存只读副本。单纯wslpath转换不足以证明文件可读。
- Python Seed：默认disabled，显式启用和上传开关后异步识别游戏图。固定模型、有限超时、严格字段与JSON边界；不记录凭据。
- TypeScript统一状态：未知/不可用/false分开；保留源观察、截图、代码/prompt/schema/校准/配置版本与输入关联。模型结果以源图时间计算时效，迟到结果不能伪装新观察。
- 录制有限动作与离线回放：输入执行/释放与游戏效果分别记录；回放重建状态并核原始CV、前后图及唯一动作链接，不启动原生程序或模型。

## 负责人真实验收

| 检查 | 实际结果与边界 |
| --- | --- |
| 历史正式服CV | 2张校准来源、9张独立检查，共11/11分类正确；不是独立11样本准确率 |
| 反例 | 无校准unavailable；布局变化unknown、黑/均匀帧unavailable、分差不足/缺失ROI unknown；坏校准拒绝 |
| 只读文件桥 | 非激活合成窗口及正式服均在WSL实际读JPEG/SHA一致；save=false不新增导出 |
| 生命周期 | 合成窗口与原生眼EOF exit0，Windows精确PID消失；正式服采样EOF正常退出；本轮最终Windows进程查询WinEye/WinInput/Watchdog均0 |
| 正式服录制 | HWND 0x6407cc、PID6932、客户区2048×1536；6次B100ms分别2/2事件、released、effect confirmed；每轮回放通过，最终背包恢复关闭 |
| 异步Seed | 10秒观察72个CV样本、4次真实Seed成功结果，约1.85–2.30秒/次；模型期间CV持续采样，背包模型读数因更新的CV证据被拒绝覆盖 |
| 回放反例 | 删除action_link并重排seq、伪造post观察但保留原始CV均拒绝；模拟测试另覆盖截图哈希篡改 |

初期真实只读采样在Windows本地生成JPEG，但转为/mnt/c路径后WSL不可读；native-run1保留该失败。增加显式导出后native-run2遇游戏最小化失败；native-run3最终全通过。失败记录不覆写。

## 回归

- C#5/.NET4原生程序实际编译通过；native-eye schema以Ajv strict模式编译及验证。
- Python：`python -m pytest -q tests/test_eye_calibrate.py tests/test_seed_worker.py`，42 passed，exit0。
- TypeScript：`npm --prefix agent run typecheck` 与 `npm --prefix agent test`，54/54 passed、0 skipped，均exit0；完整stdout/stderr及tested-binaries已归档于 `verification`。
- 运行时反例覆盖来源过期/乱序、false保持known、未观测字段不刷新时效、手眼错绑/条件过期零发送、已释放输入的UI确认、未知输入计数null、post捕获失败仍关联、异步Seed与慢文件复制的观察提交顺序、样本重复seq及超时。

## 证据与版本

原始产物在主checkout `out/acceptance/stage-2/`：

- `calibration/retail-bag-v1`：ROI (1740,1413,235,36)，2048×1536，两个原图SHA与无修改PNG模板。
- `native-run1`、`native-run2`、`native-run3`：离线/真实/合成反例、原生JSONL与最终 `live-first.jpg`；native-run3真实请求约89/35/32ms。
- `passive-fixture`：非激活测试窗口，JSONL、driver.py、summary.json；前台HWND前后相同。实际验证EOF关闭，不外推15秒计时自动关闭已实测。
- `seed-live-api`：初次两张历史游戏图的模型原文和结构化结果，约2.1/2.9秒；只发送游戏图。
- `game-run1`：每次录制的manifest、events.jsonl、只读截图、schema/校准快照、stdout/stderr和总summary。包含6个动作run、一个异步模型run、两个篡改副本。

核心实现提交包括 ef2fc9f、fe67ef9（协议与未知输入计数），52eacce（原生眼），a8a4d83（Seed/校准），4371e33（被动夹具），ae499a5（状态/录制/回放）。实际测试代码与原生exe的完整哈希见各run的manifest；当时文档/验收脚本尚未提交，dirty标记如实保留。

## 实际限制

背包自动效果确认仅覆盖本次布局；移动、跳跃、镜头等仍只记录输入，自动效果unknown，留待第3阶段。窗口布局变化需要重校准。没有验证整个WSL发行版重启。

Seed在4次当前画面识别中，第3次漏看实际存在的目标栏（源图native seq46），错误原文与采纳记录完整保留。目标/战斗字段属于模型读数，目前不作为执行条件；战斗状态也未独立核实。相似度及模型自报confidence不代表准确率。当前学习、大脑与Jev未接入。

Windows QPC与WSL时钟不直接相减；字段captured_at使用请求下界，区间上界为接收时间。无法确认输入计数时用failed + counts_status:unknown + null/null，不能声称0次输入。
