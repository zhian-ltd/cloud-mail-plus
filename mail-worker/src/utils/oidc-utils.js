import { jwtVerify } from 'jose';

const encoder = new TextEncoder();

export const SAFE_ID_TOKEN_ALGORITHMS = [
	'RS256', 'RS384', 'RS512',
	'PS256', 'PS384', 'PS512',
	'ES256', 'ES384', 'ES512',
];

export function base64UrlEncode(input) {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	const value = btoa(String.fromCharCode(...bytes));
	return value.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function randomBase64Url(byteLength = 32) {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

export async function sha256Base64Url(value) {
	return base64UrlEncode(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function createOidcTransaction(returnTo = '/') {
	const codeVerifier = randomBase64Url(64);
	return {
		state: randomBase64Url(32),
		nonce: randomBase64Url(32),
		codeVerifier,
		codeChallenge: await sha256Base64Url(codeVerifier),
		returnTo: sanitizeReturnTo(returnTo),
		createdAt: Date.now(),
	};
}

export function sanitizeReturnTo(value) {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
		return '/';
	}

	try {
		const parsed = new URL(value, 'https://cloud-mail.invalid');
		if (parsed.origin !== 'https://cloud-mail.invalid') return '/';
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return '/';
	}
}

export function normalizeIssuer(value = '') {
	return String(value).trim().replace(/\/+$/, '');
}

export function toBoolean(value, defaultValue = false) {
	if (value === undefined || value === null || value === '') return defaultValue;
	if (typeof value === 'boolean') return value;
	return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function assertSecureAbsoluteUrl(value, label) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be an absolute URL`);
	}

	const localDev = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (url.protocol !== 'https:' && !localDev) {
		throw new Error(`${label} must use HTTPS`);
	}
	return url;
}

export function getAllowedIdTokenAlgorithms(discovery, configuredAlgorithm) {
	const advertised = Array.isArray(discovery.id_token_signing_alg_values_supported)
		? discovery.id_token_signing_alg_values_supported
		: [];
	const safeAdvertised = SAFE_ID_TOKEN_ALGORITHMS.filter(algorithm => advertised.includes(algorithm));

	if (configuredAlgorithm) {
		if (!SAFE_ID_TOKEN_ALGORITHMS.includes(configuredAlgorithm) || !safeAdvertised.includes(configuredAlgorithm)) {
			throw new Error('Configured ID Token signing algorithm is not supported safely');
		}
		return [configuredAlgorithm];
	}

	if (!safeAdvertised.length) {
		throw new Error('Provider does not advertise a supported asymmetric ID Token algorithm');
	}
	return safeAdvertised;
}

export function validateIdentityClaims(idTokenClaims, userInfo, { requireVerifiedEmail = true } = {}) {
	const subject = String(idTokenClaims.sub || '').trim();
	if (!subject || subject.length > 255) throw new Error('ID Token is missing a valid subject');

	const userInfoSubject = String(userInfo.sub || '').trim();
	if (!userInfoSubject || userInfoSubject !== subject) {
		throw new Error('UserInfo subject does not match the ID Token subject');
	}

	const email = String(userInfo.email || '').trim().toLowerCase();
	if (!email) throw new Error('UserInfo is missing an email address');

	const emailVerified = userInfo.email_verified === true || userInfo.email_verified === 'true';
	if (requireVerifiedEmail && !emailVerified) {
		throw new Error('The identity provider did not verify the email address');
	}

	const username = String(
		userInfo.preferred_username
		|| idTokenClaims.preferred_username
		|| userInfo.username
		|| idTokenClaims.username
		|| email.split('@')[0],
	).trim().toLowerCase();
	if (!username || username.length > 255) {
		throw new Error('The identity provider did not return a valid username');
	}

	return { subject, email, emailVerified, username };
}

export function buildSsoAutoCreateEmail(providerEmail, providerUsername, configuredDomains) {
	const email = String(providerEmail || '').trim().toLowerCase();
	const domains = (Array.isArray(configuredDomains) ? configuredDomains : [])
		.map(domain => String(domain || '').trim().toLowerCase())
		.filter(Boolean);
	const providerDomain = email.includes('@') ? email.split('@').pop() : '';
	if (providerDomain && domains.includes(providerDomain)) return email;
	if (!domains.length) throw new Error('No Cloud Mail domain is configured');

	let username = String(providerUsername || '').trim().toLowerCase();
	if (username.includes('@')) username = username.split('@')[0];
	if (!username && email.includes('@')) username = email.split('@')[0];

	if (!username
		|| username.length > 64
		|| !/^[a-z0-9._+-]+$/i.test(username)) {
		throw new Error('The identity provider username cannot be used as an email prefix');
	}

	return `${username}@${domains[0]}`;
}

export async function verifyOidcIdToken(idToken, config, discovery, expectedNonce, keyResolver) {
	if (!idToken) throw new Error('ID Token is missing');
	const algorithms = getAllowedIdTokenAlgorithms(discovery, config.idTokenAlgorithm);
	const { payload } = await jwtVerify(idToken, keyResolver, {
		issuer: config.issuer,
		audience: config.clientId,
		algorithms,
		clockTolerance: 5,
		requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce'],
	});

	if (payload.nonce !== expectedNonce) throw new Error('ID Token nonce does not match');
	if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) {
		throw new Error('ID Token authorized party does not match');
	}
	return payload;
}
