import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: {
			'cloudflare:email': fileURLToPath(new URL('./test/unit/stubs/cloudflare-email.js', import.meta.url)),
		},
	},
	test: {
		environment: 'node',
		include: ['test/unit/**/*.test.js'],
	},
});
