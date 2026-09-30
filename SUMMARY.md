# yoka-dsh-billing · 会话总结

> 本文件是「需求 → 拍板 → 实现 → 验证 → 投稿」的完整记录。投稿用的物料在 [`submission/`](./submission/)。

## 1. 需求（原始表述）

> 编写一个计费插件：根据 token 与计费规则计算出费用（根据规则实时更新），新增一个费用限制功能可以自己限制最大费用量（不超过所充金额），在桌面端 token 旁边展示费用用量和限制费用（基本形式：（货币符号）（货币数值）/（限制费用）），要求打开应用即可在聊天框底下看见。

## 2. 拍板（六条）

1. 汇率内置；
2. 采用官方价目表；
3. 计费是**全局**计费，限额的上限就是「自己已充的总额」（实时更新）；
4. 超额处置：**先弹确认再阻断**；
5. 费用口径：算**总费用**；
6. 角标可点击，弹出设置面板。

## 3. 实现

### 形态

一个双半边插件（DSH 插件标准形态），包名 `yoka-dsh-billing`：

| 半边 | 文件 | 跑在哪 | 入口声明 |
|---|---|---|---|
| 宿主 | `lib/index.js` | DSH 宿主进程 | `main` / `exports["."]` |
| 浏览器 | `lib/client.js` | Web GUI 页面 | `exports["./client"]` + `dsh.client.platform: "web"` |
| 装载 | `cordis.patch.yml` | — | `dsh.bundle.patch` |

浏览器半边是手写的 `window.__ModuleLoader__.load({...})` 工厂，**只 require `react`**，不需要构建步骤；宿主半边**只用 node 内置模块**（`node:fs` / `node:os` / `node:path` / `node:url`），没有任何 `@deepseek-ai/*` 运行时依赖——因此也不存在 peer 版本范围把预发布宿主挡在外面的经典坑。

### 计费

- 数据源：官方会话投影 `tokenUsage`（客户端 `useProjection("tokenUsage")`）与宿主的 `session/event` 折叠，四类 token 分开记：`uncachedInput` / `output` / `cacheRead` / `cacheWrite`。
- 单价：`@earendil-works/pi-ai` 的官方价目表（USD / 百万 token），由 `tools/build-pricing.mjs` 生成为 `lib/pricing.json`——**32 个 provider / 605 个模型 / 37 KB**（排除了 `openrouter`、`amazon-bedrock`、`vercel-ai-gateway` 三张超大聚合表）。
- 口径：`费用(USD) = Σ tokenᵢ × 单价ᵢ / 1e6`，再乘内置汇率（默认 7.2）得 ¥。汇率与任一模型单价都可在面板里改，**改完立刻按新规则重算全部历史**。
- 账本**只存 token 与模型键，不存金额**（`~/.dsh/billing/ledger.json`）——所以「根据规则实时更新」是结构上成立的，而不是靠事后刷。
- 折叠与官方同源：同一 `(turn, step)` 的重复采样**替换**而非累加；`llm/retry-started` 清该槽；会话日志被截断则冻结归档记录后重折。

### 上限与阻断

- 上限 = `min(自设上限, 已充金额)`；`已充金额` 为 0 时视为未设上限（角标显示「未设上限」）。
- 阻断点：宿主 `agent/pre-step` waterfall 返回 `{ kind: "reject" }` —— 该轮直接结束，**不会发出 LLM 请求**。
- 处置：超额时先弹确认框（一次性放行 / 本会话放行 / 提高上限 / 暂不放行），放行只影响后续请求。

### 展示

- 落点：客户端槽位 `conversation.composer.dock`（`id: "billing"`、`order: 20`），与官方 `ContextMeter`（token 环）**同一行、在其左侧**——这就是「token 旁边」。
- 文案：`¥12.36 / ¥50.00`，未设上限时 `¥12.36 / 未设上限`；三态配色（正常 / 80% 警告 / 超额）。
- 面板：点角标弹出（概览、已充金额、自设上限、汇率、超额阻断开关、模型单价四档覆盖并可恢复官方价、按模型 / 按会话用量明细、保存、用量归零）。面板底色完全不透明（官方菜单面色叠在 `--dsw-alias-bg-layer-1` 上），遮罩 `rgba(0,0,0,.34)`。

### 宿主接口（前缀 `/plugin-billing`）

`GET /state`、`POST /config`、`POST /override`、`POST /reset`、`GET /pricing`、`GET /diag`。守卫接受：同源标记、`Origin` 头、`dsh-auth-` cookie、或环回地址；其余 403。写盘为原子写（tmp + rename）+ 1200ms 防抖。

## 4. 验证（都是实测，不是推断）

| 证据 | 结果 |
|---|---|
| `node tools/self-test.mjs` | **55 通过 / 0 失败**（计价、替换式折叠、汇率改算、上限语义、超额 reject、一次性/整会话放行、守卫、持久化、路由注销） |
| `node tools/self-test-client.mjs` | **38 通过 / 0 失败**（模块外壳、槽位注册、角标文案、面板字段、确认框按钮、effect 清理） |
| `GET /plugin-billing/state` | 200，真实数据（`usedCNY`、四类 token、`current.key`、`source: "official"`） |
| 客户端 Slots inspect | `conversation.composer.dock` occupants 含 `{id: "billing", order: 20, active: true}` |
| `node tools/probe-hmr.mjs` | 本地 `client.js` revision == 运行中宿主发行的 revision（HMR 已跟到） |
| 账本 | 只有 token 与模型键，无金额字段 |

## 5. 已知边界

- 订阅制账号并不按 token 单价扣费，这里的金额是**等效价值参考**，不是账单。
- 角标挂在 `conversation.composer.dock`，只在会话输入态（composer）渲染；欢迎页不显示。
- 浏览器半边改动由模块图 HMR 自动跟上（`dsh-client-hmr` 每 500ms stat 一次，元数据一变就 `rebuilt(id)`）；**宿主半边改完需要重启 DSH**。
- 价格表为生成物，官方调价后需重跑 `tools/build-pricing.mjs`。

## 6. 文件

```
package.json            包清单（dsh.bundle + dsh.client）
cordis.patch.yml        装载补丁（- insert: yoka-dsh-billing）
lib/index.js            宿主半边：折叠、计价、上限、守卫、HTTP 接口
lib/client.js           浏览器半边：角标 + 面板 + 超额确认框
lib/pricing.json        官方价目表（生成物）
tools/build-pricing.mjs 从 pi-ai 数据生成 pricing.json
tools/self-test.mjs     宿主自测（55 项）
tools/self-test-client.mjs 浏览器自测（38 项）
tools/probe-hmr.mjs     核对运行中宿主已发行本地这版 client.js
tools/probe-http.mjs    HTTP 探活
submission/             投稿物料（见下）
```

## 7. 投稿路径

见 [`submission/CHECKLIST.md`](./submission/CHECKLIST.md)。一句话：先把仓库推到 GitHub（≥ 1 天后）→ 往 `awesome-dsh-plugin` 提一个只加 `data/plugins/<owner>__<repo>.yml` 的 PR →（可选）发 npm。
