# yoka-dsh-billing · DSH 计费插件

在 DSH Desktop 里按 token 计费：聊天输入框下方、token 环左边常驻显示**本会话**与**全局**两条费用，左侧边栏底部显示 DeepSeek 账号余额；每条费用右边有一个 ↺ 可**重置计费起点**（本次归零、历史只进累计），达到上限时宿主在该轮开始前阻断 LLM 请求。

```
● ¥0.0834 / ¥50.00 ↺      ● ¥12.3600 / ¥1000.00 ↺
  本会话本次计费 / 上限         全局本次计费 / 你设的全局上限
```

- 左侧边栏底部（设置按钮旁）：`余额 ¥1007.20`（充值 + 赠金，只作参考）。
- 点角标打开面板；点 ↺ 重置计费起点；超额时弹确认框。
- 圆点分三档：**绿 <60% / 橙 60–90% / 红 ≥90%**；全局上限未设时用灰点（不阻断）。

## 计费口径

| 项目 | 取值 |
| --- | --- |
| 计费粒度 | **全局**（所有会话累加）+ **单会话**（同一份 token 按会话聚合，不需要额外数据源） |
| token 来源 | 官方 `tokenUsage` 投影同源的折叠逻辑（`request/header` 定路由，`assistant/message`/`assistant/attempt` 取 usage，同一 `turn:step` 重采样替换而非累加，`llm/retry-started` 清槽） |
| 四类 token | 未缓存输入 / 输出 / 缓存读 / 缓存写，分别按官方单价计价 |
| 单价 | 内置 `@earendil-works/pi-ai` 官方价目表（USD / 百万 token），本仓库锁定了 32 个 provider、605 个模型；可在面板里按模型覆盖 |
| 汇率 | 内置 **1 USD = 7.2 CNY**，面板可改 |
| 未知模型 | 估算价 `[输入 1, 输出 4, 缓存读 0.1, 缓存写 0]` USD / 百万 token |

金额**永远现算**：账本里只存 token 与模型键，改汇率或改单价会立刻重算全部历史用量。

## 上限与余额

- **全局上限由你自己设**（面板「全局计费上限」，账本 `limit`）：填多少就是多少，**留空 / 0 = 不设上限、不阻断**。它不来自余额。
- **余额只是边界与参考**：DeepSeek 账号余额 = 充值余额 + 赠金（`deepseekAccount.getBalance`），每 60 秒自动刷新，也可在面板里手动刷新。你设的全局上限**超过余额时会被夹到余额**（`ceilingSource: "limit-clamped"`，原值仍留在账本里，余额涨回来会重新放宽）；余额取不到（未登录、接口失败）或余额为 0 时**不夹取**，你设的上限照旧生效。
- **单会话上限**：面板里独立的一段「单会话上限」（在「全局计费上限」正下方），给**每个会话各设各的**，**彼此独立、不共用**（0.2.2 起已删掉原来那个对所有会话一起生效的「默认上限」）；留空 / 0 = 该会话不设上限。单会话上限**不受余额夹取**。当前会话即使还没有用量记录也会先列出来，可提前设上限。
- 越线且守卫开启时，宿主在 `agent/pre-step` 上返回 `{kind:"reject"}`，该轮结束且不发 LLM 请求（`blockScope` 区分是全局还是单会话）。
- 阻断后界面弹确认框，可选：**一次性放行** / **本会话放行** / **去充值**（有待充地址时）/ **调高上限** / **暂不放行**。放行只影响后续请求，需要重新发送刚才的消息。
- 「本会话放行」只免该会话，**不会绕过全局上限**；「一次性放行」对两类上限都生效一次。

## 本次与累计（重置计费起点）

- 上限比的是**本次**：从最近一次重置算起的费用。**累计**是全部历史（含已经前移出去的部分），只作参考，**永不归零**。
- 两个角标右边各有一个 **↺ 重置计费起点**（本会话一个、全局一个）。重置 = **基线前移**：把当前用量记成新起点，本次归零、不再阻断，**历史只进累计，token 记录一条都不丢**（金额永远现算，所以改了汇率 / 单价，本次与累计会一起重算）。
- **两个 ↺ 彻底分开、互不影响**（0.2.5 起）：**全局 ↺** 只把全局的本次归零，各会话的本次与它们自己的 ↺ 状态分毫不动；**某个会话的 ↺** 只把那个会话的本次归零，全局本次与其它会话都不受影响。所以「谁的上限越线，就重置谁」——全局上限越线要点全局 ↺，某个会话的上限越线点它自己那行的 ↺ 即可。
- 面板里也能重置：概览第二行显示累计，右边就是全局 ↺；「单会话上限」每行末尾有 ↺（只重置该会话）；超额确认框里也加了 ↺——充值后不必再去调高上限。
- 想彻底清空历史（累计也归零）用面板底部的**清空历史**：那是硬重置，会删掉全部 token 记录，**不可恢复**。

## 面板（点击角标或侧栏余额）

概览（**本次**已用 / 上限 + 百分比 + ≈USD + 进度条，下一行是**累计** + 全局 ↺ 重置计费起点）→ 账户余额（只读：逐钱包的充值余额 / 赠金行、余额合计、其中赠金、刷新、去充值）→ 额度（**全局计费上限**、汇率、超额阻断开关）→ **单会话上限**（独立一段：列标题「会话 / 用量 / 费用 / 占比 / 单会话上限」，每个会话一行数字输入，**各设各的、互不共用**，留空 / 0 = 该会话不限；当前会话行高亮并标「当前」；回车或移开焦点即生效；行末 ↺ 只重置该会话的计费起点）→ 单价（当前模型四档官方价、按模型覆盖 / 恢复官方价、按模型的用量明细：每行显示本次费用 + 累计费用）→ 保存 / ↺ 重置计费起点 / 清空历史。

面板里没有「已充金额」——那是 0.1 的遗留概念；上限也不再等于余额，而是你在「全局计费上限」里填的数字。

## 数据

- 账本：`~/.dsh/billing/ledger.json`（可用插件 config 的 `storeFile` 覆盖），原子写盘 + 1200ms 防抖。
- `version: 3`：只存 token 与模型键（不含金额），外加 `limit`（你自设的全局上限，原值）、`sessionLimits`（**按会话各存各的**上限）、`sessionAllow`（已放行的会话）、`globalBaseline`（**全局 ↺ 前移出去的 token**）与各会话的 `baselineByModel`（**该会话 ↺ 前移出去的 token**）、`resetAt`；全局本次 = 全部 − `globalBaseline`，某会话本次 = 它的 steps − 它的 `baselineByModel`，两个口径互不影响。0.1 的 `topUp`（已充金额）保留但已废弃，0.2.1 的 `sessionLimit`（对所有会话一起生效的默认上限）已被 `sessionLimits` 取代。全局有效上限由 `limit` 与余额现算：`ceilingSource` 取 `unset`（未设） / `limit`（自设） / `limit-clamped`（超过余额被夹）；单会话的 `ceilingSource` 取 `own`（该会话自己设了） / `none`（该会话没设）。
- 旧账本自动升级：读到 0.1 的 `version: 1`、或 0.2.4 的 `version: 2` 文件时会就地补成 `version: 3` 并**立即落盘**（不等下一次用量变化），会话、步骤与 token 全部保留，金额仍按当前汇率/单价现算。若旧账本里设过 `sessionLimit`（共用默认上限），它会被落到当时已有记录的每个会话上，然后字段消失——限额不丢，且从此各自独立可改。0.2.4 的旧基线（`archiveBaseline` + 各会话 `baselineByModel`）会并进 `globalBaseline`（全局本次保持原值不变），其中**由全局 ↺ 写下的会话基线会被清掉**——那些会话本来就是被全局重置误伤的，升级后立刻恢复成它们自己的计费周期。
- 最多保留 40 个会话的明细，更早的会话折叠进按模型的归档（金额不受影响）。

## HTTP 接口（宿主半边，前缀 `/plugin-billing`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state?session=<id>&refresh=1` | 角标/面板所需的全部状态；带 `session` 时附带该会话的用量与上限，`refresh=1` 强制刷新余额 |
| POST | `/config` | 写入汇率、守卫、**全局上限（`{limit}`，0 = 不设）**、模型单价覆盖（`{price:{key,value}}` / `{price:{key,reset:true}}`）、**某个会话自己的上限（`{sessionId, sessionLimitFor}`，传 0 清除该会话的上限）**；上限被余额夹取时响应带 `limitClamped: true`。0.2.1 的 `{sessionLimit}`（共用默认上限）已废弃、被忽略 |
| POST | `/override` | `{mode:"once"｜"session"｜"off"｜"reset", sessionId?}` 放行 / 清除放行 |
| POST | `/reset` | `{scope:"session"｜"global", sessionId?}` **重置计费起点**（默认软重置 = 基线前移：本次归零、历史只进累计、token 一条不丢；`scope:"global"` 只动全局起点，各会话自己的起点不受影响，反之亦然）；`{hard:true}` 才是旧的**清空历史**（累计一起归零，不可恢复） |
| GET | `/pricing?q=` | 价目表检索（精确命中优先） |
| GET | `/diag` | 诊断：`clientModules` 是否已把浏览器半边收进启动图，以及实时余额、自设全局上限与单会话上限表、本次/累计金额与各会话基线 |

守卫：仅接受同源 / 带 `dsh-auth-` cookie / 回环地址的请求，响应 `cache-control: no-store`。

## 安装

宿主半边跑在 DSH 进程里；浏览器半边是手写的 `window.__ModuleLoader__` 包装（`lib/client.js`，**无需构建**），由 `dsh-client-modules` 以 combo URL 提供——**注意不是** `/plugins/yoka-dsh-billing/client.js`（该形状返回 404），真实 URL 形如 `/plugins/??yoka-dsh-billing/client.js&rev=<rev>`，由启动图注入，页面上会自行加载。

安装 = 让桌面 profile 能解析到本包，并在 `dsh.profile.bundles` 里登记。已执行的命令：

```powershell
# 在 DSH 会话内用 plugin_manager 工具，等价于 dsh plugin --profile desktop add link:<dir>
# target: link:C:\Users\walex lin\Desktop\dsh workflow\插件\dsh-billing
```

它会把 `"yoka-dsh-billing": "link:…/dsh-billing"` 写进 `~/.dsh/profiles/desktop/package.json` 的 `dependencies`，并把 `yoka-dsh-billing` 追加进 `dsh.profile.bundles`，随后热应用（`application: applied`）。插件自带的 `cordis.patch.yml`：

```yaml
- insert:
    - id: yoka-dsh-billing
      name: 'yoka-dsh-billing'
      config: { rate: 7.2, limit: 0, guard: true }
```

## 开发

```powershell
node tools/build-pricing.mjs "<pi-ai>/dist/providers/data"   # 重新生成 lib/pricing.json
node tools/self-test.mjs          # 宿主：折叠 / 计价 / 余额 / 自设上限与夹取 / 守卫 / 路由 / 持久化 / 旧账本迁移 / 重置计费起点（全局与单会话互不影响）（151 项）
node tools/self-test-client.mjs   # 浏览器：模块外壳 / 槽位 / 双角标与 ↺、侧栏余额、面板文案与「单会话上限」独立段、本次与累计 / 两个 ↺ 互不牵连（102 项）
node tools/probe-hmr.mjs          # 核对「运行中的宿主」是否已发布本地这版 client.js（无需刷新/重启）
```

## 已知边界

- 订阅制账号并不按 token 单价扣费，这里的金额是**等效价值参考**，不是账单。
- 余额来自宿主 `deepseekAccount` 服务（可选依赖：拿不到就只影响余额显示与「上限夹取」，不影响计费、自设上限与单会话上限）。
- 面板里的模型键是 `provider/model`；直接改单价只影响该键的用量。
- 角标挂在 `conversation.composer.dock` 槽位，只在会话输入态（composer）渲染；欢迎页不显示。侧栏余额挂在 `sidebar.footer.action`，与设置按钮同一行，收起态（56px）只留一个圆点。
- 浏览器半边的改动由模块图 HMR 自动跟上：`dsh-client-hmr` 每 500ms stat 一次各条目的 `client.js`，元数据一变就 `rebuilt(id)` 并经 `/plugins/events` 广播，页面会把该插件重挂载（**不用刷新页面**，但被重载插件的 React 状态会丢，所以打开着的面板会自己关掉）。`node tools/probe-hmr.mjs` 可核对当前发行的 revision。**宿主半边（`lib/index.js`）不热重载源码**，改完需要重启 DSH 才会生效——已安装的那份实例跑的是安装时的代码。
- 面板与确认框的底色是**完全不透明**的：官方「菜单面」色（`--dsw-specific-menu`，浅 `#f8f9faf0` / 深 `#303136f0`，94% 不透明）叠在 `--dsw-alias-bg-layer-1`（纯色层）上，外加 `rgba(0,0,0,.34)` 遮罩；面板经 `react-dom` 的 `createPortal` 挂到 `document.body`，避免侧栏祖先的 transform 困住 `fixed` 定位。
