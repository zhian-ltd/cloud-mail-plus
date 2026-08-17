function toolName(part) {
	if (part?.toolName) return part.toolName;
	return typeof part?.type === 'string' && part.type.startsWith('tool-') ? part.type.slice(5) : '';
}

export function uiMessagesToModelMessages(uiMessages) {
	return (Array.isArray(uiMessages) ? uiMessages : []).map(message => {
		const segments = [];
		for (const part of Array.isArray(message?.parts) ? message.parts : []) {
			if (part?.type === 'text' && part.text) segments.push(part.text);
			if (message.role !== 'assistant') continue;
			const output = part?.output ?? part?.result;
			const name = toolName(part);
			if (!name || output === undefined) continue;
			let serialized;
			try { serialized = JSON.stringify(output); }
			catch { serialized = String(output); }
			segments.push(`[Tool ${name} result: ${serialized.slice(0, 4000)}]`);
		}
		if (!segments.length && message?.content) segments.push(message.content);
		return { role: message?.role || 'user', content: segments.join('\n') };
	}).filter(message => message.content);
}
