# 时长与原生音频边界修复（2026-10-16）

状态：本地候选，未发布，未覆盖用户配置或备份。实际设备出声待用户验证。

## 最新日志与操作

- 用户说明：首次选择歌曲后立即拖进度；第二次快速切歌。
- 北京时间 00:00:57.048 原生音频记录 CANCELLED，随后新准备 epoch 24 成功。日志本身未给出具体回调，不能单凭取消码认定所有原生报错同因。
- 00:02:22 起，播放/暂停事实预期时长 270000 ms，实际 270048 ms，均为暂停，进度 1353 ms。清理重复失败于 cleanup-source-pause。
- 新测试复现独立竞态：初次 prepare 未登记 preparing，Seek 查询尚无有效 reader 的 HQPlayer。修复前测试失败并出现 stale reader；失败记录保留 r2-duration-boundary-first.log。

## 修改

1. durationFacts.cjs 统一 1000 ms（含边界）容差。Wrapper 状态读取、采集事实和选曲后元数据刷新使用同一规则；非法时长及超过容差仍失败。
2. 采用选定歌曲的实际播放状态时长，不以刷新后的整数秒目录时长覆盖。进度按该次状态自己的有效时长检查，容许其真实暂停曲尾，不放宽到错误歌曲或越界进度。
3. 初次 native prepare 与续播 prepare 一样登记为在途工作。立即 Seek 先终止旧准备/采集，再设置新位置，不先查询未就绪的 HQPlayer reader。
4. 准备中的 Seek 保留最新 Play/Pause 意图；对待恢复的 Play 自动在新位置准备并继续播放，无需人工再次 Play。
5. 原生错误映射识别取消及 AbortError，IPC 维持取消语义；取消不再打印为原生音频故障，不把当前 live stream 标为失败/abort。真实 SOURCE_UNAVAILABLE 仍发故障事件并停止。

## 其他边界检查

- sourceLifecycleError：保留实际源故障与恢复失败，不把取消降级成未知原生错误。
- source/output 时长：用选中播放器时长作为源时长；保留原生输出位置有效范围、确认起点与 reader 身份检查。观察到的进度是时间坐标，不能直接按元数据时长容差放宽任意 Seek。
- HQPlayer/ASIO/WASAPI 格式：采样率、声道数、帧格式仍是实际 PCM 合约，不按“宽松冲突”忽略真实格式变化。
- 输出切换/退出：保留源停止、设备释放和路由恢复顺序；未删除失败清理记录，不用成功响应掩盖尚未停止的源。
- 快速替换：旧 decoder/reader 不得影响新请求；取消静默，真正错误仍可观察。
- 未重写自动重建音频管道，也未声称故障后的所有无缝恢复已验收。

## 验证

10 个相关 Vitest 文件共 353 项通过，覆盖 native service、live PCM、流会话、流传输、预缓冲、Wrapper、Spotify 控制和路由整合；TypeScript 通过。
新增：48/+1000/-1000 ms 清理与后续请求、真实曲尾位置、错歌与 1001 ms 拒绝、目录与播放器时长精度不同、取消不终止当前输出而真实错误仍终止、首次准备立即 Seek、续播准备中 Seek 保留播放意图。

证据在 spotify-r37-local/evidence：r2-duration-native-final.log、r2-duration-typecheck.log、r2-duration-assembly.log。r2-duration-targets.log 的单项失败来自模拟 control.prepare 覆盖时长，调整夹具使其返回真实精度差异后通过；不删除初始失败记录。

候选：artifacts/Folia-HiFi-0.7.19-r2-duration-seek-20261016/win-unpacked/Folia-HiFi-WASAPI-ASIO-HQPlayer.exe。

最终补充：HQPlayer 独立错误回调与退出清理回调也过滤取消；未过滤真实控制拒绝。事件回归 21 项通过（含 1 项新增），续播 Seek 保留暂停期间暂存的音量/增益设置，相关控制回归 46 项通过。以上含重复用例，不与 353 简单相加。最终组件装配记录 r2-duration-final-assembly.log，类型检查再次通过。
