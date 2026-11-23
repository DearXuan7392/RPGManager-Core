# RPGManager-Core

RPGManager 桌面端与安卓端共用的纯逻辑层。它只负责计算与规则，不关心 UI、宿主环境和操作系统。

## 设计约束

- 仅使用 CommonJS + Node 内置的 `fs` / `path` / `Buffer`，Node 18+ 可用。
- 不引用 `nw.gui`、DOM、Compose、Android SDK 或任何进程级副作用。
- 只通过 `index.js` 导出公共函数；内部实现不对外暴露。
- 游戏目录以普通绝对路径传入，由调用方决定该路径来自 `games/` 还是 SAF 换算结果。

## 公共 API

| 分类 | 函数 |
| --- | --- |
| 资源解密 | `decrypt`、`decryptAudio`、`sniffMime`、`decryptedName`、`isEncrypted`、`isEncryptedImage`、`isEncryptedAudio`、`isEncryptedPath` |
| 游戏发现与元信息 | `scanGames`、`readGameInfo`、`findTitleImage`、`resolveCoverFile` |
| 批量任务 | `decryptImages`、`cloneDecryptedGame` |
| 存档 | `listSaves`、`backupSave`、`backupSaveName`、`decodeSave`、`encodeSave` |
| 资源规则 | `mimeOf`、`altExtensions` |
| HTML 注入 | `injectHtml`、`buildInjectSnippet` |

常量：`ENCRYPTED_IMAGE_EXTS`、`ENCRYPTED_AUDIO_EXTS`、`ENCRYPTED_EXTS`。

```js
const core = require('./core');

const games = core.scanGames('/path/to/games');
const info = core.readGameInfo(games[0].root);
const plain = core.decrypt(buffer, info.encryptionKey);

await core.decryptImages(games[0].root, {
  onProgress: ({ current, total }) => console.log(current, total)
});
```

`decodeSave(raw, decompressFromBase64)` 的第二个参数可选：MV 旧存档通常由游戏页面提供 LZString 解压函数，MZ 或纯 JSON 存档不需要。

## 被谁使用

- `RPGManager-Desktop`：`menu/*.js` 通过 `require('../core')` 直接调用。
- `RPGManager-Android`：仓库根目录的 `core/` 子模块由 Gradle 复制到 `assets/nodehost/core/`，内嵌 Node 的 `server.js` 通过 `require('./core')` 调用。

两端都以 git submodule 方式引用本仓库，路径固定为 `core/`：

```bash
git submodule add git@github.com:DearXuan7392/RPGManager-Core.git core
git submodule update --init --recursive
```

## 测试

```bash
npm test
```

测试覆盖解密（含无密钥兜底）、后缀映射、游戏扫描、`System.json` 读取、封面定位、存档编解码、批量解密副本以及 HTML 注入。

## 与安卓 WebView 模式的关系

安卓的「纯 WebView」模式不启动内嵌 Node，因此不能调用 Core。为保持该模式兼容，`RPGManager-Android` 的 Kotlin 侧仍保留 `RpgCrypto.kt`、`DecryptTasks.kt`、`CoverLoader.kt`、`SafRepo.scanGames` 与 `GameServer.kt` 中的同类实现。Core 是 Node 模式与桌面端的单一规则来源；Kotlin 实现是 WebView 兜底路径，不通过 RPC 依赖 Core。
