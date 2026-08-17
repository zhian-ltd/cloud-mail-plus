# AI 设置

Cloud Mail Plus 的邮件助手、自动回复草稿和邮件翻译共用一套由管理员维护的全局 AI 配置。普通用户只能启用个人助手及人设，不能读取或修改提供商凭据。

## 默认选择

新安装和升级安装默认使用：

- 提供商：Cloudflare Workers AI
- 模型：`@cf/zai-org/glm-4.7-flash`

该模型支持多语言和函数调用，并可用于 Workers Free。Cloudflare 每日提供 10,000 Neurons 的免费额度，超出额度需要 Workers Paid。官方资料：

- [GLM 4.7 Flash 模型页](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/)
- [Workers AI 计费说明](https://developers.cloudflare.com/workers-ai/platform/pricing/)

`@cf/moonshotai/kimi-k2.6` 不是默认模型。Cloudflare 自 2026-07-28 起将它限制为 Workers Paid；Workers Free 调用会返回 HTTP 403、内部错误 `5035`。同样受限的还有 `@cf/moonshotai/kimi-k2.7-code` 和 `@cf/zai-org/glm-5.2`。参见 [Cloudflare 变更公告](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/)。

## 在网页中配置

1. 使用管理员账户登录。
2. 打开“系统设置 → AI 设置”。
3. 选择提供商和模型。
4. 点击“测试连接”；成功后点击“保存”。
5. 打开任意邮件，验证翻译；再到“个人设置 → AI 邮件助手”启用助手并验证对话和草稿。

### Cloudflare Workers AI

此方式不需要额外 API Key，但 Worker 必须保留 `[ai]` 绑定。系统提供以下常用选项，也允许手工输入其他 Workers AI 模型 ID：

- `@cf/zai-org/glm-4.7-flash`：Free 计划可用，默认；
- `@cf/google/gemma-4-26b-a4b-it`：Free 计划可用；
- `@cf/nvidia/nemotron-3-120b-a12b`：Free 计划可用；
- `@cf/moonshotai/kimi-k2.6`：需要 Workers Paid。

GitHub 自动部署中应保持 Repository Variable `WORKERS_AI_ENABLED=true`，否则部署配置不会生成 AI 绑定。

### OpenAI 兼容接口

填写：

- API 基础地址，例如 `https://api.openai.com/v1`；
- 模型 ID，例如 `gpt-5.6-terra`；
- 对应服务商签发的 API Key。

系统调用标准 `POST {base_url}/chat/completions`，支持流式文本和函数调用。基础地址必须是公共 HTTPS 主机，不能包含用户名、密码、查询参数或片段，也不接受 localhost 和直接 IP，以降低服务端请求伪造风险。

`gpt-5.6-terra` 可以用于本项目：OpenAI 官方列出的 Chat Completions、流式输出和函数调用能力符合邮件助手需要。它不是 Cloudflare Workers AI 模型，也不是 OpenAI API 免费模型；需要有效的 OpenAI API Key 和 API 计费账户。参见 [GPT-5.6 Terra 模型页](https://developers.openai.com/api/docs/models/gpt-5.6-terra)。其他服务商只有在其 Chat Completions 和工具调用格式与 OpenAI 兼容时，才能完整使用邮件助手；只支持纯文本的接口可能只能用于翻译或普通生成。

## 密钥安全

- API Key 只提交给 Workers 后端，浏览器以后只能看到“已配置”，不能读回明文。
- 后端使用 AES-GCM 加密后存入 D1，密钥由 Worker 的 `jwt_secret` 派生。
- 更换 `jwt_secret` 会同时使现有登录会话失效，并导致旧 AI API Key 无法解密；轮换后必须在系统设置中重新输入 API Key。
- “测试连接”可以使用尚未保存的新 Key；成功并不等于已经保存，仍需点击“保存”。

## 升级与数据库初始化

本版本在 `setting` 表新增 `ai_provider`、`ai_model`、`ai_base_url` 和 `ai_api_key_encrypted` 字段。GitHub Actions 部署会在代码发布后调用受保护的 `POST /api/init` 幂等升级 D1；不会删除邮件、用户、SSO 绑定或个人推送配置。

如果代码已经上线但初始化步骤失败，可先从 Cloudflare Deployments 回滚，再修复凭据并重新运行部署。不要跳过初始化后直接修改 AI 设置。

## 验证清单

1. 系统设置显示默认 GLM 4.7 Flash 且状态为“可用”。
2. “测试连接”返回成功。
3. 邮件翻译能够生成并缓存译文。
4. 普通用户的 AI 助手只能查询该用户自己的邮件。
5. 自动起草只生成草稿，不自动发送。
6. 发送和删除仍要求用户在界面中明确确认。
7. 切换为 OpenAI 兼容接口后，保存页面不会回显 API Key。
