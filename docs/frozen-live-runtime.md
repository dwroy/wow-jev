# 已批准源码的真实任务启动

`system live` 和 `system observe` 支持 `--registry DIR`。父入口只选择一个已经验签的版本，把完整源码复制到独立临时目录；新子任务再验签原包、核实自己的实际执行源码、依赖 lock、知识和 Brain/Jev prompt。当前指针之后变化不会改变已运行任务；下一任务重新选版本。源码生成目录、依赖链接和运行结果分别存放，结果保留在用户给出的持久 run-dir。

```bash
npm --prefix agent run system -- observe \
  --registry /absolute/registry \
  --window HWND --pid PID \
  --client-profile /absolute/game-data/profiles/retail-cn-12.1.0.69933.json \
  --run-dir /absolute/persistent-run
```

真实输入仍需 `live --live --role-scene-confirmed --goal FILE`，并经过已有统一 gate、有限执行、取消与 Windows 释放看门狗。observe 不创建输入执行器，不抢焦点。模型仍需 `--seed --allow-game-image-upload` 两个开关；API key 不从父环境继承，启用模型时只把显式凭据文件路径传给需要的 worker。冻结启动保留 Windows/WSL interop 所需环境项，后台截图和版本探针按原有真实适用条件验证。

旧发布包可能只有模拟入口，不能用它改变标签后运行当前 main 的 live 实现。真实冻结模式要求发布包内含本启动实现和 Jev prompt；不支持时返回明确错误。用户不能用 `--executing-source-sha256`、`--runtime-version-file` 或 `--native-root` 冒充已批准版本。registry 中的外部 goal、bindings、校准、客户端 profile、评价 context 和 Seed env-file 在父入口先变成绝对路径，再传给子任务。inline live 仍提供原入口，其日志不宣称来自已发布冻结包。

registry 启动的依赖根由实际执行的 launcher 模块路径独立确定，`--repo-root` 不能替换 bootstrap loader 的执行权限。相同 package-lock 也不能让其它目录的 loader 运行；子任务还核对实际 `--import` 路径与父记录的 loader SHA。这里使用当前已安装可信依赖，不把用户可传路径当作依赖来源证明。

实际 Windows 客户端版本 probe 固定使用可信 `/usr/bin/python3`；`--python` 只配置模型 worker，不能替换版本核验解释器或冒充进程元数据。没有启用模型时，该 wrapper 不会因版本 probe 被执行。

## 原生构建与相同字节复用

源码包不包含 ignored `native/windows/bin`。子任务将批准的 `.cs`、`build.sh` 等原生源码复制到独立生成目录，调用冻结 `build.sh` 和本机固定 Windows Framework4 `csc.exe`，复核构建前后源文件。实际编译器、源码、script、输出日志和每个二进制 SHA 进入证据。

每个缓存二进制复制后立即复核实际字节，首次 list/probe/hand 调用之前再检查整套 source/bin/compiler；编译器在构建前后也必须保持同 SHA。写 proof 时仍再次检查，不能先运行错误字节再由后续日志发现。

Framework4 csc 同源码重复编译的 PE 字节实际不同，不能忽略二进制差异做游戏收益比较。因此使用 registry 内 `native-builds/` 的不可变签名缓存：key 来自原生源目录、build.sh 和实际 compiler SHA；初次实际构建后保留源来源版本、日志、完整输出字节和 HMAC。后续复核原创建版本的批准包、对应原生源及签名，复用完全相同的二进制；TypeScript/prompt 变更不会导致原生字节凭空改变。原生源或编译器变化产生新 key，真实比较仍严格区分。

每个真实任务保存 `native-build.json`、`native-build-cache-proof.json`、构建 stdout/stderr，以及 `native-proof/source/` 和 `native-proof/bin/` 实际文件。manifest 记录来源、是否复用与所有 hash。`system replay`、严格学习来源和游戏对照会独立复核这些文件、HMAC、批准源码/原创建包、manifest 原生组件和日志；改写任一源、二进制或 proof 不能仅靠一致的版本标签通过。缓存失败/损坏会拒绝启动，不自动降级为 main 二进制。

## 验证范围

新增测试覆盖伪版本/hash/native override、依赖链接、未批准文件、固定代码/prompt，既有模拟和取消测试保留。原生持久证据用明确标为 synthetic 的签名 fixture 测试逐项篡改拒绝；这些 fixture 不是游戏或编译验收。真实 Windows 同源码两次构建已证明 PE hash 不同；当前正式服另执行冻结只读 observe，验证实际编译、缓存复用和严格回放。真实输入、版本收益与整个 WSL 重启仍需分别验收，不能由只读结果外推。

本轮修复版 `259c0f6` 的实际证据在 `out/acceptance/retail-closure/frozen-live-agent-2`：两轮各 2 观察/21 记录，actual client 12.1.0.69933/CN/zh_CN，首次真实编译、第二次复用，4 个 exe 字节 SHA 相同；两次独立回放均通过，真实/模拟输入和 native_input 记录均为 0，game_effect 保持 unverified。专用 registry 不改变负责人正式版本指针。该提交分支全量 245 项 TS 和类型检查通过。

随后最小版本 probe 修复 `f4a4937` 已通过公开 CLI/stub 回归：即使用户指定自选 Python wrapper，实际 metadata probe 仍用 `/usr/bin/python3`，wrapper marker 没有创建，未生成输入或运行日志。6 项该测试族和类型检查通过。对其再次尝试真实只读时，旧 HWND/PID 已不再被枚举，两个尝试均在 `system_live_only_bound_wow` 拒绝；原始记录在 `frozen-live-agent-3`，不能把这两次拒绝报成通过。前一原型的缺 profile 路径失败及后续只读记录保留在 `frozen-live-agent-1`。
