import { settingConst } from '../const/entity-const';

export function parsePushRuleEmails(value) {
	return String(value || '')
		.split(',')
		.map(item => item.trim().toLowerCase())
		.filter(Boolean);
}

export function matchesPushRule(pushSetting, recipient) {
	if (!pushSetting) return false;
	if (pushSetting.ruleType !== settingConst.ruleType.RULE) return true;

	const normalizedRecipient = String(recipient || '').trim().toLowerCase();
	return parsePushRuleEmails(pushSetting.ruleEmail).includes(normalizedRecipient);
}

export function resolvePushScopes(globalSetting, personalSetting, recipient, personalRecipient = recipient) {
	return {
		global: matchesPushRule(globalSetting, recipient),
		personal: matchesPushRule(personalSetting, personalRecipient),
	};
}
