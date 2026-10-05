# 版本隔离的本地游戏数据库

`game_database/` 使用 Python 标准库 SQLite，`agent/src/game-data/` 提供只读 TypeScript 异步桥。数据库收集外部参考资料与实际本地观察，和既有严格日志学习的知识快照分开。实体断言按来源与内容 SHA 保存，同 ID 不同版本、同名不同 ID、历史评论与当前页面冲突均并存。

## 版本与适用性

`GameVersion` 六个字段分别为 `branch / expansion / patch / build / region / locale`。branch 显式区分 `retail`、`classic-era`、`classic-progression`、`classic-seasonal`、`classic-anniversary`、`custom`，另设未知；expansion 是运行客户端资料片类别，实体所属旧资料片另存 `facts.content_expansion`。locale 使用 API 拼写 `zh_CN`，配置的 `zhCN` 需显式规范化。

在线资料查询必须知道全部六字段，逐项精确匹配；缺值返回 `version_unknown`，没有适用记录返回 `not_found`。不选择“最近的 build”、不跨地区/语言、不把后版数据移到旧版、不按名字把 NPC 或联盟/部落任务合并。当前 v1 不推定 patch 区间，多个已核实版本分别追加有自己的证据的断言。游戏服务器热修可能与相同客户端 build 的早期记录不同；断言仍保留抓取时间与来源，冲突返回 `conflict`，由上层依据当时真实场景处理。

`source.source_version` 是资料来源对应版本，未知字段必须为 null。`applicability` 是明确证据绑定：每项提供完整版本、核实方法、证据 URL、SHA 和核实时间，且必须与原始观察/提取/来源版本相符。空数组为 `reference_only`。网页“增加于 10.0.2”表示加入历史，不表示当前页面内容属于该 patch。正式服网页也不能证明对应国服 build。官方 API 的 `static-*` namespace 同样不是历史 build 证据。

`lookup()` 按 entity ID 或精确名字检索；同名多 ID 返回 `ambiguous`，单 ID 多个不同内容返回 `conflict`，保留全部来源不自动融合。`references()` 是独立检索入口，明确 `applicable_to_requested_client=false`；即使存在适用断言，数据库也始终返回 `automatic_action_eligible=false`，不能替代当前目标、战斗、距离、焦点等真实感知条件。

客户端安装证据单独注册为 profile。`installed_client`、`running_client`、`online_session` 不相互冒充；注册时复核本地 JSON 证据 SHA、scope、版本与 online 标记，不会提升任何网页实体断言。本机 `_retail_/Wow.exe` 是 `12.1.0.69933`，产品元数据 `wow/Active=1`，配置 CN/zhCN；旁边的 `wow_classic_titan` 不属于此 profile。保存的安装元数据不是角色登录/服务端版本证明。[官方 12.1 内容与 Midnight 的关联](https://worldofwarcraft.blizzard.com/en-us/news/24250385)用于资料片命名。

## 使用

在仓库根执行（SQLite 属运行产物，存 out 而非 Git）：

```bash
/usr/bin/python3 -B -m game_database.cli --db out/runtime/game-data.sqlite import game-data/seeds/dragon-isles-reference-v1.json
/usr/bin/python3 -B -m game_database.cli --db out/runtime/game-data.sqlite register-profile game-data/profiles/retail-cn-installed-12.1.0.69933.json --evidence-root .
/usr/bin/python3 -B -m game_database.cli --db out/runtime/game-data.sqlite profiles --version game-data/profiles/retail-cn-12.1.0.69933.json
/usr/bin/python3 -B -m game_database.cli --db out/runtime/game-data.sqlite query --version game-data/profiles/retail-cn-12.1.0.69933.json --kind quest --id 70123
/usr/bin/python3 -B -m game_database.cli --db out/runtime/game-data.sqlite references --branch retail --locale zh_CN --kind quest --name 练手材料
```

当前公开小样 11 条全部属于参考资料，因此上面的 69933 精确查询返回 `not_found`；references 能找到对应短字段和不同年代/阵营断言。标准版本 JSON 在 `game-data/profiles/retail-cn-12.1.0.69933.json`；独立安装 profile 在相邻 `retail-cn-installed-*` 文件，其元数据字节存 `game-data/provenance/client-version-1.json`，SHA `94951e43c2aafd41281a33cfe132727528632fb26cbb659088836d9b6fa7ca6d`。

TypeScript：

```ts
const db = new GameDataClient({ repositoryDirectory: repo, databasePath: sqlitePath });
const result = await db.lookup(version, { kind: "creature", entity_id: 195597 });
const clues = await db.references("retail", "zh_CN", { kind: "quest", name: "练手材料" });
```

桥接进程默认 5 秒超时、最多 4 MiB 响应，支持 AbortSignal，只打开现有数据库的只读连接；不读 API key、不联网、不操作游戏。响应格式来源为 `game_database/schema-v1.json`，TS 使用 AJV 验证，Python 校验相同实体/来源/版本字段并实施跨字段约束。

## 外部资料与扩充

本轮通过网页工具实际读取如下短字段，没有复制任务叙述、攻略全文或原始 HTML；`artifact_sha256=null` 明确不冒称保存了 HTTP 源字节，数据库为提取的完整断言计算 canonical SHA。

| 来源 | 保留的数据 | 限制 |
| --- | --- | --- |
| [探险者遇险 70122](https://www.wowhead.com/cn/quest=70122/探险者遇险) | 名称、ID、营救数量 3 | 未证 build/region |
| [原始龙害 70123](https://www.wowhead.com/cn/quest=70123/原始龙害) | 页面数量 8；历史评论 10 独立断言 | 评论仅为 2022 年代线索 |
| [练手材料 70124](https://www.wowhead.com/cn/quest=70124/练手材料) | 页面数量 12；历史评论 15 独立断言；关联鳞片 ID | 未证 build/region |
| [同名部落任务 65451](https://www.wowhead.com/cn/quest=65451/练手材料) | 同名、独立 ID、部落、数量 20 | 不与 70124 合并 |
| [原始始祖雏龙 195597](https://www.wowhead.com/cn/npc=195597/原始始祖雏龙) | 名称、ID、地区名 | 无等级/血量/掉率 |
| 原始龙害/练手材料主页面链接 | 幼龙 193806/193816/193811 与鳞片 198398 名称和 ID | 子详情页未成功访问，仅父链接证据 |

[Blizzard Game Data API](https://community.developer.battle.net/documentation/world-of-warcraft/game-data-apis)需 OAuth，当前没有读取/申请新凭据，提供离线官方响应导入适配。`import-blizzard response.json --source-url '<credential-free official entity URL>' --source-version version.json --retrieved-at '<带时区时间>'` 默认仍隔离为参考；需要另给已核实 `--applicability` JSON 才参与精确查询。URL 必须对应 ID、namespace、region、locale，禁止 access_token 等认证 query，响应只保存结构字段，不存任务全文。官方原始响应 SHA 被保留。

[Blizzard 官方 Classic namespace 说明](https://us.forums.blizzard.com/en/blizzard/t/wow-classic-era-realm-apis/16812)区分 Era 的 `static-classic1x-{region}` 与进度服的 `static-classic-{region}`；适配器仅接受已核实的 retail/Era/progression 映射，季节/周年分支在数据库中可存可查，不能猜 API namespace。未来扩充接口必须重新核官方支持。[官方 Quest API 回复](https://us.forums.blizzard.com/en/blizzard/t/quest-attributes/8892)指出 category 列表次序不保证任务链顺序，不能据其列表顺序生成前后置任务。

## 验证

`tests/test_game_database.py` 验证六维反跨版、同 ID 多版、未知隔离、名字歧义、冲突来源、幂等/原子导入、来源/版本伪绑定拒绝、本地观察区分、凭据 URL 拒绝、JSON 重复字段、SHA 篡改、只读不存在文件、官方 API 错 ID/namespace、真实 CLI 与安装 profile 状态边界。`agent/tests/game-data.test.ts` 实际启动 Python/SQLite 检查 TS 查询、歧义参考、版本未知、取消和失败，不使用 fake DB。
