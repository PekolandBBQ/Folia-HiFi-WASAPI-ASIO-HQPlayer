# r4 主页界面截图

2026-10-13 整理。除 HQPlayer 设置图外，截图来自提交 `8def76679cca20a2f0752bbb1297a37dea52f18c` 的完整 Folia 与已构建 renderer，使用独立复制的既有验收资料。HQPlayer 设置图由当前 React 设置组件离线渲染，组件安装状态为展示样例；没有操作本机 HQPlayer 或音频设备。没有重新安装组件、运行 Spicetify backup/apply 或覆盖原配置与备份。

| 文件 | 内容 |
| --- | --- |
| spotify-setup.png | 本机实际检测的 Store Spotify、固定组件组合、一键安装与配置、首次驱动安装重启说明 |
| spotify-library.png | 既有本机资料中的已点赞歌单九宫格与已加载曲目入口 |
| spotify-exit.png | 本轮关闭 Folia 后实际显示的后台 Spotify 退出询问 |
| native-output.png | 本机枚举的 WASAPI 输出与 XingCore ASIO 驱动 |
| integer-mode.png | 整数处理、Spotify PCM 预缓冲和音频链路显示设置 |
| streaming-output.png | 本轮短时 Spotify 播放中的实际 PCM32 流式处理、44.1 kHz / 32-bit 接收格式与 WASAPI 输出 |
| hqplayer-settings.png | 独立 HQPlayer 组件、后台静默启动、DSP 默认设置与普通输出选择 |

本机图片为原始窗口截图，未替换界面文字或状态。流式截图来自为拍摄进行的一次短时播放，其余为设置、已有歌单和退出提示；HQPlayer 设置图为离线界面渲染。本轮没有运行测试或实播复测。这些图片不证明全新安装、其他音源边下载边播放、全套恢复或性能通过。具体结论沿用 [验证记录](../../VALIDATION.md) 的日期与组件版本；三秒目标和偶发 Seek 继续保留观察。
