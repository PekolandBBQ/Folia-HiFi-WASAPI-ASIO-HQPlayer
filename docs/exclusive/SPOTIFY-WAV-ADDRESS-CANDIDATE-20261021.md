# Spotify → HQPlayer WAV 请求地址候选 · 2026-10-21

候选：`C:\Users\Pekora\Documents\ChatGPT\Folia\artifacts\Folia-HiFi-Spotify-WAV-AddressFix-20261021\win-unpacked\Folia-HiFi-WASAPI-ASIO-HQPlayer.exe`。运行时需保留整个 `win-unpacked` 目录。

内部构建 `1792514282043`，`wavHttpRevision: 3`。继承 WAV ReadFix 候选及此前主页、跨音源退出、路由恢复修改。此次仅改请求地址校验与日志，未发布、未启动或关闭用户应用、未改用户配置或备份。

## 失败证据及边界

`%APPDATA%\Folia HiFi\logs\runtime\2026-10-20.log` 在北京时间 2026-10-21 00:19:23 记录 HQPlayer 的 HEAD 请求：已采集 620928 字节，返回 404 / unknown-source。00:19:28 收到 HQPLAYER_SOURCE_REJECTED，清理时已采集 2402568 字节、实际读取 0 字节。随后 EPIPE 为关闭后的连带错误。

旧实现将路径与 Host 的完整字符串比较合并为一个 404，日志没有原始结构或分项结果。因此可以确认此次失败发生在 HTTP 地址校验；无法回溯确认是路径形式还是 Host 形式造成，不能声称已复现 HQPlayer 当次的具体请求写法，也不能据此断言 WAV 解析已经通过。

## 修改

- 请求地址检查分离为 `electron/hqplayer/wavHttpAddress.cjs`；仅在绑定 `127.0.0.1` 的 WAV 服务上使用。
- 接受 origin-form 和本机 HTTP absolute-form；兼容本机 Host 大小写、本机别名、省略端口及 HTTP/1.0 无 Host。明确写出的端口必须匹配当前服务。HTTP/1.1 缺失 Host、重复 Host、非本机 Host、绝对地址中的非本机/错误端口/用户凭据仍拒绝。
- 路径可为带 `.wav` 的当前会话令牌或原组件的无扩展令牌；只解码一次百分号编码，扩展名不区分大小写，令牌仍完整、精确且区分大小写。查询参数不能代替路径令牌。多余路径段、错误/旧令牌、双重编码、路径穿越、反斜线及不支持的请求形式均拒绝。没有改写到其他会话的回退路径。
- 正确凭据与 Host 检查通过后，才执行原有 HEAD/GET、分段、重读和缓存读取逻辑。拒绝读者不会关闭源，下一次正确请求仍可读取原 PCM。
- 原 WAV 头、PCM 字节、采样率、缓冲、生产结束和会话清理规则保持前一候选实现。未知长度实时 WAV 的 EOF 长度告警仍是前轮未确认项，此次不宣称解决。
- 新 worker 仅由该候选 `wavHttpRevision: 3` 选择 `resources/hqplayer-wav-addressfix`，不修改正式组件安装指针。此前 revision 2 继续选择自己的目录。

## 日志

仍在普通 runtime 日志内，标记 `[HQPlayer WAV HTTP]`。日志日期采用 UTC，因此北京时间凌晨可能记录在前一天文件。

request 新增 `httpVersion`、`requestTargetForm`、`requestHost`、`hostPort`、`expectedPort`、`hostCheck`、`requestPathPattern`、`decodedPathPattern`、`pathWasEncoded`、`hasQuery`、`pathCredentialMatches`、`pathMatches`、`pathForm`、`addressAccepted` 和 `rejectionReason`。absolute-form 另有 `targetAuthority` 与 `targetAuthorityCheck`。

response 的 `reason` 明确区分 `path-mismatch`、`host-missing`、`host-invalid`、`host-not-loopback`、`host-port-mismatch`、`host-ambiguous`、对应的 `absolute-host-*`、`invalid-path-encoding` 和 `invalid/unsupported-request-target`。用 session、streamGeneration、sourceSession 与 requestId 关联原有请求/响应/关闭日志。

路径结构以 `[session]`、`[other]` 占位；不记录令牌、查询参数值或用户音频。合法本机 Host 和端口保留以供比较，其他 Host/无效 authority 只记录类别。HTTP 解析器在进入应用 handler 前拒绝的畸形请求不计为地址校验事件。

## 验证

- `build/wav-address-boundaries.log`：12 文件、173 项通过。包括新地址正反例、真实 TCP 中 HTTP/1.0 / 省略 Host 端口 / absolute-form 探测、拒绝后恢复、重复读取、原有分段/缓存/断开/Seek/旧会话隔离及跨音源退出边界。
- `build/wav-address-typecheck.log`：类型检查通过。
- `build/wav-address-package-verification.json`：实际候选 worker 和 helper 的 4 种本机探测、3 种独立拒绝原因、2 次完整读取一致性、凭据脱敏及临时缓存清理通过。
- `build/wav-address-assembly.log`：独立候选装配记录；没有发布或更新页面。

上述为自动化及本地 HTTP 验证，不是 HQPlayer 实播通过。

## 用户实播

由用户自行关闭旧 Folia，运行本候选，保持原 HQPlayer DSP 和缓冲设置，先点播一首 Spotify。代理核对首个 HEAD/GET 的路径和 Host 分项结果、状态码及后续实际输入回报。首次成功后再做一次暂停/继续、切歌。若失败，保留当次记录，不能以控制命令 accepted 代替 HQPlayer 输入解析或 DAC 出声确认。
