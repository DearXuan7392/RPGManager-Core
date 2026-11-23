'use strict';
/**
 * RPGManager-Core —— 两端共用的纯逻辑层。
 *
 * 只依赖 Node 的 fs / path / Buffer，不含 NW.js、DOM、Compose、Android API。
 * 所有对外能力都从本文件导出；内部函数不暴露。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
]);
const RPGMV_SIGNATURE = '5250474d56000000';
const HEADER_SIZE = 16;

const IMAGE_EXTS = ['.rpgmvp', '.rmmzmvp', '.png__', '.png_'];
const AUDIO_EXTS = ['.rpgmvo', '.rpgmvm', '.ogg_', '.m4a_'];
const ENCRYPTED_EXTS = IMAGE_EXTS.concat(AUDIO_EXTS);
const TITLE_EXTS = IMAGE_EXTS.concat(['.png', '.jpg', '.jpeg']);
const SAVE_EXTS = ['.rpgsave', '.rmmzsave'];

const VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1,' +
  'maximum-scale=1,user-scalable=no,viewport-fit=cover">';

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function extOf(name) {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  return dot < 0 ? '' : s.slice(dot + 1).toLowerCase();
}

function endsWithAny(name, exts) {
  const lower = String(name || '').toLowerCase();
  return exts.some(function (ext) { return lower.endsWith(ext); });
}

function toSlash(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function timestamp(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function firstJsonObject(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) throw new Error('存档内容为空');
  if (s.startsWith('{')) {
    try {
      JSON.parse(s);
      return s;
    } catch (e) {
      const tight = s.match(/^\{[\s\S]*?\}(?=\s*\{|\s*$)/);
      if (tight) return tight[0];
    }
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  throw new Error('无法识别的存档 JSON');
}

function patchSystemJsonBytes(buffer) {
  try {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const json = JSON.parse(text);
    json.hasEncryptedImages = false;
    json.hasEncryptedAudio = false;
    return Buffer.from(JSON.stringify(json, null, 4), 'utf8');
  } catch (e) {
    return buffer;
  }
}

async function walkFiles(dir, prefix, out) {
  const list = out || [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, rel, list);
    } else if (entry.isFile()) {
      list.push({ full: full, rel: rel });
    }
  }
  return list;
}

async function writeRel(root, rel, name, data) {
  const parts = toSlash(rel).split('/');
  parts.pop();
  const dir = path.join.apply(path, [root].concat(parts));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), data);
}

// ---------------------------------------------------------------------------
// 资源解密
// ---------------------------------------------------------------------------

function isEncryptedImage(name) {
  return endsWithAny(name, IMAGE_EXTS);
}

function isEncryptedAudio(name) {
  return endsWithAny(name, AUDIO_EXTS);
}

function isEncrypted(name) {
  return endsWithAny(name, ENCRYPTED_EXTS);
}

function isEncryptedPath(name) {
  return isEncrypted(name);
}

/** 加密后缀 → 明文后缀（.rpgmvp → .png / .rpgmvo → .ogg / .rpgmvm → .m4a） */
function decryptedName(name) {
  const s = String(name || '');
  const ext = extOf(s);
  const base = s.slice(0, s.length - ext.length - (ext ? 1 : 0));
  if (IMAGE_EXTS.indexOf('.' + ext) >= 0) return base + '.png';
  if (ext === 'rpgmvo' || ext === 'ogg_') return base + '.ogg';
  if (ext === 'rpgmvm' || ext === 'm4a_') return base + '.m4a';
  return s;
}

/**
 * 有密钥且是官方签名 → 异或还原前 16 字节；
 * 否则剥掉混淆头，缝回标准文件头。
 */
function decrypt(buffer, keyHex) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= HEADER_SIZE) return buffer;

  const standard = buffer.slice(0, HEADER_SIZE).toString('hex').startsWith(RPGMV_SIGNATURE);
  const validKey = typeof keyHex === 'string' && keyHex.length === 32 ? keyHex : null;

  if (validKey && standard) {
    const body = Buffer.alloc(buffer.length - HEADER_SIZE);
    for (let i = 0; i < 16; i++) {
      body[i] = buffer[HEADER_SIZE + i] ^ parseInt(validKey.slice(i * 2, i * 2 + 2), 16);
    }
    if (buffer.length > HEADER_SIZE + 16) {
      buffer.copy(body, 16, HEADER_SIZE + 16);
    }
    return body;
  }

  if (standard || buffer[0] !== 0x89) {
    const stripLen = standard ? 32 : 16;
    if (buffer.length > stripLen) {
      return Buffer.concat([PNG_HEADER, buffer.slice(stripLen)]);
    }
  }
  return buffer;
}

function decryptAudio(buffer, keyHex) {
  const out = decrypt(buffer, keyHex);
  if (out.length > 16 && out[0] === 0x52 && out[1] === 0x50) {
    return out.slice(16);
  }
  return out;
}

function sniffMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    if (buffer[8] === 0x57 && buffer[9] === 0x45) return 'image/webp';
    return 'audio/wav';
  }
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return 'audio/ogg';
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return 'audio/mp4';
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'audio/mpeg';
  if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) return 'audio/mpeg';
  return null;
}

// ---------------------------------------------------------------------------
// 游戏发现与元信息
// ---------------------------------------------------------------------------

/** 扫描游戏根目录；同时支持直接含 index.html 与多套一层 www 的情况 */
function scanGames(root, options) {
  const opts = options || {};
  const abs = path.resolve(String(root || ''));
  if (!exists(abs)) return [];

  const result = [];
  let entries = [];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(abs, entry.name);
    if (exists(path.join(dir, 'index.html'))) {
      result.push({ name: entry.name, root: dir, location: entry.name });
    } else if (opts.wwwFallback !== false) {
      const www = path.join(dir, 'www');
      if (exists(path.join(www, 'index.html'))) {
        result.push({ name: entry.name, root: www, location: entry.name + '/www' });
      }
    }
  }
  return result.sort(function (a, b) { return a.name.localeCompare(b.name); });
}

function readGameInfo(gameRoot) {
  const fallback = {
    title1Name: null,
    encryptionKey: null,
    hasEncryptedImages: false,
    hasEncryptedAudio: false
  };
  const systemPath = path.join(gameRoot, 'data', 'System.json');
  if (!exists(systemPath)) return fallback;
  try {
    const text = fs.readFileSync(systemPath, 'utf8').replace(/^\uFEFF/, '');
    const json = JSON.parse(text);
    return {
      title1Name: json.title1Name || null,
      encryptionKey: typeof json.encryptionKey === 'string' && json.encryptionKey.length === 32
        ? json.encryptionKey : null,
      hasEncryptedImages: !!json.hasEncryptedImages,
      hasEncryptedAudio: !!json.hasEncryptedAudio
    };
  } catch (e) {
    return fallback;
  }
}

/** 找标题图：先按 System.json 的 title1Name，失败再盲搜 titles1 目录 */
function findTitleImage(gameRoot) {
  const titlesDir = path.join(gameRoot, 'img', 'titles1');
  if (!exists(titlesDir)) return null;
  const info = readGameInfo(gameRoot);

  if (info.title1Name) {
    for (const ext of TITLE_EXTS) {
      const candidate = path.join(titlesDir, info.title1Name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  let files = [];
  try {
    files = fs.readdirSync(titlesDir, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  for (const entry of files) {
    if (!entry.isFile()) continue;
    if (endsWithAny(entry.name, TITLE_EXTS)) return path.join(titlesDir, entry.name);
  }
  return null;
}

/** 封面兜底：标题图 → icon/icon.png */
function resolveCoverFile(gameRoot) {
  return findTitleImage(gameRoot) || (function () {
    const icon = path.join(gameRoot, 'icon', 'icon.png');
    return exists(icon) ? icon : null;
  })();
}

// ---------------------------------------------------------------------------
// 批量任务
// ---------------------------------------------------------------------------

/** 解密 img 资产到 <game>/decrypt_img/ */
async function decryptImages(gameRoot, options) {
  const opts = options || {};
  const imgDir = path.join(gameRoot, 'img');
  const result = { ok: false, reason: null, outputDir: null, total: 0, done: 0, failed: 0 };
  if (!exists(imgDir)) {
    result.reason = 'missing-img';
    return result;
  }

  const files = await walkFiles(imgDir, '');
  result.total = files.length;
  if (!files.length) {
    result.reason = 'empty-img';
    return result;
  }
  if (!files.some(function (f) { return isEncrypted(f.rel); })) {
    result.reason = 'not-encrypted';
    result.outputDir = imgDir;
    return result;
  }

  const outputDir = path.join(gameRoot, 'decrypt_img');
  await fsp.mkdir(outputDir, { recursive: true });
  const key = readGameInfo(gameRoot).encryptionKey;
  result.outputDir = outputDir;
  result.ok = true;

  for (const file of files) {
    try {
      const name = decryptedName(path.basename(file.rel));
      let data = await fsp.readFile(file.full);
      if (isEncrypted(file.rel)) {
        data = isEncryptedAudio(file.rel) ? decryptAudio(data, key) : decrypt(data, key);
      }
      await writeRel(outputDir, file.rel, name, data);
    } catch (e) {
      result.failed++;
    }
    result.done++;
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({ current: result.done, total: result.total, rel: file.rel });
    }
    await new Promise(function (resolve) { setImmediate(resolve); });
  }
  return result;
}

/** 克隆一份完全解密、可直接游玩的副本（默认 <game>-解密） */
async function cloneDecryptedGame(gameRoot, options) {
  const opts = options || {};
  const root = path.resolve(gameRoot);
  const outputDir = opts.outputDir
    ? path.resolve(opts.outputDir)
    : root.replace(/[\\/]+$/, '') + '-解密';
  const result = { ok: true, outputDir: outputDir, total: 0, done: 0, failed: 0 };

  const files = await walkFiles(root, '');
  result.total = files.length;
  if (!files.length) {
    result.ok = false;
    result.reason = 'empty-game';
    return result;
  }
  await fsp.mkdir(outputDir, { recursive: true });
  const key = readGameInfo(root).encryptionKey;

  for (const file of files) {
    try {
      const rel = toSlash(file.rel);
      let data = await fsp.readFile(file.full);
      let name = path.basename(rel);
      if (rel === 'data/System.json') {
        data = patchSystemJsonBytes(data);
      } else if (isEncrypted(rel)) {
        name = decryptedName(name);
        data = isEncryptedAudio(rel) ? decryptAudio(data, key) : decrypt(data, key);
      }
      await writeRel(outputDir, rel, name, data);
    } catch (e) {
      result.failed++;
    }
    result.done++;
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({ current: result.done, total: result.total, rel: file.rel });
    }
    await new Promise(function (resolve) { setImmediate(resolve); });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 存档
// ---------------------------------------------------------------------------

function listSaves(gameRoot) {
  const dir = path.join(gameRoot, 'save');
  if (!exists(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!endsWithAny(name, SAVE_EXTS)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name: name, path: path.join(dir, name), size: st.size, mtimeMs: st.mtimeMs });
    } catch (e) {
      // 文件可能在扫描期间被游戏改写，跳过即可
    }
  }
  return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
}

function backupSaveName(fileName, date) {
  return path.basename(String(fileName || '')) + '.backup_' + timestamp(date);
}

async function backupSave(gameRoot, fileName, date) {
  const dir = path.join(gameRoot, 'save');
  const src = path.join(dir, path.basename(String(fileName || '')));
  const dst = path.join(dir, backupSaveName(fileName, date));
  await fsp.copyFile(src, dst);
  return dst;
}

/** decompressFromBase64 由宿主注入；MV 旧存档需要 LZString，MZ/纯 JSON 不需要 */
function decodeSave(raw, decompressFromBase64) {
  const text = String(raw == null ? '' : raw).trim();
  let decoded = text;
  if (!text.startsWith('{')) {
    if (typeof decompressFromBase64 === 'function') {
      const inflated = decompressFromBase64(text);
      if (inflated) decoded = inflated;
    }
    if (decoded === text) {
      decoded = Buffer.from(text, 'base64').toString('utf8');
    }
  }
  return JSON.parse(firstJsonObject(decoded));
}

function encodeSave(data) {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// MIME / 后缀补偿
// ---------------------------------------------------------------------------

function mimeOf(name) {
  switch (extOf(name)) {
    case 'html': case 'htm': return 'text/html; charset=utf-8';
    case 'js': case 'mjs': return 'application/javascript; charset=utf-8';
    case 'json': return 'application/json; charset=utf-8';
    case 'css': return 'text/css; charset=utf-8';
    case 'txt': case 'md': return 'text/plain; charset=utf-8';
    case 'xml': case 'plist': return 'application/xml; charset=utf-8';
    case 'png': case 'rpgmvp': case 'rmmzmvp': case 'png__': case 'png_': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'svg': return 'image/svg+xml';
    case 'ico': return 'image/x-icon';
    case 'ogg': case 'rpgmvo': case 'ogg_': return 'audio/ogg';
    case 'm4a': case 'aac': case 'rpgmvm': case 'm4a_': return 'audio/mp4';
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'ttf': return 'font/ttf';
    case 'otf': return 'font/otf';
    case 'woff': return 'font/woff';
    case 'woff2': return 'font/woff2';
    case 'wasm': return 'application/wasm';
    case 'rpgsave': case 'rmmzsave': case 'zip': return 'application/octet-stream';
    default: return 'application/octet-stream';
  }
}

function altExtensions(ext) {
  switch (String(ext || '').toLowerCase()) {
    case 'png': return ['rpgmvp', 'png_', 'rmmzmvp', 'jpg', 'jpeg', 'webp'];
    case 'jpg': case 'jpeg': return ['png', 'rpgmvp', 'png_', 'webp'];
    case 'webp': return ['png', 'rpgmvp'];
    case 'rpgmvp': case 'rmmzmvp': case 'png_': return ['png', 'jpg', 'rpgmvp', 'png_', 'rmmzmvp'];
    case 'ogg': return ['rpgmvo', 'ogg_', 'm4a', 'rpgmvm', 'm4a_', 'mp3', 'wav'];
    case 'oga': return ['ogg', 'rpgmvo', 'ogg_'];
    case 'm4a': return ['rpgmvm', 'm4a_', 'ogg', 'rpgmvo', 'ogg_', 'mp3'];
    case 'mp3': return ['ogg', 'rpgmvo', 'm4a', 'rpgmvm'];
    case 'wav': return ['ogg', 'm4a'];
    case 'rpgmvo': case 'ogg_': return ['ogg', 'm4a', 'rpgmvo', 'ogg_', 'rpgmvm', 'm4a_'];
    case 'rpgmvm': case 'm4a_': return ['m4a', 'ogg', 'rpgmvm', 'm4a_', 'rpgmvo', 'ogg_'];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// HTML 注入（纯字符串处理，不涉及宿主）
// ---------------------------------------------------------------------------

function buildInjectSnippet(options) {
  const opts = options || {};
  const parts = [];
  if (opts.viewport !== false) parts.push(VIEWPORT);
  if (opts.flag) parts.push('<script>' + opts.flag + '</script>');
  for (const item of (opts.scripts || [])) {
    const src = typeof item === 'string' ? item : item.src;
    const attrs = (item && item.attrs) ? ' ' + item.attrs : '';
    parts.push('<script src="' + src + '" charset="utf-8"' + attrs + '></script>');
  }
  return parts.join('');
}

function injectHtml(html, options) {
  let result = String(html == null ? '' : html);
  try {
    result = result.replace(/<meta\s+[^>]*name\s*=\s*["']viewport["'][^>]*>/gi, '');
    const snippet = buildInjectSnippet(options);
    let insertAt = -1;
    const head = /<head[^>]*>/i.exec(result);
    if (head) {
      insertAt = head.index + head[0].length;
    } else {
      const root = /<html[^>]*>/i.exec(result);
      if (root) insertAt = root.index + root[0].length;
    }
    if (insertAt < 0) insertAt = 0;
    result = result.slice(0, insertAt) + snippet + result.slice(insertAt);
  } catch (e) {
    // 注入失败时返回原 HTML，由宿主记录日志
  }
  return result;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

module.exports = {
  ENCRYPTED_IMAGE_EXTS: IMAGE_EXTS,
  ENCRYPTED_AUDIO_EXTS: AUDIO_EXTS,
  ENCRYPTED_EXTS: ENCRYPTED_EXTS,

  isEncryptedImage: isEncryptedImage,
  isEncryptedAudio: isEncryptedAudio,
  isEncrypted: isEncrypted,
  isEncryptedPath: isEncryptedPath,
  decryptedName: decryptedName,
  decrypt: decrypt,
  decryptAudio: decryptAudio,
  sniffMime: sniffMime,

  scanGames: scanGames,
  readGameInfo: readGameInfo,
  findTitleImage: findTitleImage,
  resolveCoverFile: resolveCoverFile,
  decryptImages: decryptImages,
  cloneDecryptedGame: cloneDecryptedGame,

  listSaves: listSaves,
  backupSaveName: backupSaveName,
  backupSave: backupSave,
  decodeSave: decodeSave,
  encodeSave: encodeSave,

  mimeOf: mimeOf,
  altExtensions: altExtensions,

  buildInjectSnippet: buildInjectSnippet,
  injectHtml: injectHtml
};
