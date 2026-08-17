import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const userPushSetting = sqliteTable('user_push_setting', {
	userId: integer('user_id').primaryKey(),
	tgBotToken: text('tg_bot_token').default('').notNull(),
	tgChatId: text('tg_chat_id').default('').notNull(),
	tgBotStatus: integer('tg_bot_status').default(1).notNull(),
	tgMsgFrom: text('tg_msg_from').default('only-name').notNull(),
	tgMsgTo: text('tg_msg_to').default('show').notNull(),
	tgMsgText: text('tg_msg_text').default('hide').notNull(),
	forwardEmail: text('forward_email').default('').notNull(),
	forwardStatus: integer('forward_status').default(1).notNull(),
	ruleEmail: text('rule_email').default('').notNull(),
	ruleType: integer('rule_type').default(0).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	updateTime: text('update_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export default userPushSetting;
