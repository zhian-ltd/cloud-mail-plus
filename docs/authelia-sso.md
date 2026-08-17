# Cloud Mail Plus 接入 Authelia SSO

本实现把 Authelia 作为 OpenID Connect Provider，同时保留 Cloud Mail Plus 原有密码登录。OIDC 回调、Client Secret、令牌兑换、ID Token 验证、用户匹配和 Cloud Mail Plus JWT 签发均在 Cloudflare Worker 后端完成。

## 已实现的安全模型

- OIDC Authorization Code Flow。
- 随机 `state`，同时保存在短期 KV 事务和 HttpOnly、SameSite Cookie 中，回调后立即删除。
- 随机 `nonce` 并与经过验签的 ID Token 比对。
- S256 PKCE；`code_verifier` 只保存在 10 分钟有效的服务端事务中。
- 通过 Discovery 获取授权、Token、JWKS 和 UserInfo 端点。
- 用 JWKS 验证 ID Token 签名，并校验 `iss`、`aud`、`azp`（适用时）、`exp`、`iat` 和 `nonce`。
- 仅允许 Provider 公布的非对称签名算法；推荐并默认固定为 `RS256`。
- UserInfo 的 `sub` 必须与 ID Token 的 `sub` 完全一致。
- D1 使用 `(issuer, subject)` 唯一约束绑定本地用户；email 只在首次绑定时匹配已有用户或创建用户。
- 默认要求 `email_verified=true`，默认关闭自动创建用户。
- 登录成功后调用 Cloud Mail Plus 原有会话签发逻辑，JWT/KV 会话、角色权限和邮箱数据隔离均保持原样。
- 回调 HTML 使用 `no-store`、CSP nonce、禁止嵌入和无 Referer 等响应头。

2026-08-10 已实际读取当前实例：

```text
Issuer:        https://auth.longlivehome.eu.org
Discovery:     https://auth.longlivehome.eu.org/.well-known/openid-configuration
Authorization: https://auth.longlivehome.eu.org/api/oidc/authorization
Token:         https://auth.longlivehome.eu.org/api/oidc/token
JWKS:          https://auth.longlivehome.eu.org/jwks.json
UserInfo:      https://auth.longlivehome.eu.org/api/oidc/userinfo
PKCE:          S256
```

该 Discovery 当前没有公布 `end_session_endpoint`，因此跨系统退出采用显式、可选的完整 Authelia Logout URL；未配置时只退出 Cloud Mail Plus 本地会话。

## 1. 确定 Cloud Mail Plus 回调地址

先确定用户最终访问 Cloud Mail Plus 的 HTTPS 地址。假设为：

```text
https://mail.example.com
```

则回调地址必须精确填写为：

```text
https://mail.example.com/api/auth/callback/authelia
```

Authelia 对 Redirect URI 做区分大小写的精确匹配。不要填写前端路由，也不要把回调放到浏览器中处理。

## 2. 生成 OIDC Client ID 和 Client Secret

Authelia 官方建议使用长随机值，并在 Authelia 配置中保存 Client Secret 的哈希，在 Cloud Mail Plus Worker secret 中保存明文。

Docker：

```bash
docker run --rm authelia/authelia:latest \
  authelia crypto hash generate pbkdf2 \
  --variant sha512 --random --random.length 72 --random.charset rfc3986
```

裸机：

```bash
authelia crypto hash generate pbkdf2 \
  --variant sha512 --random --random.length 72 --random.charset rfc3986
```

保存输出中的两项：

- 明文随机值：后面写入 Cloudflare Worker secret。
- `$pbkdf2-sha512$...` 哈希：写入 Authelia 的 `client_secret`。

Client ID 也应使用独立的长随机值，且只使用 RFC3986 unreserved 字符。

## 3. 配置 Authelia 客户端

把下面片段加入 Authelia `configuration.yml` 的现有 `identity_providers.oidc.clients`。不要覆盖已有 Provider 的 `hmac_secret`、JWKS 或其他客户端。

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: '替换为随机ClientID'
        client_name: 'Cloud Mail Plus'
        client_secret: '$pbkdf2-sha512$替换为上一步生成的哈希'
        public: false
        authorization_policy: 'one_factor'
        consent_mode: 'implicit'
        require_pkce: true
        pkce_challenge_method: 'S256'
        redirect_uris:
          - 'https://mail.example.com/api/auth/callback/authelia'
        scopes:
          - 'openid'
          - 'profile'
          - 'email'
        response_types:
          - 'code'
        grant_types:
          - 'authorization_code'
        id_token_signed_response_alg: 'RS256'
        access_token_signed_response_alg: 'none'
        userinfo_signed_response_alg: 'none'
        token_endpoint_auth_method: 'client_secret_basic'
```

本部署按单因素、无重复同意页的使用要求配置。`consent_mode: 'implicit'` 会在已有 Authelia 登录会话时自动视为用户同意；Cloud Mail Plus 不请求 `offline_access`，也不会取得 Refresh Token。Authelia 官方提示 `implicit` 不属于标准 OIDC 同意模式且不建议用于不受信任客户端，因此只应对这个受控的机密客户端启用，不能作为所有客户端的全局默认值。若以后希望恢复显式同意，删除该行或改为 `explicit`；若希望首次同意后记忆一段时间，可改为 `pre-configured` 并配置 `pre_configured_consent_duration`。

重启或重载 Authelia 后，再次读取 Discovery，确认服务正常：

```bash
curl --fail --silent \
  https://auth.longlivehome.eu.org/.well-known/openid-configuration | jq
```

参考：

- https://www.authelia.com/configuration/identity-providers/openid-connect/clients/
- https://www.authelia.com/integration/openid-connect/frequently-asked-questions/
- https://www.authelia.com/integration/openid-connect/openid-connect-1.0-claims/

## 4. Cloudflare Worker 环境变量

非敏感变量放在 `mail-worker/wrangler.toml` 的 `[vars]`：

```toml
authelia_sso_switch = "true"
authelia_issuer = "https://auth.longlivehome.eu.org"
authelia_client_id = "替换为与Authelia一致的ClientID"
authelia_redirect_uri = "https://mail.example.com/api/auth/callback/authelia"
authelia_scopes = "openid profile email"
authelia_auto_create_user = "false"
authelia_require_verified_email = "true"
authelia_token_endpoint_auth_method = "client_secret_basic"
authelia_id_token_signing_alg = "RS256"
authelia_logout_enabled = "false"
```

Client Secret 只能写成 Worker secret：

```bash
cd mail-worker
npx wrangler secret put authelia_client_secret
```

输入第 2 步保存的明文，不能输入 Authelia 配置中的 PBKDF2 哈希。

### 环境变量清单

| 名称 | 必需 | 默认值 | 说明 |
|---|---:|---|---|
| `authelia_sso_switch` | 是 | `false` | 是否显示并启用 SSO |
| `authelia_issuer` | 是 | 无 | 必须与 Discovery 的 `issuer` 完全一致 |
| `authelia_client_id` | 是 | 无 | Authelia Client ID |
| `authelia_client_secret` | 是 | 无 | Worker secret；绝不放进源码或 `[vars]` |
| `authelia_redirect_uri` | 推荐 | 当前请求 origin + 固定回调路径 | 生产环境建议显式填写 |
| `authelia_scopes` | 否 | `openid profile email` | 必须含 `openid` 和 `email` |
| `authelia_auto_create_user` | 否 | `false` | 没有同邮箱用户时是否创建本地用户 |
| `authelia_require_verified_email` | 否 | `true` | 是否拒绝未验证邮箱 |
| `authelia_token_endpoint_auth_method` | 否 | `client_secret_basic` | 支持 `client_secret_basic`、`client_secret_post` |
| `authelia_id_token_signing_alg` | 否 | Provider 公布的安全非对称算法 | 建议固定 `RS256` |
| `authelia_logout_enabled` | 否 | `false` | 本地退出后是否跳转到 Authelia |
| `authelia_logout_url` | 条件必需 | 无 | 启用联动退出时的完整 HTTPS URL |

## 5. 部署 Cloudflare Workers 和 D1

### 一键脚本

```bash
bash scripts/deploy.sh --with-authelia
```

脚本会：

1. 将非敏感 OIDC 配置写入它管理的 `wrangler.toml` 区块。
2. 部署 Worker 和前端。
3. 用 `wrangler secret put` 写入明文 Client Secret，不把它保存到状态文件。
4. 调用数据库初始化接口，创建或升级 D1，包括 `sso_identity` 表。自动部署通过 `X-Init-Secret` 请求头传递密钥，避免把 JWT 密钥写进 URL 和访问日志。

若第一次部署时还不知道最终 URL，可先执行：

```bash
bash scripts/deploy.sh --no-authelia
```

确定 URL、配置好 Authelia 客户端后再执行：

```bash
bash scripts/deploy.sh --with-authelia --redeploy
```

`--redeploy` 会重新生成托管配置区块，因此可以从关闭状态切换为启用状态。

### 手动部署或升级已有实例

不要在已有生产实例上直接用仓库中的默认 `mail-worker/wrangler.toml` 运行 `npx wrangler deploy`。该文件是待填写的模板；缺少的绑定会被生产部署移除。已有实例请优先使用下一节的 GitHub Actions，并把现有绑定全部映射为 Repository variables；或先用 `scripts/deploy.sh --with-authelia --redeploy` 生成完整配置后再部署。

随后必须重新运行数据库初始化端点；它是幂等的。推荐从请求头传递密钥：

```bash
curl --fail --request POST \
  --header "X-Init-Secret: 你的jwt_secret" \
  "https://mail.example.com/api/init"
```

确认表和唯一索引存在：

```bash
npx wrangler d1 execute "你的_D1_数据库名" --remote --command \
  "SELECT name, type FROM sqlite_master WHERE name LIKE '%sso_identity%';"
```

预期至少看到 `sso_identity` 表、`idx_sso_identity_issuer_subject` 唯一索引和 `idx_sso_identity_user_id` 索引。

### GitHub Actions 自动部署（推荐）

仓库的 `.github/workflows/deploy-cloudflare.yml` 会在 `main` 分支中的 Worker、前端或部署工作流发生变化时自动执行：安装锁定依赖、运行 Worker 单元测试、构建前端、把代码和加密 Worker Secrets 一次发布，并调用幂等的数据库初始化/升级接口。生产 Secrets 仅注入最终部署和初始化步骤，不会暴露给依赖安装、测试或前端构建。也可以在 GitHub 的 **Actions → Deploy cloud-mail to Cloudflare Workers → Run workflow** 手动执行（只允许 `main`）。

已有实例推荐复用原 Worker 和绑定，不需要删除数据。先在 Cloudflare 控制台记录以下值，再到 fork 仓库的 **Settings → Secrets and variables → Actions** 配置。不要把 Secret 写进 Repository variable。

Repository secrets：

| 名称 | 必需 | 说明 |
|---|---:|---|
| `CLOUDFLARE_API_TOKEN` | 是 | 使用 Cloudflare `Edit Cloudflare Workers` 模板创建的 API Token |
| `JWT_SECRET` | 是 | Cloud Mail Plus JWT 密钥；可保留旧值，修改它只会使现有登录会话失效，不会删除邮件数据。若旧值曾以明文变量保存或已经暴露，应生成新值并轮换 |
| `AUTHELIA_CLIENT_SECRET` | 启用 SSO 时 | Authelia OIDC 客户端的明文 Secret；不是 PBKDF2 哈希 |
| `LINUXDO_CLIENT_SECRET` | 否 | 仍需保留 LinuxDo 登录时填写 |

Repository variables：

| 名称 | 推荐值/说明 |
|---|---|
| `NAME` | 现有 Worker 名称，例如 `cloud-mail`；必须与要升级的 Worker 完全一致 |
| `DEPLOYMENT_MODE` | 升级现有实例填 `existing`；只有明确全新部署时才填 `fresh` |
| `PRODUCTION_BINDINGS_CONFIRMED` | 完成现有绑定盘点后才设为 `true`；这是防止误覆盖生产 Worker 的安全开关 |
| `CUSTOM_DOMAIN` | 仅主机名，例如 `mail.example.com`，不要带 `https://` 或路径 |
| `DOMAIN` | JSON 字符串数组，例如 `["example.com"]` |
| `ADMIN` | Cloud Mail Plus 管理员邮箱 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `D1_DATABASE_NAME` | 现有 D1 名称；一般为 `cloud-mail` |
| `D1_DATABASE_ID` | 现有 D1 UUID；保留数据时务必填写 |
| `KV_NAMESPACE_ID` | 现有 KV namespace ID；保留登录会话配置时务必填写 |
| `R2_BUCKET_NAME` | 现有附件桶名称；没有使用 R2 时留空 |
| `CF_EMAIL_SEND_ENABLED` | 旧实例有 `EMAIL` Send Email binding 时设 `true`，否则 `false` |
| `WORKERS_AI_ENABLED` | 旧实例有 `AI` binding（翻译或邮件 Agent）时设 `true`，否则 `false` |
| `AI_EMAIL_AGENT_ENABLED` | 旧实例有 `EMAIL_AGENT` Durable Object binding 时设 `true`，否则 `false`；启用时 `WORKERS_AI_ENABLED` 也须为 `true` |
| `EMAIL_EVENTS_QUEUE` | 可选；旧实例配置邮件发送事件 consumer 时填写 queue 名称 |
| `EMAIL_EVENTS_DEAD_LETTER_QUEUE` | 可选；对应 dead-letter queue 名称 |
| `AUTHELIA_SSO_SWITCH` | `true` |
| `AUTHELIA_ISSUER` | `https://auth.longlivehome.eu.org` |
| `AUTHELIA_DISCOVERY_URL` | 可留空；需要显式固定时填 `https://auth.longlivehome.eu.org/.well-known/openid-configuration` |
| `AUTHELIA_CLIENT_ID` | 与 Authelia 配置完全一致的 Client ID |
| `AUTHELIA_REDIRECT_URI` | `https://mail.example.com/api/auth/callback/authelia` |
| `AUTHELIA_SCOPES` | `openid profile email` |
| `AUTHELIA_AUTO_CREATE_USER` | `true`：没有同邮箱本地用户时，以 OIDC `preferred_username` 和首个 `DOMAIN` 域名创建邮箱。本 fork 的自动部署工作流已按生产要求固定启用；如需关闭，应将工作流中的该值改为 `false` |
| `AUTHELIA_REQUIRE_VERIFIED_EMAIL` | `true` |
| `AUTHELIA_TOKEN_ENDPOINT_AUTH_METHOD` | `client_secret_basic` |
| `AUTHELIA_ID_TOKEN_SIGNING_ALG` | `RS256` |
| `AUTHELIA_LOGOUT_ENABLED` | `true`；本 fork 的生产工作流已固定启用联动退出 |
| `AUTHELIA_LOGOUT_URL` | `https://auth.longlivehome.eu.org/logout?rd=https%3A%2F%2Fmail.longlivehome.eu.org%2Flogin`；本 fork 的生产工作流已固定此值 |
| `PROJECT_LINK` | 可选的项目链接 |
| `ORM_LOG` | 可选；需要 Drizzle SQL 日志时填 `true`，否则留空或填 `false` |
| `MAIL_BRIDGE_URL` | 可选；使用 Stalwart sent-mail bridge 时填写服务 URL |
| `LINUXDO_CLIENT_ID` | 可选；仍保留 LinuxDo SSO 时填写 |
| `LINUXDO_CALLBACK_URL` | 可选；仍保留 LinuxDo SSO 时填写 |
| `LINUXDO_SWITCH` | 可选；保留时设 `true`，否则设 `false` |

可选的 `MAIL_BRIDGE_KEY` 必须作为 Repository secret 保存，不能作为变量。

只有在 `DEPLOYMENT_MODE=fresh` 时，`D1_DATABASE_ID` 或 `KV_NAMESPACE_ID` 才允许留空；工作流会按名称查找，找不到时创建新资源。`existing` 模式要求显式 ID，避免误接到空库。R2 bucket、Email Sending、AI/DO、队列及 Email Routing 不会自动创建，必须先在 Cloudflare 配好。自动创建 D1/KV 时，Cloudflare API Token 还需要对应的编辑权限。

配置完成后把功能分支合并到 `main`。第一次成功运行会对原 D1 执行增量初始化，新增 `sso_identity`，不会清空现有用户、邮箱或邮件。后续每次向 `main` 推送相关代码都会自动更新同一个 Worker。

从旧 Authentik 版本迁移时，先保持 `AUTHELIA_AUTO_CREATE_USER=false`，并确保 Authelia 返回的已验证 email 与原 Cloud Mail Plus 本地用户 email 完全相同（匹配不区分大小写）。旧 Authentik 实现没有可迁移的 Authelia `(issuer, sub)` 绑定；第一次 Authelia 登录会用 email 找到原用户并建立新绑定。若先开启自动创建且 email 不一致，会创建第二个本地用户，看起来像原邮件“消失”。确认绑定正确并留出一个回滚窗口后，才考虑开启自动创建和删除旧 `authentik_*` 变量/secret。

Fork 第一次使用 Actions 时，GitHub 可能要求在 **Actions** 页点击启用工作流。务必先设置全部 Secrets/Variables，再合并 PR；PR 本身不会部署，合并到 `main` 才会触发。部署不是数据库事务：若 Worker 已更新但 Secret 上传或初始化失败，可先在 Cloudflare **Workers & Pages → Worker → Deployments** 回滚上一版本，修复配置后再从 Actions 手动重跑。

Cloudflare Secret 的旧值不可回读。不知道旧 `JWT_SECRET` 时可以生成新的随机十六进制值；不会删除数据，但所有旧登录会话会失效。旧 Cloudflare API Token 或 OIDC Client Secret 不知道明文时，也应新建或轮换，而不是尝试恢复。

## 6. 用户匹配和权限行为

首次 SSO 登录按以下顺序处理：

1. 验证 ID Token 和 UserInfo，取稳定的 `issuer + sub` 以及 email。
2. 如果 D1 已存在该 `issuer + sub` 绑定，直接使用绑定的 `user_id`；即使以后 email 变化，也不会错绑到其他账户。
3. 如果尚未绑定，以大小写不敏感方式查找同 email 的 Cloud Mail Plus 用户并建立绑定。
4. 如果没有同 email 用户，仅在 `authelia_auto_create_user=true` 时创建用户：始终优先以 OIDC `preferred_username`（缺失时回退到已验证邮箱的本地部分）加首个 `DOMAIN` 域名生成本地邮箱。
5. 自动创建仍执行邮箱格式、允许域名、前缀规则、默认角色和角色域名权限检查。由用户名生成的目标邮箱若已存在会拒绝登录，绝不会按用户名接管旧账户。
6. 已删除或已禁用用户仍由原生登录检查拒绝。

SSO 用户最终获得的仍是 Cloud Mail Plus 原生 JWT，并继续使用现有 KV 会话列表和权限中间件。因此用户只能访问其本地 `user_id` 下的邮箱账户和邮件数据。

## 7. 安全退出

无论是否启用联动退出，界面都会先调用 Cloud Mail Plus `/api/logout` 撤销当前 KV 会话并删除浏览器本地 Token。

当前 Authelia Discovery 未公布标准 `end_session_endpoint`，Authelia 也尚未实现 OIDC RP-Initiated Logout。本 fork 使用 Authelia 门户的 `/logout` 清除其浏览器会话，并通过受信任的 `rd` 参数返回邮箱登录页：

```toml
authelia_logout_enabled = "true"
authelia_logout_url = "https://auth.longlivehome.eu.org/logout?rd=https%3A%2F%2Fmail.longlivehome.eu.org%2Flogin"
```

退出顺序是：撤销当前 Cloud Mail Plus KV/JWT 会话、删除浏览器本地 Token、访问固定的 Authelia Logout URL、清除 Authelia Session Cookie、回到 `/login`。Worker 只接受部署时配置的 HTTPS Logout URL，不接受浏览器传入任意跳转地址。

## 8. 验证清单

### 静态和自动化验证

```bash
cd mail-worker
pnpm run test:unit
npx wrangler deploy --dry-run

cd ../mail-vue
pnpm run build
```

### 实际登录验证

1. 未启用 SSO 时，原有密码登录和注册流程保持可用，页面不显示 SSO 按钮。
2. 启用后访问登录页，确认显示“统一身份认证（SSO）”。
3. 点击按钮，检查 Authelia 请求中包含 `response_type=code`、`state`、`nonce`、`code_challenge` 和 `code_challenge_method=S256`。
4. 完成 Authelia 登录后，应回到 `/api/auth/callback/authelia`，再跳转到 Cloud Mail Plus 首页。
5. 查询绑定：

```bash
npx wrangler d1 execute "你的_D1_数据库名" --remote --command \
  "SELECT issuer, subject, user_id, email, create_time FROM sso_identity;"
```

6. 确认相同用户再次登录不会新增第二条绑定。
7. 在 Authelia 修改该用户 email 后再次登录，确认仍进入原 `user_id`，仅绑定表的审计 email 更新。
8. 设置 `authelia_auto_create_user=false`，用没有本地同邮箱账户的 Authelia 用户登录，应被拒绝。
9. 暂时把 `authelia_client_secret` 改错，确认回调失败且不会创建本地会话；随后恢复 secret。
10. 退出并确认当前 Cloud Mail Plus Token 无法再调用受保护 API；若配置联动退出，再确认浏览器被送到指定 Authelia Logout URL。

## 9. 常见故障

- `redirect_uri` 错误：Authelia 和 Worker 必须逐字符一致。
- `state` 失效：从登录页重新开始；事务和 Cookie 只保留 10 分钟。
- ID Token 验证失败：确认 Client 的 `id_token_signed_response_alg` 与 Worker 的 `authelia_id_token_signing_alg` 一致，且 Authelia JWKS 正常。
- UserInfo 缺少 email：Client scopes 必须允许 `email`，用户目录中也必须有主邮箱。
- 自动创建失败：检查 Cloud Mail Plus `domain`、邮箱前缀规则和默认角色可用域名。
- 已有实例首次启用后报 D1 表不存在：用本节的 `POST /api/init` + `X-Init-Secret` 方式重新初始化。
- 部署后登录页仍是旧界面：先用无痕窗口验证；必要时硬刷新并注销旧 PWA Service Worker/清理该站点缓存。
