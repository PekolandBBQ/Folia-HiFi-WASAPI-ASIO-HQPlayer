# RFC 草案：可选 Windows 原生音频组件 v1

状态：本地原型，未提交／未获得维护者批准。对应 [维护者意见](https://github.com/chthollyphile/folia-major/issues/353#issuecomment-5845948009)。功能和验证结果见 [使用说明](windows-native-audio.md)。

## 职责边界

| 部分 | 所在位置 | 责任 |
| --- | --- | --- |
| 驱动进程 | 独立组件仓库 | .NET/NAudio、设备枚举、格式协商、PCM 输出、增益、播放时钟；独立构建/版本/许可 |
| Electron 接入 | Folia 主仓库 | 固定清单、可选安装、校验、进程监管、会话/临时文件、完整下载在线音源、调用主程序 FFmpeg |
| 前端接入 | Folia 主仓库 | 现有本地库/在线音源解析、播放器适配器、原生设置、歌词进度、可选信号路径 |
| FFmpeg | 官方 folia-ffmpeg-build | 裁剪版追加 pcm_s24le/pcm_s32le，不携带第二套 FFmpeg |

组件和上述接入代码由本贡献方向的维护者一起负责。独立进程不等于无需适配主程序：本地库、automix、媒体事件或数据结构改变时仍需回归。

在线路径不改变组件的本地 PCM 协议：渲染进程把现有解析流程选中的 HTTP(S) URL 或缓存 blob 交给可信 IPC，宿主完整下载/暂存（2 GiB 上限）后再解码（WAV 4 GiB 上限）。准备成功前不调用播放；下载失败、停止或切歌不加载部分文件。组件没有账号、Cookie、提供商接口或网络下载职责。此方案依赖原流程提供可直接读取的音频 URL/缓存，不新增 DRM 解密或 Spotify/Apple Music 接入。

## 进程协议

传输：UTF-8 JSON Lines，stdin 请求，stdout 响应/事件，stderr 诊断。一个 STA 线程串行处理 COM/ASIO 命令；音频回调不执行进程管理。

```json
{"id":1,"action":"hello","protocolMajor":1}
{"id":1,"ok":true,"result":{"protocolMajor":1,"componentVersion":"0.1.0","capabilities":["local-pcm","integer-pcm","replaygain","format-telemetry"]}}
```

每次建立组件连接先验证主版本、组件版本和所需能力。协议 v1 可以追加可选字段，不能改变既有字段语义或单位；破坏性变更必须升级主版本，主程序拒绝不认识的版本。

| 命令 | 字段与行为 |
| --- | --- |
| devices | 无会话；返回 WASAPI/ASIO 名称和设备 id |
| load | session、绝对本地 PCM WAV path、backend、deviceId、processingMode；只准备/探测，不立即播放 |
| play / pause / stop | 必须匹配会话；暂停释放输出；stop 不触发自然结束 |
| seek | position，秒；夹在当前时长内，重新基准化时钟 |
| volume | 线性 0–1；支持静音 |
| replaygain | 线性 0–16；来自 Folia 既有 ReplayGain 计算，结合软件音量 |

响应为 `{id,ok,result}` 或 `{id,ok:false,error}`。错误文本仅用于显示；是否释放引擎根据命令类型及会话归属判断，不匹配错误字符串。load 或当前会话的 play/pause/seek 失败可释放部分初始化资源；枚举/增益/版本/旧会话错误不停止当前播放。

状态事件包含 session、position/duration（秒）、playing/ended、sampleRate（Hz）、channels、latency（秒）、backend/deviceId、processingMode/outputFormat、volume/replayGain/effectiveGain。`sampleValuesPreserved` 只描述准备后的整数 PCM 在软件输出提供器中的单位增益复制，不能据此推断源解码和 DAC 的逐位一致。

源文件编码/采样率/位深由宿主读取并补充到遥测；解析失败不阻止播放，但显示未知。高频播放时间不写入 React 的信号路径 store；仅格式/增益变化更新该面板。

## 安装、更新与停用

1. Folia 内置受审查的固定版本清单：版本、win32-x64、协议主版本、HTTPS URL、SHA-256。不从网络发现 latest，也不接受渲染进程提供任意下载 URL。
2. 独立可选 CI 从该清单获取、校验和握手；原型清单为空时显式输出 PENDING，不假装完成生产验证。清单审核与发布策略需维护者确认。
3. 用户在原 Folia 的设置里按需安装。主进程限长下载，限制解压大小与扁平文件名，检查归档哈希及包内版本/协议；完整验证后才切换激活指针。
4. 更新失败保留旧激活版本。安装/停用需要先切回浏览器后端；旧版本目录保留以便恢复，当前“停用”不等于清理全部磁盘文件。
5. 普通 Folia 包、应用标识、音乐库和更新通道不变，不引入 .NET SDK 构建依赖。组件缺失/不兼容时无法开启原生播放，但浏览器仍可用；原生播放错误不静默回退到可能不同响度的其他后端。
6. 本地开发可用环境变量指定固定开发清单；打包后的应用不接受这一覆盖，也不接受清单里的 localPath。

## 首阶段审查范围

Windows x64、本地文件及在线音源完整准备后播放、WASAPI 独占/ASIO、基本控制/歌词、ReplayGain、可选整数模式、可选信号路径。不承诺 DSD、DoP、HQPlayer 或其他系统的原生驱动。Linux/macOS 继续原有后端，未来若扩展，应增加对应平台实现而非向所有平台强塞 Windows 后端。

工程上保留 ReplayGain 和音量优先于强行“直通”：关闭整数模式不改用户 ReplayGain 偏好；开启整数模式也不跳到最大音量。整数增益使用 Q16，超过范围饱和保护，存在量化与剪裁的可能。此模式不作为无条件的音质提升保证。

## 正式提交前仍需确认

- 独立组件仓库归属、公开发布/签名流程、组件清单批准及分发方式。
- 官方 FFmpeg 合并并发布 PCM24/PCM32 编码后，更新 Folia 已有 FFmpeg 固定版本/哈希；当前发布版不能直接开启此原型。
- 接入代码的审查边界、是否将两个可选开关同批审查；若需拆 PR，保持依赖顺序而非一次提交全部自用功能。
- 主线回归安排和兼容性问题收集。当前只实测 XingCore，其他设备须独立验证。
- 本地通过不等于跨平台/公开 CI 通过；此轮没有发布任何远程改动。
