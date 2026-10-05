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

一、二、三已完成离线验收；四实施中。运行库固定修补后的SQLite；世界包与v1接口分开，尚无v2发布或当前客户端已核实覆盖。

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

## 步骤2a：双语参考文本

实源接入前修正同entity的en_US/zh_CN文本冲突归类。name/alias/description按locale选择，未知语言只保留候选、不采纳；数值参考允许保留来自不同source locale的来源，精确六维接口不变。84Python/14TS及typecheck通过，0skip。初次新TS测试数组未标tuple被noUncheckedIndexedAccess正确拒绝，改为显式const tuple后typecheck通过，未放宽编译设置。原世界包schema字节及v1断言SHA不变；旧包继续固定SHA读取。

## 步骤2b：固定来源与苏醒海岸种子

原件ATT commit/TDB tag、下载资产/解压父文件及作者规则SHA固定于 `game-data/source-locks/dragon-isles-v2.json`；本机实际归档下载SHA为fc551333…c5a3f5。每次导入验证固定完整父字节，SQL原tuple/CREATE schema原字节按offset复核并保存在标明derived的base64小容器；容器SHA不冒称原SQL SHA。未执行来源Lua/SQL。

- 106项Python：22来源/CLI关联+84基础库，通过无skip；源码diff检查通过。
- 实源CLI完整构建与实际TS桥查验通过。最终manifest SHA `5f762a251e9fb301ee3c8e50d9bbbc31fefc8bf2a67b686a60ef8360bb1c2774`，129实体/779断言，595known源字段、161unknown、23unsupported；全reference_only，current69933 coverage=0，distribution=local_only。原件小包1944426字节，导入需校验大父源约37秒，查询只读小包，不读大dump。
- 每任务名称24known、faction8known/16unknown、原始条件24但求值unknown、作者provider24；确认starter/finisher均0。目标原行及逐项count23known/1unknown；规范目标动作23unsupported/1unknown。UI作者点24，楼层/位面/精度/变换、实际spawn和适用性未核实。raw SQL覆盖不能替代规范动作支持。
- 真实70124参考名称练手材料、objective429858/count12；giver unknown、exact69933 not_found，uint64种族掩码保留字符串6130900294268439629。

独立审查复现symlink父目录越界写、cache中断半文件、首行build代表混合数组、coverage漏unsupported；已补原子no-replace/写前拒绝、同内容幂等、混合build及normalized/raw覆盖反例，复核无剩余P1/P2。unsupported不作source withdrawal，名称delta按locale/condition区分。原候选39d6…、raw失败和审查过程保留，最终使用reviewed包。

实施树证据 `out/acceptance/game-database-v2/milestone-2/{cli-result-reviewed.json,reviewed-summary.json,bridge-validation.json}`；主checkoutff-only集成后重新生成本机验收。尚无真实游戏任务、导航、模型或输入效果验证。

## 步骤3：条件、进度与规划查询

165Python（旧接口/包/运行/来源106+规划及CLI59）全部通过，无skip。独立审查真实复现跨provider世界/六维客户端污染、pending掩盖确定冲突、独立边/难度与楼层/false位面误冲突，修正后反例通过；引用原始assertion/SHA不改写。三值unknown阻塞，turned_in/completed_confirmed与目标完成分开，账号/角色显式所有权、同clock新鲜度和event幂等沿用M1。

M2实际包5f762a…2774再次打开查验：当前69933 ID可接/中文/区域均not_found；reference可接unknown、练手返回65451/70124歧义，IDs=[]且applicable=false。合成世界覆盖楼层、位面、精度、变换、距离边界、路线counterexample/能力以及代表成就/副本；不宣称真实地图可达或副本机制核实。

实际129实体/779断言包Python查询基线：

| 查询 | 新建连接p50/p95 ms（20次） | 复用连接p50/p95 ms（50次） |
| --- | --- | --- |
| ID参考可接 | 11.618 / 13.212 | 0.967 / 1.600 |
| 中文双字参考 | 17.475 / 21.170 | 5.068 / 7.146 |
| 区域参考 | 40.984 / 48.948 | 24.587 / 30.708 |

`out/acceptance/game-database-v2/milestone-3/{real-source-queries,query-baseline}.json`保留完整来源/blockers/测量。OS缓存未清除，区分新连接与复用连接，非物理冷缓存；不含TS进程启动成本，不设数据规模性能承诺。
