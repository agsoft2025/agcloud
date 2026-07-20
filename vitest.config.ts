import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
		setupFiles: ['test/setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			include: ['src/**/*.ts'],
			exclude: [
				'src/index.ts',
				'src/server.ts',
				'src/**/*.types.ts',
				'src/modules/**/livekit.types.ts',
				'src/config/constants.ts',
			],
		},
		include: ['test/**/*.test.ts'],
		testTimeout: 15000,
	},
});
