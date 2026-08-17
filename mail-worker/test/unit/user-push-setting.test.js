import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = {
	accounts: [],
	settings: new Map(),
};

function fakeOrm(c) {
	return {
		select: projection => ({
			from: () => ({
				where: () => ({
					get: async () => rows.settings.get(c.testUserId),
					all: async () => rows.accounts
						.filter(item => item.userId === c.testUserId && item.isDel === 0)
						.map(item => projection?.email ? { email: item.email } : item),
				}),
			}),
		}),
		insert: () => ({
			values: values => ({
				onConflictDoUpdate: ({ set }) => ({
					run: async () => rows.settings.set(values.userId, {
						...rows.settings.get(values.userId),
						...values,
						...set,
					}),
				}),
			}),
		}),
	};
}

vi.mock('../../src/entity/orm', () => ({ default: fakeOrm }));

const { default: userPushSettingService } = await import('../../src/service/user-push-setting-service');

function contextFor(userId) {
	return { testUserId: userId };
}

function addAccount(userId, email, isDel = 0) {
	rows.accounts.push({ userId, email, isDel });
}

beforeEach(() => {
	rows.accounts.length = 0;
	rows.settings.clear();
});

describe('userPushSettingService isolation', () => {
	it('returns only the current user mailboxes and never returns the saved bot token', async () => {
		addAccount(1, 'Mine@Example.com');
		addAccount(1, 'deleted@example.com', 1);
		addAccount(2, 'other@example.com');
		rows.settings.set(1, {
			userId: 1,
			tgBotToken: 'server-only-token',
			tgChatId: '',
			tgBotStatus: 1,
			tgMsgFrom: 'only-name',
			tgMsgTo: 'show',
			tgMsgText: 'hide',
			forwardEmail: '',
			forwardStatus: 1,
			ruleType: 1,
			ruleEmail: 'mine@example.com,deleted@example.com,other@example.com',
		});

		const result = await userPushSettingService.get(contextFor(1), 1);

		expect(result).not.toHaveProperty('tgBotToken');
		expect(result.tgBotTokenConfigured).toBe(true);
		expect(result.accountEmails).toEqual(['mine@example.com']);
		expect(result.ruleEmail).toBe('mine@example.com');
	});

	it('rejects a rule containing a mailbox owned by another user', async () => {
		addAccount(1, 'mine@example.com');
		addAccount(2, 'other@example.com');

		await expect(userPushSettingService.set(contextFor(1), {
			ruleType: 1,
			ruleEmail: 'other@example.com',
		}, 1)).rejects.toMatchObject({ code: 403 });
	});

	it('stores independent Telegram and forwarding destinations per user', async () => {
		addAccount(1, 'first@example.com');
		addAccount(2, 'second@example.com');

		await userPushSettingService.set(contextFor(1), {
			tgBotToken: 'first-token',
			tgChatId: '101',
			tgBotStatus: 0,
			forwardEmail: 'first-destination@example.net',
			forwardStatus: 0,
		}, 1);
		await userPushSettingService.set(contextFor(2), {
			tgBotToken: 'second-token',
			tgChatId: '202',
			tgBotStatus: 0,
		}, 2);

		expect(rows.settings.get(1)).toMatchObject({
			tgBotToken: 'first-token',
			tgChatId: '101',
			forwardEmail: 'first-destination@example.net',
		});
		expect(rows.settings.get(2)).toMatchObject({
			tgBotToken: 'second-token',
			tgChatId: '202',
			forwardEmail: '',
		});
	});
});
