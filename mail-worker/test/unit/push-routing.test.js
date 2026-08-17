import { describe, expect, it } from 'vitest';
import { settingConst } from '../../src/const/entity-const';
import { matchesPushRule, resolvePushScopes } from '../../src/service/push-routing-service';
import { normalizeChatIds, normalizeEmailList } from '../../src/service/user-push-setting-service';

describe('push scope routing', () => {
	it('keeps global and personal rule decisions independent', () => {
		const globalSetting = {
			ruleType: settingConst.ruleType.RULE,
			ruleEmail: 'global@example.com',
		};
		const personalSetting = {
			ruleType: settingConst.ruleType.RULE,
			ruleEmail: 'mine@example.com',
		};

		expect(resolvePushScopes(globalSetting, personalSetting, 'mine@example.com')).toEqual({
			global: false,
			personal: true,
		});
	});

	it('matches email rules without case or whitespace surprises', () => {
		const setting = {
			ruleType: settingConst.ruleType.RULE,
			ruleEmail: ' First@Example.com, second@example.com ',
		};
		expect(matchesPushRule(setting, 'first@example.com')).toBe(true);
		expect(matchesPushRule(setting, 'missing@example.com')).toBe(false);
	});

	it('treats all-mail mode as a match and a missing personal setting as disabled', () => {
		expect(matchesPushRule({ ruleType: settingConst.ruleType.ALL, ruleEmail: '' }, 'a@example.com')).toBe(true);
		expect(matchesPushRule(null, 'a@example.com')).toBe(false);
	});

	it('uses the owning mailbox for personal rules when plus addressing is used', () => {
		const rules = { ruleType: settingConst.ruleType.RULE, ruleEmail: 'mine@example.com' };
		expect(resolvePushScopes(rules, rules, 'mine+shop@example.com', 'mine@example.com')).toEqual({
			global: false,
			personal: true,
		});
	});
});

describe('personal push input normalization', () => {
	it('deduplicates and normalizes forwarding addresses', () => {
		expect(normalizeEmailList('One@Example.com, one@example.com，two@example.com'))
			.toBe('one@example.com,two@example.com');
	});

	it('accepts numeric Telegram chat IDs and removes duplicates', () => {
		expect(normalizeChatIds('-100123, 42，-100123')).toBe('-100123,42');
	});

	it('rejects invalid addresses and chat IDs', () => {
		expect(() => normalizeEmailList('not-an-email')).toThrow();
		expect(() => normalizeChatIds('@channel-name')).toThrow();
	});
});
