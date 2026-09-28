const { defineConfig } = require('@playwright/test');

// playwright.native-review.config.cjs — reuse the review dev server; never clear accumulated hardware evidence.
module.exports = defineConfig({
    testDir: './test/component', testMatch: 'nativeAudio.spec.ts', workers: 1, timeout: 90000,
    outputDir: 'test-results/ui-supplement', reporter: 'line',
    expect: { timeout: 15000 },
    use: { baseURL: 'http://127.0.0.1:3000/dev-probe.html', viewport: { width: 1440, height: 1100 },
        serviceWorkers: 'block', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } },
});
