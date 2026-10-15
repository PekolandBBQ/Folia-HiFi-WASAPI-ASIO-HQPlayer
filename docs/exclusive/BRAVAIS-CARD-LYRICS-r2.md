# 歌单拼贴卡片歌词（2026-10-16，本地候选）

依据用户截图，目标是 Bravais 歌单展开卡片，不是切换到队列拼贴或歌曲详情。
对照 fork/codex/folia-exclusive 与 origin/main（1b39fd86，v0.7.20）后确认：Bravais 原实现只有曲目信息；现有滚动歌词在 Lattice 队列拼贴中。此次复用该画布、时钟、滚动和失败回退，不另建歌词解析或音频链路。

- 集合卡片播放显式传 shouldNavigateToPlayer=false，不修改用户保存的全局设置。
- 保留暂停/继续、加入队列、歌手/专辑入口及显式“进入播放页”。
- 仅当前歌曲且播放身份一致的展开卡显示歌词。歌词画布实际准备好后才收拢标题；无歌词或渲染失败保留原信息。
- 78 项相关单测 + 12 项 Bravais 显示/选歌回归通过；typecheck 和桌面 renderer 构建通过。
- 2 项浏览器组件测试通过：真实歌词画布推进、按钮空间、无歌词回退、非当前卡不借用歌词。首轮冷启动 gallery 在 90 秒总预算内未完成首项，保留原始失败记录；同一代码以 150 秒挂载预算重跑，2 项 25.5 秒通过。
- 浏览器测试使用固定歌词与可控时钟，不作为用户账号实播通过结论。
- 候选：artifacts/Folia-HiFi-0.7.19-r2-card-lyrics-20261016/win-unpacked/Folia-HiFi-WASAPI-ASIO-HQPlayer.exe。
- 用户自行关闭旧版本并打开此候选；不自动关闭，不发布，不修改配置、组件和备份。

补充上一轮选歌证据：本机最新运行日志 local 00:54:32.217 点选土竜，00:54:32.647 收到旧 Toge 的 ended；新诊断记为 outgoing-ended-ignored（pendingSelection=true），随后土竜 source-committed 与 deck-playing 一致。该观察支持此前“旧结束事件挤入新选歌”的判断，不能替代其余快速点歌情形的验证。

证据：../spotify-r37-local/evidence/r2-card-lyrics-{unit,selection,typecheck,ui,ui-cold-start,renderer,assembly}.log 与 r2-card-lyrics.png。
