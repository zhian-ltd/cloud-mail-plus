import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const ssoIdentity = sqliteTable('sso_identity', {
	identityId: integer('identity_id').primaryKey({ autoIncrement: true }),
	issuer: text('issuer').notNull(),
	subject: text('subject').notNull(),
	userId: integer('user_id').notNull(),
	email: text('email').notNull().default(''),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
	updateTime: text('update_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, table => ({
	issuerSubjectUnique: uniqueIndex('idx_sso_identity_issuer_subject').on(table.issuer, table.subject),
}));

export default ssoIdentity;
