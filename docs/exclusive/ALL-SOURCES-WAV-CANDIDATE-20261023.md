# HQPlayer 全部 PCM 流使用 WAV 的试听候选

## 定位

r9 的 `buildWavListeningComponent.cjs` 仅在 `spec.transport !== undefined` 时创建 WAV 源。该字段属于 Spotify 实时采集的传输契约；`hqplayerStreamAdapter.cjs` 对普通解码音源使用 `sourceKind: finite`，不附加该字段。因此 QQ、网易云等普通流媒体解码路径仍使用 RAW HTTP 源。旧测试还明确断言 finite 输入不使用 WAV，属于此前迁移范围遗漏。

这能确认格式遗漏，不能独立证明本次 QQ 爆音原因。检查时最新运行日志 `2026-10-22.log` 为零字节，没有可供归因的这次播放事件。

## 修改边界

- 所有通过 HQPlayer PCM 流适配器的输入统一使用现有 WAV 封装、磁盘回读缓存和 HTTP 读取实现；不按 provider 名称分支。
- 命名管道保持原始 signed PCM32，采样率、声道和采样值保持不变；实时采集身份、generation 和 transport 验证不变。
- 完整文件直接交给 HQPlayer 的路径仍保留原文件格式，不进行无意义的转码。WASAPI/ASIO 输出不变。
- WAV 诊断增加 `producerKind`（live-capture / decoded-pcm）、`inputContainer`、采样率及声道。会话和流代次字段保留。

## 验证

- WAV 源/HTTP 兼容性：18 项通过；覆盖普通解码输入也选择 WAV，PCM 相等、HEAD、Range、完整重复读取、EOF 和超过三秒 DSP 延迟排空。
- 适配器、流 facade、完整文件 session、实时 PCM 契约、路径与 Range：97 项通过。
- 对装配后的实际 worker 和其随包 WAV helpers 重跑 11 项，通过；确认候选实际选择独立 WAV worker。
- 未进行真实 QQ/网易云或硬件试听，待用户关闭旧 Folia 后打开候选，在相同 HQPlayer 滤波/整形/输出配置下验证。不得将模拟接收器通过视为爆音已解决。

## 交付

`artifacts/Folia-HiFi-All-Sources-WAV-20261023/win-unpacked/Folia-HiFi-WASAPI-ASIO-HQPlayer.exe`

独立复制 r9 并复用已有隔离试听组件选择机制。未启动或关闭用户应用，未修改用户配置、备份、已安装组件及其回退指针，未发布。正式发布仍需重新生成组件版本和目录，此候选不覆盖 r9 发行件。
