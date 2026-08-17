import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../../src/utils/secret-crypto';

const SERVER_SECRET = 'a'.repeat(64);

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
		await expect(decryptSecret(`${encrypted.slice(0, -1)}x`, SERVER_SECRET)).rejects.toThrow(/cannot be decrypted/i);
	});

	it('requires a sufficiently strong server secret', async () => {
		await expect(encryptSecret('value', 'short')).rejects.toThrow(/not configured/i);
	});
});
