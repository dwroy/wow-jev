# 第3阶段：代码 play 工程验收

更新：2026-10-05。主循环、执行闸、基础技能、CLI/跨终端取消、计划回放已实施；负责人已完成独立代码审查、自动回归、纯模拟和真实专用窗口整链验收。**正式服首轮包含人工输入干扰并在最后背包关闭时停止，完整五轮仍待补测，暂不标整个第3阶段完成。**

## 实现与边界

TypeScript CodePlay串行运行有限计划，每步采样并两次检查观察来源、750ms时效、窗口身份、计划版本与条件。取消/失败锁存；不重试输入、不自动恢复。E短移动、右键拖拽转向、SPACE跳跃、背包开闭，以及明确绑定的技能槽由纯技能编译器生成；槽默认未绑定。背包已有目标状态时不发输入。

背包效果须原生完整终端计数与released、终端收到后的新图、同窗口/校准和有效CV一致；其它技能保持效果unknown。先冻结配置/计划/schema/源码及二进制指纹，出站命令与原生回执分开记录；不混减Windows QPC与WSL时间。模拟不启动原生进程，来源全simulated，输入simulated、效果not_applicable。

Windows候选枚举增加严格的PlayFixture进程名+自己的标题前缀；WoW/旧记录窗口筛选仍保留。专用fixture使用真实Windows事件与GetAsyncKeyState，B只在非repeat keydown切换可校准UI标记，不发OS输入、不伪清零物理键态。

## 负责人验证

- TypeScript类型检查、全套106项测试通过，包括旧阶段回归、技能解析、取消/超时/部分输入、迟到回执、出手时效、步骤缺口、控制socket关闭与真实CLI模拟子进程。
- Windows C#5/.NET4原生四模块与PlayFixture实际编译通过；Python验收入口py_compile通过。
- `demo-1`/`demo-2`：五轮25模拟步骤与独立回放均exit0，零native输入/捕获/真实效果。demo-1曾未传递helper rounds参数，原始记录保留；helper已修，demo-2明确传5轮。
- `passive-fixture-1`：默认窗口不改变前台、零焦点控制/OS输入；只内部切换标记，两张真实截图的原生离线CV均正确。此项不是实时游戏动作效果。
- `native-2/five-rounds`：真实Windows专用窗口25动作、124/124原生插入事件，所有终端回执完整且released；10次标记开闭confirmed、15次移动/转向/跳跃保持unknown，独立回放与出手时效核验通过；E/SPACE各收到5次、B切换10次，结束标记关闭，物理键鼠全释放。
- `native-2/already-open`：真实当前状态已满足，零native输入、标记不再切换，回放通过。
- `native-2/external-cancel`：长按E期间从另一个CLI进程取消，后续SPACE步骤未执行，未向secondary发新keydown/mousedown；物理释放与严格回放通过。
- `focus-retest-1`：长按E期间切换自己的secondary，原生停止，整轮failed且仅一个步骤；零迟到跳跃，物理键鼠全释放，严格回放通过。原生因失焦终止后，关闭通道release仍为unconfirmed；独立物理观测证明释放，不改写缺失的关闭ACK。

上述专用窗口用例只绑定自己的fixture；“10次标记效果”不能当游戏背包验收。模拟反例也不能替代整个WSL重启或Windows强杀恢复测试。

## 正式服首轮与辅助接取

`retail-1`重新枚举WoW为HWND 0x6407cc、PID6932、2048×1536。初始画面位于熔岩且生命值约一半，未发送移动；用户手动移到平地并恢复生命后，用一次60ms ESC关闭设置，再运行五轮。25个唯一出站动作与25个终端回执对应（另有25个accepted消息），累计125/125事件且全部released；前24步完成、9次游戏背包开闭效果confirmed。最后B之后冒险指南消失，但背包仍开，新图持续CV=true，1.5秒观察到期停止；cancel/release_all/shutdown和最终关闭均确认释放。独立回放exit0，结果保持failed/complete=false，不重发B。

用户确认测试期间有人工操作；冒险指南从observation-0即覆盖运动视野，不能归因为最后一步才出现，也不能把画面变化全归给agent。独立审查直接看五轮30张运动前后图：移动有背景平移、跳跃后有纵向变化，但角色被遮挡，转向起点落在面板内、背景基本未变。因此15个运动效果仍unknown，该轮不是完整正式服通过记录。原始失败不覆盖。

随后用户要求接取面前三项任务。`quest-assist-1`记录负责人逐次观察、短点击及有限靠近，已接“原始龙害”“探险者遇险”“练手材料”；任务对话、游戏聊天和追踪均有对应图，用户确认完成。这不是自主任务执行或CodePlay计划验收。computer-use初始化在WSL报sandboxCwd不是local file URI，改用既有项目执行器；没有绕过权限审批。

期间窗口改为3840×2160。旧2048校准失效，当前正式服五轮需新校准、关闭面板并避免人工操作后补测；不根据专用fixture或受干扰首轮标为通过。

## 实际失败与修复

`native-1`在任何输入前被CLI拒：既有原生list只枚举WoW与InputRecorder，新PlayFixture未列入；已按严格进程名+专用标题前缀补候选，并构建后继续。原失败不覆盖。

`native-2/focus-loss`已实际停止/释放但回放拒plan_status_mismatch：已知原生window_unfocused失败先到，后续断连cancel却把计划改成cancelled。已修已知失败步骤优先级、保留原生错误并补竞态回归；`focus-retest-1`真实补测通过。原始failed记录保留，不修改成成功。

独立审查还修复：启动取消无plan日志时保持incomplete；半关闭socket不能阻止收尾；step_started落盘等待期间取消也补齐step_result，避免缺步骤；logger延迟之后再次gate；实际输入日志入队后同调用栈发出，不插入可能跨取消的await。

## 证据与体验

证据在主checkout `out/acceptance/stage-3`：原生记录窗口状态、采样/图像、校准、CLI输出、冻结manifest、动作意图、计数和回放。当前meta保存对应实际版本及源码/原生二进制SHA，失败和补测分开。凭据未读取，模型未调用。

使用入口见[play-runtime.md](../play-runtime.md)。代码play已可工程体验；正式服需按3840×2160新布局校准，再做无干扰五轮并复核游戏画面。所有真实输入仍通过原有Windows独立释放看门狗；整WSL重启、自动弹窗检测、移动等自动效果确认尚未验收。
