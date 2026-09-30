# yoka-dsh-billing · 会话总结

> 本文件是「需求 → 拍板 → 实现 → 验证 → 投稿」的完整记录。投稿用的物料在 [`submission/`](./submission/)。

## 1. 需求（原始表述）

> 编写一个计费插件：根据 token 与计费规则计算出费用（根据规则实时更新），新增一个费用限制功能可以自己限制最大费用量（不超过所充金额），在桌面端 token 旁边展示费用用量和限制费用（基本形式：（货币符号）（货币数值）/（限制费用）），要求打开应用即可在聊天框底下看见。

## 2. 拍板（六条）

1. 汇率内置；
2. 采用官方价目表；
3. 计费是**全局**计费，限额的上限就是「自己已充的总额」（实时更新）——**0.2.1 起更正**：全局上限由主人自设，余额只作夹取边界与参考，见 2c；
4. 超额处置：**先弹确认再阻断**；
5. 费用口径：算**总费用**；
6. 角标可点击，弹出设置面板。

## 2b. 追加需求与拍板（0.2.0）

> 让该插件新增余额显示，直接显示在左侧边栏下部 在对话框下的角标中新增单个任务的计费和单个任务上限（即单个会话）  直接放在原形式左边（单个任务计费 全局计费  两个左侧都有颜色指示） 弹出界面不需要设置已充金额，因为上限就是余额

四条拍板：

1. 余额口径 = **充值余额 + 赠金** 合计；
2. 单会话上限 = **每个会话可单独设，并有一个默认值**（0.2.2 起更正为「每个会话各自独立、没有共用默认」，见 2d）；
3. 余额拿不到时 = **不阻断**，角标显示 `—`；
4. 颜色 = **三档：绿 <60% / 橙 60–90% / 红 ≥90%**。

## 2c. 更正：全局上限≠余额（0.2.1）

> 发现了一个逻辑bug 我要求删去设置已充金额，但未说全局的限额上限就是余额

m00862 的原句「弹出界面不需要设置已充金额，因为上限就是余额」被我误读成「全局上限恒等于余额」，于是把主人 m00001 的核心诉求「可以自己限制最大费用量（不超过所充金额）」删掉了——面板里再也没法自设全局上限。修正后：

- **全局上限由主人自设**（`limit`，面板「全局计费上限」）；**留空 / 0 = 不设上限、不阻断**；
- 余额**只是边界与参考**：自设值超过余额时被夹到余额（`ceilingSource: "limit-clamped"`，原值保留在账本里，余额涨回来会重新放宽）；余额取不到 / 为 0 时**不夹取**；
- **单会话上限不受余额夹取**；
- 确认框全局分支的按钮由「查看余额」统一为「调高上限」。

## 2d. 更正：单会话上限各自独立（0.2.2）

> 发现一个问题单会话的设置上限是共用的，不是独立的

0.2.1 及更早的单会话上限是「一个对所有会话一起生效的默认值（`sessionLimit`）+ 按会话覆盖」，于是**没单独设过的会话都共享那个默认值**，单个会话只能往上收紧、不能豁免（填 0 = 删掉覆盖 → 回落默认）。修正后（主人选①）：

- 删掉共用默认上限；`sessionLimits[id]` 是**每个会话自己的**上限，**各设各的、互不共用**，表里没有该会话 = 该会话不设上限；
- 面板额度段不再有「单会话默认上限」字段，上限只在「会话用量与单会话上限」里逐个会话设（0.2.3 起该段改名为独立的「单会话上限」，见 2e）；
- 旧的 `{sessionLimit}` 配置字段**被忽略**（`/config` 不再写它）；`source` 由 `"override"` 改名 `"own"`（该会话自己设了）/ `"none"`（没设）；
- 迁移：旧账本里若设过 `sessionLimit`，它会被**落到当时已有记录的每个会话上**（显式、看得见、可单独改），然后字段消失——限额不丢。

## 2e. 更正：单会话上限在面板里独立成段（0.2.3）

> 现在弹窗里完全没有单会话设置上限了

查证：**不在数据链**——运行中的宿主已是 0.2.2（`/state` 有 `sessionLimits`、`sessions` 里有会话），宿主发布的 `client.js` 字节里也确实含单会话输入框。问题在**摆放**：那段藏在「单价」section 末尾、按模型用量下面，每行只有一个**没有标签的空数字框**，很容易被读成「根本没有这个设置」。修正（0.2.3）：

- 提升为**独立一段「单会话上限」**，紧跟「全局计费上限」之后、单价之前；
- 加列标题（会话 / 用量 / 费用 / 占比 / 单会话上限）与说明「每个会话各设各的，互不共用；留空或 0 = 该会话不限。填好回车或移开焦点即生效，单会话上限不受余额夹取。」；
- 当前会话行加淡底高亮并单独标「当前」；**当前会话即使还没有用量记录也会先列一行**，可提前设上限；
- 一个会话记录都没有时显示「还没有会话用量记录。产生用量后这里会出现每个会话，可逐个设上限。」而不是空白。

浏览器半边经 HMR 即时生效（无需重启 DSH）；自测 `self-test-client.mjs` 新增 3 条断言（独立成段 / 列标题 / 「当前」标记）。

## 3. 实现

### 形态

一个双半边插件（DSH 插件标准形态），包名 `yoka-dsh-billing`：

| 半边 | 文件 | 跑在哪 | 入口声明 |
|---|---|---|---|
| 宿主 | `lib/index.js` | DSH 宿主进程 | `main` / `exports["."]` |
| 浏览器 | `lib/client.js` | Web GUI 页面 | `exports["./client"]` + `dsh.client.platform: "web"` |
| 装载 | `cordis.patch.yml` | — | `dsh.bundle.patch` |

浏览器半边是手写的 `window.__ModuleLoader__.load({...})` 工厂，**只 require `react` 与 `react-dom`**，不需要构建步骤；宿主半边**只用 node 内置模块**（`node:fs` / `node:os` / `node:path` / `node:url`），没有任何 `@deepseek-ai/*` 运行时依赖——因此也不存在 peer 版本范围把预发布宿主挡在外面的经典坑。唯一的外部宿主服务是**可选**依赖 `ctx.get("deepseekAccount")`（余额），拿不到就退化为「无全局上限」。

### 计费

- 数据源：官方会话投影 `tokenUsage`（客户端 `useProjection("tokenUsage")`）与宿主的 `session/event` 折叠，四类 token 分开记：`uncachedInput` / `output` / `cacheRead` / `cacheWrite`。
- 单价：`@earendil-works/pi-ai` 的官方价目表（USD / 百万 token），由 `tools/build-pricing.mjs` 生成为 `lib/pricing.json`——**32 个 provider / 605 个模型 / 37 KB**（排除了 `openrouter`、`amazon-bedrock`、`vercel-ai-gateway` 三张超大聚合表）。
- 口径：`费用(USD) = Σ tokenᵢ × 单价ᵢ / 1e6`，再乘内置汇率（默认 7.2）得 ¥。汇率与任一模型单价都可在面板里改，**改完立刻按新规则重算全部历史**。
- 账本**只存 token 与模型键，不存金额**（`~/.dsh/billing/ledger.json`）——所以「根据规则实时更新」是结构上成立的，而不是靠事后刷。
- 折叠与官方同源：同一 `(turn, step)` 的重复采样**替换**而非累加；`llm/retry-started` 清该槽；会话日志被截断则冻结归档记录后重折。

### 上限与阻断

- **全局上限由主人自设**（账本 `limit`，面板「全局计费上限」）：填多少就是多少，**留空 / 0 = 不设上限、不阻断**。
- 余额（宿主 `deepseekAccount.getBalance(meta)`，60s TTL + 60s 轮询，面板可手动刷新）**只是边界与参考**：`费用上限 = min(自设 limit, 余额)`；`ceilingSource` 为 `unset`（未设）/ `limit`（自设生效）/ `limit-clamped`（超过余额被夹，原值仍留在账本里，余额涨回来会自动放宽）。
- 余额取不到 / 为 0 → **不夹取**（此时你填多少就是多少），也**不阻断**；单会话上限**不受余额夹取**。
- **单会话上限**：只有按会话的 `sessionLimits[id]`（**每个会话各设各的、互不共用**，0.2.2 起已无「共用默认值」）；没有该会话的记录 = 该会话不设上限。`ceilingSource` 单会话取 `own` / `none`。
- 阻断点：宿主 `agent/pre-step` waterfall 返回 `{ kind: "reject" }` —— 该轮直接结束，**不会发出 LLM 请求**；`blockScope` 区分 `global`（全局上限）与 `session`（单会话）。
- 处置：超额时先弹确认框（一次性放行 / 本会话放行 / 去充值 / 调高上限 / 暂不放行），放行只影响后续请求；**「本会话放行」不会绕过全局上限**。

### 展示

- 角标落点：客户端槽位 `conversation.composer.dock`（`id: "billing"`、`order: 20`），与官方 `ContextMeter`（token 环）**同一行、在其左侧**——这就是「token 旁边」。**两个**角标并排：本会话 `● ¥0.0834 / ¥50.00`、全局 `● ¥12.3600 / ¥1000.00`；未设上限都显示 `未设`。
- 余额落点：客户端槽位 `sidebar.footer.action`（`id: "billing-balance"`、`order: 20`）——左侧边栏底部、设置按钮旁，显示 `余额 ¥1007.20`；侧栏收起（56px）时只留一个圆点。
- 颜色：每个角标左侧一个 6px 圆点，按各自百分比走三档 **绿 <60% / 橙 60–90% / 红 ≥90%**；被阻断的方向显示红色，全局上限未设时全局点变灰（不阻断）。
- 面板：点角标或侧栏余额弹出（概览、账户余额只读明细 + 刷新 + 去充值、**全局计费上限**、汇率、超额阻断开关、**独立的「单会话上限」一段（列标题 + 每会话一行数字输入 + 当前会话高亮标「当前」）**、模型单价四档覆盖并可恢复官方价、按模型用量明细、保存、用量归零）。**面板里没有「已充金额」**（0.1 的遗留概念）、**也没有「单会话默认上限」**（0.2.2 删）；全局上限不再等于余额，而是主人填的数字，超过余额才会被夹。面板底色完全不透明，并经 `react-dom` 的 `createPortal` 挂到 `document.body`，避免侧栏祖先的 transform 困住 `fixed` 定位。

### 宿主接口（前缀 `/plugin-billing`）

`GET /state?session=&refresh=1`、`POST /config`（rate / guard / **limit（全局上限，0 = 不设）** / price / **`{sessionId, sessionLimitFor}`（该会话自己的上限，0 = 清除）**；0.2.1 的 `sessionLimit` 已废弃、被忽略）、`POST /override`（`once` / `session` / `off` / `reset`，可带 `sessionId`）、`POST /reset`、`GET /pricing`、`GET /diag`。守卫接受：同源标记、`Origin` 头、`dsh-auth-` cookie、或环回地址；其余 403。写盘为原子写（tmp + rename）+ 1200ms 防抖。

## 4. 验证（都是实测，不是推断）

| 证据 | 结果 |
|---|---|
| `node tools/self-test.mjs` | **107 通过 / 0 失败**（计价、替换式折叠、汇率改算、余额合计=充值+赠金、自设全局上限与「超过余额夹到余额」、未设上限不阻断、余额取不到时不夹取且自设上限照旧生效、全局与单会话上限、**单会话上限各自独立（旧的共用默认字段已失效；两会话各存各的；清 0 只清该会话）**、超额 reject 与 blockScope、一次性/单会话放行、守卫、持久化、路由注销、0.1 旧账本迁移落盘且**旧的共用默认上限落到各会话**） |
| `node tools/self-test-client.mjs` | **83 通过 / 0 失败**（模块外壳、槽位注册、双角标文案与颜色点、未设上限文案、侧栏余额、面板字段含「全局计费上限」且不含「已充金额」与「单会话默认上限」、**「单会话上限」独立成段且有列标题与「当前」标记**、**两个会话各自一格上限输入且提示「不与其他会话共用」**、两种确认框、浮层开关、effect 清理） |
| `GET /plugin-billing/state` | 200，真实数据（`usedCNY`、四类 token、`current.key`、`source: "official"`、`balance` 字段） |
| 客户端 Slots inspect | `conversation.composer.dock` occupants 含 `{id: "billing", order: 20, active: true}`；`sidebar.footer.action` 含 `{id: "billing-balance", order: 20}` |
| `node tools/probe-hmr.mjs` | 本地 `client.js` revision == 运行中宿主发行的 revision（HMR 已跟到） |
| 账本 | `version: 2`，只有 token 与模型键，无金额字段；读到 0.1 的 `version: 1` 会就地升级并立即落盘（用真实账本副本演练过：3 个会话 / 370 个步骤前后一致）；旧的共用默认上限（`sessionLimit`）会被落到当时已有记录的每个会话上再消失 |

## 5. 已知边界

- 订阅制账号并不按 token 单价扣费，这里的金额是**等效价值参考**，不是账单。
- 角标挂在 `conversation.composer.dock`，只在会话输入态（composer）渲染；欢迎页不显示。
- 浏览器半边改动由模块图 HMR 自动跟上（`dsh-client-hmr` 每 500ms stat 一次，元数据一变就 `rebuilt(id)`）；**宿主半边改完需要重启 DSH**。
- 价格表为生成物，官方调价后需重跑 `tools/build-pricing.mjs`。

## 6. 文件

```
package.json            包清单（dsh.bundle + dsh.client）
cordis.patch.yml        装载补丁（- insert: yoka-dsh-billing）
lib/index.js            宿主半边：折叠、计价、余额、上限、守卫、HTTP 接口
lib/client.js           浏览器半边：双角标 + 侧栏余额 + 面板 + 超额确认框
lib/pricing.json        官方价目表（生成物）
tools/build-pricing.mjs 从 pi-ai 数据生成 pricing.json
tools/self-test.mjs     宿主自测（107 项）
tools/self-test-client.mjs 浏览器自测（83 项）
tools/probe-hmr.mjs     核对运行中宿主已发行本地这版 client.js
tools/probe-http.mjs    HTTP 探活
submission/             投稿物料（见下）
```

## 7. 投稿路径

见 [`submission/CHECKLIST.md`](./submission/CHECKLIST.md)。一句话：先把仓库推到 GitHub（≥ 1 天后）→ 往 `awesome-dsh-plugin` 提一个只加 `data/plugins/<owner>__<repo>.yml` 的 PR →（可选）发 npm。
