import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	send: vi.fn(),
	tokens: [],
}));

vi.mock('resend', () => ({
	Resend: class {
		constructor(token) {
			mocks.tokens.push(token);
			this.emails = { send: mocks.send };
		}
	},
}));

import { buildResendForwardForm, forwardIncomingEmail } from '../../src/service/mail-forward-service';

const parsedEmail = {
	from: { address: 'sender@outside.example', name: 'Sender' },
	to: [{ address: 'user@example.com', name: 'User' }],
	subject: 'Original subject',
	date: '2026-08-17T08:00:00Z',
	html: '<p>Original body</p>',
	text: 'Original body',
};

describe('incoming email forwarding provider selection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.tokens.length = 0;
		mocks.send.mockResolvedValue({ data: { id: 'resend-forward-1' }, error: null });
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => vi.restoreAllMocks());

	it('builds a Resend-safe forward from the local mailbox with Reply-To and attachments', () => {
		const form = buildResendForwardForm({
			parsedEmail,
			sourceEmail: 'user@example.com',
			destination: 'archive@third-party.example',
			attachments: [{
				filename: 'note.txt',
				mimeType: 'text/plain',
				content: new TextEncoder().encode('hello'),
			}],
		});

		expect(form).toMatchObject({
			from: 'user <user@example.com>',
			to: ['archive@third-party.example'],
			replyTo: 'sender@outside.example',
			subject: 'Fwd: Original subject',
		});
		expect(form.html).toContain('Sender &lt;sender@outside.example&gt;');
		expect(form.attachments).toEqual([expect.objectContaining({
			filename: 'note.txt',
			content: 'aGVsbG8=',
			contentType: 'text/plain',
		})]);
	});

	it('uses Resend directly in resend-only mode without Cloudflare destination verification', async () => {
		const message = { forward: vi.fn() };
		const result = await forwardIncomingEmail({
			message,
			parsedEmail,
			sourceEmail: 'user@example.com',
			forwardEmail: 'Archive@Third-Party.Example',
			scope: '个人',
			emailProvider: 'resend-only',
			resendTokens: { 'example.com': 're_test' },
		});

		expect(message.forward).not.toHaveBeenCalled();
		expect(mocks.tokens).toEqual(['re_test']);
		expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
			to: ['archive@third-party.example'],
		}));
		expect(result).toEqual([expect.objectContaining({ provider: 'resend', ok: true })]);
	});

	it('uses Cloudflare first and does not call Resend when it succeeds', async () => {
		const message = { forward: vi.fn().mockResolvedValue(undefined) };
		const result = await forwardIncomingEmail({
			message,
			parsedEmail,
			sourceEmail: 'user@example.com',
			forwardEmail: 'archive@third-party.example',
			scope: '全域',
			emailProvider: 'cf-first',
			resendTokens: { 'example.com': 're_test' },
		});

		expect(message.forward).toHaveBeenCalledWith('archive@third-party.example');
		expect(mocks.send).not.toHaveBeenCalled();
		expect(result[0]).toMatchObject({ provider: 'cloudflare', ok: true });
	});

	it('falls back to Resend when Cloudflare forwarding rejects the destination', async () => {
		const message = { forward: vi.fn().mockRejectedValue(new Error('destination not verified')) };
		const result = await forwardIncomingEmail({
			message,
			parsedEmail,
			sourceEmail: 'user@example.com',
			forwardEmail: 'archive@third-party.example',
			scope: '个人',
			emailProvider: 'cf-first',
			resendTokens: { 'example.com': 're_test' },
		});

		expect(message.forward).toHaveBeenCalledOnce();
		expect(mocks.send).toHaveBeenCalledOnce();
		expect(result[0]).toMatchObject({ provider: 'resend', ok: true });
	});

	it('keeps cf-only mode on Cloudflare and reports a failed unverified destination', async () => {
		const message = { forward: vi.fn().mockRejectedValue(new Error('destination not verified')) };
		const result = await forwardIncomingEmail({
			message,
			parsedEmail,
			sourceEmail: 'user@example.com',
			forwardEmail: 'archive@third-party.example',
			scope: '个人',
			emailProvider: 'cf-only',
			resendTokens: { 'example.com': 're_test' },
		});

		expect(mocks.send).not.toHaveBeenCalled();
		expect(result[0]).toMatchObject({ provider: 'cloudflare', ok: false });
	});
});

