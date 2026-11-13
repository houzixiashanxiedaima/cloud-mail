# 发布覆盖（release overlay）

本仓库是 `maillab/cloud-mail` 的 fork。默认分支 `main` 始终是上游的镜像，不含任何本地提交；
发布用的本地改动只放在 `release` 分支。

## 为什么需要覆盖

上游的 `.github/workflows/deploy-cloudflare.yml` 在发布后用
`curl https://<CUSTOM_DOMAIN>/api/init/<JWT_SECRET>` 初始化数据库。GitHub Actions
的出口 IP 到达 Cloudflare 时会被 zone 级人机校验拦下（403 "Just a moment..."，
`cType: managed`），请求根本到不了 Worker，于是「发布成功、流水线报红」。

实测（2026-11-13）：同一路径从住宅网络请求返回 `200 ❌ JWT secret mismatch`（应用层
校验生效），从 5 个不同的 GitHub runner IP 请求全部被 challenge；更换 User-Agent
无效。该校验属于平台侧，不能按路径放行（免费版 Bot Fight Mode 不支持 WAF Skip），
而关闭整站防护会削弱所有接口，因此不改 zone 配置。

## 覆盖内容

`release` = `main` + 以下文件，不改动任何上游文件：

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/deploy-release.yml` | 上游发布流程的副本，改为在 `release` 推送时运行；初始化改为经桥接 Worker 调用 |
| `mail-worker/src/ci-init.js` | 一次性桥接 Worker：用 service binding 直接调用主 Worker |
| `mail-worker/wrangler-ci-init.toml` | 桥接 Worker 的配置（`workers_dev = true`，service binding 指向主 Worker） |

执行顺序：

1. 构建并 `wrangler deploy` 主 Worker（与上游一致）。
2. `wrangler deploy` 桥接 Worker `cloud-mail-ci-init`，拿到它的 `*.workers.dev` 地址。
3. 请求 `https://cloud-mail-ci-init.<account>.workers.dev/<JWT_SECRET>`；桥接 Worker 用
   service binding 转发到主 Worker 的 `/api/init/:secret`，不经过 zone 的 HTTP 边缘。
4. 删除桥接 Worker（`if: always()`）。下次运行会以同名重新部署，残留不影响后续。

初始化接口自身的逻辑没有改动：`/api/init/:secret` 仍比对 `env.jwt_secret`，
桥接 Worker 只是换了一条进站路径。`workers_dev` 只对「初始化桥接 Worker」开启，
主 Worker 没有额外公网别名，整站防护保持原样。

## 幂等性

`mail-worker/src/init/init.js` 的设计已经可重复执行：

- 建表统一用 `CREATE TABLE IF NOT EXISTS`。
- 加列/改列在 `try/catch` 里执行，已存在时只打印「跳过字段」。
- 初始数据用 `WHERE NOT EXISTS` 或包在 `try/catch` 里。
- 一次性迁移（如 `receive_email` → `recipient`）先用 `pragma_table_info` 判断列是否还在。

因此在已有生产库上重复运行是安全的；工作流里也对失败做了有限重试（最多 12 次，
每次间隔 5 秒），只把最终结果算作失败。

## 每日同步如何维持

omarchy 上的 `~/.agents/skills/github-fork-sync/bin/fork-sync.sh`：

1. 照旧把 `main` fast-forward 到上游（不加本地提交）。
2. 追加一步：`POST /repos/houzixiashanxiedaima/cloud-mail/merges {base: release, head: main}`
   在 GitHub 服务端把 `main` 合进 `release`，推送事件触发 `deploy-release.yml`。
3. 服务端合并失败（409 冲突）时只报告，不强推、不改写历史。

上游的 `deploy-cloudflare.yml` 在仓库设置里保持 disabled，避免 `main` 追平时再用
未修复的初始化步骤跑一次（会必然报红）。

## 手动操作

```bash
# 重建 release（把 overlay 继续叠在新的 main 上）
git fetch origin main
git checkout release && git merge origin/main && git push origin release
```

合并冲突通常说明上游改了 `deploy-cloudflare.yml`（工作流里的 `Overlay drift notice`
会给出 `::warning::`）。此时按上游新版本重新拷贝该文件、重放本文件列出的 3 处改动，
并更新 drift 校验里的 sha256。

## 何时可以删除覆盖

上游发布流程不再要求从公网调用 `/api/init/`（例如改为 D1 迁移命令），或 zone 侧
允许对初始化路径放行时，可以删除本分支与相关文件，并把 `deploy-cloudflare.yml`
重新启用。
