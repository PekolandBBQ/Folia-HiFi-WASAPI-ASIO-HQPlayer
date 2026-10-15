# Spotify Hi-Res 偏好请求修复（2026-10-15）

用户运行的 r2 配套路由为 dev.30。22:24:52–22:26:30 的运行日志连续出现 `Spotify: invalid-audio-request`，此前音源预取使用 `hires`。安装包和源码均存在同一缺口：共享播放偏好含四档，Spotify 采集入口只接受 standard/high/lossless。

以有效歌曲编号、有效请求编号和 hires 在旧代码复现拒绝。修复接受全部四档全局偏好；只保留 requestedQuality，实际音质和编码仍未知，不改变 Spotify 客户端音质，也不将 s32le 采集容器标记为 Hi-Res。

无效歌曲编号、请求编号、音质参数分别提供独立中文原因。常规 SpotifyAudioRequest 日志记录接受/拒绝、偏好和字段有效性，不记录歌曲或请求标识。该修复不涉及原生组件、路由策略或音量。

验证：新增用例在旧代码 4 失败；修复后 3 个相关文件共 84 项通过，Node 中文/诊断 13 项通过。用户已要求自行实播，因此当前仅装配并打开候选，实播待用户反馈，尚未发布。

候选目录：`artifacts/Folia-HiFi-0.7.19-r2-hires-request-20261015/win-unpacked`。使用已有 Folia HiFi 资料；未重装组件、未运行 backup/apply、未覆盖备份。
