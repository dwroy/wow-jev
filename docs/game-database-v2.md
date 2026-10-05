# v2 世界包与运行库

实施规划见 `handoff-game-database.md`，当前验收见 `acceptance/game-database-v2.md`。v1 的 `game_database.cli`、`GameDataClient` 和 schema-v1 保持独立。此版本只提供离线知识与索引，不产生游戏输入；所有查询返回 `automatic_action_eligible=false`。

## 世界包

`game_database/v2/` 接受受控中间格式，来源Lua/SQL不在业务库执行。实体键为 `{namespace,kind,native_id}`，名称只是带locale的断言。来源版本、代码/数据/图像许可、第三方来源、原件SHA、locator、源时间、条件和六维适用性分别保留。来源版本声明不自动证明当前国服适用性。

每个字段有独立断言与SHA；相同条件下的同字段冲突返回conflict，其它字段继续可查。unknown、unsupported、not_present分开。未提供的请求字段返回unknown。`assertion_ids`只列采纳的断言；冲突或条件未明确为true时不采纳，完整候选仍在assertions。本地核实证明必须绑定包中已校验的原件SHA；没有对应原件不冒称核实。

世界包先在输出目录内staging构建，校验原件、外键、完整性和领域类型，完成checkpoint/DELETE模式后计算SQLite SHA，再原子发布到manifest SHA目录。重复构建同一输入返回同一包；失败清理本次staging，不覆盖旧包。发布文件只读，读取必须传预期manifest SHA，并校验manifest、SQLite、schema/rule及来源原件；不能把SHA检查改成“读取当前包”。manifest不嵌自身SHA，其canonical JSON原字节SHA就是world_pack_sha256。

精确查询匹配branch/expansion/patch/build/region/locale；不知道版本返回version_unknown，未覆盖版本返回not_found。references显式返回不适用于请求客户端。批量查询在同一固定包、连接和版本下执行，最多128个selector。中文名称使用NFKC/casefold；双字索引已建，条件、短词、空间检索在里程碑三接入。UI百分比坐标与世界坐标的typed map不可混用；未知楼层/精度/位面保留，不由坐标推导可通行。

构建/迁移入口（仓库根）：

```bash
python3 -B -m game_database.cli --db out/runtime/game-data.sqlite import game-data/seeds/dragon-isles-reference-v1.json
python3 -B -m game_database.v2.cli migrate-v1 --db out/runtime/game-data.sqlite --output-root out/runtime/world/retail/dragon-isles/v1-migration
python3 -B -m game_database.v2.cli build --bundle /本机的bundle.json --evidence-root /本机原件根目录 --output-root out/runtime/world/retail/dragon-isles
```

迁移读原v1库，不改写文件或旧断言SHA；migration_v1保存完整原payload，migration_mapping记录新字段SHA和转换器版本。v1的非规范事实键及v2保留谓词转义，不凭旧自由JSON推定新关系。旧本地证据原件尚不可用时，新字段隔离为reference_only，旧证明仍在原payload；不会无原件沿用locally_verified。

查询：保存六维version JSON及selector数组，再固定上一步输出的directory与world_pack_sha256：

```bash
python3 -B -m game_database.v2.cli query --pack /本次包目录 --sha256 本次manifestSHA --version game-data/profiles/retail-cn-12.1.0.69933.json --selectors /本机selectors.json
python3 -B -m game_database.v2.cli references --pack /本次包目录 --sha256 本次manifestSHA --version game-data/profiles/retail-cn-12.1.0.69933.json --selectors /本机selectors.json
```

selector严格包含 `namespace/kind/native_id/name/predicates`；native_id/name二选一，另一值null，predicates可null或字段数组。示例：`[{"namespace":"retail","kind":"quest","native_id":70123,"name":null,"predicates":["name","objectives"]}]`。原11条seed迁移得到9实体/27字段断言；当前69933精确查询仍not_found，references保留历史冲突。

manifest的distribution只是来源声明的保守汇总，不能替代许可核查。未知/受限来源、第三方输入、未关联许可的资产和缺图像许可的图像均标local_only；不自动发布、上传或推送世界数据。

## 可写运行域

里程碑一已实现并通过离线验收。`database`依赖组固定APSW3.53.4.0，其实际SQLite3.53.4包含WAL-reset修复；v1/世界包仍用Python标准库。运行库只在WSL/Linux本地文件系统打开，不允许Windows共享路径或网络WAL。运行服务负责单写连接与checkpoint；Windows只提交JSON。

[SQLite官方WAL修复说明](https://sqlite.org/wal.html#walreset)确认修补版本及回补版本。活动库备份须用[Backup API](https://sqlite.org/backup.html)，不能只复制主SQLite文件。运行索引、角色进度、经验评估/注册与真实层日志适配分别验收，创建表不代表执行学习闭环完成。


运行库入口（安装依赖可用 `uv sync --group database`，或既有venv）：

```bash
.venv/bin/python -B -m game_database.runtime_cli --db out/runtime/agent.sqlite init
.venv/bin/python -B -m game_database.runtime_cli --db out/runtime/agent.sqlite inspect
.venv/bin/python -B -m game_database.runtime_cli --db out/runtime/agent.sqlite backup --output out/runtime/agent-backup.sqlite
.venv/bin/python -B -m game_database.runtime_cli --db out/runtime/restored-agent.sqlite restore --backup out/runtime/agent-backup.sqlite --sha256 本次backup输出的SHA
```

backup/restore拒绝覆盖，恢复到新路径；活动WAL经Backup API进入一致性单文件快照。单写锁与连接由同一服务持有，第二writer明确拒绝，进程被强杀后锁释放、已提交WAL可恢复。run固定世界manifest/SQLite、六维客户端、code/prompt/knowledge/bindings/calibration SHA及真实/模拟/只读模式。原始日志为权威，索引以run/seq/event SHA幂等补入，序号缺口与日志尾缺口明确记录。

角色和账号分别注册，progress的entity/world/client/源观察身份、源时钟和七字段事实必须与indexed observation payload一致；不允许凭存在一个event写出任意完成事实。缺记录、跨版本、不相容源时钟、过期和相同源时钟冲突均返回unknown；不把接收时间当源时间。任务消失保留not_present，不推成交付。经验候选保留真实/模拟/只读样本与反例；评估和发布内容地址注册不可变，并重新核原件。现阶段是运行/经验注册能力，直接消费layers日志和接通既有知识发布仍在里程碑四。

TypeScript批量入口：

```ts
const world = new WorldDataClient({ repositoryDirectory: repo, worldPackDirectory: packDir, worldPackSha256: manifestSha });
const data = await world.lookup(version, [
  { namespace: 'retail', kind: 'quest', native_id: 70123, name: null, predicates: ['name', 'objectives'] }
]);
```

`game_database/schema-v2.json` 是批量跨语言请求/响应的结构契约。子进程只读固定包，5秒默认超时，支持AbortSignal；请求64KiB、响应4MiB，严格验证包/版本/规则/总状态/实体/字段和采纳断言绑定；原assertion/source canonical字节分别核SHA，再核JSON值与外层一致，保留Python浮点与Unicode原字节。TS拒绝不可精确保留的int64 ID；其它字段不得据JSON数字舍入合并身份。原v1入口和读取格式不变。
