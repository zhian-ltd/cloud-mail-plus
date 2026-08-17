import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../../src/utils/secret-crypto';

const SERVER_SECRET = 'a'.repeat(64);

function decodeBase64Url(value) {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

describe('secret encryption', () => {
	it('round-trips a secret without storing plaintext', async () => {
		const encrypted = await encryptSecret('sk-private-value', SERVER_SECRET);
		expect(encrypted).toMatch(/^v1:/);
		expect(encrypted).not.toContain('sk-private-value');
		await expect(decryptSecret(encrypted, SERVER_SECRET)).resolves.toBe('sk-private-value');
	});

	it('rejects tampering and a different server key', async () => {
		const encrypted = await encryptSecret('sk-private-value', SERVER_SECRET);
		await expect(decryptSecret(encrypted, 'b'.repeat(64))).rejects.toThrow(/cannot be decrypted/i);

		const [version, initializationVector, ciphertext] = encrypted.split(':');
		const tamperedCiphertext = decodeBase64Url(ciphertext);
		tamperedCiphertext[0] ^= 1;
		const tampered = `${version}:${initializationVector}:${encodeBase64Url(tamperedCiphertext)}`;
		await expect(decryptSecret(tampered, SERVER_SECRET)).rejects.toThrow(/cannot be decrypted/i);
	});

	it('requires a sufficiently strong server secret', async () => {
		await expect(encryptSecret('value', 'short')).rejects.toThrow(/not configured/i);
	});
});
