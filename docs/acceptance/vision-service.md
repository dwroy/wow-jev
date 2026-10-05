# xdwin2 本地视觉服务验收

负责人已完成远程服务部署、真实GPU、图片/有限视频输入和生命周期验收，并本地集成。完整7字段游戏识别尚未通过；不据接口成功切换WoW默认视觉源。用户明确要求在xdwin2部署视频service，并指定使用Windows SSH。

## 目标与版本

- 目标：`iem@172.26.203.214`，WSL主机DESKTOP-PHTQGNQ，RTX3090 24576MiB；部署前模型/RPC空闲，桌面显存约1354MiB。
- 独立目录：`/home/iem/Services/wow-vision`。既有CUDA架构86的llama.cpp commit c8cda8b4fe3f2217793eb68e6df2e93a0a1a73c1，不修改驱动或硬件。
- 模型：Qwen3.5-9B，社区仓库unsloth/Qwen3.5-9B-GGUF固定revision3885219b6810b007914f3a7950a8d1b469d598a5，Q4_K_M与配套F16 mmproj；两个权重共约6.6GB，完整大小/SHA必须通过后启动。
- Backend和gateway都只监听127.0.0.1，计划端口18791/18790。访问经Windows SSH隧道，POST需token，默认关闭思考、限制256输出token、单项推理。

## 已做与待验

服务鉴权、JSON/图像/视频上限、远程URL拒绝、时间戳顺序、并发立即429与后端超时拒绝后续请求等12项HTTP边界测试已由实施agent在本机和远端通过；它们使用模拟后端，不能代替真实GPU测试。

负责人probe的凭据权限、来源哈希、完整响应与回环限制3项测试通过。三个游戏图的标签由负责人直接看图标注，只标注可见的名字、等级、目标和背包，不标注战斗/血量。

三秒视频是由已验收的游戏截图编码的关闭→打开→关闭测试片段，各1秒，非实时录制。实际FFmpeg预处理已得到500/1500/2500ms三帧；抽帧时间是请求seek位置，不冒称精确原生PTS。

真实GPU图片及有序帧输入、MP4均匀抽帧理解、本机Windows SSH隧道访问、SSH断开存活、正常停止和哈希期间启动取消均通过。GPU初测峰值8037MiB（含桌面），实际backend PID对应CUDA动态库/NVIDIA compute-app及固定引擎版本已保存；未独立验证逐层offload数量、supervisor强杀或WSL重启。服务不自动开机启动，暂不将本地Qwen作为WoW在线状态默认来源。

## 固定样例与入口

主checkout `out/acceptance/vision-service/fixtures/manifest.json` 含3张图的源SHA与人工标签、视频源SHA和合成说明。本地测试结果只作为部署检查，不足以估计游戏准确率。

当前隧道已建立，本机18792已实测可用。精简5字段测试入口：

```bash
/usr/bin/python3 tools/vision_service_probe.py \
  --base-url http://127.0.0.1:18792 \
  --token-file /home/dai/Projects/wow-jev/out/runtime/vision-service/client-token \
  --fixtures /home/dai/Projects/wow-jev/out/acceptance/vision-service/fixtures/manifest.json \
  --out /home/dai/Projects/wow-jev/out/acceptance/vision-service/my-probe-1 --compact
```

输出目录不能已存在；程序不发送游戏输入、不调用Seed。HTTP和schema通过与字段预测正确分别记录，错误也保留。检查源图/视频SHA、采样方法及时间顺序；记录预处理、后端和端到端耗时、用量及原始模型结果，不落盘Authorization或请求base64。

凭据仅在`out/runtime/vision-service`运行目录，父目录700、文件600，不能写入验收目录/manifest/git。视频接口是最多4帧/12秒的有序抽帧理解，不处理音轨。单图缩放与多帧缩放的尺寸须随结果记录，识别误差不能只归因模型。

## 真实结果与限制

- `remote-smoke-1`：简单合成大字图片首次876ms、热请求约293ms；三帧颜色顺序899ms，不能外推WoW性能。当前服务PID在`remote-lifecycle-1.json`，精确隧道PID8984与命令在`remote-tunnel.json`。
- `home-probe-1`：真实游戏图完整7字段2.37–2.85秒；3图共15个人工标注字段，7个读对、3个已知错判、5个unknown。目标框位置假设错误已修，旧错误/原始回复/旧prompt与哈希不改写。
- `home-probe-2`：新prompt首图触发unknown/confidence语义错误，exit1，不当作通过。
- `home-probe-3`：修正位置假设后三图原文都读对目标；2个完整结果把unknown字段confidence写成0.5，严格拒绝，exit1；原始错误保留，不自动改成0。闭包未知仍保留。
- `home-compact-1`：精简到同5个标注字段、不生成战斗/场景/置信度，3图15个标注值均正确；首次1.91秒、后两张1.63/1.60秒，输出53token，约115token/s。视频1.90秒，闭→开→闭正确。该结果减少任务内容，不是换引擎带来的加速，也不是长期准确率或每秒一张吞吐证明。

三秒视频为从截图合成的验证片段。尚未验证长视频、实时连续流、声音、移动轨迹或目标稳定识别。vLLM/SGLang未在该设备进行同任务性能对照。下一步优先研究固定UI区域/独立OCR和短输出，再评估引擎差异。服务代码不发送游戏输入。

负责人最终本机Python视觉/客户端回归46项、HTTP网关边界13项通过（模拟后端，均exit0）；远端Python3.14同13项也通过。真实功能证据与模拟测试分开保存，不将测试exit0作为所有模型字段正确的证明。

## Seed mini 与本地 Qwen 同图对照

`seed-qwen-comparison-1` 使用上述3张游戏图，各重复3轮，每家9次请求。相同五字段 prompt、temperature=0.1、最多256输出token、关闭思考、串行且交替先后，没有重试。端到端时间包括本机请求到完整响应；本地为3090上的Qwen3.5-9B Q4_K_M/llama.cpp经SSH隧道，云端为doubao-seed-2-0-mini-260428。

| 当前部署 | 有效响应 | 标注值正确 | 中位延迟 | 延迟范围 |
| --- | --- | --- | --- | --- |
| 本地 Qwen | 9/9 | 45/45 | 1.802秒 | 1.588–1.832秒 |
| Seed mini | 9/9 | 45/45 | 1.382秒 | 1.149–1.778秒 |

Seed在本轮中位延迟低23.3%，两边在这些固定字段上均读对。只有3张独立截图，不能视为45个独立场景或总体准确率结论，也未测复杂战斗、任务理解、视频或并发。相同源图2048×1536，本地网关缩到1280×960，Seed内部预处理不同；这是当前部署链路对照，不是固定精度/预处理的模型排行榜。完整7字段的Qwen格式问题仍未解决。

原始输出、每次用量、预处理、延迟及汇总在 `out/acceptance/vision-service/seed-qwen-comparison-1`。`executed-vision-compare.py`与summary中的代码SHA一致，保留实测版本；集成脚本随后补充失败停止整轮及源图哈希校验，不改写这轮证据，9个本地响应的源SHA已逐一离线核对。没有新增游戏输入或截图。

再次比较的入口为 `tools/vision_compare.py --allow-game-image-upload --fixtures <manifest.json> --token-file <client-token> --out <全新目录> --repeats 3`，仅在既有WoW截图上传授权内使用；输出不含凭据和请求图片base64。
