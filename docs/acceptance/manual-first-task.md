# 人工审核优先现场轮次

2026-10-07，稳定业务基线3acb376。reviewer=claude明确审核原帧SHA f60daaacd71fc016cf6dbc53dc7d876305326eb0e49ad56769fd477e57498737，2560×1440客户区正中重连bbox x.431–.569/y.474–.526、center(.5,.5)，logout y.603避让。新帧路径主out/acceptance/manual-first-task-20261007/readonly-01/evidence-2.png，SHA fadc64a68529beb8836bf597e40bb7de4d1cfd8708382227dc06779fba8bf66b；重连ROI mean absRGB .00065264、独立logo .686516，与原审核图相符。人工来源/归一化bbox/新旧SHA存claude-reviewed-reference.json，不刷新原参考戳或冒充Seed/CV自动识别。

输入桌面Default/UOI_IO=true，Wow目标身份/物理2560×1440/DPI144一致；前台却是0x3607de/PID32924/class CASCADIA_HOSTING_WINDOW_CLASS/start639269272456499052，标题“管理员: Windows PowerShell”。实际高Z/矩形遮挡已原生确认。用户已授权仅移动/最小化遮挡窗口，不关闭或输入其内容；本轮编译固定ForegroundOccluderMinimizer，保持least privilege，只操作此已核验的单窗口并在1.5s内复核WoW前台。

ShowWindowAsync(SW_MINIMIZE)实际FALSE/GetLastError5，遮挡窗未最小化、FG仍0x3607de。按切换后前台复核失败必须停止，没有第二切换、提升权限、绕过系统限制或重连点击。键鼠/游戏输入0，无输入执行器或按键所有权，release_scope仅no_input_executor_acquired。首任务未完成，观察→输入及效果n=0，没有150ms成绩；没有继续OCR/模板研究。

两项最低权限临时任务创建后删除，分别在lifecycle中GetTask80070002独立回查：

- WowJev-Resident-aeecd391f5bd494985dd5aa9d385ebe5
- WowJev-OccluderMinimize-647e63f381e14b2f9b66af1c69a924a3


原件/程序SHA/任务XML/真实错误和summary在主out/acceptance/manual-first-task-20261007。C#编译通过、实际只读及权限拒绝路径已执行，diff检查通过；不冒称完整软件测试复验或强杀释放。本轮在隔离树提交记录和固定helper，主树只ff-only集成，不推送。用户可在本机最小化该管理员窗口并点击WoW，或明确选择管理员上下文执行同一精确动作，再重新取证继续。
