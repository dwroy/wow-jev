# 第 7 阶段：离线迭代和任务边界版本

这个入口把真实学习事实引用、修改提案、隔离 Git 工作树、固定回归和版本切换接通。它不发送游戏输入，也不调用视觉或决策模型。历史回归可以检查协议与决策边界，不能证明替代动作带来游戏收益。

## API

```ts
import {
  createIterationProposal, IterationRuntime, RuntimeVersionRegistry,
} from './learner/iteration/index.js';

const runtime = new IterationRuntime({ repository, candidatesRoot, registryRoot });
await runtime.registry.registerBaseline({
  versionId: 'baseline', repository, knowledgeFile,
  prompts: [{ id: 'brain-retail-v1', file: 'perception/prompts/brain-retail-v1.txt' }],
  approvedBy: 'codex',
});
const proposal = createIterationProposal({
  id: 'movement-evidence-v2', description: '真实运动输入的效果仍未确认',
  knowledge, factIds: ['实际知识卡的ID'], baseCommit: '完整Git提交SHA',
  changes: [{ kind: 'prompt', path: 'perception/prompts/brain-retail-v1.txt',
    expected_sha256: originalSha256, content: proposedPrompt }],
  promptExpectations: [{ path: 'perception/prompts/brain-retail-v1.txt',
    required: ['npc.in_interaction_range', 'ui.npc_dialog_open'], forbidden: [] }],
});
const candidate = await runtime.prepare(proposal, knowledgeFile);
const evaluation = await runtime.evaluate(candidate.id);
const version = await runtime.publish(candidate.id, {
  versionId: 'runtime-v2', evaluationId: evaluation.id, approvedBy: 'codex',
});
const nextTask = await runtime.registry.resolveForTask();
await runtime.registry.rollback('baseline');
```

`prepare`返回`CandidateManifest`；`candidate.worktree`是实际detached工作树，父目录保存提案清单、冻结知识、签名评估收据和发布记录。知识文件按原始字节 SHA256 校验；知识存储器的 canonical 文件可以直接传入。真实来源失败或`complete=false`可以支持失败经验，不能冒充成功。模拟来源不能支持“真实问题”提案。

`changes`只接受`kind/path/expected_sha256/content`。新文件必须给`null`，已有文件必须给原字节 SHA256。只允许`agent/src/**/*.ts`和`perception/prompts/*.txt`，拒绝绝对路径、`..`、反斜线、隐藏文件、符号链接、重复路径和未声明改动。手、system启动、eval、iteration、底层进程执行、技能输入和actions/凭据路径属于保护模块。提案不能传可执行命令。代理写入的代码仍需要负责人审查；固定回归在WSL用户进程中运行，不是针对恶意代码的操作系统隔离沙箱。

两个评估profile都运行固定的TypeScript类型检查、候选提交中未被修改的既有TS回归测试，以及数据形式的提示断言。代码修改必须使用`code-regression`。依赖来自主项目既有node_modules；提案不能变更依赖、测试或评估实现。命令直接spawn，不使用shell，不读取stdin，环境不继承凭据，HOME为不可用路径；固定GIT_CONFIG_GLOBAL只指向OS用户全局Git身份配置，让临时仓库测试继续使用全局身份，避免仓库级user.*。超时或输出超限会杀死POSIX进程组，原始stdout/stderr不写入报告，只保存状态、退出码、输出长度和SHA256。

评估工具自己写HMAC签名收据，绑定清单和全部源码字节。传入`passed:true`无法替代工具评估。评估后再次检查候选，发布前又核对清单、来源、知识、完整源码和签名；失败或被修改的候选不能激活。候选之外的签名密钥仅本地保存在运行目录，不放入候选、发布包或日志。评估通过以后，`approvedBy`记录已获授权的负责人具体验收。

## 版本与任务

registry按不同ID只创建一次`versions/<id>/package`；重复ID不覆盖旧release。包内有`runtime.json`、签名seal、代码提交的完整普通源码快照、冻结知识、全部提示和候选评估证据。每次resolve核对exact shape、ID、相对路径、regular file、文件SHA和源码树SHA。指针`current.json`只引用已经发布的完整包；`activate`和`rollback`都先验证包。

`resolveForTask()`返回深冻结的`{version, knowledge, prompts, code_root, code_source_sha256}`。`version`符合共享`RuntimeVersion`；其中知识/提示的`file`是包内相对位置。执行者直接使用snapshot的知识与提示内容，并从已核验`code_root`装载任务代码。当前任务必须只取一次snapshot；新指针只影响下一任务。旧snapshot的内容不随activate/rollback变化。已取得的纯数据也不会因包后来被篡改而改变；新的resolve会拒绝篡改包。

源码包不含`.git`、node_modules或符号链接。system launcher负责把已验证源码复制到任务专用目录，核对锁文件后挂接依赖，再启动冻结代码。仅保存commit而继续运行当前checkout代码不能证明代码版本切换。

## 用户入口

不改既有package脚本。可以从项目根用既有tsx运行：

```sh
agent/node_modules/.bin/tsx tools/iteration_demo.ts \
  --repository "$PWD" \
  --knowledge out/acceptance/stage-6/knowledge.json \
  --fact 实际运动未确认知识ID \
  --prompt perception/prompts/brain-retail-v1.txt \
  --output out/acceptance/stage-7/demo-1 \
  --approvedBy codex
```

该demo需要第6阶段产出的真实知识文件和正确fact ID，输出目录须是一次新的运行目录。它真实创建Git工作树、冻结baseline、评估并发布提示candidate，验证旧任务/下一任务版本与rollback；只做离线回归。实际模型对照需要另行保存源图、prompt版本、模型响应与采纳依据，不能用这个demo冒充模型调用。

单步CLI为`agent/src/learner/iteration/cli.ts`。命令包括`baseline --config <JSON>`，`prepare --proposal <JSON> --knowledge <JSON>`，`inspect/evaluate --candidate <ID>`，`publish --candidate <ID> --evaluation <ID> --version <ID> --approvedBy <负责人>`，`resolve`，`activate/rollback --version <ID>`。所有命令需`--registry <目录>`；候选命令另需`--repository <仓库> --candidates <目录>`。

任务完成后保留发布提交：可由负责人建立`codex/runtime-<版本>`分支，再正常`git worktree remove <candidate.worktree>`。评估失败也保留清单与报告。版本包已自含源码，移除工作树不会删除已发布源码与知识。不要对仍运行的工作树强制清理。

## 验证

```sh
npm --prefix agent run typecheck
(cd agent && node_modules/.bin/tsx --test tests/iteration-runtime.test.ts)
npm --prefix agent test
```

专门测试包含真实临时Git仓库/工作树的prompt与code发布；不安全路径、SHA冲突、新文件null SHA、symlink、未声明变更、失败评估和伪造passed、评估后变更、多版本/重复ID、旧task冻结和rollback、源码篡改、固定命令、环境清理、输出上限和超时。它们与正式服实测分别报告。

2026-10-05 本模块离线工程验证：`npm --prefix agent run typecheck`退出0；`npm --prefix agent test`退出0，166项通过/0失败/0跳过（其中11项iteration测试）。prompt/code行为测试使用临时Git仓库和真实worktree、固定编译器和实际测试进程。尚未在本模块运行正式服动作或模型请求，也未据此声称游戏收益；负责人仍需将真实learned事实、独立模型对照和任务代码启动验收加入阶段记录。

补充验证：将测试父进程HOME设为`/nonexistent`实际复现全局Git身份丢失；修复后同条件11项iteration测试全部通过，typecheck退出0。固定测试环境保留全局Git配置的绝对路径，仍不继承API凭据。
