import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyOidcIdToken } from '../../src/utils/oidc-utils';

const issuer = 'https://auth.example.test';
const clientId = 'cloud-mail-plus';
const discovery = {
	jwks_uri: `${issuer}/jwks.json`,
	id_token_signing_alg_values_supported: ['RS256'],
};

let privateKey;
let resolver;

beforeAll(async () => {
	const keyPair = await generateKeyPair('RS256');
	privateKey = keyPair.privateKey;
	const jwk = await exportJWK(keyPair.publicKey);
	resolver = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256', kid: 'test-key', use: 'sig' }] });
});

async function issueToken(overrides = {}) {
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		iss: issuer,
		aud: clientId,
		sub: 'stable-subject',
		nonce: 'expected-nonce',
		iat: now,
		exp: now + 300,
		...overrides,
	};
	return new SignJWT(claims)
		.setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
		.sign(privateKey);
}

describe('Authelia ID Token validation', () => {
	it('verifies signature, issuer, audience, expiry, and nonce', async () => {
		const payload = await verifyOidcIdToken(
			await issueToken(),
			{ issuer, clientId, idTokenAlgorithm: 'RS256' },
			discovery,
			'expected-nonce',
			resolver,
		);
		expect(payload.sub).toBe('stable-subject');
	});

	it('rejects a nonce mismatch', async () => {
		await expect(verifyOidcIdToken(
			await issueToken(),
			{ issuer, clientId, idTokenAlgorithm: 'RS256' },
			discovery,
			'wrong-nonce',
			resolver,
		)).rejects.toThrow(/nonce/);
	});

	it('rejects the wrong audience', async () => {
		await expect(verifyOidcIdToken(
			await issueToken({ aud: 'another-client' }),
			{ issuer, clientId, idTokenAlgorithm: 'RS256' },
			discovery,
			'expected-nonce',
			resolver,
		)).rejects.toThrow();
	});

	it('rejects an expired token', async () => {
		const now = Math.floor(Date.now() / 1000);
		await expect(verifyOidcIdToken(
			await issueToken({ iat: now - 600, exp: now - 300 }),
			{ issuer, clientId, idTokenAlgorithm: 'RS256' },
			discovery,
			'expected-nonce',
			resolver,
		)).rejects.toThrow();
	});

	it('requires this client as azp when the token has multiple audiences', async () => {
		await expect(verifyOidcIdToken(
			await issueToken({ aud: [clientId, 'another-client'], azp: 'another-client' }),
			{ issuer, clientId, idTokenAlgorithm: 'RS256' },
			discovery,
			'expected-nonce',
			resolver,
		)).rejects.toThrow(/authorized party/);
	});
});
