# Spotify → HQPlayer WAV 读取候选 · 2026-10-21

后续手动测试在地址校验阶段返回 404，新的地址兼容候选及分项日志见 [WAV 请求地址候选](SPOTIFY-WAV-ADDRESS-CANDIDATE-20261021.md)。本文保留前轮验证与未确认项。

候选路径：`C:\Users\Pekora\Documents\ChatGPT\Folia\artifacts\Folia-HiFi-Spotify-WAV-ReadFix-20261021\win-unpacked\Folia-HiFi-WASAPI-ASIO-HQPlayer.exe`。

内部构建 `1792512470986`，`wavHttpRevision: 2`。基于上一轮主页与跨源退出候选追加读取修复，保留其余修复。正式标签仍是 r8，未发布。没有操作用户的 Folia、Spotify 或 HQPlayer 界面，没有改动配置、DSP、登录资料或备份，也没有覆盖已安装组件指针。

## 失败证据与结论边界

用户截图为 HQPlayer `ReadWAV::OpenURI / clWaveMainChunk / mandatory chunks missing`。2026-10-20 本地 23:41:49、23:42:04、23:42:29 的 Folia 日志均在控制加载 accepted 后紧接着出现 PCM session cancelled / EPIPE。accepted 仅代表控制命令接受，不能算 WAV 解析成功。

旧 HTTP 源仅允许一次 GET、大多数 Range 返回 416、第二次 GET 返回 409，并在首次读者断开时关闭整个源。它不适合需要先探测、关闭再重新读取的文件读取器。这些行为已经由本轮真实本地 HTTP/文件测试复现并修复；原始运行没有 HTTP 请求日志，尚不能断言截图当时具体是哪一次 GET 或哪个 Range 触发了 HQPlayer 失败。

修正前次分析：把两个 `0xFFFFFFFF` 当成普通有限长度来计算“相差 36 字节”，不足以证明流式 WAV 头就是根因；这两个值也被流式写入器用作未知长度标记。尝试自洽的 RIFF 容量上界后，独立解码器仍在 EOF 报告长度告警；RF64 零长度和负一长度试验也未通过独立解码验证，未采用。所有失败证据保留。

## 本次实现

- PCM32 使用 WAVE_FORMAT_EXTENSIBLE，明确 32 位有效位深、采样率、声道布局和 PCM 子格式。头长 68 字节；PCM payload 没有量化、重采样、增删或修改。实时头保持未知长度标记，不伪造歌曲已经完整采集；完成后的新读取使用实际捕获字节数和精确 Content-Length。
- 实时 HTTP 响应使用连接结束定界，不插入 HTTP chunked 编码。HEAD、从零开始的连续 GET 与探测请求互不消耗捕获数据。
- 每个源有独立的临时 PCM 文件，支持头部/音频跨度、闭合范围、完成后的开放范围和尾部范围、并发读取及重复读取。同一位置返回相同 PCM。实时探测只返回已经可用的前缀；尚未采集到的范围和尚不能确定的尾部请求返回 503 + Retry-After，不伪报 EOF 或销毁源。非法范围与完成后的越界返回 416。
- 读者关闭只释放该读者。采集继续，后续读者可重连；停止、切歌及新 generation 才关闭源、断开等待读者并删除该会话的临时文件。保持进程身份、输出所有权及原清理链路。
- 内存按单块读写，临时缓存上限约 4 GiB/会话，超过时明确失败而不截断 PCM。磁盘缓存使历史读取可重放，未额外提高用户预缓冲设定；它不表示 HQPlayer 已播放完对应字节。
- 资源只在独立候选中启用；本地及其他有限音源沿用原组件路径。

## 日志

普通 runtime 日志新增 `[HQPlayer WAV HTTP]`，含 request/response/reader-wait/reader-close/socket-error/reader-error/producer-complete/producer-error/cache-open/cache-close。

关键字段：Folia session、streamGeneration、sourceSession、requestId、method、Range、HTTP status、start/end、Content-Range、Content-Length、lengthKind、capturedBytes、sentBytes、连接关闭 reason、sourceRetained、缓存清理结果。不记录访问 URL 中的随机凭据或音频内容。正常停止期间的关闭不伪报为读取失败。

用户下一轮打开后的日志位置：`C:\Users\Pekora\AppData\Roaming\Folia HiFi\logs\runtime\2026-10-21.log`。

## 已完成的验证

- 相关 11 文件、133 项通过：`build/wav-http-boundaries-final.log`。覆盖接口探测后重新连接、PCM pipe 尚未打开时的准备、不阻塞的格式探测、重复/并发读取、范围/尾部/越界、取消/清理、Seek 新会话头、旧 HQPlayer 错误隔离与原跨音源退出边界。
- 最后停止日志调整后，相关 2 文件、11 项通过：`build/wav-http-close-final.log`。
- 类型检查通过：`build/wav-http-typecheck-final.log`。本轮没有修改 renderer，没有重复构建前端。
- 独立 FFmpeg 解码：HTTP body 通过 pipe 输入，实时及完成后分别还原 352800 字节，逐样本字节一致，均退出 0：`build/wav-http-decoder-extensible.log`。完成后读取无解码警告；实时源在 EOF 仍有 unknown/max-size 和 corrupt-packet 长度告警，不能将其删除后宣称完全兼容。该测试不用 HQPlayer，不是实播通过。
- 包内实际 worker/helper 的 3 次分段探测、2 次精确重读、日志回传和缓存清理验证通过：`build/wav-http-package-verification.json`。装配记录：`build/wav-http-assembly.log`、`build/wav-http-finalize.log`。
- 首轮停止测试只接受连接异常，但无 Content-Length 的响应也可以正常 EOF；断言修正为接受两种终止形式，停止/释放检查保留。首次失败记录：`build/wav-http-compatibility-first.log`。
- 独立解码探针最初用了不含 HTTP 协议和 s32le 输出 muxer 的随包裁剪版 FFmpeg，随后改为经典 HTTP 客户端将响应体送入 WAV 解码/再封装。Node 的 fetch 在大块 EOF 测试中出现 undici 内部断言，保留原失败记录，探针改用 node:http。最终探针实际验证了 WAV 解码，不把工具协议缺失算成播放器故障。

## 待用户实播

由用户自行关闭旧 Folia，打开上述完整目录中的 EXE。先保持原 HQPlayer 滤波、整形器和缓冲设置，点一首 Spotify 歌曲，检查首次能否解析并播放。若成功，再做一次暂停/继续和切歌；完成后代理读取正常 runtime 日志，关联请求、输入格式、播放状态及关闭事件。

这轮候选尚未取得真实 HQPlayer 读取/结束结果。尤其是未知长度实时 WAV 在 HQPlayer 的 EOF 行为仍需确认；不能以合成接收器或 FFmpeg 的样本一致替代该项。若还失败，新日志应能区分被拒绝的 Range、首个探测断开、无捕获字节、原生源取消或 WAV 解析后拒绝。
