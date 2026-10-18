import React from 'react';
// src/components/modal/settings/ForkAbout.tsx
export function formatForkVersion(value: string) {
    return value.replace(/^v?folia-hifi-v/, 'Folia HiFi ');
}
export default function ForkAbout() {
    const linkClass = 'underline underline-offset-2 hover:opacity-100 break-words';
    return <div className="space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
        <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Folia HiFi</p>
        <p>专版作者／维护者：<a className={linkClass} href="https://github.com/PekolandBBQ" target="_blank" rel="noopener noreferrer">PekolandBBQ</a></p>
        <p>专版仓库：Folia-HiFi-WASAPI-ASIO-HQPlayer</p>
        <p><a className={linkClass} href="https://github.com/PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer" target="_blank" rel="noopener noreferrer">GitHub</a> · <a className={linkClass} href="https://gitee.com/pekoland-bbq/folia-hi-fi-wasapi-asio-hqplayer" target="_blank" rel="noopener noreferrer">Gitee</a></p>
        <p>基于上游：<a className={linkClass} href="https://github.com/chthollyphile/folia-major" target="_blank" rel="noopener noreferrer">chthollyphile/folia-major</a>，感谢原作者及贡献者。</p>
        <p className="text-xs leading-relaxed opacity-75">这是 PekolandBBQ 维护的 Folia HiFi 专版，非上游官方发行版。<a className={linkClass} href="https://github.com/PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer/issues" target="_blank" rel="noopener noreferrer">问题反馈至专版仓库</a>。</p>
    </div>;
}
