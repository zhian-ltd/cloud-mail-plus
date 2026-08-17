import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	draftDetail: vi.fn(),
	send: vi.fn(),
	deleteDraft: vi.fn(),
	selectByEmailIncludeDel: vi.fn(),
}));

vi.mock('../../src/service/email-service', () => ({
	default: {
		draftDetail: mocks.draftDetail,
		send: mocks.send,
		deleteDraft: mocks.deleteDraft,
	},
}));

vi.mock('../../src/service/account-service', () => ({
	default: {
		selectByEmailIncludeDel: mocks.selectByEmailIncludeDel,
	},
}));

import { executeConfirmedTool } from '../../src/agent/tools';

describe('AI confirmed draft sending', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.deleteDraft.mockResolvedValue(true);
	});

	it('uses the native mail service for reply drafts and removes the draft after success', async () => {
		const env = { marker: 'env' };
		mocks.draftDetail.mockResolvedValue({
			emailId: 41,
			accountId: 9,
			sendEmail: 'admin@example.com',
			name: 'Admin',
			recipient: JSON.stringify([
				{ address: 'recipient@example.net', name: '' },
				{ address: 'recipient@example.net', name: '' },
			]),
			toEmail: 'recipient@example.net',
			subject: 'Re: Test',
			content: '<p>Received.</p>',
			text: 'Received.',
			aiMetadata: JSON.stringify({ source: 'tool', sourceEmailId: 28 }),
		});
		mocks.send.mockResolvedValue([{ emailId: 92, resendEmailId: 'resend-92' }]);

		const output = await executeConfirmedTool({
			env,
			userId: 7,
			userEmail: 'admin@example.com',
			name: 'sendDraft',
			args: { draftId: 41 },
		});

		expect(mocks.send).toHaveBeenCalledWith({ env }, {
			accountId: 9,
			name: 'Admin',
			sendType: 'reply',
			emailId: 28,
			receiveEmail: ['recipient@example.net'],
			text: 'Received.',
			content: '<p>Received.</p>',
			subject: 'Re: Test',
			attachments: [],
		}, 7);
		expect(mocks.deleteDraft).toHaveBeenCalledWith({ env }, 41, 7);
		expect(output).toEqual({ sent: true, emailId: 92, messageId: 'resend-92' });
	});

	it('resolves the sender account for older drafts without an account id', async () => {
		mocks.draftDetail.mockResolvedValue({
			emailId: 42,
			accountId: 0,
			sendEmail: 'user@example.com',
			name: '',
			recipient: 'not-json',
			toEmail: 'friend@example.net',
			subject: 'Hello',
			content: '<p>Hello.</p>',
			text: 'Hello.',
			aiMetadata: '',
		});
		mocks.selectByEmailIncludeDel.mockResolvedValue({ accountId: 12, name: 'User' });
		mocks.send.mockResolvedValue([{ emailId: 93, messageId: 'message-93' }]);

		const output = await executeConfirmedTool({
			env: {},
			userId: 8,
			userEmail: 'user@example.com',
			name: 'sendDraft',
			args: { draftId: 42 },
		});

		expect(mocks.selectByEmailIncludeDel).toHaveBeenCalledWith({ env: {} }, 'user@example.com');
		expect(mocks.send).toHaveBeenCalledWith({ env: {} }, expect.objectContaining({
			accountId: 12,
			name: 'User',
			sendType: '',
			emailId: 0,
			receiveEmail: ['friend@example.net'],
		}), 8);
		expect(output.sent).toBe(true);
	});

	it('keeps the draft when native sending fails', async () => {
		mocks.draftDetail.mockResolvedValue({
			emailId: 43,
			accountId: 9,
			toEmail: 'recipient@example.net',
			subject: 'Test',
			content: '<p>Test.</p>',
			text: 'Test.',
		});
		mocks.send.mockRejectedValue(new Error('provider unavailable'));

		await expect(executeConfirmedTool({
			env: {},
			userId: 7,
			userEmail: 'admin@example.com',
			name: 'sendDraft',
			args: { draftId: 43 },
		})).rejects.toThrow('provider unavailable');

		expect(mocks.deleteDraft).not.toHaveBeenCalled();
	});
});
