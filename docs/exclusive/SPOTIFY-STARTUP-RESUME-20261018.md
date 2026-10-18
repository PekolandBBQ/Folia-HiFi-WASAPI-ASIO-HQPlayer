# Spotify 启动后底部首次续播修复（2026-10-18）

## 证据与原因

本轮用户明确入口为“底部播放按钮继续上次歌曲”。最新运行记录包含恢复 Somniomancer (Null Set)、旧桥接重启和新桥接握手成功，没有对应的歌曲播放请求。

代码中，暂停恢复 Spotify 故意不生成跨进程不可复用的音频会话；已有恢复控制器可在显式 Play 时重新准备，并保留检查点。但 buildPlayerViewFlags 仅以 audioSrc 判定底部按钮是否可用，遗漏这种已选歌且尚无会话的状态。启动自动连接独立执行，不能视作歌曲点播已发出。

## 改动

- 恢复的 session-bound 歌曲可使用底部播放按钮，复用既有恢复请求；无歌曲、其他音源和舞台禁用规则保留。
- 补齐底部续播入口、会话准备、准备结果日志，仅记录歌曲 ID、状态与播放意图。
- 共享 Spotify 启动过程对全部等待调用者发送进度，后加入者接收当前阶段。
- 左下角显示“正在加载 Spotify”“正在与 Spotify 建立握手”“Spotify 握手成功”。未测量阶段不伪造百分比。
- 后台启动进度不覆盖歌曲准备进度；成功可短暂显示，不添加播放等待。
- 已连接但播放器初始化暂时拒绝 snapshot 时进入既有等待流程；能力握手未确认时不报告成功。

## 验证

- Node 生命周期/退出测试：4 通过。
- Vitest 六文件：56 通过；随后增加首次续播回归并重跑 transport 文件：16 通过（合计不同用例 57）。覆盖空会话显式续播、保存位置、暂停取消、改选歌曲、旧任务失效、自动连接和进度描述。
- Playwright 真实进度组件中文显示：1 通过。模拟状态，不是本机 Spotify 实播。
- TypeScript 类型检查与桌面 renderer 构建通过。
- 复用上一候选原生组件；未重新安装、未执行 backup、未变更用户配置或备份、未关闭运行程序、未发布。
- 本机实际出声由用户重开候选后验证，尚不宣称实播通过。

## 候选路径

C:\Users\Pekora\Documents\ChatGPT\Folia\artifacts\Folia-HiFi-r4-startup-resume-20261018\win-unpacked\Folia-HiFi-WASAPI-ASIO-HQPlayer.exe

建议保持 Spotify 预先运行，关闭旧 Folia 后打开候选，只按底部播放按钮一次，观察连接阶段与续播。日志仍在 %APPDATA%\Folia HiFi\logs\runtime。
