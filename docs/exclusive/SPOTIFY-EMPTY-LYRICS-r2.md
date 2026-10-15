# Spotify 空歌词分类与缓存修复（2026-10-16，本地候选）

范围：仅 electron/spotify/wrapper/extension.js 和 wrapper/lyrics.cjs 及其测试。保留上一候选的 renderer，不修改卡片定位、导航、音频、配置和备份；不发布。

## 已观察与未确认
最新日志中 Paper Plane（6nZlSXP6aqHUU7SJpYQzIC）首次 564ms、In Moments Does Moon Persist（0SalvDj3mS5mOqsQsPFpnV）276ms、赴大荒（19rMrCvCTdATwQVMNvromq）575ms 返回零行；之后 0–1ms 重复命中空结果。旧日志把 404/响应缺字段/空数组统称 no-lyrics，不能据此判断三首的原始响应分别属于哪一种，也不能认定 Spotify 一定没有歌词。

## 修改
- reason 分别记录 received/http-not-found/missing-lyrics/invalid-lines/empty-lines/blank-lines；记录 cacheHit、响应结构摘要、404 状态和中文原因。不记录歌词正文、令牌或原始响应。
- 仅保留有文本的正结果与正在进行的请求；空、404、异常及失败请求完成后淘汰，下一次请求可重新获取。
- 不确定空结果最多三次静默重试，持续为空时正常返回空结果，不干扰音频。404 不立即重试，也不长期缓存；429 不重试。401/403 区分未授权/拒绝访问，不再伪装成无歌词。
- 原有 30 秒歌词超时、控制队列独立、迟到旧歌词防覆盖保持。
- 主进程记录每次尝试的具体原因与耗时；旧桥接没有原因时标为 unclassified-empty，不能冒充已确认无歌词。

## 验证
Node 28 项通过，含三首 ID × 五种空结果 → 下一次有效返回 → 正缓存复用，401/403，429，重试上限，迟到响应与控制独立。
Vitest 71 项通过，含歌词解析、原生歌词晚到、播放请求代数与旧失败隔离。
用例模拟响应而非向 Spotify 发出真实歌词查询；本轮不宣称这三首实播已有歌词。
候选：artifacts/Folia-HiFi-0.7.19-r2-lyrics-empty-20261016/win-unpacked/Folia-HiFi-WASAPI-ASIO-HQPlayer.exe。
用户自行退出旧 Folia 和 Spotify 后打开新候选，以加载新桥接脚本。无须重装/backup。
证据前缀：spotify-r37-local/evidence/r2-lyrics-empty-。
