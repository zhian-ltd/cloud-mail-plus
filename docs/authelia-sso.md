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
        authorization_policy: 'two_factor'
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
4. 调用原有 `/api/init/<jwt_secret>`，创建或升级 D1，包括 `sso_identity` 表。

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

```bash
cd mail-worker
pnpm install
npx wrangler secret put authelia_client_secret
npx wrangler deploy
```

随后必须重新运行数据库初始化端点；它是幂等的：

```bash
curl --fail "https://mail.example.com/api/init/你的jwt_secret"
```

确认表和唯一索引存在：

```bash
npx wrangler d1 execute cloud-mail --remote --command \
  "SELECT name, type FROM sqlite_master WHERE name LIKE '%sso_identity%';"
```

预期至少看到 `sso_identity` 表、`idx_sso_identity_issuer_subject` 唯一索引和 `idx_sso_identity_user_id` 索引。

## 6. 用户匹配和权限行为

首次 SSO 登录按以下顺序处理：

1. 验证 ID Token 和 UserInfo，取稳定的 `issuer + sub` 以及 email。
2. 如果 D1 已存在该 `issuer + sub` 绑定，直接使用绑定的 `user_id`；即使以后 email 变化，也不会错绑到其他账户。
3. 如果尚未绑定，以大小写不敏感方式查找同 email 的 Cloud Mail Plus 用户并建立绑定。
4. 如果没有同 email 用户，仅在 `authelia_auto_create_user=true` 时创建用户。
5. 自动创建仍执行邮箱格式、允许域名、前缀规则、默认角色和角色域名权限检查。
6. 已删除或已禁用用户仍由原生登录检查拒绝。

SSO 用户最终获得的仍是 Cloud Mail Plus 原生 JWT，并继续使用现有 KV 会话列表和权限中间件。因此用户只能访问其本地 `user_id` 下的邮箱账户和邮件数据。

## 7. 安全退出

无论是否启用联动退出，界面都会先调用 Cloud Mail Plus `/api/logout` 撤销当前 KV 会话并删除浏览器本地 Token。

当前 Authelia Discovery 未公布标准 `end_session_endpoint`。因此默认：

```toml
authelia_logout_enabled = "false"
```

如你的 Authelia 部署已确认可使用某个 Logout URL，可显式配置完整地址。例如下例仅是常见形式，必须先按你的 Authelia 版本验证：

```toml
authelia_logout_enabled = "true"
authelia_logout_url = "https://auth.longlivehome.eu.org/logout?rd=https%3A%2F%2Fmail.example.com%2Flogin"
```

Worker 只接受 HTTPS Logout URL，不接受浏览器传入任意跳转地址。

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
npx wrangler d1 execute cloud-mail --remote --command \
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
- 已有实例首次启用后报 D1 表不存在：重新调用 `/api/init/<jwt_secret>`。
