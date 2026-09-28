const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// test/manual/buildNativeAudioFinalEvidence.cjs — archive sanitized outcomes, never profiles or media.
async function main() {
    const root = path.resolve('docs/native-audio-final-validation');
    const repositories = [
        ['latest', '.'], ['complete-078', '../folia-windows-contribution'],
        ['A', '../folia-final-core'], ['B', '../folia-final-integer'], ['C', '../folia-native-review-split'],
    ];
    const files = [], runs = [], heads = {};
    async function copy(from, relative) {
        const bytes = await fs.readFile(from); const destination = path.join(root, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes);
        files.push({ path: relative.replaceAll('\\','/'), size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    for (const [label, repository] of repositories) {
        heads[label] = execFileSync('git',['-C',repository,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
        const results = path.join(repository,'test-results');
        for (const entry of await fs.readdir(results,{withFileTypes:true})) {
            if (entry.isFile() && /^(final-|latest-)/.test(entry.name) && /\.(log|json|txt|png)$/.test(entry.name)
                && !/vite|electron.*(?:error|retest|\.log)|package-build|delivery-build/.test(entry.name))
                await copy(path.join(results,entry.name),`${label}/checks/${entry.name}`);
        }
        const directory = path.join(results,'native-audio-review');
        for (const entry of await fs.readdir(directory,{withFileTypes:true}).catch(()=>[])) {
            const timestamp = Number(entry.name.split('-').at(-1));
            if (!entry.isDirectory() || (timestamp < 1790600000000 && entry.name !== 'app-navidrome-1790457638923')) continue;
            const source = path.join(directory,entry.name);
            let records = []; try { records = JSON.parse(await fs.readFile(path.join(source,'results.json'),'utf8')); } catch {}
            const relative = `${label}/runs/${entry.name}`;
            for (const file of await fs.readdir(source,{withFileTypes:true})) {
                if (file.isFile() && /\.(json|png|log)$/.test(file.name)) await copy(path.join(source,file.name),`${relative}/${file.name}`);
            }
            if (Array.isArray(records)) runs.push({ repository: label, run: entry.name, path: relative, records });
        }
    }
    const manifest = { generated:new Date().toISOString(), heads, files };
    await fs.writeFile(path.join(root,'sha256-manifest.json'),JSON.stringify(manifest,null,2));
    await fs.writeFile(path.join(root,'records.json'),JSON.stringify(runs,null,2));
    const escape = text => String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const rows = runs.flatMap(run=>run.records.map(record=>`<tr class="${record.status === 'FAIL' ? 'fail' : ''}"><td>${escape(run.repository)}</td><td><a href="${run.path}/results.json">${escape(run.run)}</a></td><td>${escape(record.id || record.scenario)}</td><td>${escape(record.status)}</td></tr>`)).join('');
    await fs.writeFile(path.join(root,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Folia 原始验证记录</title><style>body{font:15px system-ui;max-width:1400px;margin:32px auto;padding:16px;color:#182336}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:9px;border-bottom:1px solid #ddd}.fail{background:#fff0ed}a{color:#185ac2}</style><h1>Folia 原始验证记录 · 2026-09-29</h1><p>包含历史失败、测试工具前提错误和后续复测；总行数不能当作独立通过用例数。结论和分类请读<a href="../native-audio-final-validation.md">最终报告</a>。不含账号 profile、凭据或音乐原件。</p><p><a href="records.json">原始 JSON 汇总</a> · <a href="sha256-manifest.json">文件 SHA-256</a></p><table><thead><tr><th>来源</th><th>原始运行</th><th>步骤</th><th>原始状态</th></tr></thead><tbody>${rows}</tbody></table></html>`);
    console.log(JSON.stringify({ files:files.length, runs:runs.length, records:runs.reduce((n,r)=>n+r.records.length,0), root }));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
