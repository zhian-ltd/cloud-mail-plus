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

function attachmentContent(content) {
	if (typeof content === 'string') return fileUtils.base64ToDataStr(content);
	return fileUtils.buffToBase64(content);
}

export function buildResendForwardForm({ parsedEmail, sourceEmail, destination, attachments = [] }) {
	const originalFrom = addressText(parsedEmail?.from);
	const originalTo = addressListText(parsedEmail?.to);
	const originalSubject = String(parsedEmail?.subject || '');
	const displayName = String(parsedEmail?.from?.name || parsedEmail?.from?.address || emailUtils.getName(sourceEmail))
		.replace(/[\r\n<>]/g, ' ')
		.replace(/"/g, '\\"')
		.trim();
	const safeHeader = value => String(value || '').replace(/[\r\n]+/g, ' ').trim();

	const form = {
		// Resend can authenticate only a verified local domain. Keep the original
		// sender as the display name and Reply-To, without spoofing its address.
		from: `${displayName || emailUtils.getName(sourceEmail)} <${sourceEmail}>`,
		to: [destination],
		subject: originalSubject || '(no subject)',
		headers: {
			'X-Original-From': safeHeader(originalFrom),
			'X-Original-To': safeHeader(originalTo),
			'X-Original-Recipient': safeHeader(sourceEmail),
		},
	};
	if (parsedEmail?.html != null) form.html = parsedEmail.html;
	if (parsedEmail?.text != null) form.text = parsedEmail.text;
	if (form.html == null && form.text == null) form.text = '';
	if (parsedEmail?.from?.address) form.replyTo = parsedEmail.from.address;
	if (parsedEmail?.messageId) form.headers['X-Original-Message-ID'] = safeHeader(parsedEmail.messageId);

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
