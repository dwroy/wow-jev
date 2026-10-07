# UI技能治理v2软件里程碑验收

2026-10-07。最新用户授权允许游戏内自主操作，self/Seed来源无需逐点预审；active仍须客观晋升证据，Claude/user定期通过HTML抽查并可撤销。当前现场超过十分钟没有有效教程进展，已停止；吉安娜交谈和两轮/五轮练习未完成。

## 已实现与实际数据结果

运行学习库的治理接线包括条目级审核与不可覆盖的user撤销、不可变修订/知识快照、运行/代码/prompt出处、学习者从原后图独立匹配绑定目标签名、全已知状态负例、至少两次独立live且跨两run、最近十次有效尝试成功率≥80%。失败历史保留，timeout/cancel与真实失败分别统计，坏记录隔离不终止其它学习。

Windows常驻宿主增加匹配裕度、负例sidecar与原知识/素材绑定、未知模态退慢路、当前绿色姓名板/黄色躯干定位。TS接当前Native教程事实→LocalAssertions→L4/L3→Body/统一闸，实际drag/move写真实原语。Seed v4记录0–1000/xyxy换算、原结果/prompt SHA，并对当前像素/OCR复核；只凭模型框不能输入。标准库HTTP路径无需安装openai SDK，凭据仍只由模块读取。

真实库先完整备份再迁移v2，备份为主out下`agent-before-governance-v2.sqlite`，SHA `219a016b4523b187f1f05264a274316ae2343d7695faaa3680c1b8da8925a6fc`。迁移记录`runtime-governance-migration.json`；修订记录`runtime-governance-repair.json`含11项修订，历史不覆盖、合格live确认新增0。旧通用world教程签名、固定NPC点技能和被拒旧条目退役；重连双按钮锚点替换共享logo技能，重复转移通过稳定ID/alias累计后续证据。状态历史与旧签名仍在报告中展示，不能把alias等同于历史删除。

最终审计16条技能：6 candidate、8 deprecated、2 alias，**0 active、0合格晋升确认**。退役的`tutorial-controls-confirm`仍显示负例失败；它不能进入反射。一条原失败late-review回执因action/session绑定不一致隔离，保留原SHA，不回填为成功。旧镜头行为实际回执仍在L3原件，其历史学习记录不能被改成治理v2合格确认；新入口会记录真实drag/move。

原生`neutral_panel_components_v1`只检查居中、大块、中性、低纹理面板，不证明所有小型/透明/高纹理弹窗缺席。真实选角仍缺场景guard；已知状态不等于可反射执行。Windows本地完整自治闭环、真实技能晋升与热路径性能目标未验收，不能以纯fixture报告已实现或达标。

## 全量验证

源码检查点`a3ff44a`；本次最后提交只更新文档。全部原日志在主out的`integration/`，没有跳过或删除旧测试。

| 检查 | 最终实际结果 | 原件 |
| --- | --- | --- |
| Python全量（含WinEye/NPC原生配置） | 942 passed，3项原有strict xfail；收集945，0失败/普通skip | python-final.log |
| TS全量（tsx实际测试项） | 752/752，0失败/取消/skip | ts-full.tap |
| TypeScript类型检查 | 通过 | typecheck.log |
| 原生治理纯fixture | 32/32；无桌面访问/输入/live确认 | native-governance-final.json |
| NPC定位保存图正反例 | 8/8；无当前桌面或输入 | npc-locator-final.json |
| 原生编译 | Input、Watchdog、ResidentHost、Relay及上述fixture通过 | 构建产物与冻结payload SHA |

首次Python为940 passed+2 failed+3 xfailed：两个动态NPC/新鲜事实fixture缺少更新后唯一schema要求的字段；修正fixture而非放宽schema后完整重跑，上表为最终结果，`python-full.log`保留失败。默认沙箱阻止WSL/Windows互操作、tsx IPC时，按授权在可互操作环境执行实际回归；不把环境拒绝算作产品测试失败或减少测试项。

## 可运行审核入口

```bash
cd /home/dw/Projects/wow-jev
.venv/bin/python tools/ui_skill_runtime.py audit \
  --database out/runtime/agent.sqlite --out out/acceptance/ui-skill-audit-next
```

该入口只读数据库、输出HTML和精确JSON，不发送输入，也不授予晋升或自动批准。实际报告：主out的`audit-report/ui-skill-audit-b2ff1380b4e4d4e55ba0b1328a690f43cc11f722213e346379e84ec7787147d2.html`，对应JSON SHA `b2ff1380b4e4d4e55ba0b1328a690f43cc11f722213e346379e84ec7787147d2`；快照SHA `975cb0bef7b4a96216fceeeabe1b483d24e46df9878e5db0576fcbada232c533`。HTML内嵌原图便于离线审核，当前约200MB；JSON与HTML原件不可原地改写。

## 现场停止与待完成验收

最新`jaina-enter-16`的会话1/Default、WoW身份/前台/选中“小呵”均确认，客户区2560×1440、DPI144。选角识别正确但guard unsupported，退Seed；API约5.802秒、总5.939秒后非法JSON被拒，0输入，释放并删除任务。超过十分钟没有有效教程进展后停止，没有继续尝试。完整现场、分层调用和冷11.186秒拆解见[交谈验收](ui-skill-learning.md)。审计期三个热源→首MOVE样本p50=181.1080ms，未达到150ms，不含先前模型/规划或未对时compositor延迟；输入已发出与效果已确认独立记录。

`jaina-*`已创建18项Resident任务均删除并独立GetTask回查，完整任务名在主out的`field-task-cleanup-summary.json`。最后任务为`WowJev-Resident-0898f6a91be643bf9273df9495d2779a`，release_all/空账本/native退出/capture关闭均确认；只读无执行器的scope不外推物理释放。没有管理员/系统设置修改，冻结世界包未改。

后续依次完成：选角模态场景证据或有效Seed慢路→恢复进世界→当前NPC定位和新局部事实→L4/L3交谈→按授权继续教程；实际独立目标确认满足客观条件后晋升，再跑两轮/五轮enter_world学习曲线；补游戏同场景单层只读对照、有效任务动作/分钟和各环节稳定分布。它们尚未通过，不拿离线/迟到后图/失败回执代替。
