# 自主交谈现场里程碑

2026-10-07。角色联盟战士“小呵”。用户允许游戏操作自主执行，已定位修好的程序问题直接续跑；只有原因不明的连续失败、硬停止或不可逆/系统事项才暂停。世界中等待或开发达到十分钟前须先安全返回选角，或经统一闸执行一次有界无害操作。

首任务已完成：监督已独立查看34的任务对话框，以及42的“热身0/1”任务追踪，明确reviewer=claude人工验收。`first-conversation-claude-acceptance.json` SHA e3e05959af5668523d8e518fd3dd8a1b7aee4ed5efc3734d40c8351d176b76b8记首交谈confirmed、接受热身occurred；已在agent.sqlite原run作为独立manual_effect_acceptance事件seq2回读确认。该记录不进入ui_attempt合格晋升计数，不重写原程序的假阴性，也不把人工验收当代码验证已通过。

`autonomous-controls-24` 使用同源Seed正常选角判断、进入按钮框与当前Native候选，发出一次进入世界点击，3/3且释放。原预期通用world签名不合格，程序结果保持未确认；独立后图已到世界键位教学。恢复23因OCR漏掉进入按钮未发输入，不报告恢复成功。

`autonomous-controls-27` 在证据帧刷新候选后，按当前Native教程签名及按钮内OCR选择旧`confirm_controls_intro`候选，普通代码路径发出一次确定，3/3且释放。后图为“观察四周”。旧purpose与新`tutorial_confirm`别名已兼容；confidence只作遥测，普通状态存在性、精确控件签名和Windows私有技能绑定继续生效。

`autonomous-orient-29` 当前黄色指令文字及鼠标图标修订self候选，经L4/L3一次950ms视角原语，11/11事件且释放。程序独立后图确认教程变化，原图为“与吉安娜·普罗德摩尔交谈”。这不构成治理合格晋升；真实drag回执保留，不能把旧wait配方当合格拖动成功。

`autonomous-jaina-34` 使用当帧绿色姓名板/黄色躯干检测，通过当前局部事实→L4→L3→Body/统一闸→hand发出首次交谈右键，3/3事件且释放。独立原图`frame-3-evidence-10.png`已打开吉安娜的“热身”任务对话，出现接受/拒绝控件。程序L3原结果仍`dialog_effect_not_new_or_unconfirmed`，OCR标题分词/标点后验修补另记；不迟到改判该尝试为学习合格确认。后续接任务与教程获授权，当前继续实施。

`autonomous-warmup-35` 经既有L4 sequence→L3 accept_quest→Body/统一闸→hand点击接受，3/3事件且释放。独立原图`frame-3-evidence-10.png`显示系统消息“接受任务：热身”、任务追踪“0/1 摧毁作战假人”以及右键提示“攻击一个作战假人”。负责人独立查看原图确认任务已接受。程序结果保留`target_scope_source_or_window_mismatch`：独立只读后图的目标scope沿用750ms输入时效，编码后超龄；修补只读效果scope不能放宽输入时效，也不能把原失败记录迟到改判为合格学习确认。

Windows同域最新观察→首MOVE完成：24为355.1117ms，27为230.0235ms，29为214.2487ms，34为209.5049ms，35为195.228ms。34为不可重复首次交谈n=1，不能单独报告性能分布；均未达到150ms。该范围不含之前的模型/规划及未对时compositor→回调；MOVE、DOWN、UP与后图分别有事件。五种不同动作不能混作某一代码路径的p50分布。

原件在主checkout `out/acceptance/ui-skill-learning-20261007/`；24/27/29汇总为`autonomous-physical-input-summary.json`。34执行端release、空账本、退出、capture关闭及临时任务删除/回查已确认。模型请求与动作选择分开计：27动作选择0模型，但后效视觉含3次API请求（一次重试）；29模型0，24一次视觉动作选择加两次后效请求。

34动作选择与执行的Jev/大脑/视觉调用均为0；独立对话后效慢路实际另调用Seed两次，均因锚点与控件重叠未采纳，失败请求仍计入模型调用。35本轮走代码接任务路径，另与程序效果确认区分。不能因动作选择未调用模型，把含后效请求的整轮写成0模型。

已完成JSON模式、同源一次语法/契约重试、严格数字串/对话状态机械转换，原输出及转换SHA保存；不修坏符号、不猜坐标，不重试掩盖硬停。HTML使用长边≤640的JPEG缩略图和原图链接，旧报告重渲染6,986,882字节，当前库先前快照报告7,777,601字节，均小于20MB；报告版本/快照与当前学习进度分别记录。

验证器新增当前Native任务面板组合（头像、羊皮纸、控件）、分词标题OCR、同源新增任务追踪。匹配NPC任务面板无需世界目标栏仍选中该NPC，仍核对面板的NPC与来源。当前面板修订14个其它已知状态负例通过；仅candidate、确认0。新增回归包含错误NPC、旧后效、缺头像、已有条目/缺前图/无图证明、输入时效与提交后禁止重复点击，专项TS67/67及typecheck通过。尚未现场复测新验证器，原图人工验收范围与软件回归分开。

34原后图的Native OCR只保留“小呵”和右下NPC姓名提示，没有左上任务窗标题或接受按钮，分词修补不能单独消除此样本的漏判；当前任务面板CV给出独立替代路径。原OCR白名单还缺热身、拒绝/完成与任务目标，已补有限固定词，原漏读记录不覆盖。

冻结d582cae全量Python980 passed+3原有strict xfail、0普通skip/fail，TS760/760、0skip/cancel/fail，typecheck通过。日志主`out/integration/d582cae-{python.log,ts.tap,typecheck.log}`。独立验收树最初缺忽略的capture/NPC二进制导致环境skip，补齐并完整重跑；不删/跳测试。最新审计`autonomous-audit-first-conversation/`，JSON SHA 2df449748e99518efd07c1b6243beb57894d41656bd2a0d72c28d749d67b9d06，HTML19,772,636字节，active0/治理合格确认0。

安全回程43一次登出点击3/3释放，源码061343f。+15s后图为倒计时，+25s帧超时，原结果保留failed；只读44的新原图到选角，当前留在选角进行下一步开发。所有该轮临时任务删除回查，输入端退出/空账本/capture关闭已确认；只读44未取得输入端，不能冒充一次物理释放验证。
