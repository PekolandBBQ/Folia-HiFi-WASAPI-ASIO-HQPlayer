# Spotify 进程专属采集 r2 验证记录

日期：2026-10-15。基线：`7692e444064e7008b9aa5449b2fd3a83f106b2c9`。应用版本保留 0.7.19，fork 标签 `folia-hifi-v0.7.19-r2`。

## 实现与边界

Windows Application Loopback 绑定经路由观察确认的 Spotify 音频 PID 及其子进程，取代 VB-CABLE 端点混音采集。VB 仍用于 Spotify 路由、暂停格式保持与准备；此次不移除 VB，也不增加强制 Seek 或复杂自动重建。

采集 `0.1.5-capture.10` 宣告 `windows-process-tree-loopback-v1`；配对路由 `0.19.0-dev.27`。启动时验证能力，旧端点混音组件不得冒充进程采集。系统最低 API 构建号 20348，消费版 Windows 要求 Windows 11；不绑定本机 28000。Spicetify 2.45.3、VB-CABLE 3.3.1.7 不变，统一组合 revision 3。

进程模式不再要求系统默认输出为实体设备，不因其他应用写入 VB 而拦截。Spotify 身份、重复音频进程、格式保持器与实际输出回灌检查仍保留。原路由为跟随系统默认时，恢复原始空策略，不要求该时刻一定存在实体 DAC。

保留短缺口容错。Windows 负责准备后的进程 PCM，不能据此证明 Spotify 原始编码或源到 DAC 全链路 bit-perfect。失败信息保留 nativeCode、stage、sourceFailure，取消语义优先，界面固定错误码使用中文。

## 针对性测试

| 组 | 结果 |
| --- | --- |
| JS 路由、生命周期、采集能力、错误传播 | 173 通过 |
| Spotify 向导组件界面 | 14 通过 |
| 进程采集路由策略 | 5 通过 |
| 短缺口 | 20 通过 |
| 格式回读 | 9 通过 |
| 原生 Windows 产品组合 | 110 通过 |
| 准备目标与失败后恢复 | 14 通过 |
| TypeScript 类型检查、桌面 renderer、原生组件构建 | 通过 |

初次新增宿主环境变量后，一项测试仍按旧 spawn 参数完全相等断言而失败；修正为核对继承环境及模式值后本组 173 项通过。没有把旧全量测试结果当成本次全量通过。

## 完整应用实播

本机 Windows 10.0.28000.0、Spotify Store 版、XingCore、HQPlayer Desktop 6。通过完整打包 Folia 界面触发，以非零 PCM 交付、后端时钟推进、采集终态及路由恢复作为证据，不声称人工听感验收。

最终包候选先把 Windows 默认输出设为 CABLE Input，再播放：

| 操作 | 实际结果 |
| --- | --- |
| WASAPI 启播 | 2,494,296 帧，4,931,091 个非零样本；终态交付等于采集，队列 0 |
| WASAPI → HQPlayer | 自动续播，1,727,838 帧、3,438,751 个非零样本 |
| HQPlayer 下一首 | 从首曲切到 everscape，3,678,822 帧、7,340,100 个非零样本 |
| HQPlayer → ASIO | 自动续播；最终累计 5,691,105 帧、11,367,931 个非零样本 |
| 浏览本地页 | Spotify 继续；当前资料本地曲库为空，未执行本地实播 |
| 正常退出 | cleanupConfirmed，exactOriginalRolesRestored=true，globalDefaultsWritten=false，quit-restoration-complete |

先前同功能候选已验证 ASIO → HQPlayer，HQPlayer 中默认输出改为 VB 后持续约 199 秒，暂停停止采集而保留路由，暂停 Seek 到 35 秒后续播，以及 HQPlayer → ASIO → WASAPI。最终候选追加移除另一 VB 引脚外来声音的旧拦截并更新向导文案，完成上述最终包测试。

独立诊断：Spotify 暂停时，另一进程播放合成音，Spotify 进程采集 219,618 帧均为零。合成音所在端点的实际波形未独立采集，所以这一条仅是辅助隔离证据。

测试后 Windows 默认输出已恢复 LG TV SSCR2。原账号、配置、备份保留，没有重跑 backup、重装驱动或操作 Spotify 音量。

## 不扩大结论

- 默认回落由系统设置主动模拟；没有禁用所有其他实体输出来伪装“仅一台 DAC”的硬件环境。逻辑测试覆盖无备用实体输出的跟随默认策略。
- 当前资料本地曲库为空，没有新做本地跨源实播，也不把历史 QQ、网易云结果说成本轮重新通过。
- 没有在另一台电脑、其他 Windows 构建、官网版 Spotify 或其他 DAC 上实测。
- 三秒性能与历史偶发 Seek 继续保留观察，本轮不重新判定。
- 原始日志保留本机，公开材料仅包含筛选后的计数和恢复结果；没有附账号配置或完整私人曲库。

## ADR

选择进程采集解决默认输出回落 VB 的根因，不以“必须有第二个实体输出”作为播放条件，不自动把系统默认设备改到未知设备。该入口覆盖 Spotify 的 WASAPI、ASIO、HQPlayer，其他音源采集/解码路径不变。Windows API 不可用时明确显示系统要求，不静默退回会混入系统声音的端点采集。
