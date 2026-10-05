# v2 游戏数据库验收

更新：2026-10-06。实施起点47423e8，新机器 `/home/dw/Projects/wow-jev`；规划见 `docs/handoff-game-database.md`。

## 步骤0：恢复与旧接口基线

安全备份本机未跟踪旧HANDOFF，保留wow-jev.bundle与pixel-bridge工作树；主checkout切到codex/agent-system。实施在项目独立工作树，不推送。

在 `.worktrees/game-db-foundation` 执行：

- `uv sync --group database --cache-dir /tmp/wow-jev-uv-cache`：安装锁定依赖；APSW3.53.4.0内置SQLite3.53.4，标准库SQLite3.46.1。
- `.venv/bin/python -m pytest -q tests/test_game_database.py`：19 passed，exit0。
- `npm --prefix agent run typecheck`：exit0。
- `./agent/node_modules/.bin/tsx --test agent/tests/game-data.test.ts`：2 passed，exit0。

首次默认沙箱网络DNS和tsx本地IPC失败，经同一命令权限审查重跑成功；未读取凭据、调用模型、启动Windows程序或发送游戏输入。历史Windows/game验收只保留原机器记录，不外推到本机。

## 里程碑状态

一实施中；二、三、四待实施。运行库固定修补后的SQLite；世界包与v1接口分开，尚无v2发布或当前客户端已核实覆盖。

## 步骤1a：世界包与兼容迁移

独立工作树 game-db-foundation 实施，来源模块负责人独立只读审查，无剩余P1/P2阻塞。

- `.venv/bin/python -m pytest -q tests/test_world_pack.py tests/test_game_database.py`：46 passed，exit0，无skip。覆盖原子/幂等、字段级冲突、六维隔离、unknown/unsupported/not_present、只读、原件/manifest/SQLite篡改、v1原SHA/映射/任意键/未知locale、来源证明绑定、坐标/实体类型、实际CLI/stdin桥。
- 重新seed导入及v1迁移：9实体、27字段断言，全reference_only；当前精确query not_found、references可查，旧库字节与SHA不变。
- 步骤0主checkout集成：19Python、2TS与typecheck再次通过。

首次世界包测试改fixture中的原件SHA但未同步迁移映射，被正确拒绝；修正fixture后通过，未放宽校验。独立审查复现的证据/许可/迁移问题已修复，加入重算hash仍拒绝的测试。里程碑一运行库与TS桥尚未集成，尚未报告整体完成。
