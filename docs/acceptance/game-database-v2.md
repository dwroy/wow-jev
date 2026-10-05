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
