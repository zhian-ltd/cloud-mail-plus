const DRAFT_REPLY_PATTERN = /(拟稿|起草|草拟|(?:写|生成|准备).{0,8}回复|回复.{0,8}(?:草稿|邮件)|draft.{0,20}repl|repl.{0,20}draft|compose.{0,20}repl)/i;
const CURRENT_EMAIL_PATTERN = /(左侧|当前|这封|此封|正在(?:查看|阅读)|打开的|选中的|left(?:-hand| side)?|current|this|selected|open)\s*(?:的)?\s*(?:邮件|email|message)?/i;
const NEGATED_DRAFT_PATTERN = /(不要|无需|不用|别|不必)\s*(?:拟稿|起草|草拟|写回复)|(?:do not|don't|no need to)\s+(?:draft|compose|write)/i;

export function latestUserText(messages) {
	const list = Array.isArray(messages) ? messages : [];
	for (let index = list.length - 1; index >= 0; index--) {
		const message = list[index];
		if (message?.role !== 'user') continue;
		const text = (Array.isArray(message.parts) ? message.parts : [])
			.filter(part => part?.type === 'text' && part.text)
			.map(part => part.text)
			.join('\n')
			.trim();
		return text || String(message?.content || '').trim();
	}
	return '';
}

export function requestsCurrentEmailReplyDraft(text) {
	const value = String(text || '').trim();
	return !!value &&
		!NEGATED_DRAFT_PATTERN.test(value) &&
		DRAFT_REPLY_PATTERN.test(value) &&
		CURRENT_EMAIL_PATTERN.test(value);
}

export function currentEmailDraftStep({ steps, forceDraftReply }) {
	if (!forceDraftReply) return undefined;
	const draftAlreadyAttempted = (Array.isArray(steps) ? steps : []).some(step =>
		(Array.isArray(step?.toolCalls) ? step.toolCalls : [])
			.some(call => call?.toolName === 'draftReply')
	);
	if (draftAlreadyAttempted) {
		return { activeTools: [], toolChoice: 'none' };
	}
	return {
		activeTools: ['draftReply'],
		toolChoice: { type: 'tool', toolName: 'draftReply' },
	};
}
