# Windows 只读战斗日志旁路

本模块不启动游戏、不启用游戏日志、不操作窗口或键鼠。它读取已落盘的 `WoWCombatLog*.txt`，输出具有文件身份、代际、字节offset、原行hash和Windows接收QPC的JSON。游戏缓冲后才写盘的延迟不是reader轮询能消除的。

```bash
bash tools/combat_log_build.sh
out/combat-log-tools/WinCombatLog.exe \
  --file 'C:\游戏目录\_retail_\Logs\WoWCombatLog.txt' \
  --session 11111111-1111-4111-8111-111111111111 \
  --from end --duration-ms 30000 --poll-ms 250 --max-lines 10000
```

使用`--directory`可选择新写入的`WoWCombatLog*.txt`，与`--file`互斥。默认从已有文件末尾挂接，新文件代际和截断从头读；半行/UTF-8跨块保留。EOF取消、期限和行数上限均有限退出。错误UTF-8或超长行单列错误，不悄悄输出为游戏事件。

TypeScript `readCombatLog()` 校验新协议、session和文件代际，`CombatLogParser`支持V22头和CSV词法、保留原时间戳/小数精度。它不把文件字段误当CLEU数组，也不从GUID候选猜来源/目标或视觉绑定。未验证事件payload schema的字段保留原数组；本模块结果全部`eligible_for_current_state=false`，用于历史与复盘。接收QPC和WSL接收单调时间分开，迟到事件不刷新成当前状态。

本机日志版本/真实写盘延迟尚须读取实际头部并在手动游戏场景对照验证。公开12.1/V22样例不是本机生成记录。正常日志文件没有新行，不能推断非战斗、未施法或目标不存在。

`/combatlog`控制游戏是否写日志，高级日志设置不是该开关；模块不会替用户高频切换或强制刷新游戏日志。当前12.x Lua战斗读取受secret/secure限制，本实现不尝试绕过，也不依赖SavedVariables实时写盘。
