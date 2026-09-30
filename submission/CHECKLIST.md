# CHECKLIST —— 还剩什么

署名已填：**GitHub `niliemi`**、提交邮箱 `1957073994@qq.com`、仓库 `dsh-billing`。占位符已清零。

---

## ✅ 查重已做过，主人拍板：**照提**（如实写明差异）

投稿前查了精选列表目录（4392 条，`usage` 类目 **235 条**），核心能力已被更成熟的插件覆盖：

| 既有条目 | 已覆盖什么 |
|---|---|
| [PerryLink/dsh-budget](https://github.com/PerryLink/dsh-budget) v0.4.12 | **四类 token 计量（uncached input / output / cache read / cache write）、内置美元单价表 + 用户覆盖、session/日/月预算、超限策略 alert / `block`（阻断新请求直到解除）/ degrade**，另有碳排与延迟、审计事件；界面是 Settings 预算页 + `/budget` 命令 |
| [02Muller25/dsh-api-balance](https://github.com/02Muller25/dsh-api-balance) | composer 输入框下方的账户余额常驻显示 |
| [songoao25/dsh-bottom-info-bar](https://github.com/songoao25/dsh-bottom-info-bar) | 底部信息条：provider/model、余额、峰谷价、**真实持久化的每会话花费** |

也就是说：**「按 token 算钱 + 上限 + 硬阻断」这件事已经有人做完了，而且做得比本插件多。** 本插件剩下的真正差异只有三条：

1. 常驻在 `conversation.composer.dock`（与官方上下文环同一行）的角标，格式 `<符号><已用> / <上限>`；
2. 人民币 + 可改汇率，且上限定义为 `min(自设上限, 已充金额)`；
3. 阻断前先弹确认框，可一次性 / 整会话放行。

精选列表的查重规则原文是「是否与既有条目重复（谁更好谁留）」。主人已知悉上述风险，**决定照提**——PR 正文里已经写明这三点差异与三条最接近的既有条目，并明说「若判为重复，关闭或收窄条目都可以」，不含任何夸大。

**仓库可用性已核实**：GitHub 用户 `niliemi` 存在（200），`niliemi/dsh-billing` → **404，仓库名未被占用**。

---

## ✅ 已完成（本地）

- [x] 19 个文件已纳入本地 git 仓库，分支 `main`
- [x] `package.json`：去掉 `private`、英文准确描述、`keywords` 含 `dsh-plugin`、`repository`/`bugs`/`homepage`/`author` 指向 `github.com/niliemi/dsh-billing`
- [x] `dsh.bundle` + `dsh.client` 均已声明；**零 `@deepseek-ai/*` 运行时依赖**
- [x] `LICENSE`（MIT，署名 niliemi）、`.gitignore`、`.gitattributes`（`* text=auto eol=lf`）
- [x] 自测：`node tools/self-test.mjs` → **55/0**，`node tools/self-test-client.mjs` → **38/0**
- [x] `npm pack --dry-run` → 7 个文件 / 26 KB，内容完整

## ① 建 GitHub 公开仓库并推送（**只有你能做**）

1. GitHub 网页端新建**公开**仓库 `dsh-billing`——**不要**勾选自动生成 README / .gitignore / License（会和本地冲突）。
2. 仓库设置里加 topic：`dsh-plugin`。
3. 在仓库页右上角 **Settings → Emails**，确认 `1957073994@qq.com` 已加进你的账号，否则这次提交不会算在你名下。
4. 本地推送：

```powershell
cd "C:\Users\walex lin\Desktop\dsh workflow\插件\dsh-billing"
git remote add origin https://github.com/niliemi/dsh-billing.git
git push -u origin main
```

> 推送会要凭据，Windows 一般弹 Git Credential Manager 的浏览器登录。
> 如果你不想用命令行：GitHub 网页端 **Add file → Upload files** 把这 19 个文件拖上去同样可行（本仓库没有 `node_modules`，无需排除）。

## ② 等满 24 小时（**硬性**）

精选列表 CI 会检查**仓库创建已满 1 天**，不满当天提 PR 必失败。今天推 → 明天提。

## ③ 提 PR（**只有你能做**）

1. fork `awesome-dsh-plugin/awesome-dsh-plugin`。
2. 在你 fork 的新分支里加**唯一一个**文件：

   ```
   data/plugins/niliemi__dsh-billing.yml
   ```

   内容 = 本仓库的 `submission/data-plugins-entry.yml`（原样复制，已经是成品）。

   > 每个 PR 最多 3 条条目；不要动两个 README；不要碰任何无关文件——评审会看 PR 是否夹带。

3. 开 PR，标题与正文照抄 `submission/PR-body.md`。
4. CI 会跑 `awesome-lint` + 站点构建 + 仓库检查（`dsh.bundle` / 仓库年龄 / URL 一致性）。失败会在 PR 上写明原因，**在同一个分支推修复**即可。

## ④ 可选：发 npm

收录**不要求** npm，只影响市场卡片显示的下载量。你这次选择先不发。以后想发：

```powershell
npm login
npm publish --access public
```

要求已发布包的 `repository` 指向被收录的那个仓库（本仓库已声明）。**不要在精选列表的 yml 里手写 `npm:`**，会被校验拒绝——映射自动采集。

## ⑤ 可选：截图

在**本仓库根**放 `screenshots.json`（`["assets/screenshot-1.png"]`，1–8 张，相对路径不得越出插件目录；或 GitHub 托管的 https 绝对 URL；第三方图床会被拒）。不声明则市场从 README 抽取。

---

## 提醒

本机全局 git 身份**仍未配置**（提交时是用 `-c user.name=... -c user.email=...` 一次性指定的，没动你的全局配置）。以后要正常提交，执行一次：

```powershell
git config --global user.name  "niliemi"
git config --global user.email "1957073994@qq.com"
```
