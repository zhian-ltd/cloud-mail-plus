import app from '../hono/hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import autheliaService, { AUTHELIA_STATE_COOKIE } from '../service/authelia-service';
import { randomBase64Url } from '../utils/oidc-utils';

app.get('/auth/login/authelia', async c => {
	const { authorizeUrl, state } = await autheliaService.buildAuthorizeUrl(c);
	setCookie(c, AUTHELIA_STATE_COOKIE, state, {
		httpOnly: true,
		maxAge: 10 * 60,
		path: '/',
		sameSite: 'Lax',
		secure: new URL(c.req.url).protocol === 'https:',
	});
	return c.redirect(authorizeUrl);
});

app.get('/auth/callback/authelia', async c => {
	deleteCookie(c, AUTHELIA_STATE_COOKIE, {
		path: '/',
		secure: new URL(c.req.url).protocol === 'https:',
	});
	try {
		const { token, returnTo } = await autheliaService.callback(c);
		return html(c, renderLoginBridge(token, returnTo));
	} catch (error) {
		console.error('[authelia-sso] callback failed', error.message);
		return html(c, renderErrorPage(error.message), error.code || 500, false);
	}
});

app.get('/auth/logout/authelia', c => {
	const logoutUrl = autheliaService.getLogoutUrl(c);
	return c.redirect(logoutUrl || '/login');
});

function html(c, bodyFactory, status = 200, allowScript = true) {
	const nonce = randomBase64Url(18);
	const body = typeof bodyFactory === 'function' ? bodyFactory(nonce) : bodyFactory;
	const scriptPolicy = allowScript ? `script-src 'nonce-${nonce}'` : "script-src 'none'";
	c.header('Cache-Control', 'no-store');
	c.header('Content-Security-Policy', `default-src 'none'; ${scriptPolicy}; base-uri 'none'; frame-ancestors 'none'`);
	c.header('Cross-Origin-Opener-Policy', 'same-origin');
	c.header('Referrer-Policy', 'no-referrer');
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('X-Frame-Options', 'DENY');
	return c.html(body, status);
}

function renderLoginBridge(token, returnTo) {
	return nonce => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SSO Login</title></head>
<body>
<script nonce="${nonce}">
localStorage.setItem('token', ${JSON.stringify(token)});
localStorage.setItem('ssoProvider', 'authelia');
window.location.replace(${JSON.stringify(returnTo)});
</script>
</body>
</html>`;
}

function renderErrorPage(message) {
	return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SSO 登录失败</title></head>
<body><main><h1>SSO 登录失败</h1><p>${escapeHtml(message || 'Unknown error')}</p><p><a href="/login">返回登录页</a></p></main></body>
</html>`;
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
