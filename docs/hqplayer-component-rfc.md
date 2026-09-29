# 可选 HQPlayer 控制组件协议 v1

状态：专版独立发布，HQPlayer 组件源码位于 [folia-hqplayer-component](https://github.com/PekolandBBQ/folia-hqplayer-component)；上游候选与批准清单保持待审查状态，尚未申请新的最小上游合入。此 RFC 依据维护者的[组件化要求](https://github.com/chthollyphile/folia-major/issues/353#issuecomment-5845948009)和[分发、版本保留与错误恢复要求](https://github.com/chthollyphile/folia-major/issues/353#issuecomment-5847747280)，于 2026-09-30 重新读取原评论核对。

## 并列的两个组件

| 项目 | WASAPI/ASIO | HQPlayer 控制 |
| --- | --- | --- |
| 独立源码仓库 | folia-native-audio-component | folia-hqplayer-component |
| 当前组件版本 | 0.1.2 | 0.1.2 |
| 协议主版本 | 1 | 1 |
| 激活及回退目录 | components/native-audio | components/hqplayer |
| 固定官方清单 | electron/nativeAudio/component-catalog.json | electron/hqplayer/component-catalog.json |
| 外部执行 | 原生驱动 EXE | Electron utilityProcess，单文件 CJS 组件 |
| 安装依赖 | 原生驱动环境 | 用户另装 HQPlayer Desktop |

两个组件互不要求对方已安装、启用或更新；两者共用宿主的文件准备、FFmpeg 和播放器适配，以及无后端状态的归档安装机制 `electron/components`。HQPlayer 组件源码、构建、XML 库、版本和发布工作流均在独立仓库。主程序只保留安装器、版本握手、进程监管、音源准备、IPC 与设置。普通主程序构建不拉取或编译组件，也不需要第二套应用、标识或音乐库。

## 消息协议与握手

运行时通过 Electron utilityProcess 的私有父子端口传递对象；独立 CI 用 Node IPC 传递相同对象。请求 `{id, action, args}`；应答 `{id, ok, result}` 或 `{id, ok:false, errorCode}`。握手使用 `{id, action:"hello", protocolMajor:1}`，返回组件 id `hqplayer`、`componentVersion`、`protocolMajor`、能力列表 `local-file/playback-control/dsp-settings/single-instance/launch-options`。宿主逐项验证后才能 initialize。

初始化只传宿主控制的 HQPlayer 路径偏好文件位置和启动显示偏好，不传流媒体账号、Cookie、登录凭据或网络音源 URL。组件不下载歌曲，不包含 FFmpeg、HQPlayer Desktop 或音频驱动。文件下载与解码失败继续由宿主既有恢复流程处理。

命令：configuration/device、checkExisting/authorizeExisting、validateExecutable/configure、setSilent、prepare、load、command、stop、shutdown、dspSettings、dispose。load 接收 session、本地绝对路径、增益和稳定歌曲标识，只准备不播放；command 支持 play/pause/seek/volume/replaygain/gain。position/duration 单位秒，采样率 Hz，gainDb 为 dB。旧 session 的命令拒绝，不影响当前歌曲。

状态通过 `{event:"state",state}` 上报；HQPlayer 状态订阅与 200 ms 查询并用，事件频率并非恒定时钟保证。状态未报告的设备、采样率等不得伪造。暂停可以释放输出，不强制规定引擎未来实现。普通命令失败不关闭整个组件；破坏性协议变更须升级主版本。

## 更新、恢复与权限边界

- 客户端不接受渲染进程传入的下载地址，不查 latest。官方清单为空，表示暂无已批准公开下载；开发目录只在开发模式允许，专版离线入口与上游默认入口隔离。
- 独立候选清单与可选工作流 `hqplayer-component.yml`：从贡献方固定版本下载，验证归档 SHA-256、入口 SHA-256、扁平路径、长度、包内身份/协议和真实隔离进程握手，再把相同字节镜像到 Folia Release。用户只从 Folia 官方 Release 下载。候选为空时发布任务失败，不能伪造通过。
- 组件安装完整验证后原子切换激活指针。更新失败保留旧版；协议兼容旧版始终保留在批准清单，新版只提示更新。磁盘保留当前与上一版本，停用可恢复。两个组件的操作、指针和错误彼此独立。
- HQPlayer RPC 期限 35 秒，覆盖 20 秒 Desktop 冷启动与载入等待。崩溃/超时终止组件并发出固定错误码，遵循现有自动回 Web 或手动重试/回退策略，不自动无限重启。回退动作按故障后端选择 HQPlayer 或 WASAPI/ASIO 的独立版本槽。
- 原始异常只进脱敏日志，UI 使用固定错误码翻译。HQPlayer 单实例授权仍位于组件内；宿主记录组件明确报告的自建 Desktop PID，组件失联时只清理由本次组件创建的实例，不关闭用户提前打开的实例；用户显式切换离开 HQPlayer 输出时则通过 shutdown 关闭全部 Desktop 实例，这是独立于崩溃清理的操作。
- 贡献方继续负责组件及接入维护、主线生命周期兼容、测试与问题处理。维护者批准、官方镜像发布、实际 PR 拆分及多硬件验证仍为后续流程；本地实现不能代替这些批准。

## 独立审查边界

HQPlayer 基础接入作为 D 单元：组件契约、安装管理、输出选择和播放适配。DSP 浮层与音频链路显示作为 D 的独立 UI 增量；WASAPI/ASIO 的 A/B/C 和专版离线分发 E 不应强制成为 D 的提交内容。当前在专版分支发布，尚未生成新的最小上游 PR。
