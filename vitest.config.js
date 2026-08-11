import { defineConfig } from 'vitest/config';
import path from 'path';
export default defineConfig({
    resolve: {
        alias: {
            '@shared': path.resolve(__dirname, 'shared'),
            '@electron': path.resolve(__dirname, 'electron'),
        },
    },
    test: {
        // Use workspace projects for separate test suites
        workspace: './vitest.workspace.ts',
        reporters: ['verbose'],
        coverage: {
            provider: 'v8',
            include: ['electron/**/*.ts', 'shared/**/*.ts'],
            exclude: ['**/*.d.ts', '**/node_modules/**'],
        },
    },
});
