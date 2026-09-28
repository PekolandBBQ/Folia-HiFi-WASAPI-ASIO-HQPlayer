const { chromium } = require('playwright');
// test/manual/inspectTitlePreview.cjs — inspect animated styles in the existing component probe.
(async () => {
    const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    try {
        const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
        await p.goto('http://127.0.0.1:3000/dev-probe.html?probe=trackTitleNavigator');
        await p.locator('.rounded-full.cursor-pointer').first().hover();
        const t = p.locator('[class~="group/title"]'); await t.waitFor(); const box = await t.boundingBox();
        await p.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
        await p.waitForTimeout(800);
        console.log(await t.evaluate(e => ({ html: e.innerHTML, hover: [...document.querySelectorAll(':hover')].slice(-4).map(e => e.outerHTML.slice(0,120)) })));
    } finally { await b.close(); }
})();
