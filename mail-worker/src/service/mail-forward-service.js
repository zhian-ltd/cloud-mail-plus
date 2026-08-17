import { Resend } from 'resend';
import { settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import fileUtils from '../utils/file-utils';

function splitAddresses(value) {
	return [...new Set(String(value || '')
		.split(/[,，]/)
		.map(item => item.trim().toLowerCase())
		.filter(Boolean))];
}

function escapeHtml(value) {
	return String(value || '').replace(/[&<>"']/g, character => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	}[character]));
}

function addressText(address) {
	if (!address) return '';
	if (typeof address === 'string') return address;
	return address.name ? `${address.name} <${address.address || ''}>` : (address.address || '');
}

function addressListText(addresses) {
	return (Array.isArray(addresses) ? addresses : [addresses])
		.map(addressText)
		.filter(Boolean)
		.join(', ');
}

function forwardSubject(subject) {
	const value = String(subject || '').trim();
	return /^(fwd?|转发)\s*[:：]/i.test(value) ? value : `Fwd: ${value || '(no subject)'}`;
}

function attachmentContent(content) {
	if (typeof content === 'string') return fileUtils.base64ToDataStr(content);
	return fileUtils.buffToBase64(content);
}

export function buildResendForwardForm({ parsedEmail, sourceEmail, destination, attachments = [] }) {
	const originalFrom = addressText(parsedEmail?.from);
	const originalTo = addressListText(parsedEmail?.to);
	const originalSubject = String(parsedEmail?.subject || '');
	const originalDate = parsedEmail?.date ? new Date(parsedEmail.date).toUTCString() : '';
	const forwardedText = [
		'---------- Forwarded message ----------',
		originalFrom ? `From: ${originalFrom}` : '',
		originalDate ? `Date: ${originalDate}` : '',
		originalSubject ? `Subject: ${originalSubject}` : '',
		originalTo ? `To: ${originalTo}` : '',
		'',
		parsedEmail?.text || String(parsedEmail?.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
	].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');

	const headerRows = [
		['From', originalFrom],
		['Date', originalDate],
		['Subject', originalSubject],
		['To', originalTo],
	].filter(([, value]) => value)
		.map(([label, value]) => `<div><strong>${label}:</strong> ${escapeHtml(value)}</div>`)
		.join('');
	const originalHtml = parsedEmail?.html
		|| `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(parsedEmail?.text || '')}</pre>`;

	const form = {
		from: `${emailUtils.getName(sourceEmail)} <${sourceEmail}>`,
		to: [destination],
		subject: forwardSubject(originalSubject),
		html: `<div style="color:#666;margin-bottom:16px">---------- Forwarded message ----------${headerRows}</div>${originalHtml}`,
		text: forwardedText,
	};
	if (parsedEmail?.from?.address) form.replyTo = parsedEmail.from.address;

	const resendAttachments = attachments
		.filter(attachment => attachment?.content && attachment?.filename)
		.map(attachment => ({
			filename: attachment.filename,
			content: attachmentContent(attachment.content),
			contentType: attachment.mimeType || attachment.contentType || undefined,
			contentId: attachment.contentId
				? String(attachment.contentId).replace(/^<|>$/g, '')
				: undefined,
		}));
	if (resendAttachments.length) form.attachments = resendAttachments;
	return form;
}

/**
 * Forward an incoming email using the administrator-selected outbound policy.
 * Delivery failures are reported in the return value and logs but never reject
 * the original inbound message, matching the legacy message.forward behavior.
 */
export async function forwardIncomingEmail({
	message,
	parsedEmail,
	attachments = [],
	sourceEmail,
	forwardEmail,
	scope,
	emailProvider,
	resendTokens = {},
}) {
	const destinations = splitAddresses(forwardEmail);
	const useCloudflare = emailProvider !== settingConst.emailProvider.RESEND_ONLY;
	const useResend = emailProvider !== settingConst.emailProvider.CF_ONLY;
	const sourceDomain = emailUtils.getDomain(sourceEmail);
	const resendToken = resendTokens?.[sourceDomain];
	const resend = useResend && resendToken ? new Resend(resendToken) : null;

	return Promise.all(destinations.map(async destination => {
		let cloudflareError = null;
		if (useCloudflare) {
			try {
				await message.forward(destination);
				return { destination, provider: 'cloudflare', ok: true };
			} catch (error) {
				cloudflareError = error;
				console.warn(`${scope}转发邮箱 ${destination} 的 Cloudflare 转发失败：`, error);
			}
		}

		if (useResend) {
			try {
				if (!resend) throw new Error(`Resend Token is not configured for ${sourceDomain}`);
				const result = await resend.emails.send(buildResendForwardForm({
					parsedEmail,
					sourceEmail,
					destination,
					attachments,
				}));
				if (result?.error) throw new Error(result.error.message || 'Resend forwarding failed');
				return { destination, provider: 'resend', ok: true, id: result?.data?.id || '' };
			} catch (error) {
				console.error(`${scope}转发邮箱 ${destination} 的 Resend 转发失败：`, error);
				return { destination, provider: 'resend', ok: false, error: error.message || String(error) };
			}
		}

		const error = cloudflareError?.message || 'No forwarding provider is available';
		console.error(`${scope}转发邮箱 ${destination} 失败：${error}`);
		return { destination, provider: 'cloudflare', ok: false, error };
	}));
}

