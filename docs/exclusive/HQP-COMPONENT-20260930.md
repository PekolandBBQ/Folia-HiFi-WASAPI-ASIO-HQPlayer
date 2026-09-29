# HQPlayer 独立组件本地测试版

主程序测试版：0.7.9-preview.20260930.2。

- WASAPI/ASIO 组件：0.1.2，协议 1。
- HQPlayer 控制组件：0.1.0，协议 1。该版本不是 HQPlayer Desktop 自身版本。
- 两者分别安装、更新、停用、恢复和回退，拥有独立目录和批准清单。设置中的“HQPlayer 控制组件”显示版本及管理操作。
- HQPlayer 控制实现已从主程序源码移出，置于同级独立本地仓库 `folia-hqplayer-component`。入口经哈希与版本握手校验后运行在独立 utilityProcess；崩溃和超时不直接执行组件代码到主进程。
- 未安装 HQPlayer 组件不妨碍 WASAPI/ASIO，未安装 WASAPI/ASIO 不妨碍 HQPlayer；浏览器模式继续可用。管理正在使用的组件前需要先换输出。

专版离线包只携带审核过哈希的组件 ZIP，不包含 HQPlayer Desktop。原有加载进度、兼容模式、单实例确认和默认前台启动继续保留。

上游接入说明见 `docs/hqplayer-component-rfc.md`：主仓库只有接入及设置、独立版本与稳定接口、固定候选与官方镜像 CI、保留兼容旧版本、错误码及回退。普通上游入口没有随包安装逻辑，不更换应用标识或音乐库。

本轮未更新 GitHub，未创建远程仓库或正式 Release；官方组件候选和下载清单仍为空，不能把本地离线批准当作上游批准。

本轮已执行：主程序类型检查，全量 4084 项单测（1 项原有跳过），独立组件 20 项单测，25 项组件界面测试。

完整依赖安装：主程序在干净目录执行 `npm ci` 通过（1145 个包）；HQPlayer 独立组件在干净目录执行 `npm ci`、20 项单测和构建通过（46 个包）；同步服务器完整 `npm ci` 及 `build:node` 通过（45 个包），没有使用 `--ignore-scripts`。按照用户授权安装了 Microsoft Visual Studio 2022 Build Tools 的 C++ 工作负载及 Windows SDK；为 node-gyp 指定已有的 Python 3.12.14。`better-sqlite3` 原生模块编译、加载、内存数据库建表、写入和查询均通过，SQLite 版本 3.53.4，Node 24.21.0。

安装遵循项目现有 npm 脚本许可规则：npm 对未列入 allowScripts 的包仍会提示阻止脚本；未扩大上游脚本权限。同步服务器 audit 报告 2 个 moderate、3 个 high 依赖告警，未擅自升级锁文件。该安装验证不等于已通过远程上游 CI。

HQPlayer 构建规范化了 Windows 依赖目录联接产生的路径注释；干净安装与开发目录构建生成相同 ZIP，SHA-256 为 `ae6c0258200c9d0cbc94b23378faf402a87ad05b7496783482984aaeb20d552a`。

打包 EXE 已验证：两组件版本分别为 0.1.2 和 0.1.0；停用 HQPlayer 后 WASAPI/ASIO 仍可用，重新安装 HQPlayer 成功；停用 WASAPI/ASIO 后 HQPlayer 仍可用；真实独立进程握手、HQPlayer Desktop 单实例连接与 DSP 列表读取通过。此轮不播放实际音乐，不扩展为新的 DAC/流媒体兼容性结论。
