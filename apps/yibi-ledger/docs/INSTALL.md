# 构建、模拟器与真机安装

一笔记账使用 ArkTS + ArkUI，当前原生版本为 `1.1.0`、版本码为 `1001000`，包名为 `com.shengkun.yibiledger`。公开附件为未签名开发预览。在 Mate X6（API 24）已完成本地调试签名、安装启动和部分 GBK 账单检查；完整真机回归和图片 OCR 尚未完成。个人签名材料与签名包不公开分发。

## 开发环境

开发使用 macOS Apple Silicon、DevEco Studio 26.0.0.821 及配套 SDK 26、Node.js 24。模拟器系统为 HarmonyOS 6.1.0（API 23），设备使用 Mate X5 折叠屏模板。这不是 Mate X6 真机测试；本次最终验收状态见[验证说明](../../../docs/VALIDATION.md)。

项目配置的最低兼容和目标 SDK 为 `6.0.0(20)`；该工程配置、SDK 工具包编号和手机设置中的系统版本含义不同。迁移到其他工具版本时，应以实际原生构建和运行结果为准。

从[华为 DevEco Studio 页面](https://developer.huawei.com/consumer/cn/deveco-studio/)安装适合自己电脑的官方版本，按官方安装器完成 SDK 和模拟器组件配置。下载、镜像与账号条款按华为提示处理；此仓库不分发 IDE 或系统镜像。

仓库的 `scripts/deveco.py` 调用本机已有的官方 `devecocli`，按以下顺序查找：

1. 环境变量 `DEVECO_CLI_BIN` 指向的 CLI。
2. 仓库内 `.tools/deveco/node_modules/.bin/devecocli`。
3. 系统 `PATH` 中的 `devecocli`。

使用非默认安装位置时，通过 `DEVECO_CLI_STUDIO_PATH` 指定 DevEco Studio 路径。CLI、SDK 和工具缓存均由开发者在本机配置，不提交到仓库。

没有 CLI 时，可在仓库根目录安装本次验证使用的版本；此命令只安装命令行工具，不包含 Studio 或 SDK：

```bash
npm install --prefix .tools/deveco --no-save --ignore-scripts @deveco/deveco-cli@1.3.0-stable
```

辅助脚本需要 Python 3.9 或更新版本。macOS 会检测常用 Studio 安装目录；使用独立 Command Line Tools 时设置 `DEVECO_CLI_CLT_PATH`。原生交互测试中的 HDC 可通过 `HDC_BIN` 指定。原生构建副本默认放在系统临时目录，必要时设置 `HARMONYOS_BUILD_ROOT` 为只含英文字符的路径。

## 构建原生 HAP

以下命令均在仓库根目录执行：

```bash
python3 scripts/deveco.py yibi-ledger build --modules entry --build-mode debug
```

部分 Hvigor 版本不接受包含中文的工程路径。仓库脚本会先准备可用于原生构建的 ASCII 路径副本，再调用官方 CLI；查看副本位置可执行：

```bash
python3 scripts/native_project.py yibi-ledger
```

日常源码仍在 `apps/yibi-ledger/` 修改，构建副本用于工具运行。脚本会检查受管理文件的内容；如发现副本中有手动修改或新增签名配置，应先检查差异并妥善保留，不要强制覆盖。

新产物位于脚本输出的工程副本下：

```text
entry/build/default/outputs/default/
```

以本次成功构建得到的产物为准，不要把旧 HAP 当作当前提交的结果。`unsigned` 表示未签名：该类包已经在测试模拟器运行过，仍不能据此判断 Mate X6 可直接安装。

## 运行模拟器

在 DevEco Studio 的设备管理界面下载适用的 HarmonyOS 镜像、创建并启动模拟器。参考[华为模拟器说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-emulator-command-line)，使用自己的实例与设备标识。

从仓库根目录列出实例和连接设备：

```bash
python3 scripts/deveco.py yibi-ledger emulator list --format json
python3 scripts/deveco.py yibi-ledger device list
```

模拟器完成启动、解锁和首次引导后，将下面的占位设备标识替换为 `device list` 返回的实际值：

```bash
python3 scripts/deveco.py yibi-ledger run --module entry --device '<device-id>'
```

只有实例停止时才启动，避免重复创建。启动超时需结合模拟器画面、连接状态和日志判断；不要为普通连接问题清除数据或重置实例，以免删除账本。

应用按可用宽度适配：达到 680vp 时显示账本与录入双栏，窄屏使用录入面板。验收时检查新增收支、月份切换、统计、编辑、删除确认、关闭重开后的数据，以及保留草稿时折叠和展开的行为。

自动原生交互测试位于 `tests/native_ui_test.py`。运行前先阅读脚本的环境参数，并使用已解锁、已完成输入法引导的专用测试模拟器和空账本。测试会创建、编辑、删除带 `YIBI_TEST_` 标记的账单，不适合直接对日常账本运行。

## 文件导入与 OCR 环境

1.1 支持 UTF-8 / GBK CSV、普通未加密 XLSX 和带表头的粘贴文本。每个文件最多 8 MiB、5,000 笔明细。表格解析保留交易单号原始字符串，不执行公式；外层 ZIP 请先解压，不支持旧 XLS 或加密表格。使用[合成测试文件](../tests/fixtures/import/)时，请勿混入真实个人账单。

原生文件选择和解码使用系统 API，OCR 使用 Core Vision Kit。**系统 OCR 不支持模拟器。** 在模拟器中可以验证文件导入、粘贴识别文字、字段核对和保存，但不能将这些结果当作真实图片识别通过。真实手机需分别检查截图选择器、OCR 服务可用性、识别准确性、取消操作与草稿保留。

浏览器预览通过同源资源加载识别脚本、中英文模型和 WebAssembly，在本机执行 OCR，不调用外部图片识别服务。先在仓库根目录运行 `npm ci`，再启动预览；相关第三方说明见[浏览器依赖说明](../preview/THIRD_PARTY_NOTICES.md)。浏览器与原生使用相同的账单解析、去重和文字草稿逻辑，但两端的文件选择器与 OCR 引擎需要分别验收。

## 安装到 Mate X6

真机安装还需要 HarmonyOS 认可的签名与设备调试环境，不能把未签名 HAP 当作普通下载即装的安装包。下面是自行构建的完整流程；本次已完成签名、安装与基础检查，完整功能验收仍待完成：

1. 按[华为真机运行说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-run-device)启用开发者模式与 USB 调试，使用支持数据传输的线连接电脑，在手机和电脑上允许必要的连接提示。先确认 `device list` 能识别该手机。
2. 在 DevEco Studio 打开脚本生成的 ASCII 工程副本并完成 Sync。IDE 界面打开与同步成功不等于已经编译或安装成功。
3. 按[华为应用签名说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing)在 **Project Structure → Signing Configs** 配置调试签名。使用本人开发者账号，由本人输入验证码与证书密码，确认包名和调试设备匹配。
4. 妥善保存 IDE 生成的本机签名配置。原始仓库的 `signingConfigs` 为空；证书、私钥、描述文件和密码不得进入 Git 版本记录。后续同步遇到副本保护提示时，先处理本机配置，再继续。
5. 选择真实手机运行 `entry`，分别确认安装、启动和功能验收。检查 Mate X6 外屏与内屏、横竖屏、输入法避让、字体放大，以及退出重开后的数据保存。

如暂时无法建立手机调试连接，可继续使用模拟器和浏览器预览。GitHub Release 负责分发源码与附件，不会自动完成真机签名或应用市场上架。

## 数据与验证边界

账本只保存在当前应用沙箱，卸载或清除应用数据会删除记录；当前没有云同步和导出。浏览器预览的账本独立保存在浏览器中。

1.1 保持 `ledger-v1.json` 格式可读，新增导入身份字段为可选字段。导入后应避免降级到 1.0：旧版保存时会丢失这些字段，影响后续重复识别。撤销最近一批导入只在当前会话有效，不能替代备份。

当前共享核心、存储模拟与 XLSX 合计 58 项测试及 TypeScript 检查通过，最终设备和浏览器验收见[1.1 改进记录](../../../docs/IMPROVEMENTS-1.1.md)。1.0 的历史基线保留在 [verification-preview.1.json](verification-preview.1.json)。此前完整 CodeLinter 的性能分析器发生内部错误，补充 ESLint 结果不能记作 1.1 全量原生 Lint 通过。
