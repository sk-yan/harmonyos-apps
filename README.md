# 鸿蒙应用合集

[![CI](https://github.com/sk-yan/harmonyos-apps/actions/workflows/ci.yml/badge.svg)](https://github.com/sk-yan/harmonyos-apps/actions/workflows/ci.yml)

集中维护个人开发的 HarmonyOS 应用：每个 App 有独立源码、使用说明和版本发布记录，后续应用继续加入这个仓库。

## 应用目录

| 应用 | 用途 | 当前版本 | 运行状态 | 入口 |
| --- | --- | --- | --- | --- |
| 一笔记账 | 本地记账、微信/支付宝账单导入、截图辅助录入 | `1.1.0-preview.1` | 开发预览；公共包未签名；真机基础检查 | [源码与功能](apps/yibi-ledger/) · [版本发布](https://github.com/sk-yan/harmonyos-apps/releases/tag/yibi-ledger-v1.1.0-preview.1) |

**当前为开发预览版，公开下载的 HAP 未签名。** 开发测试使用 HarmonyOS 6.1.0（API 23）、Mate X5 折叠屏模拟器；各版本实际完成的检查见[验证说明](docs/VALIDATION.md)。Release 附件用于开发和模拟器测试，已在 Mate X6（API 24）完成本地调试签名、安装启动及部分 GBK 导入检查；完整真机回归和图片 OCR 仍待完成。个人调试签名包不公开分发。GitHub 发布不等于手机可直接安装或应用市场上架。

## 一笔记账

记录收入和支出，按月查看结余与分类统计；可编辑、删除账单，并在本机保存。展开时使用双栏布局，窄屏通过录入面板记账。

1.1 新增微信/支付宝 CSV、XLSX 账单导入，先预览、核对再保存；可识别重复、提醒退款与转账、撤销最近一次导入。截图可通过本机文字识别或粘贴文字填入草稿，金额、日期和收支方向确认后才入账。另加入月份直达和导入过程中的草稿保护，详见[使用说明](apps/yibi-ledger/)与[审阅后的改进记录](docs/IMPROVEMENTS-1.1.md)。

原生图片 OCR 使用系统能力，官方不支持在模拟器验证，Mate X6 真实图片识别尚未验收；模拟器可使用粘贴文字入口。

<p>
  <img src="apps/yibi-ledger/docs/screenshots/phone-empty.png" width="235" alt="一笔记账窄屏空账本界面" />
  <img src="apps/yibi-ledger/docs/screenshots/phone-sample.png" width="235" alt="一笔记账窄屏测试账单界面" />
</p>

<details>
<summary>查看折叠屏展开后的统计界面</summary>

![一笔记账在折叠屏模拟器中展开后的月度统计与双栏界面](apps/yibi-ledger/docs/screenshots/unfolded-statistics.png)

</details>

截图来自实际鸿蒙模拟器，展示的是测试账单；应用初次启动为空账本。数据保存在当前应用沙箱中，浏览器预览另存一份独立账本。当前没有账号、云同步或数据导出，卸载或清除数据会删除本机账目。1.1 可读取旧版账本；使用导入功能后应避免降级，旧版保存时会丢失导入身份信息。

## 在电脑上预览

安装 Node.js 24 或更新版本，在仓库根目录执行：

```bash
npm ci
npm run dev --workspace @harmonyos-apps/yibi-ledger
```

打开终端显示的本地地址，默认是 `http://127.0.0.1:5186/`。浏览器预览用于体验交互，不是鸿蒙安装包。

```bash
npm test
npm run typecheck
npm run build:preview
```

原生开发使用 DevEco Studio、HarmonyOS SDK 和官方 CLI，见[一笔记账构建与安装说明](apps/yibi-ledger/docs/INSTALL.md)。CI 检查账务核心、构建辅助脚本、TypeScript、浏览器打包和交互，不能证明原生构建、签名或真机运行通过；各层边界见[验证说明](docs/VALIDATION.md)。

## 目录与后续应用

```text
apps/
  yibi-ledger/       一笔记账的原生工程、预览和测试
apps.json           应用名称、路径、版本与验证状态
docs/               添加应用、发布和验证说明
scripts/            仓库级开发与原生构建工具
templates/          发布说明模板
```

新应用放入 `apps/<app-id>/`，分别维护包名与版本，使用 `<app-id>-v<version>` 标签发布。无需为每个新 App 再建一个仓库。参见[添加新应用](docs/ADDING_AN_APP.md)、[版本发布规范](docs/RELEASES.md)和[发布说明模板](templates/release-notes.md)。

本仓库暂未选定源代码许可证；发布到 GitHub 不等于授予开源许可证。开发流程参考[鸿蒙 6 Codex 指南](https://github.com/luweisong-R/harmonyos6-0exp-guide-codex)，原生 API 与工具使用以华为官方资料为准。
