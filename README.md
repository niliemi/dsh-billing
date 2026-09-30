# yoka-dsh-billing · DSH 计费插件

在 DSH Desktop 里按 token 计费：聊天输入框下方、token 环左边常驻显示**本会话**与**全局**两条费用，左侧边栏底部显示 DeepSeek 账号余额；达到上限时宿主在该轮开始前阻断 LLM 请求。

```
● ¥0.0834 / ¥50.00      ● ¥12.3600 / ¥1007.20
  本会话计费 / 本会话上限      全局计费 / 账户余额
```

- 左侧边栏底部（设置按钮旁）：`余额 ¥1007.20`。
- 点任一角标打开面板；超额时弹确认框。
- 圆点分三档：**绿 <60% / 橙 60–90% / 红 ≥90%**；余额取不到时全局角标显示 `—`。

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

- **全局上限 = DeepSeek 账号余额 = 充值余额 + 赠金**（`deepseekAccount.getBalance`，取不到就不设上限），每 60 秒自动刷新，也可在面板里手动刷新。
- **单会话上限**：面板里可设一个**默认值**（对所有会话生效），也可以给**单个会话**单独覆盖一个数字；留空 / 0 = 不设。
- 余额取不到（未登录、接口失败）或余额为 0 时**不阻断**，避免把还能用的账号锁死；全局角标显示 `—`。
- 越线且守卫开启时，宿主在 `agent/pre-step` 上返回 `{kind:"reject"}`，该轮结束且不发 LLM 请求（`blockScope` 区分是余额还是单会话）。
- 阻断后界面弹确认框，可选：**一次性放行** / **本会话放行** / **去充值**（余额）/ **提高上限**（单会话）/ **查看余额** / **暂不放行**。放行只影响后续请求，需要重新发送刚才的消息。
- 「本会话放行」只免该会话，**不会绕过全局余额**；「一次性放行」对两类上限都生效一次。

## 面板（点击角标或侧栏余额）

概览（已用 / 上限 + 百分比 + ≈USD + 进度条）→ 账户余额（只读：逐钱包的充值余额 / 赠金行、余额合计、其中赠金、刷新、去充值）→ 额度（单会话默认上限、汇率、超额阻断开关）→ 单价（当前模型四档官方价、按模型覆盖 / 恢复官方价、按模型的用量明细）→ 会话用量与单会话上限（每行一个数字输入，回车或移开焦点即生效）→ 保存 / 用量归零。

全局上限固定在账户余额，面板里不再有「已充金额 / 自设上限」——上限就是余额。

## 数据

- 账本：`~/.dsh/billing/ledger.json`（可用插件 config 的 `storeFile` 覆盖），原子写盘 + 1200ms 防抖。
- `version: 2`：只存 token 与模型键（不含金额），外加 `sessionLimit`（默认上限）、`sessionLimits`（按会话覆盖）、`sessionAllow`（已放行的会话）；0.1 的 `topUp` / `limit` 字段保留但不再参与上限计算。
- 旧账本自动升级：读到 0.1 的 `version: 1` 文件时会就地补成 `version: 2` 并**立即落盘**（不等下一次用量变化），会话、步骤与 token 全部保留，金额仍按当前汇率/单价现算。
- 最多保留 40 个会话的明细，更早的会话折叠进按模型的归档（金额不受影响）。

## HTTP 接口（宿主半边，前缀 `/plugin-billing`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state?session=<id>&refresh=1` | 角标/面板所需的全部状态；带 `session` 时附带该会话的用量与上限，`refresh=1` 强制刷新余额 |
| POST | `/config` | 写入汇率、守卫、模型单价覆盖（`{price:{key,value}}` / `{price:{key,reset:true}}`）、单会话默认上限（`{sessionLimit}`）或单个会话的上限（`{sessionId, sessionLimitFor}`，传 0 清除） |
| POST | `/override` | `{mode:"once"｜"session"｜"off"｜"reset", sessionId?}` 放行 / 清除放行 |
| POST | `/reset` | 用量归零 |
| GET | `/pricing?q=` | 价目表检索（精确命中优先） |
| GET | `/diag` | 诊断：`clientModules` 是否已把浏览器半边收进启动图，以及实时余额与单会话默认上限 |

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
      config: { rate: 7.2, sessionLimit: 0, guard: true }
```

## 开发

```powershell
node tools/build-pricing.mjs "<pi-ai>/dist/providers/data"   # 重新生成 lib/pricing.json
node tools/self-test.mjs          # 宿主：折叠 / 计价 / 余额 / 上限 / 守卫 / 路由 / 持久化 / 旧账本迁移（93 项）
node tools/self-test-client.mjs   # 浏览器：模块外壳 / 三个槽位 / 角标、侧栏余额与面板文案（74 项）
node tools/probe-hmr.mjs          # 核对「运行中的宿主」是否已发布本地这版 client.js（无需刷新/重启）
```

## 已知边界

- 订阅制账号并不按 token 单价扣费，这里的金额是**等效价值参考**，不是账单。
- 余额来自宿主 `deepseekAccount` 服务（可选依赖：拿不到就只影响余额显示与全局上限，不影响计费与单会话上限）。
- 面板里的模型键是 `provider/model`；直接改单价只影响该键的用量。
- 角标挂在 `conversation.composer.dock` 槽位，只在会话输入态（composer）渲染；欢迎页不显示。侧栏余额挂在 `sidebar.footer.action`，与设置按钮同一行，收起态（56px）只留一个圆点。
- 浏览器半边的改动由模块图 HMR 自动跟上：`dsh-client-hmr` 每 500ms stat 一次各条目的 `client.js`，元数据一变就 `rebuilt(id)` 并经 `/plugins/events` 广播，页面会把该插件重挂载（**不用刷新页面**，但被重载插件的 React 状态会丢，所以打开着的面板会自己关掉）。`node tools/probe-hmr.mjs` 可核对当前发行的 revision。**宿主半边（`lib/index.js`）不热重载源码**，改完需要重启 DSH 才会生效——已安装的那份实例跑的是安装时的代码。
- 面板与确认框的底色是**完全不透明**的：官方「菜单面」色（`--dsw-specific-menu`，浅 `#f8f9faf0` / 深 `#303136f0`，94% 不透明）叠在 `--dsw-alias-bg-layer-1`（纯色层）上，外加 `rgba(0,0,0,.34)` 遮罩；面板经 `react-dom` 的 `createPortal` 挂到 `document.body`，避免侧栏祖先的 transform 困住 `fixed` 定位。
