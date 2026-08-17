import { and, eq, inArray, sql } from 'drizzle-orm';
import BizError from '../error/biz-error';
import account from '../entity/account';
import orm from '../entity/orm';
import userPushSetting from '../entity/user-push-setting';
import { isDel, settingConst } from '../const/entity-const';
import { t } from '../i18n/i18n';
import verifyUtils from '../utils/verify-utils';

const DEFAULT_SETTING = Object.freeze({
	tgBotToken: '',
	tgChatId: '',
	tgBotStatus: settingConst.tgBotStatus.CLOSE,
	tgMsgFrom: 'only-name',
	tgMsgTo: 'show',
	tgMsgText: 'hide',
	forwardEmail: '',
	forwardStatus: settingConst.forwardStatus.CLOSE,
	ruleEmail: '',
	ruleType: settingConst.ruleType.ALL,
});

const STATUS_VALUES = new Set([0, 1]);
const TG_FROM_VALUES = new Set(['show', 'hide', 'only-name']);
const SHOW_HIDE_VALUES = new Set(['show', 'hide']);

function normalizeStatus(value, fallback) {
	const normalized = Number(value);
	return STATUS_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeEnum(value, allowed, fallback) {
	return allowed.has(value) ? value : fallback;
}

export function normalizeChatIds(value) {
	const items = String(value || '')
		.split(/[,，]/)
		.map(item => item.trim())
		.filter(Boolean);
	const unique = [...new Set(items)];
	if (unique.length > 20 || unique.some(item => !/^-?\d{1,20}$/.test(item))) {
		throw new BizError(t('personalPushInvalidChatId'));
	}
	return unique.join(',');
}

export function normalizeEmailList(value, maxItems = 20) {
	const items = String(value || '')
		.split(/[,，]/)
		.map(item => item.trim().toLowerCase())
		.filter(Boolean);
	const unique = [...new Set(items)];
	if (unique.length > maxItems || unique.some(item => !verifyUtils.isEmail(item))) {
		throw new BizError(t('personalPushInvalidEmail'));
	}
	return unique.join(',');
}

async function selectOwnedEmailList(c, userId) {
	const rows = await orm(c)
		.select({ email: account.email })
		.from(account)
		.where(and(eq(account.userId, userId), eq(account.isDel, isDel.NORMAL)))
		.all();
	return rows.map(row => row.email.toLowerCase());
}

const userPushSettingService = {
	async selectByUserId(c, userId) {
		const row = await orm(c).select().from(userPushSetting)
			.where(eq(userPushSetting.userId, userId)).get();
		return row || { userId, ...DEFAULT_SETTING };
	},

	async get(c, userId) {
		const [row, accountEmails] = await Promise.all([
			this.selectByUserId(c, userId),
			selectOwnedEmailList(c, userId),
		]);
		const ownedEmails = new Set(accountEmails);
		const visibleRuleEmail = String(row.ruleEmail || '').split(',')
			.filter(email => ownedEmails.has(email.toLowerCase())).join(',');
		return {
			tgBotTokenConfigured: Boolean(row.tgBotToken),
			tgChatId: row.tgChatId,
			tgBotStatus: row.tgBotStatus,
			tgMsgFrom: row.tgMsgFrom,
			tgMsgTo: row.tgMsgTo,
			tgMsgText: row.tgMsgText,
			forwardEmail: row.forwardEmail,
			forwardStatus: row.forwardStatus,
			ruleEmail: visibleRuleEmail,
			ruleType: row.ruleType,
			accountEmails,
		};
	},

	async set(c, params, userId) {
		const current = await this.selectByUserId(c, userId);
		const next = {
			...DEFAULT_SETTING,
			...current,
			userId,
		};

		if (Object.hasOwn(params, 'tgBotStatus')) {
			next.tgBotStatus = normalizeStatus(params.tgBotStatus, current.tgBotStatus);
		}
		if (Object.hasOwn(params, 'tgChatId')) next.tgChatId = normalizeChatIds(params.tgChatId);
		if (Object.hasOwn(params, 'tgMsgFrom')) {
			next.tgMsgFrom = normalizeEnum(params.tgMsgFrom, TG_FROM_VALUES, current.tgMsgFrom);
		}
		if (Object.hasOwn(params, 'tgMsgTo')) {
			next.tgMsgTo = normalizeEnum(params.tgMsgTo, SHOW_HIDE_VALUES, current.tgMsgTo);
		}
		if (Object.hasOwn(params, 'tgMsgText')) {
			next.tgMsgText = normalizeEnum(params.tgMsgText, SHOW_HIDE_VALUES, current.tgMsgText);
		}
		if (params.clearTgBotToken === true) {
			next.tgBotToken = '';
			next.tgBotStatus = settingConst.tgBotStatus.CLOSE;
		} else if (typeof params.tgBotToken === 'string' && params.tgBotToken.trim()) {
			const token = params.tgBotToken.trim();
			if (token.length > 256) throw new BizError(t('personalPushTokenTooLong'));
			next.tgBotToken = token;
		}

		if (Object.hasOwn(params, 'forwardStatus')) {
			next.forwardStatus = normalizeStatus(params.forwardStatus, current.forwardStatus);
		}
		if (Object.hasOwn(params, 'forwardEmail')) {
			next.forwardEmail = normalizeEmailList(params.forwardEmail);
		}
		if (Object.hasOwn(params, 'ruleType')) {
			next.ruleType = normalizeStatus(params.ruleType, current.ruleType);
		}
		const isUpdatingRuleEmail = Object.hasOwn(params, 'ruleEmail');
		if (isUpdatingRuleEmail) {
			next.ruleEmail = normalizeEmailList(params.ruleEmail, 100);
		}

		if (next.tgBotStatus === settingConst.tgBotStatus.OPEN && (!next.tgBotToken || !next.tgChatId)) {
			throw new BizError(t('personalPushTelegramIncomplete'));
		}
		if (next.forwardStatus === settingConst.forwardStatus.OPEN && !next.forwardEmail) {
			throw new BizError(t('personalPushForwardIncomplete'));
		}

		const ownedEmails = new Set(await selectOwnedEmailList(c, userId));
		const ruleEmails = next.ruleEmail ? next.ruleEmail.split(',') : [];
		if (isUpdatingRuleEmail && ruleEmails.some(email => !ownedEmails.has(email))) {
			throw new BizError(t('personalPushRuleEmailNotOwned'), 403);
		}
		next.ruleEmail = ruleEmails.filter(email => ownedEmails.has(email)).join(',');

		const values = {
			userId,
			tgBotToken: next.tgBotToken,
			tgChatId: next.tgChatId,
			tgBotStatus: next.tgBotStatus,
			tgMsgFrom: next.tgMsgFrom,
			tgMsgTo: next.tgMsgTo,
			tgMsgText: next.tgMsgText,
			forwardEmail: next.forwardEmail,
			forwardStatus: next.forwardStatus,
			ruleEmail: next.ruleEmail,
			ruleType: next.ruleType,
		};
		const { userId: ignored, ...updates } = values;
		await orm(c).insert(userPushSetting).values(values).onConflictDoUpdate({
			target: userPushSetting.userId,
			set: { ...updates, updateTime: sql`CURRENT_TIMESTAMP` },
		}).run();

		return this.get(c, userId);
	},

	async deleteByUserIds(c, userIds) {
		if (!userIds.length) return;
		await orm(c).delete(userPushSetting).where(inArray(userPushSetting.userId, userIds)).run();
	},
};

export default userPushSettingService;
