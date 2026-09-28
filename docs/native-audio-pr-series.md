# 原生音频审查拆分 / Native audio review series

完整验证版保留在 `codex/native-component-stage1`。以下三个分支仅在本地创建，尚未推送或提交 GitHub PR。独立组件源码另外保存在 `folia-native-audio-component`，最新本地提交 `faa4081`。

The complete candidate remains on `codex/native-component-stage1`. The following stacked branches are local only. The component source is maintained separately, at local commit `faa4081`.

| 顺序 | 分支 | 提交 | 将来的比较基准 | 范围 |
| --- | --- | --- | --- | --- |
| A | `codex/review-native-core` | `89dc9b8` | 上游 `d2b8467`（0.7.8） | 组件安装/版本/分发、完整准备的本地与在线播放、WASAPI/ASIO、ReplayGain、错误码、自动/手动恢复、验证工具 |
| B | `codex/review-native-integer` | `b29850a` | A | 整数 PCM 的显式开关、PCM32、能力要求、设置和相关测试 |
| C | `codex/review-native-signal-path` | `a554404` | B | 链路遥测展示、可选浮窗、响应式布局、设置和对应测试 |

基础分支没有整数模式开关和链路界面。保留的基础格式遥测用于格式信息与后续扩展，不要求用户启用展示。独立组件可同时提供额外能力，但基础宿主不要求 `integer-pcm`，也不接受整数处理请求。

Scope A neither exposes nor accepts integer processing and has no signal-path UI. It requires only base capabilities even if the component advertises additional ones.

审查命令（在本地贡献仓库中）：

```powershell
git diff d2b8467..codex/review-native-core
git diff codex/review-native-core..codex/review-native-integer
git diff codex/review-native-integer..codex/review-native-signal-path
```

正式提交前，先处理 [验证报告](native-audio-validation-report.md) 中的未完成项和发布条件。若作者先接收 A，B、C 应按顺序变基到已合入的主线，不把完整分支一次性提交成一个大 PR。没有使用强制推送或修改任何作者分支。

Before submission, address the remaining validation/release conditions. Once A is merged, rebase each follow-up onto upstream in sequence. No upstream branch or published history has been rewritten.


2026-09-28：补测及本轮修正已迁入 A，B/C 顺序变基完成。各分支的类型、单测、UI、实际 App 与 Windows 异常结果见 [后续验证报告](native-audio-validation-remaining.md)。旧快照保留在 codex/snapshot-review-*-20260927。