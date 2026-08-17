import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardMessage } from '../../src/email/email';

describe('incoming email transparent forwarding', () => {
	afterEach(() => vi.restoreAllMocks());

	it('always forwards the original Cloudflare message to unique verified destinations', async () => {
		const message = { forward: vi.fn().mockResolvedValue(undefined) };

		await forwardMessage(
			message,
			'Archive@Example.com, backup@example.net，archive@example.com',
			'个人',
		);

		expect(message.forward).toHaveBeenCalledTimes(2);
		expect(message.forward).toHaveBeenNthCalledWith(1, 'archive@example.com');
		expect(message.forward).toHaveBeenNthCalledWith(2, 'backup@example.net');
	});

	it('isolates an unverified destination failure from other forwarding targets', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const message = {
			forward: vi.fn(address => address.startsWith('bad@')
				? Promise.reject(new Error('destination not verified'))
				: Promise.resolve()),
		};

		await expect(forwardMessage(
			message,
			'bad@example.com,good@example.com',
			'全域',
		)).resolves.toBeUndefined();

		expect(message.forward).toHaveBeenCalledTimes(2);
		expect(console.error).toHaveBeenCalledWith(
			'全域转发邮箱 bad@example.com 失败：',
			expect.any(Error),
		);
	});
});
