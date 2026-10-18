# Spotify 首次冷启动恢复候选（2026-10-18）

状态：本地候选已装配，未发布、未提交 PR。真实播放由用户关闭旧版后手动重开验证。
候选：C:/Users/Pekora/Documents/ChatGPT/Folia/artifacts/Folia-HiFi-r4-cold-recovery-20261018/win-unpacked/Folia-HiFi-WASAPI-ASIO-HQPlayer.exe

## 证据与修复
2026-10-18 21:28 首次《浸春蕪》请求先出现 EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN，随后 ORIGINAL_ENDPOINT_UNSAFE，被冷启动包装为 BOOTSTRAP_IDENTITY_UNCONFIRMED，错过只接受 route-inspect 原错误的孤立路由恢复。第二次点播进入恢复后准备及 PCM 发布成功。原日志未给出具体端点条件，不能断言是哪个设备或 HQPlayer 导致。

- 冷启动遇到非等待类原生错误直接保留原错误和阶段；控制器的错误投影也保留组件已定义的路由错误。
- 初始和冷启动检查共用 prepareWithOrphanRecovery：现有清理完成后，按既有恢复记录恢复，再准备。未取消进程身份、暂停/清理、原策略验证；恢复失败不盲目重播。
- 音频进程等待类失败接入已有共享预算：初次尝试加最多三次重试；新请求、切源、输出切换、退出可取消旧重试。未知、身份冲突和限流不自动重放。
- ORIGINAL_ENDPOINT_UNSAFE 新增端点状态、流方向、角色、显式/默认、是否目标端点、策略是否匹配及具体拒绝条件，贯穿原生投影、普通运行日志 SpotifyRouteEndpoint 和诊断导出。
- 切换音源无退出询问，保留 Spotify。Spotify 连接设置新增退出 Folia 时自动退出 Spotify，默认 false；偏好存入独立 desktop-preferences.json，关闭时按所选安装和新鲜 PID/启动身份处理。
- 音频链路显示从 HQPlayer 和 WASAPI 卡片内移到同级独立章节，沿用原显示偏好，不依赖组件安装状态。新增开关接入命令面板及中英印尼文。

## 验证
- Node 冷启动、恢复、重试、退出偏好 35 项通过。
- 控制器、历史冷启动记录、设置导航 Vitest 195 项通过。
- Windows 原生组合 111 项通过（包含只读接口探针，不是实播）。
- 原生服务 52 项通过。
- 本次相关日志投影/导出 3 项通过，包括新增端点条件。
- Playwright 真实设置组件 1 项通过：默认关闭、保存和重新挂载、独立音频链路开关。
- TypeScript、桌面 renderer 构建、原生单文件发布通过。候选包代码/中文设置存在，路由 helper hello 支持本机接口。
- 曾执行较宽诊断导出测试，其中两项因 Windows 符号链接权限 EPERM 未进入断言；保留 build/cold-node-tests.log，不宣称该组全过。缩到此次相关投影/导出用例后通过。
- 初次设置组件测试的重挂载方式重新导航导致测试种子清空 localStorage；改为同页卸载/挂载后通过。产品磁盘偏好另有独立生命周期测试。

日志：build/cold-{node-targeted,vitest,route-tests,service-tests,diagnostic-tests,ui-tests,recovery-typecheck,renderer-build,route-publish,assembly,candidate-hello}.log。
候选从现有安装载体复制到新目录，再装配当前 renderer/主进程代码及新路由组件。未覆盖现有安装，未结束用户程序，未改用户配置或备份，未重跑 backup。打包生成组件所需元数据，没有额外人工校验值核对。

