# L1/L2 四层人物动作首版验收

日期：2026-10-05。实现工作树：`.worktrees/actions-v2`；运行 API 与命令在 `docs/body-actions.md`。

| 验收层级 | 结果 | 范围 |
| --- | --- | --- |
| TypeScript | 通过 | `npm run typecheck` |
| 新动作测试 | 18/18通过 | 同命令DOWN/UP有限租约、同步键鼠、双击/拖动、profile缓存导入与hash、L2全部union、缺映射/未知模式/飞行条件、同帧元素坐标、critical CV来源、父条件、epoch更替、取消、计数下界 |
| 既有回归 | 30/30通过 | hand协议/客户端、核心协议、统一执行闸；旧ready缺timeline仍接受 |
| Windows C#编译 | 通过 | WinInput、WinInputWatchdog、InputRecorder、WinEye；无新增构建依赖 |
| Windows原生无输入验证 | 通过 | 2条有效退出0；9条无效退出2；fixture客户区800×600；源码与二进制SHA保留 |
| 专用窗口真实timeline输入 | 本轮未做 | 由集成负责人另行验证事件顺序、同步、取消与物理释放 |
| 正式服/游戏效果 | 本轮未做 | 距离、角度、跳跃、骑乘、飞行、技能、交互均未确认 |
| 强杀/EOF/失焦/WSL重启后的timeline释放 | 本轮未做 | 继续复用现有账本/独立看门狗，不能由源码和旧单动作证据外推 |

本轮测试均无游戏输入、无截屏、无抢焦点、无视觉模型或凭据读取。mock的live模式只测试代码契约，mock事件插入计数不是实际Windows输入证明。

证据在工作树 `out/acceptance/actions-v2/`：`native-build.stdout.txt`、`native-build.stderr.txt`、`native-validation-proof.json`、`native-valid.jsonl`、`native-invalid.jsonl`、`typecheck.stdout.txt`、`typecheck.stderr.txt` 与 `tests.tap`。proof记录fixture原字节、WinInput/InputCommon/Watchdog源码、native-input schema、实际WinInput.exe SHA和退出码。它是无输入校验证明，不替代冻结运行包与真实输入日志。

真实运行前必须提供版本化BodyProfile、任务revision/epoch、明确expectedWindow与当前Collected。MOVEFORWARD等语义从实际bindings-cache导入；profile没有的能力unbound/unsupported，模式或关键来源未知blocked。simulation的real_inputs为0；运输失效时只返回确认下界并标input_count_scope=lower_bound。高级行为必须自己以后续观察确认效果。
