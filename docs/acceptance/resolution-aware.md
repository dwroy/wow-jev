# 客户区锚定与 ROI 校准验收（2026-10-06）

本阶段移除了 `image.Width == 2560 && image.Height == 1440` 的识别门槛。2560×1440 只保留为两张已审核真实图的参考坐标系，不代表当前窗口必须使用该尺寸。`RecoveryCalibration.Match`、`RecoveryTutorialCv.Match` 保持兼容；恢复及 L3 可以复用同一套识别实现，不创建第二套特例。

## 坐标、UI 缩放与身份门槛

所有输入与输出坐标均为 **DPI-aware 的客户区物理像素**。选角卡使用客户区右边缘和垂直中心锚点；名字、职业及联盟徽记使用卡内相对坐标。字体、卡片和徽记使用一个等比尺度，不能沿 X/Y 独立拉伸。

教程提示使用底部中间 UI 锚点；NPC 名牌使用参考世界点的客户区归一化中心，字形尺寸使用独立 UI 等比尺度。名牌与提示必须分别匹配，绿色名字与灰色提示的 IoU 门槛仍 ≥0.90。名字“小啊”、职业战士、联盟徽记、选中卡必须全部通过原有独立像素阈值；没有降低名字/职业门槛，也不使用全图 OCR 文字推断选中角色。

当前有界 UI 候选是 `clientHeight / 1440 × {0.75, 1.0, 1.25, 1.5}`，实际尺度限 0.375–3.0。**尺寸只能提出候选，独立匹配才确认尺度**。多尺度同时通过、缺少 ROI、错误 ROI 原点、变形字形、阈值失败或未知渲染均返回未核验。有效几何边界为宽 640–7680、高 360–4320、宽高比 1–3.5；这是算法可尝试范围，不是所有这些尺寸均已完成游戏实测的承诺。当前实测/回归尺寸见下文，四个候选以外的 UI 缩放返回 unknown。

NPC 世界名牌的位置还受相机、FOV 和游戏渲染影响。不同宽高比离屏正例是从真实图重绘锚定 UI 布局，**不能证明真实游戏相机/FOV 已正确适配**。恢复/任务行为必须使用当前观察中的独立目标/提示证据；旧图只是模板，不能当作当前目标坐标或游戏效果。匹配失败时应通过新现场证据处理，不能自动认领一个相似名字或接受下一任务。

## 缓存与小 ROI 接口

`RecoveryCvProfile.DescribeRegions(width, height, fixedDirectory)` 初始化 JSON、模板 SHA 和模板像素/缩放副本，返回 `List<RecoveryCvRegion>`，每项包括 `Id` 和客户区物理像素 `Rectangle`。单尺度最多一个选角卡、两个教程 ROI；宿主可以合并重叠 ROI，但所有小图须来自同一源帧。

`MatchRegions(List<RecoveryCvFrameRegion>, width, height, fixedDirectory)` 返回 `selected_character` 和 `tutorial_interaction`。每个 frame region 保存原点 `Rectangle` 与对应小 `Bitmap`；尺寸必须一致。宿主从 WGC 内存帧只 staging 这些 ROI，不需要创建整个客户区 Bitmap。原 `Match(Bitmap, dir)` 是兼容包装，使用同一内部逻辑。

模板在进程生命周期内固定；变更 JSON/模板需重启宿主再做 hash 验证。热匹配不读 JSON/模板、不 hash、不加载 PNG、不用 GetPixel：小 ROI 使用 LockBits，字形 IoU 使用预载墨迹索引与积分图。返回的源 frame 身份、时间、截图 SHA 仍由宿主绑定；CV 本身没有截屏、焦点操作或输入权限。

## 离屏验证

Windows x64 Framework 编译成功；fixture **115/115**，游戏输入、桌面捕获、模型调用均为 0。

保留原来的全部 14 项检查，包括错误名字、名字仅 30 个像素变更、错误职业、错误联盟徽记、未选中行、错误 NPC、缺少任务提示、镜头横移、选角/世界互斥、空白小图拒绝。历史 `wrong_dimensions` 检查名保留，当前含义是拒绝空白小图；新增的真实缩放小图正例验证小尺寸本身不再构成拒绝理由。

新增回归覆盖：

- 两张真实完整截图等比重采样到 **1280×720、1920×1080**，正例通过；同尺寸错误名字/30像素变更/职业/阵营/卡/目标/提示负例通过。
- 真实 ROI 重绘到 **1600×1200、1920×800、1713×956**，每尺寸的 UI 因子 **0.75 / 1 / 1.25 / 1.5** 均独立匹配；错误名字、联盟徽记、目标及提示均拒绝。
- 直接非等比拉伸完整图片、超出有界 UI 候选、错误 ROI 原点及缺失 ROI 均拒绝。
- 当前实际断线截图作两个负例：不能认作已选中联盟战士，也不能认作世界内与吉安娜交谈。

真实模板源分别为主 `out/acceptance/exiles-first-task-20261006/foreground-restored-readonly-01/client.png`（SHA `4390bfd2ac283781d678bb06a342f056b51d34cb87d181b717f463aab8995069`）和 `interactive-readonly-03/client.png`（SHA `a38066a414ee46e31f9f4b6cbe18bab59a19e227bb60160578a33f53000e4a6f`）。未更改这些原件，也未把派生缩放图当作现场证据。

## 当前窗口只读取证与 DPI

主协调器的新只读取证在 `out/acceptance/layered-tutorial-20261006/layout-precheck-01/`，当前实际客户区仍为 **2560×1440 物理像素、DPI 144**，屏幕客户区 `(612,413)-(3172,1853)`，PID `22072`、HWND `0x904a6` 未变。新截图 SHA `0b249cf52d6dc0a9fb217deb8b0baf64276918b1695c36640a9962e604188657`；root 审核为断线 `WOW51900319`。此刻没有新的小尺寸游戏布局正例，不能把离屏 1713×956 回归报告为该尺寸现场实测。

用户提供的外框 `(401,245)-(2122,1242)` 很可能是 DPI 虚拟化逻辑坐标：1721×997 乘 1.5 后可容纳上述物理客户区及非客户边框。**这是推断**；当前物理尺寸结论来自原生 DPI-aware 客户区测量与截图。[微软 GetWindowRect 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)说明该 API 受 DPI 虚拟化影响，还包含不可见的 resize 边框；不能直接把外框逻辑尺寸送给物理像素 ROI。

新归一化代码还通过当前会话只读 `observe` 实际运行，原件位于主 `out/acceptance/layered-tutorial-20261006/stage-1/current-layout-observe/`：仍为 2560×1440 / DPI144，当前断线图的选角与教程检查均未匹配，0 输入。新截图 SHA `b07b0a6eeb8a4aab4f880d2e24eb1467589e67a56d4a53c56f71a8f74fe243a7`；此一次性冷宿主的完整 CV 区间为 1064.062ms（含模板初始化与该运行环境的文件读取），不是下表温热 ROI 数值，也不是端到端输入延迟。该临时 observe 任务已删除且回查不存在；任务名在原始生命周期文件内。

本次两个只读任务 `WowJev-SessionRecovery-afeb64e68e5c4ffd98d0028726a118b3`、`WowJev-SessionRecovery-c2296a6f19434f1f8e878ea96ad6c07f` 均删除并独立回查不存在（HRESULT `0x80070002`）；本模块负责人没有创建任务、访问现场窗口或发送输入。

## 性能范围与可复跑入口

结果记录在本阶段工作树 `out/acceptance/resolution-aware-20261006/full-fixture-final.json` 与 `build.log`。计时使用 Windows Stopwatch/QPC，初始化与热样本分开。热样本针对已经 staging 好的 ROI，两种场景各 100 次、此前各 5 次预热；每次包括选角和教程两个校准检查。

| 环节 | n | p50 / p95 / max |
| --- | ---: | --- |
| 冷模板初始化（包括校准读取/hash/缩放缓存） | 1 | 136.718ms |
| 已保存选角帧，两种 CV 合计 | 100 | 10.920 / 15.178 / 16.380ms |
| 已保存教程帧，两种 CV 合计 | 100 | 12.046 / 16.360 / 18.907ms |

这只验证 CV 本身，不包含 WGC 捕获/staging、PNG、OCR、执行闸或输入。不能把本表当作“观察→输入发出 <150ms”证据，也不能与协调器时钟直接相减。该端到端目标需要后续常驻宿主与实际有限输入阶段分别验收。

构建：`bash tools/session_recovery_build.sh`（按项目方式先构建原生链接依赖）。另将 `RecoveryCalibrationFixture.cs` 编译为 EXE，引用该输出 `InteractiveSessionHost.exe`、System.Drawing 和 System.Web.Extensions。fixture 入口：

```text
RecoveryCalibrationFixture.exe <已保存选角图> <已保存教程图> <tools/recovery-calibration目录> [已保存当前断线图]
```

前三个参数运行 113 项，第四个只增加两条当前截图负例。入口只读本地图片，不接受窗口句柄、不调用输入 API。

## 完整回归与环境口径

最终 TS **546/546**、Python **729 passed + 3 项原有 strict xfail**（收集732，失败/跳过0）、typecheck通过。主日志位于 `out/acceptance/layered-tutorial-20261006/stage-1/`。首次工作树缺 `.venv` 入口引起一项TS worker环境失败，缺capture/原生入口及绑定引起84、44、21项环境跳过；所有原件保留，补齐后全量复跑。不把这些不完整运行当作通过，也没有删改旧测试。

完整Python必须先 `bash capture/build.sh`、`bash native/windows/build.sh`、`bash tools/npc_fixture_build.sh`，然后显式绑定当前checkout的 `WOW_COMBAT_EYE_EXE=<repo>/native/windows/bin/WinEye.exe`、`WOW_NPC_CLASSIFY_EXE=<repo>/out/npc-tools/NpcClassify.exe`，用项目已有venv运行 `python -m pytest -q`。独立树共享已安装venv/dependencies，未安装软件或改变测试条件；这些原生用例仅解码本地图片。TS入口 `npm --prefix agent test`，类型入口 `npm --prefix agent run typecheck`。
