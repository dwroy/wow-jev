# TypeScript 全量测试数量核查

日期：2026-10-06。仅完成用户指定的第1步；没有继续数据库实施或推送。

## 结论与实际运行

没有测试丢失。交接文档的335项是旧版全量，上次131项是17个文件的数据库定向回归，两者统计范围不同。此前最终汇报未明确这一区别，本记录更正；131通过不能表示全量通过。

在两个独立工作树安装各自锁文件中的依赖，保持源码不变，依次从各自`agent/`目录实际执行原始`npm test`，没有筛选文件、修改并发、跳过失败或模拟测试结果。两版原始script均为`tsx --test tests/*.test.ts`。

| 快照 | 工作树 | 文件 | 实跑测试 | 通过 | 失败 | 跳过 | 取消 | todo | exit |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dcbf3323ad336a1e2b7a212c5ec18434779357c2 | .worktrees/ts-audit-dcbf332 | 46 | 335 | 333 | 2 | 0 | 0 | 0 | 1 |
| 7ccd3616341a61507289fe151651e28f1d53201f（核查开始时HEAD） | .worktrees/ts-audit-head | 52 | 382 | 381 | 1 | 0 | 0 | 0 | 1 |
| 上次里程碑四定向回归（既存原始TAP，本步未重跑） | 主checkout | 17 | 131 | 131 | 0 | 0 | 0 | 0 | 0 |

本次两份完整TAP的用例名称与各自源码AST中的全部`node:test`注册调用逐项、多重集比对：均无缺项、无多项。全部335/382项实际被注册和运行；没有模块加载失败造成未注册用例，也没有把文件失败占位计为一项用例。本机有`wslpath`及Windows C#编译器，原`regional-eye.test.ts`的离屏Windows Bitmap构建/fixture与12项测试也实际运行并通过。该测试不发送游戏输入。

环境相同：WSL2 Linux、Node v22.23.3、npm 10.9.9、tsx 4.23.15、TypeScript 5.9.3、Python 3.14.4；npm依赖以相同锁文件离线`npm ci`安装。两版`agent/package-lock.json`的SHA256均为`6e22080f17b3baf2961259480894016b55813ec9a72b43170aeed95b3169d67f`。Python环境以各工作树`uv sync --offline --cache-dir /tmp/wow-jev-uv-cache`准备，用于测试中的受控Python子进程；没有运行Python测试套件或调用模型。原始TAP耗时分别为17.356秒和44.140秒。

## 131项的确切范围

上次17个文件包含旧版已有的11个文件、84项旧测试，以及本轮全部47项新增测试。因此：

- 旧版全量：84 + 251 = 335。
- 上次定向：84 + 47 = 131。
- 当前全量：335 + 47 = 382 = 131 + 251。

当时剩余35个文件的251项旧测试没有运行。这些文件全部仍在原始`tests/*.test.ts`匹配范围内，未删除、禁用或从默认命令排除；本步已全部实际补跑。范围选择是上次执行命令显式指定17个文件，不是npm默认发现规则变化。

上次实际命令（项目根目录）：

```bash
./agent/node_modules/.bin/tsx --test \
  agent/tests/layers-learning.test.ts \
  agent/tests/world-objective-runtime.test.ts \
  agent/tests/world-live-gate.test.ts \
  agent/tests/world-task.test.ts \
  agent/tests/world-version-registry.test.ts \
  agent/tests/knowledge.test.ts \
  agent/tests/brain-knowledge.test.ts \
  agent/tests/layers-integration.test.ts \
  agent/tests/behavior-task-runtime.test.ts \
  agent/tests/brain-planner.test.ts \
  agent/tests/brain-runtime.test.ts \
  agent/tests/brain-replay.test.ts \
  agent/tests/iteration-runtime.test.ts \
  agent/tests/system-launch.test.ts \
  agent/tests/system-cli.test.ts \
  agent/tests/world-data.test.ts \
  agent/tests/game-data.test.ts
```

本步保留的旧131项TAP也与这17个文件的131个测试名称完全匹配。

## 源码增减核对

`git diff --name-status dcbf332 7ccd361 -- agent/tests agent/package.json agent/package-lock.json`显示：原有46个测试文件无删除，45个文件字节未变，仅`brain-planner.test.ts`修改；npm script与锁文件无变化。旧版全部335个测试名称仍存在，未增加skip/todo/only选项。

| 文件 | 旧用例 | 当前用例 | 增量 |
| --- | ---: | ---: | ---: |
| brain-planner.test.ts | 5 | 6 | +1 |
| layers-learning.test.ts | 0 | 10 | +10 |
| world-data.test.ts | 0 | 12 | +12 |
| world-live-gate.test.ts | 0 | 1 | +1 |
| world-objective-runtime.test.ts | 0 | 5 | +5 |
| world-task.test.ts | 0 | 10 | +10 |
| world-version-registry.test.ts | 0 | 8 | +8 |
| 合计 | | | +47 |

新增`layers-learning-fixture.ts`是辅助模块，不注册测试，原始glob本来就不匹配它；不计为测试文件或用例。AST统计的是测试注册调用，不把一个测试内部的多次assert或循环反例拆成多项；实际TAP总数验证了此口径。

## 失败原因及边界

两版并非全量全绿，本次没有通过改快照或跳过失败伪造335/335或382/382。

1. **仅旧版失败：`brain-planner.test.ts`的Python worker边界测试。** 旧版第41行写死`/home/dai/Projects/wow-jev/.venv/bin/python`，本机路径不存在，直接spawn探针返回ENOENT；测试收到`failed`而期望`disabled`。当前版已在里程碑四改为`join(repo, '.venv/bin/python')`，同一旧用例本次实际通过。该历史路径问题不代表测试删除或模型失败。
2. **两版共同失败：`eye-artifact-cli.test.ts`的PNG observe/record-action transport mock测试。** 第49、51行生成mock EXE时写死shebang `#!/usr/bin/node`；本机Node实际为`/home/dw/.local/node/bin/node`，`/usr/bin/node`不存在，直接spawn探针返回ENOENT。mock文件本身已创建，但内核找不到shebang解释器，CLI返回`eye_spawn_failed:ENOENT`、exit2，observe断言期望exit0。该测试文件在两版字节相同，本次没有环境修补或源码修改；当前全量仍有此1项失败。这是既存测试对本机可执行路径的依赖，不是本轮数据库逻辑新增回归。

`docs/acceptance/four-layer-runtime.md`的历史335/335记录原机器结果；本步在当前机器重跑复现335项总数，未复现全通过。没有发现丢失测试，无需恢复测试。用户仅要求本步统计核查，未继续处理上述既存mock路径问题或后续规划；不将定向通过继续称作完整TS验收。

## 原始证据与复现

主checkout的`out/acceptance/ts-suite-audit/`留存完整证据，不随Git提交原始out：

- `dcbf332-full.tap`、`head-full.tap`：未经筛选的两份完整输出。
- `dcbf332-full.json`、`head-full.json`：固定commit、实际cwd/命令、UTC时间、环境、退出码和耗时。
- `previous-targeted-131.tap`：上次原始131项TAP的副本；原件仍在`out/acceptance/game-database-v2/milestone-4/checks/ts-tests.tap`。
- `source-inventory.json`：每个测试文件的SHA、AST用例名/行号、数量、定向包含情况，以及新增/删除差异；含全部35个上次未运行文件清单。
- `comparison.json`：三份TAP精确计数及用例名称与源码对应核对。
- `environment-path-probes.json`：实际解释器/编译器路径及两条ENOENT探针。
- `sha256-manifest.json`：以上原始证据逐文件SHA256。

两份本次完整TAP SHA256：

```text
dcbf332-full.tap  b6ff8d37641c6a004eb0cc0ded58f1225e705599f161d8e578e9635ed4329a1b
head-full.tap     a403ac186027cddd132e7630c3d3a156eae0415cbe61594a46f5b537c795653b
```

已有审计工作树可直接复现相同原始命令：

```bash
npm --prefix .worktrees/ts-audit-dcbf332/agent test
npm --prefix .worktrees/ts-audit-head/agent test
```

本次仅提交验收文档和HANDOFF更正，测试/生产代码未改，原未跟踪bundle及HANDOFF备份保留。核查开始时HEAD的实际测试结果始终指向`7ccd361`；后续文档提交不冒充已重跑过的代码快照。
