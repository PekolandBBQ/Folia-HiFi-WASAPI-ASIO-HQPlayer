# 歌单点歌身份与请求溯源（2026-10-16）

当前候选保持 0.7.19 r2，不发布，不修改现有配置或组件备份。

## 原始证据与结论边界

运行日志 2026-10-15.log 中，本机时间 00:24:59.111 请求 可愛くてごめん，00:24:59.536 请求 Radiance Across Sea and Sky；随后多组间隔约 400 ms 的不同曲目请求。旧日志没有输入来源，不能追溯证明这些请求均由某一种入口产生。用户报告歌单卡片与实播错位，上一首/下一首悬浮标题与实播一致。当前窗口确认使用 Bravais 拼贴墙。

## 修复

1. Bravais 展示面可以在翻牌期间保留旧条目，点击却仅传 slotKey，按最新布局重新解析。这会使可见歌曲与点击目标不一致。播放和入队现在传递实际可见条目键；键已消失时不替换成位置上的其他歌曲。键盘仍按当前位置正常导航。
2. 普通网格 PolaroidCard 的 memo 比较遗漏点击回调及 rawTrack，同画面下可保留旧行为。补齐比较，回归验证回调更新后只调用最新回调一次。
3. 新点歌准备期间，旧端 ended 仍可按旧队列另发下一首并取消新选择。自然结束入口现在带明确 trigger；仅在有待完成来源请求时忽略旧结束，不影响手动上一首/下一首。

## 日志

PlaybackSelection: input（bravais-card/grid-card/library-track）、card-visible、wall-play-resolved（可见键/位置映射键/解析键）、request、allowed、next/previous、outgoing-ended-ignored、source-committed、deck-playing。
SpotifyAudioRequest: accepted/prepared/pcm-publication 均携带 trackId、requestId，后两者有 Spotify 会话关联。prepared 记录实际回报曲目。采集开始不等同于已听到声音；deck-playing 也不是人工听音验收。
日志仍写到原用户资料 runtime 日志，不写音频 URL、账号凭据或 PCM 数据。

## 验证

旧代码失败证据：r2-selection-before.log（旧 ended 多发第二次请求）、r2-card-before.log（旧回调被调用）。
最终 r2-selection-targeted.log：4 个测试文件、92 项通过，包括快速连续选择与迟到结果、保留展示面/新布局冲突、消失条目不替换、实际卡片按钮携带可见键。
类型检查和桌面 renderer 构建通过；最终装配逐项检查诊断标记（不核对校验值）。
这轮为本地手动实播候选，不等同于原始用户问题已实机验收。历史第二请求来源仍不能从旧日志唯一还原；新增日志用于实播确认。

候选：artifacts/Folia-HiFi-0.7.19-r2-selection-20261016/win-unpacked/Folia-HiFi-WASAPI-ASIO-HQPlayer.exe
