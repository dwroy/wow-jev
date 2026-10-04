# xdwin2 本地视觉服务验收

当前部署进行中，尚未报告真实GPU推理通过。用户明确要求在xdwin2部署视频service，并指定使用Windows SSH。

## 目标与版本

- 目标：`iem@172.26.203.214`，WSL主机DESKTOP-PHTQGNQ，RTX3090 24576MiB；部署前模型/RPC空闲，桌面显存约1354MiB。
- 独立目录：`/home/iem/Services/wow-vision`。既有CUDA架构86的llama.cpp commit c8cda8b4fe3f2217793eb68e6df2e93a0a1a73c1，不修改驱动或硬件。
- 模型：Qwen3.5-9B，社区仓库unsloth/Qwen3.5-9B-GGUF固定revision3885219b6810b007914f3a7950a8d1b469d598a5，Q4_K_M与配套F16 mmproj；两个权重共约6.6GB，完整大小/SHA必须通过后启动。
- Backend和gateway都只监听127.0.0.1，计划端口18791/18790。访问经Windows SSH隧道，POST需token，默认关闭思考、限制256输出token、单项推理。

## 已做与待验

服务鉴权、JSON/图像/视频上限、远程URL拒绝、时间戳顺序、并发立即429与后端超时拒绝后续请求等12项HTTP边界测试已由实施agent在本机和远端通过；它们使用模拟后端，不能代替真实GPU测试。

负责人probe的凭据权限、来源哈希、完整响应与回环限制3项测试通过。三个游戏图的标签由负责人直接看图标注，只标注可见的名字、等级、目标和背包，不标注战斗/血量。

三秒视频是由已验收的游戏截图编码的关闭→打开→关闭测试片段，各1秒，非实时录制。实际FFmpeg预处理已得到500/1500/2500ms三帧；抽帧时间是请求seek位置，不冒称精确原生PTS。

真实GPU图片推理、完整短视频理解、响应耗时、显存峰值、从本机调用及SSH断开后服务存活仍待完成。暂不将本地Qwen作为WoW在线状态默认来源。

## 固定样例与入口

主checkout `out/acceptance/vision-service/fixtures/manifest.json` 含3张图的源SHA与人工标签、视频源SHA和合成说明。本地测试结果只作为部署检查，不足以估计游戏准确率。

服务就绪、隧道建立后使用：

```bash
/usr/bin/python3 tools/vision_service_probe.py \
  --base-url http://127.0.0.1:18792 \
  --token-file /home/dai/Projects/wow-jev/out/runtime/vision-service/client-token \
  --fixtures /home/dai/Projects/wow-jev/out/acceptance/vision-service/fixtures/manifest.json \
  --out /home/dai/Projects/wow-jev/out/acceptance/vision-service/home-probe-1
```

输出目录不能已存在；程序不发送游戏输入、不调用Seed。HTTP和schema通过与字段预测正确分别记录，错误也保留。检查源图/视频SHA、采样方法及时间顺序；记录预处理、后端和端到端耗时、用量及原始模型结果，不落盘Authorization或请求base64。

凭据仅在`out/runtime/vision-service`运行目录，父目录700、文件600，不能写入验收目录/manifest/git。视频接口是最多4帧/12秒的有序抽帧理解，不处理音轨。单图缩放与多帧缩放的尺寸须随结果记录，识别误差不能只归因模型。
