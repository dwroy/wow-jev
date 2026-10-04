# 眼运行时模块

命令使用方式见项目 `docs/eye-runtime.md`。本模块的职责是消费 Windows 截图/CV 消息，融合低频 Seed 字段，记录证据并离线核对。

- `client.ts`：常驻只读 WinEye JSONL 客户端。每次 sample 都有请求开始和完整接收边界；Windows QPC 仅保存原值，不直接与 WSL 时间相减。显式 `save` 才产生 JPEG。
- `state.ts`：源字段、实际测量与未测占位分开。CV 只更新测过的字段；较旧 Seed 不能覆盖较新实际测量，校准后的库存 CV 优先。过期变为 unknown，保留原始来源时间。
- `seed.ts`：独立异步 worker，最多一项请求在途。默认不启用上传；worker 默认 disabled。读取到的原始回复由运行时记录，是否采纳及原因另记，不把模型返回时间当源图时间。
- `runtime.ts`：观察状态提交使用同一个队列，保证状态合并、观察 ID/序号和日志顺序一致；模型网络请求不占用该队列。收尾等待所有已启动 Seed jobs 和提交队列。
- `store.ts`：追加 JSONL、schema/config/prompt/calibration/code 指纹与不可覆盖的截图副本。JPEG 走显式 Windows UNC 导出，复制前检查路径归属，复制后验证 SHA256；不根据 AppData 路径可转换就假定可读。
- `replay.ts`：只读取本次保存的 schema、日志和图片，不启动 native 或模型进程。校验源时间、状态重建、跨消息关系、图片哈希和实际 CV 证据；每条执行回执都要有唯一关联记录。

`record-action` 每个 run 只执行一个动作。发送前核 HWND/PID、条件时效和 deadline；之后最多等待 1.5 秒采样 UI 渲染，不重复输入。只有同一校准下已知库存状态发生期望转变、post 源采样晚于收到原生终态、完整非零事件计数并已释放，才确认库存效果。移动、跳跃、摄像机以及仅有画面变化均保留 unknown。

输入断连后发送计数记录为 unknown/null。post 捕获失败仍记录保守失败观察、unknown 效果和动作关联。模型输出遵循 schema 代表格式有效，不能据此断言游戏事实准确。
