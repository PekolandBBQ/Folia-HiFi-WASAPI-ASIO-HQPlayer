const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Archive only explicitly allowed evidence files, never profiles, source music or installed binaries.
async function main() {
    const output = path.resolve('docs/native-audio-remaining-validation'); await fs.mkdir(output, { recursive: true });
    const roots = [['complete', 'test-results/native-audio-review'], ['branches', '../folia-native-review-split/test-results/native-audio-review']];
    const records = [], manifest = [];
    const copy = async (source, target) => { await fs.copyFile(source, target); manifest.push({ file: path.relative(output, target).replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex') }); };
    for (const [origin, root] of roots) for (const dir of await fs.readdir(root, { withFileTypes: true })) {
        const historical = ['app-navidrome-1790457638923', 'app-navidrome-1790457772342', 'app-navidrome-1790457841134'].includes(dir.name);
        if (!dir.isDirectory() || !/(\d{13})$/.test(dir.name) || (!historical && Number(dir.name.match(/(\d{13})$/)[1]) < 1790600000000)) continue;
        const source = path.join(root, dir.name); let rows, env;
        for (const name of ['provider-results.json', 'results.json']) { try { rows = JSON.parse(await fs.readFile(path.join(source, name), 'utf8')); break; } catch {} }
        if (!rows) continue;
        try { env = JSON.parse(await fs.readFile(path.join(source, 'environment.json'), 'utf8')); } catch {}
        const target = path.join(output, origin, dir.name); await fs.mkdir(target, { recursive: true });
        const files = await fs.readdir(source);
        for (const file of files) if (/\.png$|^(results|provider-results|environment|startup-trace)\.json$|-trace\.json$/.test(file)) await copy(path.join(source, file), path.join(target, file));
        let sampleIndex = 0;
        for (const [index, row] of rows.entries()) {
            const id = row.id || row.scenario;
            if (row.layer === 'real-source-production-transcode-service') sampleIndex++;
            const imageName = dir.name === 'startup-race-1790607394787' && index === 0 ? 'user-play-before-restore-completes'
                : row.layer === 'real-source-production-transcode-service' && !id.startsWith('navidrome-sample-') ? `navidrome-sample-${sampleIndex}` : id;
            const image = files.includes(`${imageName}.png`) ? path.relative(output, path.join(target, `${imageName}.png`)).replaceAll('\\', '/') : null;
            records.push({ ...row, id, origin, run: dir.name, commit: env?.commit || env?.hostCommit || row.commit || null, image,
                evidence: path.relative(output, path.join(target, files.includes('results.json') ? 'results.json' : 'provider-results.json')).replaceAll('\\', '/'),
                validity: dir.name === 'nav-corrupt-recovery-1790607765271' ? 'HARNESS_EXPECTATION_WRONG' : 'recorded' });
        }
    }
    const checks = path.join(output, 'checks'); await fs.mkdir(checks, { recursive: true });
    for (const [root, pattern] of [['test-results/native-audio-review', /^remaining-.*\.(log|json)$/], ['../folia-native-review-split/test-results', /^(core|integer|signal)-remaining-.*\.log$/]]) {
        for (const file of await fs.readdir(root)) if (pattern.test(file)) await copy(path.join(root, file), path.join(checks, file));
    }
    await fs.writeFile(path.join(output, 'records.json'), JSON.stringify(records, null, 2));
    await fs.writeFile(path.join(output, 'report.md'), (await fs.readFile('docs/native-audio-validation-remaining.md', 'utf8')).replaceAll('(native-audio-remaining-validation/', '('));
    await fs.copyFile('docs/native-audio-validation-supplement.md', path.join(output, 'native-audio-validation-supplement.md'));
    await fs.writeFile(path.join(output, 'sha256-manifest.json'), JSON.stringify(manifest, null, 2));
    const esc = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const table = records.map(r => `<tr data-status="${esc(r.status)}"><td>${esc(r.origin)}<br>${esc(r.run)}</td><td>${esc(r.id)}</td><td>${esc(r.status)}<br>${esc(r.validity)}</td><td>${esc(r.commit?.slice(0, 12) || 'see run log')}</td><td><a href="${esc(r.evidence)}">JSON</a>${r.image ? ` · <a href="${esc(r.image)}">截图</a>` : ' · 无截图'}</td></tr>`).join('');
    await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Folia 后续验证证据</title><style>body{font:15px/1.6 system-ui;margin:32px;background:#111820;color:#e7edf3}a{color:#8dccff}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #384450;text-align:left}select{padding:8px}</style><h1>后续验证证据 · 2026-09-28</h1><p><a href="report.md">结论与范围</a> · <a href="records.json">全部记录</a> · <a href="sha256-manifest.json">文件校验清单</a></p><p>保留失败、重跑及错误测试前提。行数是步骤数，不是独立通过用例数。自然转码失败与受控错误恢复分别标注。</p><select onchange="document.querySelectorAll('tbody tr').forEach(r=>r.hidden=this.value&&r.dataset.status!==this.value)"><option value="">全部状态</option><option>PASS</option><option>FAIL</option></select><table><thead><tr><th>运行</th><th>步骤</th><th>状态 / 有效性</th><th>宿主提交</th><th>证据</th></tr></thead><tbody>${table}</tbody></table></html>`);
    console.log(JSON.stringify({ records: records.length, screenshots: records.filter(r => r.image).length, manifestFiles: manifest.length }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
