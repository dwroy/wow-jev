# Windows会话恢复

2026-10-06用户明确授权A/B/C：受限点击恢复焦点、处理选角/断线、通过战网启动正式服，并仅完成联盟战士“小啊”的第一个教程交谈步骤。授权替代此前“绝不抢前台”和“失焦只停止”，但普通动作仍严格前台。本入口在WSL用TypeScript编排，在Windows session1执行截屏、本地OCR/CV、原生输入及独立释放看门狗。不会把恢复流程称作后台输入支持。

## 执行顺序

1. 只读发现目标进程、窗口、路径/版本/启动时间、会话和客户区DPI。已有WoW则复用当前身份，不重复启动；存在但无可用窗口则有限等待，不把无窗口当进程不存在。
2. 无WoW时，只读查找战网安装位置，核对实际文件身份后在当前用户session1启动。先观察战网状态；凭据、验证、协议或更新安装界面立即停止。固定`--exec="launch WoW"`仅是一次受限启动尝试，未发现WoW时才考虑当前图上明确健康的正式服进入游戏按钮。禁止启动其它产品/账号/角色或直接绕过战网登录。
3. 选角时，当前图必须证明选中的金色行是“小啊”、战士、联盟；整屏出现名字不足以证明选中。校准CV逐一核对选中行、名字、职业和联盟徽记；布局变化或任何关键ROI不匹配保持unknown。确认后仅点击当前图的“进入魔兽世界”，再等待独立后图确认进入世界。
4. 无焦点时，仅使用当前已核验场景中的安全点击位置。原生执行闸在按下前再次核对完整客户区可见性、显示器覆盖、上方窗口区域、落点归属和空闲>5s，固定一次短左键点击。最多75ms等待激活；一旦激活后再失焦即停止，释放后再复核。可见/遮挡不确定、最小化、按钮已被用户按住或前台复核失败都停止；近期输入仅在原阶段预算内只读等到严格空闲>5s，始终不发点击，超时停止。不会连续尝试抢鼠标。
5. 独立确认可玩世界后立即停止。2026-10-07 起 `recover` 与 `launch` 都不执行NPC交谈；首个教程通过[局部证据到四层执行](tutorial-layered-runtime.md)的独立入口，复用L4/L3/Body/统一闸。当前校准HUD可作为只读world与安全focus锚点，不能输出NPC动作或完成结果；其它world画面需要独立场景证据，unknown仍停止。

## 输入、取消与证据

所有点击都经恢复执行闸、串行预算和既有WinInput/WinInputWatchdog；每个动作最长100ms，原生focus_click硬上限150ms，其它原入口不变。输入进程自身按下前核对PID/start及焦点；失焦和传输/心跳中断由本地终止/释放机制处理。Windows任务宿主取消会向原执行器请求取消/释放；看门狗与所有权账本负责宿主正常finally以外的释放。缺实际release回执/账本证据时记unconfirmed并禁止继续，不能从进程退出推断成功；同树强杀及WSL重启必须另有真实验收，不从本轮推断。

一次性任务使用当前登录用户的InteractiveToken、least privilege、无触发器、固定项目payload和SHA、指定session1、有限执行期限；删除后再次GetTask核对不存在。注册/路径发现只读，不读凭据，不写系统配置。OCR只输出有限状态关键词及矩形，账号、聊天和任意识别文本不写日志。战网截图只作本地取证，不上传视觉模型；当前恢复默认本地CV/OCR，模型调用数如实记0。

Native首次成功SendInput的QPC区间是“输入已发出”；其后的独立图及状态转换是“效果已确认”。Windows捕获、CV、原生安全闸、首次发送与协调器决策/任务往返分域记录。未经对时不混减QPC与协调器单调时钟，重叠跨度不相加。冷启动/任务往返包含的延迟单独报告，本轮恢复不是single/layered成对游戏性能对照，不据少量启动点击宣称分层架构收益。Jev/执行大脑模型未参与时比例/调用计数明确未参与。

GetLastInputInfo仅描述调用会话，且SendInput也可更新时间，不能可靠区别真人与程序注入；空闲阈值只用于恢复点击前的保守闸门。[微软GetLastInputInfo文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo)。窗口落点检查是完整几何遮挡检查的补充，不能仅凭几个点或可能过期的SYSRGN宣称完整可见。[WindowFromPoint文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint)、[GetRandomRgn限制](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-getrandomrgn)。

## 校准与范围

当前包含两份真实本地截图审核后的窄布局校准：2560×1440选中联盟战士“小啊”的卡片，及同尺寸初始教程吉安娜名字/交谈提示。PNG/JSON保留原图SHA、ROI、阈值及审核依据，编译输出冻结并验证参考图SHA。阶段一已增加按客户区与UI比例、锚点变换的ROI匹配；角色、布局或教程证据不匹配会安全停在unknown，不把参考级本地任务包转成当前任务事实。没有角色GUID或游戏内部任务ID可报告。

## 可独立运行的入口

从主checkout运行；每个run-dir必须全新。需先安装仓库已有依赖和构建原生/交互载荷，不新增软件或语言包：

```bash
bash native/windows/build.sh
bash tools/session_recovery_build.sh
python3 tools/recover.py --help
python3 tools/recover.py launch --recovery-authorized --target-character 小啊 \
  --run-dir /home/dw/Projects/wow-jev/out/recovery/launch-01
python3 tools/recover.py recover --recovery-authorized --target-character 小啊 \
  --run-dir /home/dw/Projects/wow-jev/out/recovery/ready-01
```

`launch`与兼容的`recover`均只恢复至独立确认的世界画面，绝不点击NPC。默认总预算180s、单阶段30s、最多8个操作（包括启动请求）、默认点击60ms（上限100ms），均可调低不可扩成无限。Ctrl+C/SIGTERM触发串行取消及原生释放，允许最多额外6.5s的释放取证排空；没有release证据的结果仍unconfirmed。脚本不接受任意shell/executable/启动参数或凭据。

输出`summary.json`、`recovery.jsonl`（事件与分域trace）、`manifest.json`/冻结源码、每阶段request/result、PNG、OCR/CV、完整任务注册/删除/回查与原生JSONL；摘要的`trace`保留同份span/mark。未知帧时可返回当前source检查点；`--review-file`只接受精确同源同target审核，不能把旧frame变新、不能覆盖认证/协议/更新硬停止。常规已校准选角路径无需逐帧review文件；独立教程识别与执行不属于recovery。

初版全量TS538/538、Python728passed+3原有strict xfail/0skip通过；live-01只读实际发现断线公告中的账号文字误触强认证阻塞，及零面积上方窗口误拒。这属于程序误判，不是用户需要输入凭据的证据；原件保留，输入0。修补后最终全量TS546/546、Python729passed+3原有strict xfail/0skip、typecheck/diff-check通过；C45项/桥27项、原生安全fixture42、窗口发现/延期心跳fixture50、真实保存图的CV正反例14检查通过，新增真实断线图的本地OCR回放。没有删改或跳过旧测试。

账号/登录等泛词仅在中心成对表单上下文构成认证要求，密码/验证码/二次验证等强词仍即时停止。中心明确断线标记与当前确定框配对才可确认一次，重连需后图重新取证；通用“确定”没有输入资格。零面积窗口无可见区域，明确排除并记录；反向矩形/仍存在但API失败仍拒绝。可选QPC元数据拆截图API、PNG编码写盘、窗口安全复核、CV/OCR；旧capture envelope包含PNG，fallback API envelope还包含可见性复核，分别标注范围。

窗口fixture在session0，只能验证纯候选规则/隐藏窗口拒绝/心跳序列，不冒充session1战网可见正样本；此处为历史初版记录；2026-10-07阶段一已补不同尺寸/比例回归，现场其它游戏阶段仍需独立证据。现场冷启动、取消强杀和游戏效果各另报告，不能从上述软件数字外推。

最新现场与完整延迟见[恢复验收](acceptance/session-recovery.md)：第二轮正确识别断线，但完整客户区检查发现上方窗口0x400ce区域相交，停止在恢复点击前。两轮均0游戏输入，首个交谈未完成；当前需要用户移开遮挡，再以新取证继续。四项临时任务已删除并独立回查，没有系统配置改动。

2026-10-07边界迁移：原45项恢复测试保留，重验恢复只到world ready；交谈输入/效果测试迁到tutorial分层链路。当前两个命令的goal_effect最多world_confirmed，没有first_conversation_confirmed终态。阶段二专项与未接入常驻memory证明的限制见[教程运行契约](tutorial-layered-runtime.md)。
