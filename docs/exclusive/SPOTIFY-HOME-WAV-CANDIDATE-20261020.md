# Spotify 主动连接、跨源退出及 WAV 试听候选 · 2026-10-20

后续 WAV 读取兼容性修复见 [2026-10-21 读取候选](SPOTIFY-WAV-READ-CANDIDATE-20261021.md)。该记录也修正了仅按长度字段差值判断根因的分析，保留实时 EOF 的未确认项。

本次为独立候选，版本仍为 0.7.19 r8，内部构建 `1792510182172`，候选标记 `spotify-home-wav-listening`。未发布、未覆盖正式版，也未操作运行中的 Folia 或 Spotify。配置与备份目录保持原样。

## 手机接管后仍拦住其他音源的漏口

最新日志中，同一个 Spotify 控制器在手机接管后持续返回 DEVICE_INACTIVE。旧候选虽然允许路由恢复暂缓，但原生输出的 `complete()` 收尾又调用了旧源的暂停，因此仍抛出 SOURCE_RESTORE_UNCONFIRMED。这是先前只验证路由退出、不覆盖完整原生输出收尾的缺口。

本次将进程采集的跨源退出贯通到原生输出收尾：独立确认本机采集停止、确认输出释放后，将远端暂停、失联和待恢复路由归还 Spotify 自己保留，不再要求其他音源等待手机或 Spotify 控制通道。旧恢复记录与真实失败保留，不假报路由已恢复。旧 HQPlayer 会话的迟到错误也按会话过滤，不能再影响新源。

切回 Spotify 时会重新执行连接检查；握手失败走现有自动配置再连接。若实际本机采集或输出停止失败，仍保留该具体错误，不能以远端断连为由忽略仍在工作的本机输出。

## 其他本轮改动

- 启动总是显示主页；不从已保存账号或上次 Spotify 源推断用户本次选择。主进程桥接改为按需初始化，后台库、循环和连接状态检查在明确选择 Spotify 前不启动。配置和保存的账号不删除。
- 发现 Spotify 的显式应用输出仍指向 VB-CABLE 或失效端点时，自动记录原值，只修复 Spotify 应用输出，再应用已有配置并重试。`system default` 本身视为合法设置；不修改 Windows 全局默认输出、不重跑首次备份。实际每应用策略写入仍待用户本机触发验证。
- 信号链区分 Spotify 桌面客户端的进程采集 PCM 与 Spotify 未提供的原始编码/音质档位；不再让“实际返回：未回报”掩盖已知的采集来源，也不把 32 位 PCM 标成原始曲目位深。
- 仅 Spotify 实时 PCM 到 HQPlayer 的候选输入改为开放长度的 WAV 封装。保留相同 PCM、采样率、位深、队列、预缓冲与背压机制，非 Spotify 文件路径不改。不是等待完整文件下载，也尚不能据此声称爆音已解决。

## 验证范围与记录

- 本轮较早的全量单测：830 文件通过、1 文件跳过，9705 项通过、2 项原有跳过：`build/spotify-home-wav-full-unit-final.log`。
- 最后修改后的相关边界回归：14 文件、222 项通过：`build/spotify-home-wav-delivery-tests.log`。包括真实控制器编排、旧源完整释放、失败重试、切回 Spotify、取消/替换请求、迟到 HQPlayer 错误隔离与 WAV 组件行为；控制回执及播放设备为模拟。
- 自动握手失败后配置、重新连接及保留具体失败：9 项通过：`build/spotify-home-wav-autoconnect-final.log`。
- 首次配置、组件复用、搜索资源恢复及启动进度 Node 回归：39 项通过：`build/spotify-home-wav-node-regression-final.log`。
- 原生路由组合测试 116 项通过，含只读 Windows 接口探测，不含策略写入或实播：`build/spotify-home-wav-route-tests.log`。
- 类型检查与 renderer 构建通过：`build/spotify-home-wav-typecheck-delivery.log`、`build/spotify-home-wav-renderer.log`。
- WAV 测试使用正式 r8 所带 preview.7 组件，验证加 WAV 头前后 PCM 字节一致、读取背压、取消及新会话/Seek 重新生成头；这不等于真实 HQPlayer 接收和听感通过。
- 初次 Node 运行暴露旧合成启动夹具没有模拟自动重启所需的 stop/start/PID，误触实际停止函数；已将夹具全部隔离，保持生产流程不变。失败记录保留在 `build/spotify-home-wav-node-regression.log`。
- 初次装配的外部脚本同步传错目录，最终 ASAR 已生成但同步未完成；已修正并重新同步。保留初次日志 `build/spotify-home-wav-assembly.log`，完成记录 `build/spotify-home-wav-assembly-final.log`。
- 包内检查确认新 renderer、恢复模块、原生应用输出修复组件和独立 WAV worker 已入包：`build/spotify-home-wav-package-verification.json`。没有启动候选、没有修改已安装组件指针。

## 交付与用户验证

候选程序：`C:\Users\Pekora\Documents\ChatGPT\Folia\artifacts\Folia-HiFi-Spotify-Home-WAV-20261020\win-unpacked\Folia-HiFi-WASAPI-ASIO-HQPlayer.exe`。保留整个 `win-unpacked` 目录。

由用户关闭旧 Folia，打开上述候选。先停留主页，确认未主动开始 Spotify 握手；随后选择 Spotify 播放。使用原 HQPlayer 滤波设置试听 WAV，观察信号链实际回报。

用手机接管 Spotify 后，在 Folia 切到网易云、QQ 或本地并播放，确认旧 Spotify 错误不再切断新源；最后切回 Spotify，观察重新连接与必要时自动配置的实际日志。原先已通过且与本轮无关的播放行为不重复测试。

这些人工实播结果尚待用户执行；代理继续核对实际日志，不把模拟通过写成实播通过。
