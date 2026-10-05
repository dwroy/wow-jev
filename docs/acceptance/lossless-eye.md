# WinEye 同帧无损证据

更新：2026-10-05。实施分支 `codex/lossless-eye`，工作树 `.worktrees/lossless-eye`；本轮没有窗口截屏、真实输入、模型调用或凭据读取，未改主目录现有产物。

WinEye 原有 CV 对捕获的 Bitmap 工作，但落盘固定 JPEG90。黄色名字字形边缘会被有损编码改变，因此 JPEG 模板的离线自匹配不能证明在线原像素能匹配。现在 `NativeEyeClient`、`eye observe/record-action` 和 `system observe/live` 支持显式 `--artifact-format png`；registry 父入口将格式传入冻结子任务，manifest 记录实际配置。默认仍为 JPEG90，高频不保存图片的采样仍只跨系统传 JSON。 客户端只在选择 PNG 时传新增原生参数，默认或显式 JPEG 不向旧 WinEye 传未知 flag；旧构建继续使用其原 JPEG 默认值。

PNG 只用于本地模板与原像素复核。当前模型 worker 保留 JPEG 边界，PNG+Seed 在 eye CLI、system CLI 及真实适配入口启动前拒绝。复制图片同时校验 `.jpg`/`.png` 扩展名与魔数，继续保留文件类型/大小、源目录绑定、SHA 和不可覆盖复制检查。原生 jpg/png 共同消耗每会话 128 张、128 MiB 总量和单图 64 MiB 配额；显式导出继续不可覆盖创建并核验大小/SHA。

## 验证

- 最终全量 TS：266/266 通过，零跳过；类型检查通过。日志在工作树 `out/acceptance/lossless-eye/full-ts-tests-final.log` 和 `typecheck-final.log`。
- 格式专项覆盖默认 JPEG、PNG 魔数/扩展名、严格回放、未知扩展名/误标图片拒绝、非法格式、PNG+Seed 提前拒绝、eye observe/record-action 的格式透传，以及公开 system registry observe/live 到实际冻结子进程 argv 的透传。CLI 的原生端和冻结接收端为明确合成 fixture，record-action 在输入 transport stub 处停止，零动作意图。
- 实际 Windows Framework4 编译和 codec/Save 测试六组通过。单张 97×83、24bpp RGB 合成 Bitmap 经原生 Save 保存并回读，PNG 的 8051 个像素全部相同；默认 JPEG 的 SHA 与独立 JPEG90 编码一致。导出文件 SHA 一致；jpg/大写 PNG 混合文件计数、会话重新初始化计数、混合字节配额及编码后超限清理通过。
- 实际编译来源已冻结在 `out/acceptance/lossless-eye/native-codecs-final/source`，编译器、两个 exe 和源码 SHA 在 `build-sha256.txt`，结果与源图在 `summary.json`/`cases`。首次 UNC `Assembly.LoadFrom` 触发 Framework4 环境限制，失败目录 `native-codecs-1` 保留；测试改为从冻结 exe 字节加载，`native-codecs-2` 和最终冻结来源重跑通过。

原生专项可运行：

```bash
bash tools/eye_artifact_check.sh out/acceptance/lossless-eye/native-codecs-new
```

本轮测试不包含实际 PrintWindow 或 WoW 采样；它直接验证实际 WinEye Save 方法对同一 Bitmap 的编码/配额行为。负责人另行完成实际游戏的同帧 PNG 观察、离线回读和名字校准；本记录不宣称游戏名字识别或自动 NPC 动作已验收。
