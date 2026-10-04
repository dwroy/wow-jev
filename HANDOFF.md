# WoW Agent 当前交接

更新：2026-10-04。用户最新授权和项目规则见 `AGENTS.md`，实施计划见 `docs/agent-roadmap.md`。历史3.3.5a像素桥任务原文已保留在 `docs/handoff-pixel-bridge.md`；当前测试目标为用户指定的正式服客户端。

## 已完成

- 第0阶段工程基线、第1阶段真实键鼠执行已完成并合并。Windows独立释放看门狗与焦点检查已实测，原始记录在 `out/acceptance/stage-1`。
- 第2阶段眼与状态日志已通过负责人真实整链验收和最终回归（TypeScript54/Python42），完成本地集成。Windows截图/CV、显式UNC图片导出、Python异步Seed、TypeScript状态融合、录制与回放已接通。
- 正式服 `game-run1` 六次B开关全部获得完整输入计数、released与效果confirmed；每轮离线回放通过，背包恢复起始关闭。10秒观察含72个原生样本、4个真实Seed结果，删动作关联/伪造观察均被拒绝。
- Seed第三次结果漏看实际存在的目标栏，原始错误保留。模型字段仅为带来源的模型观察，目标/战斗读数尚未独立稳定核验，当前不用于执行闸。背包效果确认使用校准CV。

## 环境与体验

主checkout为 `/home/dai/Projects/wow-jev`，分支 `codex/agent-system`；第2阶段已在独立工作树验收并本地合并，必要产物在主checkout的out归档，阶段工作树随后清理。用户已授权负责人组织并行agent、研发测试、验收和本地合并；不推送远端。

WSL运行TypeScript编排和Python低频视觉，Windows运行C#5/.NET4截图、CV、键鼠和释放看门狗。不能将WSL调度器中断测试外推为整个发行版重启恢复。

本轮游戏绑定 HWND `0x6407cc`、PID `6932`、客户区2048×1536；重启或变更布局后重新枚举、校准。角色移动绑定ESDF，E前进；W/A是技能，不能使用默认WASD假设。禁止程序抢焦点。

用户明确授权上传所有WoW游戏截图至火山方舟；只限游戏客户区，不包括其它应用/桌面。新worker默认不启动模型；显式Seed+上传开关才读取 `~/.config/wow-jev/api.env`，不输出凭据。配置固定 `doubao-seed-2-0-mini-260428`。

使用说明见 `docs/eye-runtime.md`。验收与限制见 `docs/acceptance/stage-2.md`；原始证据在主checkout `out/acceptance/stage-2`，包括真实图、JSONL、冻结schema/校准/代码与二进制指纹。不得改写失败的native-run1/native-run2为通过。

## 接续

第2阶段已可按 `docs/eye-runtime.md` 体验只读观察及离线回放。第3阶段将建设代码play主循环、可中断技能、统一调度与效果验证；Jev、大脑与学习迭代分别在后续阶段接入。

对移动、跳跃、转向暂不自动确认游戏效果；背包CV仅在已验收布局适用。个人长期记忆按 `/home/dai/agent-memory/SPEC.md` 操作，进度只写项目文件。
