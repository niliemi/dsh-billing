# 投稿物料（awesome-dsh-plugin）

DeepSeek **没有**自营插件商店；桌面端内置的「插件市场」(`dshmarket`) 的目录与安全白名单唯一来自精选列表
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
所以「上架」= 往那个仓库提一个**只加一行条目文件**的 PR。站点与内置市场会自动收录（通常一天内生效）。

署名已填好：**GitHub `niliemi`**，仓库 `dsh-billing`。

| 文件 | 用途 |
|---|---|
| `data-plugins-entry.yml` | 要放进精选列表的条目（成品，无占位符） |
| `PR-body.md` | PR 标题与正文（直接粘贴） |
| `CHECKLIST.md` | **剩下要做的步骤**，标了哪几步只能由你的账号完成 |
| `README.md` | 本文件 |

## 一个容易看混的点

仓库名是 `dsh-billing`，**包名 / 插件 id 仍是 `yoka-dsh-billing`**（已装进你本机 profile 的就是这个 id，改名会把它从已装状态里踢掉）。
两者不一致是允许的，条目里 `name:` 用 `owner/repo` 即可。

## 条目文件名必须是

```
data/plugins/niliemi__dsh-billing.yml
```

即：把 `data-plugins-entry.yml` 改名后放进精选列表仓库的 `data/plugins/`。**不要手改那个仓库的两个 README**（由 `node scripts/generate-readme.mjs` 生成）。
