# 分段点击重连验收（2026-10-07）

一次授权重试成功，未进入教程或下一任务。前帧客户区归一化中心(0.5,0.5)，reviewer=claude，源SHA85b8f0c589086eb3b63bb8bd6f7e854177308a417fe8c07342cc3bf5ea441a76。当前帧源SHA c93707782d3f0d4b14f51eec6ffdbb4e5c0f8afe872600540859e6e38089731b；按钮MAE0.000205、Logo1.05184，未用旧帧充当新观察。

Native session cdee8e69-5f2f-41bc-8f65-6b9643fa20e6；全部时刻属于Windows QPC毫秒：MOVE完成232831783.4093，DOWN开始232831941.8505/完成232831952.5898，UP开始232832041.0697/完成232832043.8353。MOVE→DOWN158.4412ms，实际持有至少88.4799ms。input_timing首发送是MOVE；click_timing独立记录按钮DOWN。实际输入3/3，独立release_all已确认，账本键0x0/鼠标0，executor退出。

+1/+3/+8秒后图由同一Windows宿主以UP结束预约，PNG低频取证，未调用OCR/模型；实际capture开始相对UP结束1094.6488、3182.8397、8094.7504ms。+1刷新服务器列表证明离开重连页，+8选角获取列表；新step-3观察进一步CV验证小啊、等级1战士、联盟徽记。原生receipt.effect仍unknown，独立后图状态变化单独计效果。

原件：out/acceptance/click-retry-20261007/recovery/step-2-input（native-input.jsonl/result.json/post-click-*.png），step-3-observe/client.png，summary.json。maxActions=1故恢复以action_budget停止，input_issued=1/effects_confirmed=1/release=confirmed；不会自动继续教程。4个临时任务注册均删除并GetTask HRESULT80070002回查。83项相关TS、27项Python、typecheck、Windows编译通过；全量回归在集成阶段另记。
