# r37 测试迁移记录（2026-10-13）

这些 `.txt` 文件是迁移前的测试原文，供审计和历史对照，不进入当前单测收集。原始失败日志保留在本机证据目录。当前基准是 r2 最终包的 Wrapper 实现与用户确认需求。

- `desktopColdBootstrap.test.ts.txt`：旧 HTTP 自动静音、音量回读与恢复流程已退役，64 项旧测试退出当前验收。设备、曲目、授权和取消保护继续由 `desktopPlaybackControl`、`ownedRoute*`、`cableAudioPreparation*` 和 `spicetifySource.integration` 的有效用例覆盖。
- `desktopColdRecovery.test.ts.txt`：原 24 项改为 11 项历史记录检查，验证不访问 Spotify、不更改音量、不删除旧 receipt，以及区分未知播放操作与历史音量操作。
- `cableSetup.test.ts.txt`：退役两个旧音量恢复用例和五个同流程参数用例。其余配置、观察和错误检查保留；模拟文件与厂商路径使用宿主路径规则。
- `useSpotifyConnection.test.ts.txt`：淘汰六项旧四步向导操作，保留六项有效状态/所有权检查，增加三项 Wrapper 完成、撤销就绪和关闭后的迟到响应检查。
- `r11IndependentUi.test.ts.txt`：淘汰七项旧向导布局和操作断言，保留门户动画与公开封面测试；新的 `spotifyDesktopGuide.test.ts` 共 11 项覆盖当前组件向导、桌面/Store 选择、安装/配置顺序、重启、实际默认输出指导、重试、完成、门户和键盘焦点。
- `privateDevelopment.test.ts.txt` / `pauseResponseInspection.test.ts.txt`：三项依赖真实符号链接权限的旧私有诊断测试退出本地验收；未因这些测试改变运行时保护。
- `spotifyQueueReadOverlap.integration.test.ts.txt`：旧测量实验依赖外部模型、另一台 Linux 的工具路径与本机专用 .NET 桥，之前未执行任何测试。退出可移植发行验收；不是已通过的用例。队列、取消与播放时序继续采用仓库内现行单测。若将来恢复该实验，需要独立、可移植的夹具。

另修复缺失的 `sharedRouteHarness.cjs` 引用，将 Wrapper 夹具纳入仓库，`spicetifySource.integration.test.ts` 的六项实层模拟测试现在实际执行通过。HQPlayer 别名夹具补齐 pause/stop 接口；取消操作断言采用当前 AbortError 契约。

路径修正后的 `cableBaseEndpointBoundary` 保留原有有效断言；先前默认确认状态差异是模拟配置未读到造成的，修正路径后消失。`cablePostProbeLifecycle` 八项全部保留并执行通过。旧 125 项统计属于迁移前的测试口径，不能与新口径直接按净减少数比较。

最终结果：616 个文件通过，1 个原有跳过文件；7024 项通过，0 项失败，2 项原有跳过，无未处理错误。类型检查通过。此结果是设备外工程检查，真实播放证据保留原版本与日期。
