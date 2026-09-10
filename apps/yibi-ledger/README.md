# 一笔记账

面向个人日常使用的 HarmonyOS 本地记账应用，使用 ArkTS + ArkUI。可记录收支、修改账单、按月查看结余和支出分类，并适配窄屏与折叠屏展开布局。

[版本发布](https://github.com/sk-yan/harmonyos-apps/releases/tag/yibi-ledger-v1.0.0-preview.1) · [构建与安装](docs/INSTALL.md) · [返回应用目录](../../README.md)

**当前为 `1.0.0-preview.1` 模拟器预览版，HAP 未签名。** 原生应用版本为 `1.0.0`；已在 HarmonyOS 6.1.0（API 23）、Mate X5 折叠屏模板验证。Mate X6 真机签名、安装和验收仍待完成。

## 功能

- 收入与支出、12 个内置分类、记账日期和备注。
- 月份切换、月度收入、支出、结余与支出分类统计。
- 账单修改、确认删除和未保存草稿保护。
- 可用宽度达到 680vp 时使用账本与录入双栏，窄屏使用底部录入面板。
- 金额按人民币整数分计算，本地保存成功后更新账本；读取损坏数据时暂停写入。

第一版没有账号、云同步、自动导入、预算和数据导出。原生账本存储在应用沙箱中；卸载或清除应用数据会删除账目。浏览器预览使用浏览器本地存储，与原生账本互相独立。

## 实际界面

<p>
  <img src="docs/screenshots/phone-empty.png" width="235" alt="初次启动时的空账本" />
  <img src="docs/screenshots/phone-sample.png" width="235" alt="窄屏下的测试账单和月度收支" />
</p>

<details>
<summary>折叠屏展开后的双栏与统计</summary>

![折叠屏展开后的月度统计与双栏录入](docs/screenshots/unfolded-statistics.png)

</details>

截图来自实际模拟器，样例为验收用测试账单；测试后已清空。应用默认不附带示例账目。

## 运行与检查

以下命令均在**仓库根目录**执行，需要 Node.js 24 或更新版本：

```bash
npm ci
npm run dev --workspace @harmonyos-apps/yibi-ledger
```

浏览器打开终端显示的地址，默认是 `http://127.0.0.1:5186/`。只检查本应用时执行：

```bash
npm test --workspace @harmonyos-apps/yibi-ledger
npm run typecheck --workspace @harmonyos-apps/yibi-ledger
npm run build:preview --workspace @harmonyos-apps/yibi-ledger
```

安装并配置 DevEco 环境后，构建原生包：

```bash
python3 scripts/deveco.py yibi-ledger build --modules entry --build-mode debug
```

工程复制、CLI 配置、模拟器和真机签名步骤见[安装说明](docs/INSTALL.md)。

## 验证状态

2026-09-10，合集中的工程已重新通过 20 项核心与存储模拟测试、8 项构建副本保护测试、类型检查、预览构建、9 组浏览器交互和 8 组鸿蒙模拟器验收；本次新构建的 HAP 已安装并启动。见[本次验证记录](docs/verification-preview.1.json)。CI 结果另见仓库工作流。

模拟器验收覆盖收支保存、编辑统计、月份切换、重启后的数据保留、折叠布局与草稿、确认删除。完整原生 Lint 存在性能分析器内部错误；补充 ESLint 检查未报告缺陷，不代表全量 Lint 通过。存储单元测试模拟了 HarmonyOS Kit 依赖，不能替代真实设备文件系统测试。详见[各层验证边界](../../docs/VALIDATION.md)。

## 源码结构

```text
AppScope/                         应用信息和图标
entry/src/main/ets/pages/Index.ets 原生界面
entry/src/main/ets/model/Ledger.ts 共享账务核心
entry/src/main/ets/storage/        原生本地存储
preview/                          浏览器交互预览
tests/                            核心、存储和交互验收
docs/INSTALL.md                    构建、模拟器和真机安装
```
