# 操作技能严谨性审计与整改验收

监督与验收方：Claude 与用户。当前吉安娜交谈完成或真实阻塞后停止练习；任何技能晋升前先完成 P0，并提交逐条 HTML 报告审核。修完全绿后只推送 `codex/agent-system`，批准后恢复五轮练习。

## P0 治理

1. 仅 `user`、`claude` 审核使 state/signature/skill 获 active 资格；`self`、`seed`、`seed_model` 只能 candidate/pending_review。提案者不能自审。user rejected 不得被 self/seed 覆盖。审核按条目生效，不重写整个 state。
2. 学习者在后图独立重算 approved 目标签名；不信任执行者 effect proof。expected_effect 必须绑定目标签名。
3. 迟到审核不能将失败回执改判 confirmed 计入晋升；人工补录独立证据，不计确认数。
4. 至少两次独立 live 确认、至少两个 run、最近 N 次成功率至少 80%。成功不清零失败历史。timeout/cancel/真实失败分别记录。

## P0 识别

5. reconnect 不能只用共享 WoW logo，必须有重连按钮等区分锚点与负例。
6. 通用 in_world 不能绑定“与吉安娜交谈”教程提示，迁移到 tutorial_talk_jaina。
7. 签名对其它全部已知状态样本做负例验证；置信度按匹配裕度计算，不恒为 0.95。
8. NPC 不是固定 UI 元素。反射交互必须按当前帧名字/姓名板检测定位，技能存方法，不存参考图固定点击坐标。
9. 清理重复 char_select、look_around、controls 状态/签名；技能 ID 不带帧 SHA，同一转移累积确认。

## P1 动作与安全

10. schema 支持 drag/move；950ms 右键拖动、150ms W 必须记录真实动作和尝试，不能记 wait。
11. 硬停止依据屏幕输入框/验证码/协议勾选/更新进度等视觉/OCR证据，去 label/state_id 关键词正则；硬停签名加载不受审核影响，同帧换 state_id 不可绕过。
12. 未知模态/异常退慢路，不盲目反射执行。
13. Seed 明确 0–1000 或 xyxy 坐标转换；模型框经当前像素/OCR复核才采纳。技能出处记录 prompt 版本、结果 SHA。

## P2 追溯与验收

14. attempt 带知识版本、代码 SHA、prompt 版本；技能修订不可原地覆盖，每次学习更新有快照。
15. 单条坏记录隔离并报告，不退出整个学习者。
16. `ui-skill audit` 导出 HTML：state 签名裁剪、全部负例结果、源帧元素叠框、技能动作/预期、确认失败明细、前后缩略图、审核链。active 前 Claude/user 审核该报告，批准绑定实际报告 SHA 和条目修订。

安全边界：普通游戏输入前核验当前目标身份与前台、有限时长、取消、释放与看门狗；认证/验证/协议/更新硬停。冻结世界包不修改。历史不合格记录保留为候选或补充证据，不回填成合格 live 成功。
