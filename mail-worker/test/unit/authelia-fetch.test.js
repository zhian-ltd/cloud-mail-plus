import { afterEach, describe, expect, it, vi } from 'vitest';
import autheliaService from '../../src/service/authelia-service';

function createContext(suffix) {
	const issuer = `https://auth-${suffix}.example.test`;
	return {
		issuer,
		context: {
			req: { url: 'https://mail.example.test/api/auth/login/authelia' },
			env: {
				authelia_sso_switch: 'true',
				authelia_issuer: issuer,
				authelia_discovery_url: `${issuer}/.well-known/openid-configuration`,
				authelia_client_id: 'cloud-mail-plus',
				authelia_client_secret: 'test-secret',
				authelia_redirect_uri: 'https://mail.example.test/api/auth/callback/authelia',
				kv: { put: vi.fn() },
			},
		},
	};
}

function discoveryDocument(issuer) {
	return {
		issuer,
		authorization_endpoint: `${issuer}/api/oidc/authorization`,
		token_endpoint: `${issuer}/api/oidc/token`,
		jwks_uri: `${issuer}/jwks.json`,
		userinfo_endpoint: `${issuer}/api/oidc/userinfo`,
		code_challenge_methods_supported: ['S256'],
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('Authelia outbound requests', () => {
	it('uses the Cloudflare-compatible manual redirect mode', async () => {
		const { context, issuer } = createContext('manual');
		const fetchMock = vi.fn().mockResolvedValue(new Response(
			JSON.stringify(discoveryDocument(issuer)),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		));
		vi.stubGlobal('fetch', fetchMock);

		const result = await autheliaService.buildAuthorizeUrl(context);

		expect(fetchMock).toHaveBeenCalledWith(
			`${issuer}/.well-known/openid-configuration`,
			expect.objectContaining({ redirect: 'manual' }),
		);
		expect(result.authorizeUrl).toContain(`${issuer}/api/oidc/authorization`);
		expect(context.env.kv.put).toHaveBeenCalledOnce();
	});

	it('rejects a Discovery redirect instead of following it', async () => {
		const { context } = createContext('redirect');
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {
			status: 302,
			headers: { Location: 'https://unexpected.example.test/discovery' },
		})));

		await expect(autheliaService.buildAuthorizeUrl(context)).rejects.toBeTruthy();
		expect(context.env.kv.put).not.toHaveBeenCalled();
	});
});

describe('Authelia federated logout configuration', () => {
	it('publishes and returns only the fixed HTTPS logout URL when enabled', () => {
		const logoutUrl = 'https://auth.example.test/logout?rd=https%3A%2F%2Fmail.example.test%2Flogin';
		const context = {
			req: { url: 'https://mail.example.test/api/auth/logout/authelia' },
			env: {
				authelia_sso_switch: 'true',
				authelia_issuer: 'https://auth.example.test',
				authelia_logout_enabled: 'true',
				authelia_logout_url: logoutUrl,
			},
		};

		expect(autheliaService.getPublicConfig(context).logoutEnabled).toBe(true);
		expect(autheliaService.getLogoutUrl(context)).toBe(logoutUrl);
	});

	it('keeps provider logout disabled without an explicit URL', () => {
		const context = {
			req: { url: 'https://mail.example.test/api/auth/logout/authelia' },
			env: {
				authelia_sso_switch: 'true',
				authelia_issuer: 'https://auth.example.test',
				authelia_logout_enabled: 'true',
			},
		};

		expect(autheliaService.getPublicConfig(context).logoutEnabled).toBe(false);
		expect(autheliaService.getLogoutUrl(context)).toBeNull();
	});
});
