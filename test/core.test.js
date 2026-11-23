'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('..');

const KEY_HEX = '00112233445566778899aabbccddeeff';
const KEY = Buffer.from(KEY_HEX, 'hex');

function encryptedBody(body) {
  const head = Buffer.alloc(16);
  Buffer.from('5250474d56000000', 'hex').copy(head, 0);
  const xored = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) xored[i] = body[i] ^ KEY[i];
  return Buffer.concat([head, xored, body.slice(16)]);
}

function makeGame(root, name) {
  const game = path.join(root, name);
  fs.mkdirSync(path.join(game, 'data'), { recursive: true });
  fs.mkdirSync(path.join(game, 'img', 'titles1'), { recursive: true });
  fs.mkdirSync(path.join(game, 'save'), { recursive: true });
  fs.writeFileSync(path.join(game, 'index.html'), '<html><head></head><body></body></html>');
  fs.writeFileSync(path.join(game, 'data', 'System.json'), JSON.stringify({
    title1Name: 'Title',
    encryptionKey: KEY_HEX,
    hasEncryptedImages: true,
    hasEncryptedAudio: true
  }));
  return game;
}

test('decrypt: 有密钥走异或，无密钥缝合 PNG 头', () => {
  const body = Buffer.concat([Buffer.alloc(16), Buffer.from('payload')]);
  const enc = encryptedBody(body);
  assert.deepEqual(core.decrypt(enc, KEY_HEX), body);
  assert.deepEqual(core.decrypt(enc, null).slice(0, 16), Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
  ]));
});

test('decryptedName / isEncrypted 后缀映射', () => {
  assert.equal(core.decryptedName('a.rpgmvp'), 'a.png');
  assert.equal(core.decryptedName('a.rpgmvo'), 'a.ogg');
  assert.equal(core.decryptedName('a.rpgmvm'), 'a.m4a');
  assert.equal(core.isEncrypted('A.RPGMVP'), true);
  assert.equal(core.isEncrypted('a.png'), false);
});

test('scanGames 支持 www 嵌套并跳过隐藏目录', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgcore-scan-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  makeGame(tmp, 'B');
  const nested = path.join(tmp, 'A', 'www');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'index.html'), '');
  fs.mkdirSync(path.join(tmp, '.hidden'), { recursive: true });

  const games = core.scanGames(tmp);
  assert.deepEqual(games.map(g => g.name), ['A', 'B']);
  assert.equal(games[0].root, nested);
  assert.equal(games[0].location, 'A/www');
});

test('readGameInfo / findTitleImage / listSaves', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgcore-info-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const game = makeGame(tmp, 'G');
  const title = path.join(game, 'img', 'titles1', 'Title.rpgmvp');
  fs.writeFileSync(title, encryptedBody(Buffer.concat([Buffer.alloc(16), Buffer.from('x')])));
  fs.writeFileSync(path.join(game, 'save', 'file2.rpgsave'), 'e30=');
  fs.writeFileSync(path.join(game, 'save', 'file1.rpgsave'), 'e30=');

  assert.equal(core.readGameInfo(game).title1Name, 'Title');
  assert.equal(core.findTitleImage(game), title);
  assert.deepEqual(core.listSaves(game).map(s => s.name), ['file1.rpgsave', 'file2.rpgsave']);
});

test('decodeSave / encodeSave / backupSaveName', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgcore-save-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const data = { party: { _gold: 123 }, actors: { _data: [] } };
  const encoded = core.encodeSave(data);
  assert.deepEqual(core.decodeSave(encoded), data);
  assert.equal(core.backupSaveName('file1.rpgsave', new Date(2026, 0, 2, 3, 4, 5)), 'file1.rpgsave.backup_20260102030405');

  const game = makeGame(tmp, 'S');
  fs.writeFileSync(path.join(game, 'save', 'file1.rpgsave'), encoded);
  const backup = await core.backupSave(game, 'file1.rpgsave', new Date(2026, 0, 2, 3, 4, 5));
  assert.equal(fs.readFileSync(backup, 'utf8'), encoded);
});

test('decryptImages 与 cloneDecryptedGame 产出明文副本', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgcore-task-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const game = makeGame(tmp, 'T');
  const body = Buffer.concat([Buffer.alloc(16), Buffer.from('image-data')]);
  fs.writeFileSync(path.join(game, 'img', 'titles1', 'Title.rpgmvp'), encryptedBody(body));

  const progress = [];
  const images = await core.decryptImages(game, { onProgress: p => progress.push(p.current) });
  assert.equal(images.ok, true);
  assert.equal(images.outputDir, path.join(game, 'decrypt_img'));
  assert.deepEqual(progress, [1]);
  assert.deepEqual(fs.readFileSync(path.join(game, 'decrypt_img', 'titles1', 'Title.png')), body);

  const clone = await core.cloneDecryptedGame(game);
  assert.equal(clone.ok, true);
  assert.deepEqual(fs.readFileSync(path.join(clone.outputDir, 'img', 'titles1', 'Title.png')), body);
  const system = JSON.parse(fs.readFileSync(path.join(clone.outputDir, 'data', 'System.json'), 'utf8'));
  assert.equal(system.hasEncryptedImages, false);
  assert.equal(system.hasEncryptedAudio, false);
});

test('injectHtml 在 head 顶部插入脚本并移除原 viewport', () => {
  const html = '<html><head><meta name="viewport" content="width=1"></head><body></body></html>';
  const out = core.injectHtml(html, {
    scripts: [{ src: '/a.js', attrs: 'data-rpg="a"' }, '/b.js'],
    flag: 'window.X=1;'
  });
  assert.match(out, /<head><meta name="viewport" content="width=device-width/);
  assert.doesNotMatch(out, /width=1/);
  assert.equal((out.match(/name="viewport"/g) || []).length, 1);
  assert.match(out, /<script src="\/a.js" charset="utf-8" data-rpg="a"><\/script>/);
  assert.match(out, /<script>window.X=1;<\/script>/);
  assert.ok(out.indexOf('width=device-width') < out.indexOf('/a.js'));
});
