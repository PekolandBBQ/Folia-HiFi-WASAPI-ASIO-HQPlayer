const fs = require('node:fs/promises');
const path = require('node:path');

// test/manual/buildNativeAudioReviewReport.cjs — archive sanitized results and screenshots, never account profiles.
async function main() {
    const root = path.resolve('test-results/native-audio-review');
    const output = path.resolve('docs/native-audio-validation');
    await fs.mkdir(output, { recursive: true });
    const report = await fs.readFile('docs/native-audio-validation-report.md', 'utf8');
    await fs.writeFile(path.join(output, 'report.md'), report.replaceAll('(native-audio-validation/index.html)', '(index.html)'));
    const series = await fs.readFile('docs/native-audio-pr-series.md', 'utf8');
    await fs.writeFile(path.join(output, 'native-audio-pr-series.md'), series.replaceAll('(native-audio-validation-report.md)', '(report.md)'));
    const folders = ['.', ...(await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)];
    const records = [];
    for (const folder of folders) {
        let entries;
        try { entries = JSON.parse(await fs.readFile(path.join(root, folder, 'provider-results.json'), 'utf8')); } catch { continue; }
        // Keep original results intact, but never count a known invalid harness run as product evidence.
        const invalidHarness = entries.some(entry => entry.id.endsWith('-expired-refresh') && entry.recovered && entry.sourceScheme === null);
        const target = path.join(output, 'evidence', folder === '.' ? 'initial' : folder);
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, 'results.json'), JSON.stringify(entries, null, 2));
        for (const entry of entries) {
            const sourceImage = path.join(root, folder, `${entry.id}.png`);
            const destImage = path.join(target, `${entry.id}.png`);
            let image;
            try { await fs.copyFile(sourceImage, destImage); image = path.relative(output, destImage).replaceAll('\\', '/'); } catch { /* JSON remains the evidence when an early failure preceded capture. */ }
            records.push({ run: folder === '.' ? 'initial' : folder, ...entry, image,
                ...(invalidHarness ? { validity: 'HARNESS_INVALID' } : {}) });
        }
    }
    const ui = [];
    for (const name of (await fs.readdir('test-results')).filter(name => /^native-(recovery|signal-path|audio-settings).*\.png$/.test(name))) {
        await fs.mkdir(path.join(output, 'ui'), { recursive: true });
        await fs.copyFile(path.join('test-results', name), path.join(output, 'ui', name));
        ui.push(`ui/${name}`);
    }
    const logNames = ['regression-final.log', 'ui-complete.log', 'typecheck-final.log', 'versions.log', 'version-results.json', 'pcm.log', 'component.log', 'ui.log', 'ui-retest.log', 'core-unit.log', 'core-ui.log', 'core-typecheck.log', 'integer-unit.log', 'integer-ui.log', 'integer-typecheck.log', 'signal-unit.log', 'signal-ui.log', 'signal-typecheck.log'];
    await fs.mkdir(path.join(output, 'checks'), { recursive: true });
    for (const name of logNames) {
        try {
            const log = (await fs.readFile(path.join(root, name), 'utf8')).replaceAll(path.resolve('.'), '<workspace>');
            await fs.writeFile(path.join(output, 'checks', name), log);
        } catch { /* Explicit check inventory is kept separate from missing evidence. */ }
    }
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(records, null, 2));
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const rows = records.map(record => `<tr data-status="${escape(record.validity || record.status)}"><td>${escape(record.run)}</td><td>${escape(record.id)}<small>${escape(record.zh)}<br>${escape(record.en)}</small></td><td class="${escape(record.status)}">${escape(record.validity || record.status)}${record.validity ? `<small>原始记录 / Recorded: ${escape(record.status)}</small>` : ''}</td><td>${escape(record.sourceCodec)} ${record.sourceSampleRate ? escape(record.sourceSampleRate / 1000) + ' kHz' : ''} ${record.sourceBitsPerSample ? escape(record.sourceBitsPerSample) + '-bit' : ''}<small>${escape(record.code || record.reason)}</small></td><td>${record.preparationMs ?? '—'}</td><td>${record.image ? `<a href="${record.image}">截图 / Screenshot</a>` : '无截图 / No screenshot'}</td></tr>`).join('');
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Folia 原生音频专项验证</title><style>body{margin:auto;padding:32px;max-width:1500px;font:16px/1.65 system-ui;background:#111820;color:#dce6ef}h1,h2{color:white}small{display:block;opacity:.72}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:10px;text-align:left;border-bottom:1px solid #344451;overflow-wrap:anywhere}a{color:#8ccef3}.PASS{color:#94e1b2}.FAIL,.BLOCKED{color:#ffbe91}button{margin:8px;padding:8px 16px;background:#25394a;color:white;border:1px solid #64839a;border-radius:9px}.note{padding:20px;background:#20313d;border-radius:16px}img{width:100%;max-width:660px;border-radius:12px}details{padding:10px}pre{white-space:pre-wrap}</style><h1>Folia 原生音频专项验证</h1><p>Windows x64 · XingCore · 2026-09-27<br><small>Native audio validation — local evidence, not an upstream release approval.</small></p><div class="note">相关单元测试 150 通过；浏览器组件测试 6 通过；真实音源、模拟故障和环境问题分开记录。<br>真实播放记录是账号音源经完整准备后驱动时钟前进，不是 DAC 模拟输出测量或听感评价。HTTP 403 为受控注入；更新恢复 UI 为模拟桥接，版本回退另有真实可执行程序握手。<br><small>150 focused unit tests and 6 UI component tests pass. Hardware telemetry does not establish analog output quality. Injected expiry and mocked recovery UI are identified separately from real provider playback and executable version checks.</small></div><p><a href="report.md">完整专项报告 / Full report</a> · <a href="native-audio-pr-series.md">本地审查分支 / Local review branches</a></p><h2>仍需完成 / Remaining</h2><p>QQ 搜索空列表之后，已通过用户提供的歌单补齐远程、完整缓存和过期刷新两后端测试。另一次随机 Navidrome 样本转码失败因缺少样本身份尚未定位；固定同一首 FLAC 的三路径复测通过不等于该失败已修复。候选发布清单为空，Folia 官方镜像 CI 未远程运行。基础接入、整数模式和链路展示已拆为三个本地依赖分支，分别测试；尚未推送或提交集成 PR。本报告不是合并申请。</p><h2>失败和修复 / Failures and fixes</h2><ul><li>Navidrome 未找到 FFmpeg → 单独配置服务器 FFmpegPath；MP3 转码复测通过。</li><li>Folia 转码专用目录未配置 → 使用官方裁剪版音频运行时；folia-transcode 源复测通过。</li><li>测试脚本误读 result.url → 改为 result.representation.url，未修改产品接口。</li><li>403 用例最初只读取 Error.code，而 Electron 桥接未保留扩展字段 → 使用产品已有的固定错误码解析器，同时读取精确 message；复测通过。</li><li>StrictMode 探针提前撤销 Blob URL → 修复探针资源释放；自动回退 UI 复测通过。按钮断言修正为实际翻译文本。</li></ul><p>每轮保留原始结果，不把历史 FAIL 删除或计作当前产品失败率。截图耗时包含在 elapsedMs，性能比较只参考 preparationMs，且仅是少量样本。</p><h2>可筛选记录 / Evidence index</h2><button onclick="filter('')">全部 / All</button><button onclick="filter('PASS')">通过 / Pass</button><button onclick="filter('FAIL')">失败 / Fail</button><button onclick="filter('BLOCKED')">受阻 / Blocked</button><button onclick="filter('HARNESS_INVALID')">无效脚本轮次 / Invalid harness</button><table><thead><tr><th>轮次 / Run</th><th>步骤 / Step</th><th>结果 / Result</th><th>格式或错误 / Format or error</th><th>准备 ms / Preparation</th><th>证据 / Evidence</th></tr></thead><tbody>${rows}</tbody></table><h2>产品组件界面 / UI component evidence</h2>${ui.map(src => `<details><summary>${escape(path.basename(src))}</summary><a href="${src}"><img loading="lazy" src="${src}"></a></details>`).join('')}<h2>自动检查日志 / Check logs</h2><ul>${logNames.map(name => `<li><a href="checks/${name}">${name}</a></li>`).join('')}</ul><script>function filter(status){document.querySelectorAll('tbody tr').forEach(row=>row.hidden=!!status&&row.dataset.status!==status)}</script></html>`;
    await fs.writeFile(path.join(output, 'index.html'), html);
    console.log(`专项证据归档完成 / Evidence archived: ${records.length} records, ${records.filter(record => record.image).length} screenshots, ${ui.length} UI screenshots`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
