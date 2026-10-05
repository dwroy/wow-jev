# 代码 play 与基础技能

第3阶段工程版本支持有限计划、统一执行闸、串行调度、取消锁存和效果记录。Windows负责执行时长、焦点及独立释放；WSL负责编排。此次验收不接模型，既有眼的Seed方案保持不变。

## 纯模拟体验

```bash
npm --prefix agent run play -- demo --rounds 5
```

五轮共25步：E短前进、右键小幅拖拽转向、SPACE跳跃、背包打开、背包关闭。demo只推进模拟状态，不启动Windows进程、不发送键鼠、不读凭据；回执为simulated，效果为not_applicable。输出包含run_dir；程序结束会独立回放。

```bash
npm --prefix agent run play -- replay --run-dir /absolute/path/to/run
```

回放不输入、不截屏、不调用模型。源图、配置、校准、schema、计划/步骤、出站命令、原生回执与效果逐一关联；模拟不能伪造真实输入，取消后不能继续出手。只证明记录中已有的事实，不推断没有观察到的效果。

## 正式服体验

当前角色向前为E，跳跃SPACE，背包B；转向用右键拖拽，不假设WASD。动作槽默认没有映射，use_action_slot需明确配置。改变角色键位时提供完整bindings文件，参考`profiles/play/retail-esdf.json`。

先进入非战斗的空旷角色场景、下坐骑并关闭任务/设置/冒险指南，列出当前窗口并替换以下HWND/PID；游戏重启后不能复用旧身份。运行期间保持前台且不同时手动操作。以下校准已在当前3840×2160布局与B同时开闭全部背包的五轮中验收；分辨率、UI布局或独立单包操作变化时须重新校准。旧2048×1536校准不能用于4K。

```bash
npm --prefix agent run input -- list

npm --prefix agent run play -- live \
  --window 0xHWND --pid PID --live --role-scene-confirmed --rounds 1 \
  --calibration /home/dai/Projects/wow-jev/out/acceptance/stage-3/calibration/retail-bag-4k-buttons-v2/calibration.json
```

默认最多30秒等待用户手动聚焦，不抢游戏焦点；角色场景确认是启动者的明确声明，不能由“截图可用”推为角色可操作。live必须显式确认，模型不参与本轮代码计划。计划最多50个有限步骤，原生单次技能默认最多1000ms，整轮默认上限60秒。

每步重新读取实际截图、窗口和状态，检查750ms时效、目标身份及计划版本；写意图之后再次检查才发出。背包只在当前校准CV已知时按B，已经处于目标状态不再输入；只观察轮询，不重发B。无法确认背包变化或输入计数/释放异常时，整轮停止。移动、转向和跳跃目前效果为unknown，不以完整输入回执当游戏效果已确认。

新终端取消使用启动输出的session_id：

```bash
npm --prefix agent run play -- status --session-id UUID
npm --prefix agent run play -- cancel --session-id UUID
```

Ctrl+C、SIGTERM、跨终端cancel，以及Windows Ctrl+Alt+F10可停止。play取消锁存整份计划，动作间隙也不会继续下一步；需要重新启动才恢复。取消控制响应若无法确认释放，返回非零退出码；日志中的unconfirmed保持原义，不能改成confirmed。

## 工程验收入口

`tools/play_acceptance.py`默认仅模拟；`tools/play_native_acceptance.py --run-live-tests`仅针对自己的PlayFixture，真实键鼠测试需Windows桌面临时空闲。fixture默认不激活窗口，只有显式测试控制才改变自己的焦点；其UI标记不是游戏背包。构建仅编译，不打开窗口：

```bash
bash tools/play_fixture_build.sh
bash native/windows/build.sh
```

有限键鼠工程验收、正式服效果与模型决策是不同层次；验收状态见[第3阶段记录](acceptance/stage-3.md)。
