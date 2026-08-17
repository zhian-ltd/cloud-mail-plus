import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst, userConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import userPushSettingService from '../service/user-push-setting-service';
import { resolvePushScopes } from '../service/push-routing-service';

async function forwardMessage(message, forwardEmail, scope) {
	const emails = String(forwardEmail || '').split(',').map(item => item.trim()).filter(Boolean);
	await Promise.all(emails.map(async email => {
		try {
			await message.forward(email);
		} catch (e) {
			console.error(`${scope}转发邮箱 ${email} 失败：`, e);
		}
	}));
}

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}


		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);

		let account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		// Plus-addressing fallback: strip "+suffix" so jane.doe+anything@domain
		// delivers into jane.doe@domain mailbox (Gmail/Outlook-style).
		if (!account) {
			const canonical = message.to.replace(/^([^@+]+)\+[^@]*@/, '$1@');
			if (canonical !== message.to) {
				account = await accountService.selectByEmailIncludeDel({ env: env }, canonical);
			}
		}

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0) {
				await attService.addAtt({ env }, attachments);
			}
		} catch (e) {
			console.error(e);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);

		// AI auto-draft hook (no-op if user has agent.autoDraft disabled or bindings missing)
		try {
			const { maybeAutoDraft } = await import('../agent/auto-draft.js');
			await maybeAutoDraft({ env, executionCtx: { waitUntil: (p) => p } }, { emailId: emailRow.emailId, userId: emailRow.userId });
		} catch (err) { console.error('[auto-draft hook]', err); }

		let personalSetting = null;
		if (account && account.isDel === isDel.NORMAL
			&& userRow.isDel === isDel.NORMAL && userRow.status === userConst.status.NORMAL) {
			try {
				personalSetting = await userPushSettingService.selectByUserId({ env }, account.userId);
			} catch (e) {
				console.error('读取个人邮件推送配置失败：', e);
			}
		}

		const pushScopes = resolvePushScopes(
			{ ruleType, ruleEmail },
			personalSetting,
			message.to,
			account?.email || message.to,
		);

		// 全域 Telegram 推送：继续使用系统设置，作用于所有收件邮件。
		if (pushScopes.global && tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			await telegramService.sendEmailToBot({ env }, emailRow)
		}

		// 全域第三方邮箱推送保持原有行为。
		if (pushScopes.global && forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {
			await forwardMessage(message, forwardEmail, '全域');
		}

		// 个人推送只会加载当前收件邮箱所属 user_id 的配置。
		if (pushScopes.personal && personalSetting) {
			if (personalSetting.tgBotStatus === settingConst.tgBotStatus.OPEN
				&& personalSetting.tgBotToken && personalSetting.tgChatId) {
				await telegramService.sendEmailToBot({ env }, emailRow, personalSetting);
			}
			if (personalSetting.forwardStatus === settingConst.forwardStatus.OPEN
				&& personalSetting.forwardEmail) {
				await forwardMessage(message, personalSetting.forwardEmail, '个人');
			}
		}

	} catch (e) {
		console.error('邮件接收异常: ', e);
		throw e
	}
}
