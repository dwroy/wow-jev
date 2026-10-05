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

一已完成离线验收；二开始实施；三、四待实施。运行库固定修补后的SQLite；世界包与v1接口分开，尚无v2发布或当前客户端已核实覆盖。

## 步骤1a：世界包与兼容迁移

独立工作树 game-db-foundation 实施，来源模块负责人独立只读审查，无剩余P1/P2阻塞。

- `.venv/bin/python -m pytest -q tests/test_world_pack.py tests/test_game_database.py`：46 passed，exit0，无skip。覆盖原子/幂等、字段级冲突、六维隔离、unknown/unsupported/not_present、只读、原件/manifest/SQLite篡改、v1原SHA/映射/任意键/未知locale、来源证明绑定、坐标/实体类型、实际CLI/stdin桥。
- 重新seed导入及v1迁移：9实体、27字段断言，全reference_only；当前精确query not_found、references可查，旧库字节与SHA不变。
- 步骤0主checkout集成：19Python、2TS与typecheck再次通过。

首次世界包测试改fixture中的原件SHA但未同步迁移映射，被正确拒绝；修正fixture后通过，未放宽校验。独立审查复现的证据/许可/迁移问题已修复，加入重算hash仍拒绝的测试。里程碑一运行库与TS桥尚未集成，尚未报告整体完成。

## 步骤1b：运行库与批量TS桥，里程碑一闭合

- `.venv/bin/python -m pytest -q tests/test_runtime_cli.py tests/test_game_runtime.py tests/test_world_pack.py tests/test_game_database.py`：83 passed，exit0，无skip。
- `./agent/node_modules/.bin/tsx --test agent/tests/world-data.test.ts agent/tests/game-data.test.ts`：13 passed，exit0，无skip。
- `npm --prefix agent run typecheck`、`git diff --check`：exit0。
- 实际运行runtime CLI init、Backup API单文件备份、SHA固定restore到新路径及integrity检查均成功，APSW SQLite3.53.4。测试包含未checkpoint WAL、另进程writer拒绝、writer SIGKILL后已提交数据与锁恢复、角色/账号来源与时钟、进度逐字段证据、跨版本、缺口和模拟统计隔离。

独立审查复现的字段/来源SHA绑定和整体状态欺骗已修复，并加入同步改字段/来源仍拒绝、有效重复JSON、合法Python浮点与Unicode反例；不删除原失败或降低约束。旧v1代码只增加world export，v1协议、旧assertion SHA和知识快照不变。

主checkout小样50次查询基线在 `out/acceptance/game-database-v2/milestone-1/python-query-baseline.json`。9实体/27字段、OS缓存未清除，以下只区分新建连接与复用连接，不称物理冷缓存，也不含TS启动成本：

| 查询 | 新建连接p50/p95 ms | 复用连接p50/p95 ms |
| --- | --- | --- |
| ID精确（not_found） | 1.437 / 1.882 | 0.187 / 0.252 |
| ID参考 | 1.580 / 2.141 | 0.581 / 0.635 |
| 中文同名参考（ambiguous） | 2.292 / 3.105 | 0.841 / 1.769 |

区域查询此阶段unsupported，里程碑三补测；没有据此设广域数据性能承诺。里程碑一完成原子/幂等、篡改、缺字段、跨版本、备份恢复、批量桥与旧接口验收，尚不包含任何模型/Windows/游戏输入、当前游戏核实数据或执行学习闭环。
