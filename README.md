# RPGManager-Core

RPGManager 桌面端与安卓端共用的 CommonJS 模块。

## 引用

作为 git submodule 放在项目根目录 `core/`：

```bash
git submodule add git@github.com:DearXuan7392/RPGManager-Core.git core
```

```js
const core = require('./core');
```

## 导出函数

- 解密：`decrypt`、`decryptAudio`、`sniffMime`、`decryptedName`、`isEncrypted`、`isEncryptedImage`、`isEncryptedAudio`、`isEncryptedPath`
- 游戏：`scanGames`、`readGameInfo`、`findTitleImage`、`resolveCoverFile`
- 批量任务：`decryptImages`、`cloneDecryptedGame`
- 存档：`listSaves`、`backupSave`、`backupSaveName`、`decodeSave`、`encodeSave`
- 资源：`mimeOf`、`altExtensions`
- HTML：`injectHtml`、`buildInjectSnippet`

常量：`ENCRYPTED_IMAGE_EXTS`、`ENCRYPTED_AUDIO_EXTS`、`ENCRYPTED_EXTS`

## 测试

```bash
npm test
```
