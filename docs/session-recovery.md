# Windows会话恢复与第一个教程交谈

2026-10-06用户明确授权A/B/C：受限点击恢复焦点、处理选角/断线、通过战网启动正式服，并仅完成联盟战士“小啊”的第一个教程交谈步骤。授权替代此前“绝不抢前台”和“失焦只停止”，但普通动作仍严格前台。本入口在WSL用TypeScript编排，在Windows session1执行截屏、本地OCR/CV、原生输入及独立释放看门狗。不会把恢复流程称作后台输入支持。

## 执行顺序

1. 只读发现目标进程、窗口、路径/版本/启动时间、会话和客户区DPI。已有WoW则复用当前身份，不重复启动；存在但无可用窗口则有限等待，不把无窗口当进程不存在。
2. 无WoW时，只读查找战网安装位置，核对实际文件身份后在当前用户session1启动。先观察战网状态；凭据、验证、协议或更新安装界面立即停止。固定`--exec="launch WoW"`仅是一次受限启动尝试，未发现WoW时才考虑当前图上明确健康的正式服进入游戏按钮。禁止启动其它产品/账号/角色或直接绕过战网登录。
3. 选角时，当前图必须证明选中的金色行是“小啊”、战士、联盟；整屏出现名字不足以证明选中。校准CV逐一核对选中行、名字、职业和联盟徽记；布局变化或任何关键ROI不匹配保持unknown。确认后仅点击当前图的“进入魔兽世界”，再等待独立后图确认进入世界。
4. 无焦点时，仅使用当前已核验场景中的安全点击位置。原生执行闸在按下前再次核对完整客户区可见性、显示器覆盖、上方窗口区域、落点归属和空闲>5s，固定一次短左键点击。最多75ms等待激活；一旦激活后再失焦即停止，释放后再复核。可见/遮挡不确定、最小化、近期输入、按钮已被用户按住或前台复核失败都停止。不会连续尝试抢鼠标。
5. 教程初始场景只有当前同源图同时匹配吉安娜的名字标签和“与吉安娜·普罗德摩尔交谈”提示，才产生一个有限右键交谈候选。旧图只是校准来源，不能作为新观察。下一张图中独立确认与吉安娜的对话/教程步骤转换才计交谈完成；输入回执不能代替效果。完成即停，不接受或执行随后训练目标。

## 输入、取消与证据

所有点击都经恢复执行闸、串行预算和既有WinInput/WinInputWatchdog；每个动作最长100ms，原生focus_click硬上限150ms，其它原入口不变。输入进程自身按下前核对PID/start及焦点；失焦和传输/心跳中断由本地终止/释放机制处理。Windows任务宿主取消会向原执行器请求取消/释放；看门狗与所有权账本负责宿主正常finally以外的释放。缺实际release回执/账本证据时记unconfirmed并禁止继续，不能从进程退出推断成功；同树强杀及WSL重启必须另有真实验收，不从本轮推断。

一次性任务使用当前登录用户的InteractiveToken、least privilege、无触发器、固定项目payload和SHA、指定session1、有限执行期限；删除后再次GetTask核对不存在。注册/路径发现只读，不读凭据，不写系统配置。OCR只输出有限状态关键词及矩形，账号、聊天和任意识别文本不写日志。战网截图只作本地取证，不上传视觉模型；当前恢复默认本地CV/OCR，模型调用数如实记0。

Native首次成功SendInput的QPC区间是“输入已发出”；其后的独立图及状态转换是“效果已确认”。Windows捕获、CV、原生安全闸、首次发送与协调器决策/任务往返分域记录。未经对时不混减QPC与协调器单调时钟，重叠跨度不相加。冷启动/任务往返包含的延迟单独报告，本轮恢复不是single/layered成对游戏性能对照，不据少量启动点击宣称分层架构收益。Jev/执行大脑模型未参与时比例/调用计数明确未参与。

GetLastInputInfo仅描述调用会话，且SendInput也可更新时间，不能可靠区别真人与程序注入；空闲阈值只用于恢复点击前的保守闸门。[微软GetLastInputInfo文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo)。窗口落点检查是完整几何遮挡检查的补充，不能仅凭几个点或可能过期的SYSRGN宣称完整可见。[WindowFromPoint文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint)、[GetRandomRgn限制](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-getrandomrgn)。

## 校准与范围

当前包含两份真实本地截图审核后的窄布局校准：2560×1440选中联盟战士“小啊”的卡片，及同尺寸初始教程吉安娜名字/交谈提示。PNG/JSON保留原图SHA、ROI、阈值及审核依据，编译输出冻结并验证参考图SHA。更换角色、布局、客户端尺寸或教程阶段会安全停在unknown，不把参考级本地任务包转成当前任务事实。没有角色GUID或游戏内部任务ID可报告。

## 可独立运行的入口

从主checkout运行；每个run-dir必须全新。需先安装仓库已有依赖和构建原生/交互载荷，不新增软件或语言包：

```bash
bash native/windows/build.sh
bash tools/session_recovery_build.sh
python3 tools/recover.py --help
python3 tools/recover.py launch --recovery-authorized --target-character 小啊 \
  --run-dir /home/dw/Projects/wow-jev/out/recovery/launch-01
python3 tools/recover.py recover --recovery-authorized --target-character 小啊 \
  --run-dir /home/dw/Projects/wow-jev/out/recovery/talk-jaina-01
```

`launch`只恢复至独立确认的世界画面，绝不点击NPC；`recover`仅再尝试当前第一个吉安娜交谈，确认后停。默认总预算180s、单阶段30s、最多8个操作（包括启动请求）、点击100ms，均可调低不可扩成无限。Ctrl+C/SIGTERM触发串行取消及原生释放，允许最多额外6.5s的释放取证排空；没有release证据的结果仍unconfirmed。脚本不接受任意shell/executable/启动参数或凭据。

输出`summary.json`、`events.jsonl`、`trace.jsonl`、source manifest/冻结源码、每阶段request/result、PNG、OCR/CV、完整任务注册/删除/回查与原生JSONL。未知帧时可返回当前source检查点；`--review-file`只接受精确同源同target审核，不能把旧frame变新、不能覆盖认证/协议/更新硬停止。常规已校准选角及初始交谈路径无需逐帧review文件。

软件验收：全量TS538/538、Python728passed+3原有strict xfail/0skip、typecheck/diff-check通过；原生安全fixture35、窗口发现/延期心跳fixture50、真实保存图的CV正反例14检查通过。最后原生普通点击批次/落点修补另验4原生编译及21相关TS/typecheck，未放宽旧测试。窗口fixture在session0，只能验证纯候选规则/隐藏窗口拒绝/心跳序列，不冒充session1战网可见正样本；当前角色/教程校准未覆盖其它布局。现场冷启动、取消强杀和游戏效果各另报告，不能从上述软件数字外推。
