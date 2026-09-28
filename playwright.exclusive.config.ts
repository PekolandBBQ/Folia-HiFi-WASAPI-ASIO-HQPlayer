import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// playwright.exclusive.config.ts — isolate fork tests from another worktree's development server.
export default defineConfig({ ...base,
    use: { ...base.use, baseURL: 'http://127.0.0.1:4187' },
    projects: base.projects!.map(project => ({ ...project, use: { ...project.use,
        baseURL: project.name === 'components' ? 'http://127.0.0.1:4187/dev-probe.html' : 'http://127.0.0.1:4187' } })),
    webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4187 --strictPort',
        url: 'http://127.0.0.1:4187', reuseExistingServer: false, timeout: 120000 },
});
