# 添加新应用

每个应用放在独立的 `apps/<app-id>/` 目录中，单独构建、测试和发布；共享的开发工具放在仓库根目录。

## 1. 建立应用目录

为应用选一个稳定的小写英文 ID，以连字符分隔，例如 `habit-notes`。在 `apps/habit-notes/` 创建独立 DevEco 工程，至少保留以下内容：

```text
apps/habit-notes/
  AppScope/            包名、原生版本和应用资源
  entry/               应用模块
  hvigor/              构建配置
  build-profile.json5
  code-linter.json5    原生检查配置
  hvigorfile.ts
  oh-package.json5
  README.md            功能、限制、运行状态与入口
  docs/INSTALL.md      开发环境和安装说明
  docs/screenshots/    脱敏后的应用截图
```

从已有应用复用结构时，必须更换包名、名称、图标、业务逻辑和存储约定。不要把“一笔记账”的测试结果、适配结论或版本记录复制成新应用的验证结果。

如需浏览器预览，可另加 `preview/`、`tests/` 和 `package.json`。包名采用 `@harmonyos-apps/<app-id>`，设置 `private: true` 避免误发 npm。使用该应用实际需要的 `dev`、`test`、`typecheck` 与 `build:preview` 命令；新增依赖后在根目录更新并提交 npm 锁文件。

## 2. 登记应用信息

在根目录 `apps.json` 的 `applications` 数组追加一项，字段含义如下：

| 字段 | 内容 |
| --- | --- |
| `id` | 稳定的应用 ID，与目录名一致 |
| `name` | 显示名称 |
| `path` | 相对仓库根目录的源码路径 |
| `bundleName` | HarmonyOS 应用包名，应用间不能复用 |
| `nativeVersion` | `AppScope/app.json5` 中的 `versionName` |
| `releaseTag` | 对应应用的 Git 标签，如 `habit-notes-v0.1.0-preview.1` |
| `status` | 如 `in-development`、`simulator-preview`、`device-preview` 或 `released` |
| `signed` | 本次发布的 HAP 是否有有效签名，不等于签名适用于所有设备 |
| `physicalDeviceTested` | 本次版本是否在真实设备完成了已记录的验收 |
| `description` | 一句话说明实际功能 |

如尚未发布，`releaseTag` 写 `null`；不要提前链接不存在的 Release。同步更新根 README 的应用表，并在应用 README 中记录具体模拟器、真机型号、系统版本、验收范围和仍未解决的问题。

## 3. 验证后发布

从仓库根目录运行适用的检查：

```bash
npm ci
npm test
npm run typecheck
npm run build:preview
```

为新应用准备原生工程副本或调用 CLI 时，把示例中的应用 ID 替换为实际 ID：

```bash
python3 scripts/native_project.py habit-notes
python3 scripts/deveco.py habit-notes build --modules entry --build-mode debug
```

原生脚本先检查应用目录与构建环境。需要额外输入文件或模块时，应先检查脚本是否覆盖这些输入，再构建并核验产物。不要直接编辑自动生成的构建副本。

根据[验证说明](VALIDATION.md)分别记录核心测试、预览、原生构建、模拟器和真机结果，再依照[发布规范](RELEASES.md)创建该应用的版本。截图只使用测试数据；证书、私钥、签名描述文件、密码、个人账本和本地工具目录不进入版本库。
