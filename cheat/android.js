/**
 * cheat.js —— 注入到游戏页面内部的载荷（安卓版）
 *
 * 由内嵌 Node 的 HTTP 服务在 index.html 的 <head> 顶部插入 <script> 加载，
 * 执行时机早于游戏自身的 rpg_*.js / main.js。
 *
 * 与桌面端 cheat/desktop.js 的差异：
 *   1. 界面按手机触屏重做尺寸（桌面端用鼠标，尺寸偏小）；
 *   2. 提供 window.__rpgKey(code, down)，供安卓原生虚拟按键派发键盘事件；
 *   3. require / process / nw 由 shim.js 提供（真·Node 环境），这里不再伪造；
 *   4. 把 MV 的加密标记锁成 false，资源统一由服务端解密后以明文下发。
 *
 * 控制台 API：cheatSetNoclip(true) 穿墙 / cheatBattleDefeat() 只把生命设为 0 /
 * cheatSetHp(9999) 等数值修改，详见 cheatHelp()。
 */
(function () {
    'use strict';

    var VERSION = 10;
    if (window.__RPGCHEAT_READY === VERSION) return;
    window.__RPGCHEAT_READY = VERSION;

    // 设置里可以关掉作弊界面：关掉后仍然提供 window.__rpgKey 等底层能力，
    // 只是不再挂悬浮球和面板（虚拟按键依赖本脚本，不能整个不注入）。
    var UI_ENABLED = window.__RPG_CHEAT_UI__ !== false;

    var KEY_NAMES = {
        9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Control', 18: 'Alt', 27: 'Escape',
        32: ' ', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
        88: 'x', 90: 'z'
    };
    var CODE_NAMES = {
        9: 'Tab', 13: 'Enter', 16: 'ShiftLeft', 17: 'ControlLeft', 18: 'AltLeft',
        27: 'Escape', 32: 'Space',
        37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
        88: 'KeyX', 90: 'KeyZ'
    };

    function report(msg) {
        try { console.log('%c[RPG] ' + msg, 'color:#4fc3f7;font-weight:bold'); } catch (e) { }
    }

    // =====================================================================
    // 一、反检测 / 环境补丁（必须跑在游戏页面里，且越早越好）
    // =====================================================================

    // 隐藏滚动条（只改外观）
    try {
        var scrollStyle = document.createElement('style');
        scrollStyle.setAttribute('data-rpg-cheat-style', '1');
        scrollStyle.textContent =
            '::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}' +
            'html,body{scrollbar-width:none !important;-ms-overflow-style:none !important;' +
            'overflow:hidden !important;margin:0 !important;background:#000 !important;' +
            '-webkit-tap-highlight-color:transparent !important;' +
            '-webkit-touch-callout:none !important;}';
        (document.head || document.documentElement).appendChild(scrollStyle);
    } catch (e) { }

    // 屏蔽页面右键菜单（手机上长按会弹出系统菜单，打断游戏）
    try {
        document.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
        }, true);
    } catch (e) { }

    // 错误不弹窗，只打印（带堆栈，方便定位是哪个插件出问题）
    try {
        window.addEventListener('error', function (e) {
            var msg = (e && e.message) || '';
            var stack = (e && e.error && e.error.stack) ? '\n' + e.error.stack : '';
            console.error('[RPG] 页面异常: ' + msg + stack);
        });
        window.addEventListener('unhandledrejection', function (e) {
            var r = e && e.reason;
            console.error('[RPG] 未处理的 Promise 拒绝: ' + ((r && (r.stack || r.message)) || r));
        });
    } catch (e) { }

    // =====================================================================
    // 二、虚拟按键入口（安卓原生层调用）
    // =====================================================================

    window.__rpgKey = function (code, down) {
        try {
            var ev = new KeyboardEvent(down ? 'keydown' : 'keyup', {
                key: KEY_NAMES[code] || '',
                code: CODE_NAMES[code] || '',
                bubbles: true,
                cancelable: true
            });
            try {
                Object.defineProperty(ev, 'keyCode', { get: function () { return code; } });
                Object.defineProperty(ev, 'which', { get: function () { return code; } });
            } catch (e) { }

            var active = document.activeElement;
            var target = (active && active !== document.body && active !== document.documentElement)
                ? active : document;
            target.dispatchEvent(ev);
            return true;
        } catch (e) {
            console.error('[RPG] 派发按键失败', e);
            return false;
        }
    };

    // =====================================================================
    // 三、资源后缀补丁
    //
    // 存档不用在这里接管：require('fs') 由 shim.js 接到了内嵌 Node 上，
    // 引擎的 isNwjs() 为 true，自己就会把 fileN.rpgsave 写进游戏目录的 save/。
    // =====================================================================

    var decrypterPatched = false;
    var audioExtPatched = false;

    /**
     * 资源全部由本地服务解密后以【明文】下发，引擎侧不再处理加密后缀：
     *   - MV / MZ ≤1.6：走 Decrypter.hasEncryptedImages / hasEncryptedAudio
     *   - MZ 1.7+：改成 Utils.hasEncryptedImages() / hasEncryptedAudio()，加密时还会给
     *     URL 末尾追加 "_"（audio/bgm/op.m4a_），引擎自己拼的路径基本必然 404
     * 锁成 false 之后引擎请求的是 op.png / op.ogg，服务端负责补偿后缀并解密。
     */
    function patchAssetDecryption() {
        if (decrypterPatched) return;
        var D = window.Decrypter;
        var U = window.Utils;
        if (!D || !U) return;
        // 只对 MV 生效：MV 的 Decrypter 是独立对象，锁成 false 后请求明文名，由服务端解密。
        // MZ（尤其 1.7+）把解密逻辑并进 Utils，并在 URL 上追加 "_"；改动它会打乱
        // 引擎自己的加载时序（实测会导致黑屏），所以保持 MZ 原样、由服务端只做后缀补偿。
        if (U.RPGMAKER_NAME !== 'MV') {
            decrypterPatched = true;
            return;
        }
        decrypterPatched = true;

        var alwaysFalse = function () { return false; };
        try {
            Object.defineProperty(D, 'hasEncryptedImages', {
                get: alwaysFalse, set: function () { }, configurable: true
            });
            Object.defineProperty(D, 'hasEncryptedAudio', {
                get: alwaysFalse, set: function () { }, configurable: true
            });
        } catch (e) {
            D.hasEncryptedImages = false;
            D.hasEncryptedAudio = false;
        }
    }

    /** MV 在移动端固定用 .m4a，而这些游戏基本只带 ogg */
    function patchAudioExt() {
        var A = window.AudioManager;
        if (!A || audioExtPatched) return;
        audioExtPatched = true;
        A.audioFileExt = function () {
            try {
                if (window.WebAudio && typeof WebAudio.canPlayOgg === 'function' && WebAudio.canPlayOgg()) {
                    return '.ogg';
                }
            } catch (e) { }
            return '.m4a';
        };
    }

    // 尽早打补丁：引擎各文件一加载完就接管，这里用高频轮询探测（补丁本身幂等）
    (function watchEngine() {
        var deadline = Date.now() + 20000;
        var attempts = 0;
        function tick() {
            attempts++;
            patchAssetDecryption();
            patchAudioExt();
            var done = decrypterPatched && audioExtPatched;
            if (done || Date.now() > deadline) return;
            setTimeout(tick, attempts < 60 ? 16 : 250);
        }
        tick();
    })();

    document.addEventListener('DOMContentLoaded', function () {
        patchAssetDecryption();
        patchAudioExt();
    });

    // =====================================================================
    // 四、数值修改核心
    // =====================================================================

    function getParty() { return window.$gameParty || null; }

    function toNumber(value) {
        var num = Number(value);
        return isNaN(num) ? null : num;
    }

    function setParamAll(paramId, value, label) {
        var party = getParty();
        if (!party) return { ok: false, msg: '还没进入游戏，请先加载存档并进入地图' };

        var num = toNumber(value);
        if (num === null) return { ok: false, msg: '请输入有效数字' };

        party.members().forEach(function (actor) {
            if (actor._paramPlus) actor._paramPlus[paramId] = 0;
            if (typeof actor.addParam === 'function') actor.addParam(paramId, num);
            if (paramId === 0 && typeof actor.setHp === 'function') actor.setHp(num);
            if (paramId === 1 && typeof actor.setMp === 'function') actor.setMp(num);
        });

        report(label + ' = ' + num);
        return { ok: true, msg: '已设置' + label + ' = ' + num + '（' + party.members().length + ' 名角色）' };
    }

    function setGold(value) {
        var party = getParty();
        if (!party) return { ok: false, msg: '还没进入游戏，请先加载存档并进入地图' };

        var num = toNumber(value);
        if (num === null) return { ok: false, msg: '请输入有效数字' };

        party.gainGold(num - party.gold());
        return { ok: true, msg: '已设置金币 = ' + party.gold() };
    }

    function fillToMax(paramId, label) {
        var party = getParty();
        if (!party) return { ok: false, msg: '还没进入游戏，请先加载存档并进入地图' };

        var maxFn = paramId === 0 ? 'mhp' : 'mmp';
        var curFn = paramId === 0 ? 'hp' : 'mp';
        var setFn = paramId === 0 ? 'setHp' : 'setMp';

        var applied = 0, capped = 0, firstMax = null;

        party.members().forEach(function (actor) {
            if (!actor) return;
            var max = (typeof actor[maxFn] === 'function') ? Number(actor[maxFn]()) : NaN;
            if (!isFinite(max) || max <= 0) {
                max = (typeof actor.param === 'function') ? Number(actor.param(paramId)) : NaN;
            }
            if (!isFinite(max) || max <= 0) return;
            if (firstMax === null) firstMax = max;

            var cur = (typeof actor[curFn] === 'function') ? Number(actor[curFn]()) : 0;
            if (cur > max) capped++;

            if (typeof actor[setFn] === 'function') actor[setFn](max);
            applied++;
        });

        if (!applied) return { ok: false, msg: '未取到' + label + '上限，无法回满' };

        return {
            ok: true,
            msg: '已回满' + label + '（上限 ' + firstMax + '）' +
                (capped ? '，' + capped + ' 名角色超过上限已重置' : '')
        };
    }

    window.cheatSetHp = function (v) { return setParamAll(0, v, '全员生命').msg; };
    window.cheatSetMp = function (v) { return setParamAll(1, v, '全员魔法').msg; };
    window.cheatSetAtk = function (v) { return setParamAll(2, v, '全员攻击力').msg; };
    window.cheatSetGold = function (v) { return setGold(v).msg; };
    window.cheatFillHp = function () { return fillToMax(0, '全员生命').msg; };
    window.cheatFillMp = function () { return fillToMax(1, '全员魔法').msg; };

    // =====================================================================
    // 五、地图事件雷达
    // =====================================================================

    var radar = { overlay: null, rafId: null, lastMapId: null, running: false };
    var TRIGGER_NAMES = ['调查', '触碰', '事件触碰', '自动', '并行'];

    function stopRadar() {
        radar.running = false;
        if (radar.rafId !== null) {
            cancelAnimationFrame(radar.rafId);
            radar.rafId = null;
        }
        if (radar.overlay && radar.overlay.parentNode) {
            radar.overlay.parentNode.removeChild(radar.overlay);
        }
        radar.overlay = null;
        radar.lastMapId = null;
    }

    function ensureOverlay() {
        if (radar.overlay && radar.overlay.parentNode === document.body) return radar.overlay;
        var old = document.getElementById('rpg-dynamic-overlay');
        if (old) old.remove();

        var overlay = document.createElement('div');
        overlay.id = 'rpg-dynamic-overlay';
        overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;' +
            'z-index:99999;pointer-events:none;overflow:hidden;';
        document.body.appendChild(overlay);
        radar.overlay = overlay;
        return overlay;
    }

    function drawRadarFrame() {
        if (!radar.running) return;

        var overlay = radar.overlay;
        if (!overlay || !overlay.parentNode) {
            radar.running = false;
            return;
        }
        overlay.innerHTML = '';

        try {
            var gmap = window.$gameMap;
            var canvas = document.getElementById('gameCanvas') || document.querySelector('canvas');
            if (!gmap || !canvas || typeof gmap.data !== 'function' || !gmap.data()) {
                radar.rafId = requestAnimationFrame(drawRadarFrame);
                return;
            }

            var mapId = gmap.mapId();
            var displayX = gmap.displayX();
            var displayY = gmap.displayY();
            if (radar.lastMapId !== mapId) {
                radar.lastMapId = mapId;
                report('雷达已同步地图 ID: ' + mapId);
            }

            var tw = gmap.tileWidth ? gmap.tileWidth() : 48;
            var th = gmap.tileHeight ? gmap.tileHeight() : 48;
            var boxW = (window.Graphics && (Graphics.boxWidth || Graphics.width)) || 816;
            var boxH = (window.Graphics && (Graphics.boxHeight || Graphics.height)) || 624;

            var rect = canvas.getBoundingClientRect();
            var scaleX = rect.width / boxW;
            var scaleY = rect.height / boxH;

            var events = typeof gmap.events === 'function' ? gmap.events() : (gmap._events || []);
            var maxX = canvas.width / tw + 1;
            var maxY = canvas.height / th + 1;

            events.forEach(function (ev) {
                if (!ev) return;

                var raw = typeof ev.event === 'function' ? ev.event() : ev;
                if (!raw || !raw.pages || raw.pages.length === 0) return;

                var page = (ev._pageIndex !== undefined && ev._pageIndex >= 0)
                    ? raw.pages[ev._pageIndex] : raw.pages[0];

                if (page && page.list && page.list.length <= 1 && !page.characterName && !page.tileId) return;

                var screenX = ev.x - displayX;
                var screenY = ev.y - displayY;
                if (screenX < -1 || screenX > maxX || screenY < -1 || screenY > maxY) return;

                var box = document.createElement('div');
                box.style.cssText = 'position:absolute;box-sizing:border-box;' +
                    'left:' + (rect.left + screenX * tw * scaleX) + 'px;' +
                    'top:' + (rect.top + screenY * th * scaleY) + 'px;' +
                    'width:' + (tw * scaleX) + 'px;' +
                    'height:' + (th * scaleY) + 'px;' +
                    'border:2px solid #00ffff;' +
                    'box-shadow:0 0 8px #00ffff, inset 0 0 6px rgba(0,255,255,0.3);' +
                    'background:rgba(0,255,255,0.1);';

                var label = document.createElement('div');
                label.innerText = (raw.name || ('EV' + raw.id)) + '\n[' + ev.x + ',' + ev.y + '] (' +
                    (TRIGGER_NAMES[page ? page.trigger : 0] || '未知') + ')';
                label.style.cssText = 'position:absolute;top:-' + (th * scaleY * 0.8) + 'px;left:50%;' +
                    'transform:translateX(-50%);background:rgba(0,0,0,0.8);color:#fff;' +
                    'font:10px/1.3 monospace;padding:1px 4px;border-radius:3px;' +
                    'border:1px solid #00ffff;white-space:pre;text-align:center;';

                box.appendChild(label);
                overlay.appendChild(box);
            });
        } catch (e) {
            // 地图重载瞬间的偶发 null，忽略并继续
        }

        radar.rafId = requestAnimationFrame(drawRadarFrame);
    }

    function startRadar() {
        stopRadar();
        ensureOverlay();
        radar.running = true;
        radar.rafId = requestAnimationFrame(drawRadarFrame);
    }

    window.cheatHightlightEventPos = function () {
        startRadar();
        return '雷达已开启';
    };
    window.cheatStopRadar = function () { stopRadar(); return '雷达已关闭'; };
    window.cheatIsRadarOn = function () { return radar.running; };

    // =====================================================================
    // 六、战斗控制
    // =====================================================================

    function inBattle() {
        try {
            var sm = window.SceneManager;
            var scene = sm && sm._scene;
            if (!scene) return false;
            var name = scene.constructor && scene.constructor.name;
            if (name !== 'Scene_Battle') return false;
            var bm = window.BattleManager;
            if (bm && typeof bm.isBattleEnd === 'function' && bm.isBattleEnd()) return false;
            return true;
        } catch (e) { return false; }
    }

    function killTroop() {
        var troop = window.$gameTroop;
        if (!troop || typeof troop.members !== 'function') return false;
        var killed = 0;
        troop.members().forEach(function (enemy) {
            if (!enemy) return;
            try {
                if (typeof enemy.isDead === 'function' && enemy.isDead()) return;
                if (typeof enemy.die === 'function') enemy.die();
                else if (typeof enemy.setHp === 'function') enemy.setHp(0);
                killed++;
            } catch (e) { }
        });
        return killed > 0;
    }

    function killParty() {
        var party = getParty();
        if (!party) return false;
        var killed = 0;
        party.members().forEach(function (actor) {
            if (!actor) return;
            try {
                if (typeof actor.isDead === 'function' && actor.isDead()) return;
                if (typeof actor.setHp === 'function') { actor.setHp(0); killed++; }
            } catch (e) { }
        });
        return killed > 0;
    }

    function forceVictory() {
        if (!inBattle()) return { ok: false, msg: '当前不在战斗中，无法使用' };
        var bm = window.BattleManager;
        killTroop();
        try {
            if (bm && typeof bm.processVictory === 'function') {
                bm.processVictory();
                return { ok: true, msg: '已立即胜利' };
            }
        } catch (e) { }
        try {
            if (bm && typeof bm.checkBattleEnd === 'function') {
                bm.checkBattleEnd();
                return { ok: true, msg: '已击倒全部敌人' };
            }
        } catch (e) { }
        return { ok: false, msg: '该游戏不支持一键胜利' };
    }

    function forceDefeat() {
        if (!inBattle()) return { ok: false, msg: '当前不在战斗中，无法使用' };
        // 只把全员生命设为 0，战败结算交给游戏自身判定
        var ok = killParty();
        report('战斗：全员生命设为 0');
        return ok
            ? { ok: true, msg: '已把全员生命设为 0' }
            : { ok: false, msg: '未能清空队伍生命' };
    }

    window.cheatBattleVictory = function () { return forceVictory().msg; };
    window.cheatBattleDefeat = function () { return forceDefeat().msg; };
    window.cheatInBattle = inBattle;

    // =====================================================================
    // 七、穿墙：只放开玩家的地形判定，不影响 NPC / 事件的碰撞
    // =====================================================================

    var noclipOn = false;
    var noclipPatched = false;

    function installNoclipPatch() {
        if (noclipPatched) return true;
        var GP = window.Game_Player;
        var GCB = window.Game_CharacterBase;
        if (!GP || !GP.prototype || !GCB || !GCB.prototype) return false;
        noclipPatched = true;

        var origMapPassable = GCB.prototype.isMapPassable;
        if (typeof origMapPassable === 'function') {
            GCB.prototype.isMapPassable = function () {
                if (noclipOn && window.$gamePlayer === this) return true;
                return origMapPassable.apply(this, arguments);
            };
        }

        // 部分魔改版还会用 tileId 做碰撞判定，这里一并放行玩家
        var tileOwner = (typeof GP.prototype.isCollidedWithTiles === 'function') ? GP : GCB;
        var origTileCollision = tileOwner.prototype.isCollidedWithTiles;
        if (typeof origTileCollision === 'function') {
            tileOwner.prototype.isCollidedWithTiles = function () {
                if (noclipOn && window.$gamePlayer === this) return false;
                return origTileCollision.apply(this, arguments);
            };
        }
        return true;
    }

    // 引擎脚本晚于本载荷执行，轮询等 Game_Player 出现后打补丁（幂等）
    (function watchNoclip() {
        var start = Date.now();
        (function tick() {
            if (installNoclipPatch() || Date.now() - start > 30000) return;
            setTimeout(tick, 100);
        })();
    })();

    function setNoclip(on) {
        noclipOn = !!on;
        installNoclipPatch();
        report('穿墙已' + (noclipOn ? '开启' : '关闭'));
        return noclipOn;
    }

    window.cheatSetNoclip = setNoclip;
    window.cheatIsNoclipOn = function () { return noclipOn; };

    // =====================================================================
    // 八、悬浮球 + 作弊面板（手机尺寸）
    // =====================================================================

    var UI_ID = 'rpg-cheat-host';
    var BALL = 46;        // px（页面 CSS 像素 ≈ dp，因为注入了 width=device-width 的 viewport）
    var PANEL_W = 300;
    // 悬浮球由原生层（Compose）绘制：只有原生 View 才能永远盖在虚拟按键之上，
    // 页面里这只球隐藏起来，只用来告诉面板该往哪儿展开。
    var PAGE_BALL_HIDDEN = true;

    var ui = {
        host: null, btn: null, panel: null, tip: null, radarBtn: null,
        noclipBtn: null, winBtn: null, loseBtn: null, open: false, battleTimer: null
    };

    function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

    function placeBall(left, top) {
        var maxLeft = window.innerWidth - BALL - 4;
        var maxTop = window.innerHeight - BALL - 4;
        ui.host.style.left = clamp(left, 4, Math.max(4, maxLeft)) + 'px';
        ui.host.style.top = clamp(top, 4, Math.max(4, maxTop)) + 'px';
    }

    function placePanel() {
        if (!ui.open) return;
        var r = ui.host.getBoundingClientRect();
        var pw = ui.panel.offsetWidth || PANEL_W;
        var ph = ui.panel.offsetHeight || 320;

        var left = r.left - pw - 10;
        if (left < 8) left = r.right + 10;
        left = clamp(left, 8, Math.max(8, window.innerWidth - pw - 8));
        var top = clamp(r.top, 8, Math.max(8, window.innerHeight - ph - 8));

        ui.panel.style.left = left + 'px';
        ui.panel.style.top = top + 'px';
        // 屏幕矮的时候让面板自己滚动，别把底部按钮裁掉
        ui.panel.style.maxHeight = Math.max(180, window.innerHeight - top - 8) + 'px';
    }

    function setTip(msg, isError) {
        if (!ui.tip) return;
        ui.tip.innerText = msg;
        ui.tip.style.color = isError ? '#ff8a80' : '#8ce99a';
    }

    function refreshBattleButtons() {
        if (!ui.winBtn || !ui.loseBtn) return;
        var on = inBattle();
        ui.winBtn.disabled = !on;
        ui.loseBtn.disabled = !on;
    }

    /** 面板打开时让原生层收起虚拟按键：按键画在 WebView 之上，会盖住面板下半部分 */
    function notifyHost(open) {
        try {
            var host = window.RPGHost;
            if (host && typeof host.setCheatPanelOpen === 'function') {
                host.setCheatPanelOpen(!!open);
            }
        } catch (e) { }
    }

    function togglePanel(force) {
        if (!ui.panel) return;
        ui.open = (typeof force === 'boolean') ? force : !ui.open;
        notifyHost(ui.open);
        ui.panel.style.display = ui.open ? 'block' : 'none';
        ui.btn.classList.toggle('active', ui.open);

        if (ui.open) {
            placePanel();
            if (window.cheatIsRadarOn()) ui.radarBtn.innerText = '事件雷达：开';
            if (ui.noclipBtn) ui.noclipBtn.innerText = '穿墙：' + (window.cheatIsNoclipOn() ? '开' : '关');
            refreshBattleButtons();
            if (!ui.battleTimer) ui.battleTimer = setInterval(refreshBattleButtons, 500);
        } else if (ui.battleTimer) {
            clearInterval(ui.battleTimer);
            ui.battleTimer = null;
        }
    }

    /** 输入框留空时直接采用灰色的 placeholder 默认值，并回填到输入框 */
    function valueOrDefault(inputEl) {
        if (inputEl.value !== '' && inputEl.value !== null) return inputEl.value;
        var def = inputEl.getAttribute('placeholder') || '';
        inputEl.value = def;
        return def;
    }

    function applyParam(paramId, inputEl, label) {
        var res = setParamAll(paramId, valueOrDefault(inputEl), label);
        setTip(res.msg, !res.ok);
    }

    function buildUI() {
        if (document.getElementById(UI_ID) || !document.body) return;

        // 游戏画布是 z-index:1 的定位元素，而本容器在 shadow DOM 里，
        // :host 规则的优先级低于文档规则，容易被画布压住。这里补一条文档级 !important 规则，
        // 把容器钉死在最上层（2147483647 是 z-index 上限）。
        try {
            if (!document.getElementById('rpg-cheat-style')) {
                var zfix = document.createElement('style');
                zfix.id = 'rpg-cheat-style';
                zfix.textContent = '#' + UI_ID + '{position:fixed !important;z-index:2147483647 !important;}';
                (document.head || document.documentElement).appendChild(zfix);
            }
        } catch (e) { }

        var host = document.createElement('div');
        host.id = UI_ID;
        host.style.cssText = 'position:fixed;width:' + BALL + 'px;height:' + BALL + 'px;' +
            'z-index:2147483647;left:0;top:0;';

        var root = host.attachShadow({ mode: 'open' });
        var pw = Math.min(PANEL_W, Math.round(window.innerWidth * 0.78));

        root.innerHTML = [
            '<style>',
            ':host{all:initial;position:fixed;z-index:2147483647;}',
            '.ball{position:relative;z-index:2;width:' + BALL + 'px;height:' + BALL + 'px;border-radius:50%;box-sizing:border-box;',
            'background:radial-gradient(circle at 32% 28%,#7fdcff,#0f7fbf 72%);',
            'box-shadow:0 6px 18px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.4);',
            'display:flex;align-items:center;justify-content:center;color:#fff;',
            'font:700 13px/1 sans-serif;letter-spacing:1px;opacity:.62;',
            'cursor:grab;user-select:none;touch-action:none;transition:opacity .15s,transform .15s;}',
            '.ball.active{opacity:1;background:radial-gradient(circle at 32% 28%,#8ef0b8,#0f9f63 72%);}',
            '.ball.dragging{transform:scale(1.08);opacity:1;}',
            '.panel{position:fixed;z-index:1;display:none;width:' + pw + 'px;box-sizing:border-box;',
            'max-height:82vh;overflow-y:auto;-webkit-overflow-scrolling:touch;',
            'background:#18181f;border:1px solid #4fc3f7;border-radius:12px;',
            'padding:12px;color:#e9e9f2;font:13px/1.5 sans-serif;',
            'box-shadow:0 16px 36px rgba(0,0,0,.6);}',
            '.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}',
            '.title{color:#4fc3f7;font-weight:700;}',
            '.close{cursor:pointer;color:#9aa0ad;font-size:20px;line-height:1;padding:0 6px;}',
            '.row{display:grid;grid-template-columns:34px minmax(0,1fr) 52px 52px;',
            'align-items:center;gap:6px;margin-bottom:8px;}',
            '.row label{color:#b8becc;font-size:12px;}',
            '.row button{width:100%;}',
            'input{width:100%;box-sizing:border-box;min-width:0;background:#0f0f14;border:1px solid #3a3a48;',
            'color:#fff;border-radius:6px;padding:7px 8px;font:13px sans-serif;outline:none;}',
            'input::placeholder{color:#7c8391;opacity:1;}',
            'button{cursor:pointer;border:1px solid #3a3a48;background:#2a2a36;color:#e9e9f2;',
            'border-radius:8px;padding:9px 8px;font:13px sans-serif;}',
            'button:active{background:#37415a;}',
            'button.fillcolor{}',
            'button.fill{color:#9fe6b8;border-color:#2f7d4f;font-size:12px;padding:9px 4px;}',
            'button.primary{background:#4fc3f7;border-color:#4fc3f7;color:#10131a;font-weight:700;}',
            '.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0;}',
            '.grid.one{grid-template-columns:1fr;}',
            'button:disabled{opacity:.4;background:#22222b;border-color:#33333f;color:#8b93a1;}',
            'button.win{border-color:#2f7d4f;}',
            'button.lose{border-color:#7d2f2f;}',
            '.sep{height:1px;background:#33333f;margin:10px 0;}',
            '.tip{font-size:11px;color:#8ce99a;min-height:16px;line-height:1.4;word-break:break-all;}',
            '</style>',
            '<div class="ball" id="ball">作弊</div>',
            '<div class="panel" id="panel">',
            '  <div class="head"><span class="title">作弊面板</span><span class="close" id="close">×</span></div>',
            '  <div class="row"><label>生命</label><input id="hp" type="number" placeholder="9999"><button data-act="hp">应用</button><button data-act="hpfill" class="fill">回满</button></div>',
            '  <div class="row"><label>魔法</label><input id="mp" type="number" placeholder="9999"><button data-act="mp">应用</button><button data-act="mpfill" class="fill">回满</button></div>',
            '  <div class="row"><label>攻击</label><input id="atk" type="number" placeholder="999"><button data-act="atk">应用</button><button disabled>—</button></div>',
            '  <div class="row"><label>金币</label><input id="gold" type="number" placeholder="999999"><button data-act="gold">应用</button><button disabled>—</button></div>',
            '  <div class="grid">',
            '    <button id="max" class="primary">一键拉满</button>',
            '    <button id="radar">事件雷达：关</button>',
            '  </div>',
            '  <div class="grid one">',
            '    <button id="noclip">穿墙：关</button>',
            '  </div>',
            '  <div class="sep"></div>',
            '  <div class="grid">',
            '    <button id="win" class="win" disabled>立即胜利</button>',
            '    <button id="lose" class="lose" disabled>立即战败</button>',
            '  </div>',
            '  <div class="tip" id="tip">拖动圆球可移动位置</div>',
            '</div>'
        ].join('');

        // 挂到 <html> 下：body 上若有 transform/filter 会形成新的层叠上下文，把容器关进去
        (document.documentElement || document.body).appendChild(host);

        ui.host = host;
        ui.btn = root.getElementById('ball');
        if (ui.btn && PAGE_BALL_HIDDEN) ui.btn.style.display = 'none';
        ui.panel = root.getElementById('panel');
        ui.tip = root.getElementById('tip');
        ui.radarBtn = root.getElementById('radar');
        ui.noclipBtn = root.getElementById('noclip');
        ui.winBtn = root.getElementById('win');
        ui.loseBtn = root.getElementById('lose');

        placeBall(window.innerWidth - BALL - 10, Math.round(window.innerHeight * 0.16));

        var drag = { active: false, moved: false, sx: 0, sy: 0, left: 0, top: 0 };

        function onPointerDown(e) {
            if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            e.stopPropagation();

            var r = host.getBoundingClientRect();
            drag.active = true;
            drag.moved = false;
            drag.sx = e.clientX;
            drag.sy = e.clientY;
            drag.left = r.left;
            drag.top = r.top;
            ui.btn.classList.add('dragging');
            try { ui.btn.setPointerCapture(e.pointerId); } catch (err) { }

            window.addEventListener('pointermove', onPointerMove, true);
            window.addEventListener('pointerup', onPointerUp, true);
            window.addEventListener('pointercancel', onPointerUp, true);
        }

        function onPointerMove(e) {
            if (!drag.active) return;
            e.preventDefault();
            e.stopPropagation();

            var dx = e.clientX - drag.sx;
            var dy = e.clientY - drag.sy;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 8) {
                drag.moved = true;
                togglePanel(false);
            }
            if (drag.moved) placeBall(drag.left + dx, drag.top + dy);
        }

        function onPointerUp(e) {
            if (!drag.active) return;
            drag.active = false;
            ui.btn.classList.remove('dragging');

            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('pointerup', onPointerUp, true);
            window.removeEventListener('pointercancel', onPointerUp, true);

            if (!drag.moved) togglePanel();
        }

        ui.btn.addEventListener('pointerdown', onPointerDown);

        var BLOCKED = ['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick',
            'mousedown', 'mouseup', 'keydown', 'keyup', 'wheel', 'contextmenu'];
        [ui.btn, ui.panel].forEach(function (el) {
            BLOCKED.forEach(function (evt) {
                el.addEventListener(evt, function (e) { e.stopPropagation(); }, false);
            });
        });

        root.getElementById('close').addEventListener('click', function () { togglePanel(false); });

        var inputs = {
            hp: root.getElementById('hp'),
            mp: root.getElementById('mp'),
            atk: root.getElementById('atk'),
            gold: root.getElementById('gold')
        };

        root.querySelectorAll('button[data-act]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var act = btn.getAttribute('data-act');
                if (act === 'hp') applyParam(0, inputs.hp, '全员生命');
                if (act === 'mp') applyParam(1, inputs.mp, '全员魔法');
                if (act === 'atk') applyParam(2, inputs.atk, '全员攻击力');
                if (act === 'gold') {
                    var res = setGold(valueOrDefault(inputs.gold));
                    setTip(res.msg, !res.ok);
                }
                if (act === 'hpfill') {
                    var rHp = fillToMax(0, '全员生命');
                    setTip(rHp.msg, !rHp.ok);
                }
                if (act === 'mpfill') {
                    var rMp = fillToMax(1, '全员魔法');
                    setTip(rMp.msg, !rMp.ok);
                }
            });
        });

        root.getElementById('max').addEventListener('click', function () {
            var r1 = setParamAll(0, 9999, '全员生命');
            var r2 = setParamAll(1, 9999, '全员魔法');
            var r3 = setParamAll(2, 999, '全员攻击力');
            var r4 = setGold(9999999);
            var ok = r1.ok && r2.ok && r3.ok && r4.ok;
            setTip(ok ? '已一键拉满：HP/MP 9999、攻击 999、金币 9999999' : (r1.msg || r2.msg || r3.msg || r4.msg), !ok);
            inputs.hp.value = 9999;
            inputs.mp.value = 9999;
            inputs.atk.value = 999;
            inputs.gold.value = 9999999;
        });

        ui.radarBtn.addEventListener('click', function () {
            if (window.cheatIsRadarOn()) {
                stopRadar();
                ui.radarBtn.innerText = '事件雷达：关';
                setTip('事件雷达已关闭', false);
            } else {
                startRadar();
                ui.radarBtn.innerText = '事件雷达：开';
                setTip('事件雷达已开启（青色框为地图事件）', false);
            }
        });

        ui.noclipBtn.addEventListener('click', function () {
            var on = setNoclip(!window.cheatIsNoclipOn());
            ui.noclipBtn.innerText = '穿墙：' + (on ? '开' : '关');
            setTip('穿墙已' + (on ? '开启' : '关闭') + '（只对玩家生效）', false);
        });

        ui.winBtn.addEventListener('click', function () {
            var res = forceVictory();
            setTip(res.msg, !res.ok);
        });

        ui.loseBtn.addEventListener('click', function () {
            var res = forceDefeat();
            setTip(res.msg, !res.ok);
        });

        document.addEventListener('pointerdown', function (e) {
            if (!ui.open) return;
            if (e.target === host || host.contains(e.target)) return;
            togglePanel(false);
        }, true);

        window.addEventListener('resize', function () {
            var r = host.getBoundingClientRect();
            placeBall(r.left, r.top);
            placePanel();
        });
    }

    /** 原生悬浮球每帧/每次点击前把位置（CSS px）同步过来，面板据此贴边展开 */
    window.__rpgSetAnchor = function (x, y) {
        if (typeof x === 'number' && typeof y === 'number' &&
            isFinite(x) && isFinite(y)) {
            placeBall(x - BALL / 2, y - BALL / 2);
        }
    };

    // 原生侧调用：打开 / 关闭作弊面板
    window.__rpgOpenCheat = function () {
        if (!UI_ENABLED) return false;
        if (!ui.panel) buildUI();
        togglePanel(true);
        return !!ui.panel;
    };
    window.__rpgCloseCheat = function () { togglePanel(false); };

    window.cheatHelp = function () {
        console.log('[RPG] 作弊球点开即用；控制台可调用：cheatSetHp(9999) / cheatSetGold(999999) / ' +
            'cheatFillHp() / cheatHightlightEventPos() / cheatStopRadar() / cheatSetNoclip(true) / ' +
            'cheatIsNoclipOn() / cheatBattleVictory() / cheatBattleDefeat()（只把生命设为 0）');
    };

    function mountWhenBodyReady() {
        if (!UI_ENABLED) return;
        if (document.body) buildUI();
        else document.addEventListener('DOMContentLoaded', buildUI, { once: true });
    }

    mountWhenBodyReady();
    window.addEventListener('load', mountWhenBodyReady);

    report('已注入 ' + location.href);
})();
