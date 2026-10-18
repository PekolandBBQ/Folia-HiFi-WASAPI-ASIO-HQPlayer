import React from 'react';
// src/components/modal/settings/ForkUpdateDetails.tsx
export default function ForkUpdateDetails({status}:{status:ElectronUpdateStatus}) {
 return <div className="space-y-2 text-xs" style={{color:'var(--text-secondary)'}}>
  <label className="flex items-center gap-3">更新来源
   <select aria-label="更新来源" value={status.sourcePreference || 'auto'} disabled={status.status === 'checking' || status.status === 'downloading'}
    className="rounded-lg border border-current/20 bg-transparent px-2 py-1" onChange={event=>void window.electron?.setUpdateSource(event.target.value as 'auto'|'github'|'gitee')}>
    <option value="auto">自动（GitHub 优先，失败后尝试 Gitee）</option><option value="github">GitHub</option><option value="gitee">Gitee（国内）</option>
   </select>
  </label>
  {status.updateSource && <p>本次更新来源：{status.updateSource === 'gitee' ? 'Gitee' : 'GitHub'}</p>}
  {status.error && <p role="status">{status.error}</p>}
  {!status.autoUpdateSupported && status.downloadUrl && <button type="button" disabled={status.status==='downloading'} className="rounded-lg border border-current/20 px-3 py-2" onClick={()=>void window.electron?.downloadUpdate()}>{status.status==='downloading'?`正在下载并合并 ${Math.round(status.downloadProgress?.percent||0)}%`:'下载便携版 ZIP'}</button>}
  {!status.autoUpdateSupported && status.status==='downloaded' && <p>完整 ZIP 已保存，下载目录已打开。请退出旧版后解压使用。</p>}
  {status.releaseNotes && <details><summary className="cursor-pointer">查看更新说明</summary><p className="mt-2 whitespace-pre-wrap max-h-56 overflow-auto">{status.releaseNotes}</p></details>}
 </div>;
}
