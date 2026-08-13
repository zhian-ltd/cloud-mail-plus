import { createRemoteJWKSet } from 'jose';
import { getCookie } from 'hono/cookie';
import BizError from '../error/biz-error';
import KvConst from '../const/kv-const';
import loginService from './login-service';
import ssoIdentityService from './sso-identity-service';
import userService from './user-service';
import { t } from '../i18n/i18n.js';
import {
	assertSecureAbsoluteUrl,
	createOidcTransaction,
	normalizeIssuer,
	sanitizeReturnTo,
	toBoolean,
	validateIdentityClaims,
	verifyOidcIdToken,
} from '../utils/oidc-utils';

const STATE_TTL_SECONDS = 10 * 60;
const DISCOVERY_CACHE_MS = 10 * 60 * 1000;
const discoveryCache = new Map();
const jwksResolvers = new Map();
export const AUTHELIA_STATE_COOKIE = 'cloud-mail-authelia-state';

const autheliaService = {
	getPublicConfig(c) {
		const enabled = toBoolean(c.env.authelia_sso_switch);
		const logoutEnabled = toBoolean(c.env.authelia_logout_enabled) && Boolean(c.env.authelia_logout_url);
		return {
			enabled,
			loginUrl: '/api/auth/login/authelia',
			logoutEnabled,
		};
	},

	getConfig(c) {
		const issuer = normalizeIssuer(c.env.authelia_issuer);
		const redirectUri = c.env.authelia_redirect_uri
			|| `${new URL(c.req.url).origin}/api/auth/callback/authelia`;
		return {
			enabled: toBoolean(c.env.authelia_sso_switch),
			issuer,
			discoveryUrl: c.env.authelia_discovery_url || `${issuer}/.well-known/openid-configuration`,
			clientId: String(c.env.authelia_client_id || '').trim(),
			clientSecret: String(c.env.authelia_client_secret || ''),
			redirectUri,
			scopes: String(c.env.authelia_scopes || 'openid profile email').trim(),
			autoCreateUser: toBoolean(c.env.authelia_auto_create_user, false),
			requireVerifiedEmail: toBoolean(c.env.authelia_require_verified_email, true),
			tokenEndpointAuthMethod: String(c.env.authelia_token_endpoint_auth_method || 'client_secret_basic').trim(),
			idTokenAlgorithm: String(c.env.authelia_id_token_signing_alg || '').trim(),
			logoutEnabled: toBoolean(c.env.authelia_logout_enabled) && Boolean(c.env.authelia_logout_url),
			logoutUrl: String(c.env.authelia_logout_url || '').trim(),
		};
	},

	validateConfig(config) {
		if (!config.enabled) throw new BizError(t('autheliaSsoDisabled'), 403);
		if (!config.issuer || !config.clientId || !config.clientSecret || !config.redirectUri) {
			throw new BizError(t('autheliaSsoMissingConfig'), 500);
		}
		if (!config.scopes.split(/\s+/).includes('openid')) {
			throw new BizError(t('autheliaSsoMissingOpenidScope'), 500);
		}
		if (!['client_secret_basic', 'client_secret_post'].includes(config.tokenEndpointAuthMethod)) {
			throw new BizError(t('autheliaSsoUnsupportedClientAuth'), 500);
		}

		try {
			assertSecureAbsoluteUrl(config.issuer, 'Authelia issuer');
			assertSecureAbsoluteUrl(config.discoveryUrl, 'Authelia discovery URL');
			assertSecureAbsoluteUrl(config.redirectUri, 'Authelia redirect URI');
		} catch (error) {
			throw new BizError(error.message, 500);
		}
	},

	async buildAuthorizeUrl(c) {
		const config = this.getConfig(c);
		this.validateConfig(config);
		const discovery = await getDiscoveryDocument(config);
		if (!Array.isArray(discovery.code_challenge_methods_supported)
			|| !discovery.code_challenge_methods_supported.includes('S256')) {
			throw new BizError(t('autheliaSsoPkceUnsupported'), 500);
		}

		const returnTo = new URL(c.req.url).searchParams.get('return_to') || '/';
		const transaction = await createOidcTransaction(returnTo);
		await c.env.kv.put(
			KvConst.AUTHELIA_OIDC_STATE + transaction.state,
			JSON.stringify(transaction),
			{ expirationTtl: STATE_TTL_SECONDS },
		);

		const authorizeUrl = new URL(discovery.authorization_endpoint);
		authorizeUrl.searchParams.set('client_id', config.clientId);
		authorizeUrl.searchParams.set('redirect_uri', config.redirectUri);
		authorizeUrl.searchParams.set('response_type', 'code');
		authorizeUrl.searchParams.set('response_mode', 'query');
		authorizeUrl.searchParams.set('scope', config.scopes);
		authorizeUrl.searchParams.set('state', transaction.state);
		authorizeUrl.searchParams.set('nonce', transaction.nonce);
		authorizeUrl.searchParams.set('code_challenge', transaction.codeChallenge);
		authorizeUrl.searchParams.set('code_challenge_method', 'S256');
		return { authorizeUrl: authorizeUrl.toString(), state: transaction.state };
	},

	async callback(c) {
		const config = this.getConfig(c);
		this.validateConfig(config);
		const url = new URL(c.req.url);
		const providerError = url.searchParams.get('error');
		if (providerError) {
			throw new BizError(t('autheliaSsoProviderError', { msg: providerError }), 400);
		}

		const code = url.searchParams.get('code');
		const state = url.searchParams.get('state');
		if (!code) throw new BizError(t('autheliaSsoCodeMissing'), 400);
		if (!state || getCookie(c, AUTHELIA_STATE_COOKIE) !== state) {
			throw new BizError(t('autheliaSsoStateInvalid'), 400);
		}

		const stateKey = KvConst.AUTHELIA_OIDC_STATE + state;
		const transaction = await c.env.kv.get(stateKey, { type: 'json' });
		if (!transaction?.nonce || !transaction?.codeVerifier) {
			throw new BizError(t('autheliaSsoStateInvalid'), 400);
		}
		await c.env.kv.delete(stateKey);

		const discovery = await getDiscoveryDocument(config);
		const tokens = await exchangeCode(config, discovery, code, transaction.codeVerifier);
		const idTokenClaims = await verifyIdToken(tokens.id_token, config, discovery, transaction.nonce);
		const userInfo = await fetchUserInfo(discovery, tokens.access_token);

		let providerIdentity;
		try {
			providerIdentity = validateIdentityClaims(idTokenClaims, userInfo, config);
		} catch (error) {
			throw new BizError(error.message, 403);
		}

		const issuer = String(idTokenClaims.iss);
		let identity = await ssoIdentityService.findByProviderSubject(c, issuer, providerIdentity.subject);
		let userRow;

		if (identity) {
			userRow = await userService.selectByIdIncludeDel(c, identity.userId);
			if (!userRow) throw new BizError(t('autheliaSsoBoundUserMissing'), 403);
			if (identity.email !== providerIdentity.email) {
				await ssoIdentityService.updateEmail(c, identity.identityId, providerIdentity.email);
			}
		} else {
			userRow = await loginService.ensureTrustedSsoUser(c, providerIdentity.email, config.autoCreateUser);
			identity = await ssoIdentityService.bindOrGet(c, {
				issuer,
				subject: providerIdentity.subject,
				userId: userRow.userId,
				email: providerIdentity.email,
			});
			if (!identity) throw new BizError(t('autheliaSsoIdentityBindFailed'), 500);
			if (identity.userId !== userRow.userId) {
				userRow = await userService.selectByIdIncludeDel(c, identity.userId);
				if (!userRow) throw new BizError(t('autheliaSsoBoundUserMissing'), 403);
			}
		}

		const token = await loginService.loginTrustedUser(c, userRow, { authMethod: 'authelia' });
		return { token, returnTo: sanitizeReturnTo(transaction.returnTo) };
	},

	getLogoutUrl(c) {
		const config = this.getConfig(c);
		if (!config.logoutEnabled) return null;
		try {
			return assertSecureAbsoluteUrl(config.logoutUrl, 'Authelia logout URL').toString();
		} catch (error) {
			throw new BizError(error.message, 500);
		}
	},
};

async function getDiscoveryDocument(config) {
	const cacheKey = `${config.issuer}|${config.discoveryUrl}`;
	const cached = discoveryCache.get(cacheKey);
	if (cached && Date.now() - cached.loadedAt < DISCOVERY_CACHE_MS) return cached.document;

	const response = await fetch(config.discoveryUrl, {
		headers: { Accept: 'application/json' },
		redirect: 'manual',
	});
	if (!response.ok) {
		throw new BizError(t('autheliaSsoDiscoveryFailed'), 502);
	}

	const document = await response.json();
	if (normalizeIssuer(document.issuer) !== config.issuer) {
		throw new BizError(t('autheliaSsoIssuerMismatch'), 502);
	}
	for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint']) {
		try {
			assertSecureAbsoluteUrl(document[field], `OIDC ${field}`);
		} catch {
			throw new BizError(t('autheliaSsoDiscoveryInvalid'), 502);
		}
	}

	discoveryCache.set(cacheKey, { document, loadedAt: Date.now() });
	return document;
}

async function exchangeCode(config, discovery, code, codeVerifier) {
	const supportedMethods = discovery.token_endpoint_auth_methods_supported || [];
	if (supportedMethods.length && !supportedMethods.includes(config.tokenEndpointAuthMethod)) {
		throw new BizError(t('autheliaSsoUnsupportedClientAuth'), 500);
	}

	const params = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: config.redirectUri,
		code_verifier: codeVerifier,
	});
	const headers = {
		Accept: 'application/json',
		'Content-Type': 'application/x-www-form-urlencoded',
	};

	if (config.tokenEndpointAuthMethod === 'client_secret_post') {
		params.set('client_id', config.clientId);
		params.set('client_secret', config.clientSecret);
	} else {
		headers.Authorization = `Basic ${btoa(`${oauthFormEncode(config.clientId)}:${oauthFormEncode(config.clientSecret)}`)}`;
	}

	const response = await fetch(discovery.token_endpoint, {
		method: 'POST',
		headers,
		body: params.toString(),
		redirect: 'manual',
	});
	if (!response.ok) {
		console.error('[authelia-sso] token exchange failed', response.status, await safeResponseText(response));
		throw new BizError(t('autheliaSsoTokenExchangeFailed'), 502);
	}

	const tokens = await response.json();
	if (!tokens.access_token || !tokens.id_token) {
		throw new BizError(t('autheliaSsoTokenMissing'), 502);
	}
	if (tokens.token_type && String(tokens.token_type).toLowerCase() !== 'bearer') {
		throw new BizError(t('autheliaSsoTokenTypeInvalid'), 502);
	}
	return tokens;
}

async function verifyIdToken(idToken, config, discovery, expectedNonce, keyResolver) {
	if (!idToken) throw new BizError(t('autheliaSsoTokenMissing'), 502);
	const resolver = keyResolver || getJwksResolver(discovery.jwks_uri);

	try {
		return await verifyOidcIdToken(idToken, config, discovery, expectedNonce, resolver);
	} catch (error) {
		console.error('[authelia-sso] ID Token validation failed', error.code || error.message);
		if (error.message.includes('nonce')) throw new BizError(t('autheliaSsoNonceInvalid'), 403);
		if (error.message.includes('authorized party')) throw new BizError(t('autheliaSsoAuthorizedPartyInvalid'), 403);
		throw new BizError(t('autheliaSsoIdTokenInvalid'), 403);
	}
}

async function fetchUserInfo(discovery, accessToken) {
	const response = await fetch(discovery.userinfo_endpoint, {
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${accessToken}`,
		},
		redirect: 'manual',
	});
	if (!response.ok) {
		console.error('[authelia-sso] UserInfo request failed', response.status, await safeResponseText(response));
		throw new BizError(t('autheliaSsoUserInfoFailed'), 502);
	}
	return response.json();
}

function getJwksResolver(jwksUri) {
	if (!jwksResolvers.has(jwksUri)) {
		jwksResolvers.set(jwksUri, createRemoteJWKSet(new URL(jwksUri)));
	}
	return jwksResolvers.get(jwksUri);
}

function oauthFormEncode(value) {
	const params = new URLSearchParams({ value: String(value) });
	return params.toString().slice('value='.length);
}

async function safeResponseText(response) {
	try {
		return (await response.text()).slice(0, 1000);
	} catch {
		return '<unreadable response>';
	}
}

export default autheliaService;
