import { describe, expect, it } from 'vitest';
import {
	base64UrlEncode,
	buildSsoAutoCreateEmail,
	createOidcTransaction,
	getAllowedIdTokenAlgorithms,
	sanitizeReturnTo,
	validateIdentityClaims,
} from '../../src/utils/oidc-utils';

describe('OIDC transaction helpers', () => {
	it('creates state, nonce, and an S256 PKCE challenge', async () => {
		const transaction = await createOidcTransaction('/inbox?filter=unread');
		const secondTransaction = await createOidcTransaction('/');
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transaction.codeVerifier));

		expect(transaction.state.length).toBeGreaterThanOrEqual(43);
		expect(transaction.nonce.length).toBeGreaterThanOrEqual(43);
		expect(transaction.codeVerifier.length).toBeGreaterThanOrEqual(43);
		expect(transaction.codeChallenge).toBe(base64UrlEncode(digest));
		expect(transaction.returnTo).toBe('/inbox?filter=unread');
		expect(secondTransaction.state).not.toBe(transaction.state);
		expect(secondTransaction.nonce).not.toBe(transaction.nonce);
	});

	it('rejects cross-origin return targets', () => {
		expect(sanitizeReturnTo('https://evil.example/steal')).toBe('/');
		expect(sanitizeReturnTo('//evil.example/steal')).toBe('/');
		expect(sanitizeReturnTo('/settings#profile')).toBe('/settings#profile');
	});
});

describe('OIDC identity claims', () => {
	it('uses a matching sub and normalized verified email', () => {
		expect(validateIdentityClaims(
			{ sub: 'stable-subject' },
			{ sub: 'stable-subject', email: 'User@Example.com ', email_verified: true, preferred_username: 'Alice' },
		)).toEqual({ subject: 'stable-subject', email: 'user@example.com', emailVerified: true, username: 'alice' });
	});

	it('rejects a UserInfo subject mismatch', () => {
		expect(() => validateIdentityClaims(
			{ sub: 'subject-a' },
			{ sub: 'subject-b', email: 'user@example.com', email_verified: true },
		)).toThrow(/does not match/);
	});

	it('requires a verified email by default', () => {
		expect(() => validateIdentityClaims(
			{ sub: 'subject-a' },
			{ sub: 'subject-a', email: 'user@example.com', email_verified: false },
		)).toThrow(/did not verify/);
	});

	it('can accept an unverified email only when explicitly configured', () => {
		expect(validateIdentityClaims(
			{ sub: 'subject-a' },
			{ sub: 'subject-a', email: 'user@example.com', email_verified: false },
			{ requireVerifiedEmail: false },
		)).toEqual({ subject: 'subject-a', email: 'user@example.com', emailVerified: false, username: 'user' });
	});
});

describe('OIDC automatic local email selection', () => {
	it('keeps a verified provider email that already uses an allowed domain', () => {
		expect(buildSsoAutoCreateEmail(
			'Alice@longlivehome.eu.org',
			'another-name',
			['longlivehome.eu.org'],
		)).toBe('alice@longlivehome.eu.org');
	});

	it('uses preferred_username with the first configured Cloud Mail domain', () => {
		expect(buildSsoAutoCreateEmail(
			'alice@example.net',
			'Alice',
			['longlivehome.eu.org'],
		)).toBe('alice@longlivehome.eu.org');
	});

	it('rejects a username that cannot safely form an email prefix', () => {
		expect(() => buildSsoAutoCreateEmail(
			'alice@example.net',
			'alice/../../admin',
			['longlivehome.eu.org'],
		)).toThrow(/email prefix/);
	});
});

describe('ID Token algorithm policy', () => {
	it('allows advertised asymmetric algorithms and rejects HMAC-only providers', () => {
		expect(getAllowedIdTokenAlgorithms({ id_token_signing_alg_values_supported: ['RS256', 'HS256'] }))
			.toEqual(['RS256']);
		expect(() => getAllowedIdTokenAlgorithms({ id_token_signing_alg_values_supported: ['HS256'] }))
			.toThrow(/asymmetric/);
	});
});
