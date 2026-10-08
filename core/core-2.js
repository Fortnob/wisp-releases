/*
 * Wisp core: the platform-independent feature layer.
 *
 * Runs in the top-level discord.com page (main world), after a small platform prelude has defined
 * window.WispHost. The same file is used by every platform; only the prelude differs.
 *
 * Host contract (window.WispHost):
 *   platform            "windows" | "macos" | "linux"
 *   send(msg, files?)   post a JSON message (and optionally File objects) to the native side
 *   on(cb)              cb(msg, objects) for messages from the native side
 *
 * Page → host:  hello, state, settings:set, compress, compress:cancel, split:open, split:close,
 *               account:open|add|rename|remove, vencord:choose, health, log, openExternal
 * Host → page:  init, settings, accounts, ui, navigate, compress:progress|done|error
 *
 * Discord internals are reached only through Vencord's public API (window.Vencord), which tracks
 * Discord's updates. Every feature declares what it needs; if a check fails after an update, only
 * that feature switches off and the host is told.
 */
(() => {
  'use strict';
  if (window.top !== window || window.__wisp) return;
  if (!/(^|\.)discord\.com$/.test(location.hostname)) return;
  const host = window.WispHost;
  if (!host) return;
  // Feature modules are exposed for debugging from DevTools (window.__wisp.features).
  const debug = window.__wisp = { features: {} };

  // ---- basics ----------------------------------------------------------------------

  const log = (...args) => console.log('%c[Wisp]', 'color:#48cdba;font-weight:bold', ...args);
  const report = (msg) => { try { host.send({ t: 'log', msg: String(msg) }); } catch { } };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const uid = () => Math.random().toString(36).slice(2, 10);

  async function waitFor(fn, timeout = 30000, interval = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch { }
      await sleep(interval);
    }
    return null;
  }

  // ---- early code patches ---------------------------------------------------------------
  // A few desktop-only parts of Discord's UI are worth having back when the host provides what
  // they need (e.g. the custom keybind editor, once keybinds work system-wide). Discord's code
  // arrives in webpack chunks pushed onto window.webpackChunkdiscord_app; Wisp edits the matching
  // module's source as its chunk is pushed, before webpack (and Vencord's own patcher, which
  // works one step later) ever sees it. A patch whose pattern no longer matches does nothing.

  const EARLY_PATCHES = [
    {
      // Settings → Keybinds: "desktop ? <editor> : <'not supported in the browser' banner>".
      name: 'customKeybindEditor',
      find: '.mPi3F3,',   // Discord's hashed key for KEYBIND_IN_BROSWER_NOTICE
      // Only the shape that matters: "<desktop>?<editor>:<anything within 200 chars mentioning the notice>".
      // (Discord renamed the notice's children: to message: in Oct 2026, which broke a stricter pattern.)
      match: /return [\w$]+\.[\w$]+\?(\(0,[\w$]+\.jsx\)\([\w$]+,\{\}\)):(?=[^;]{0,200}?\.t\.mPi3F3\b)/,
      replace: 'return true?$1:',
    },
    {
      // …and the section header's "Add a Keybind" button, gated the same way.
      name: 'addKeybindButton',
      find: 'id:"add-keybind"',
      match: /useHeaderDecoration:\(\)=>[\w$]+\.[\w$]+\?(?=\{type:[\w$]+\.[\w$]+\.BUTTON_GROUP,buttons:\[\{id:"add-keybind")/,
      replace: 'useHeaderDecoration:()=>true?',
    },
  ];

  // Patches for modules in Discord's main bundle, which webpack builds into its loader instead of
  // pushing as chunks, so the hook above never sees them. These go through Vencord's patcher,
  // registered as soon as Vencord exists. Each sets a marker when its module runs, so whether it
  // took effect can be checked (window.__wisp.mainPatches).
  const MAIN_PATCHES = [
    {
      // Discord's Spotify "auto pause while you talk or stream Spotify": check Wisp's setting first.
      name: 'spotifyNoAutoPause',
      find: '}getPlayableComputerDevices(){',
      // Replacements run in order on the already-replaced code, so the marker goes first.
      replacement: [
        { match: /(?=function \i\(\){if\(null==\i\)return;.{0,160}SPOTIFY_AUTO_PAUSED\))/, replace: 'window.__wispMark?.("spotifyNoAutoPause");' },
        { match: /(?<=function \i\(\){)(?=.{0,200}SPOTIFY_AUTO_PAUSED\))/, replace: 'if(window.__wispSpotifyNoPause?.())return;' },
      ],
    },
    {
      // Discord's web keybinds are bound in the page, which only sees keys while the page itself
      // has focus (and goes to whichever pane is focused). When Wisp's system-wide hook handles
      // keybinds, skip the in-page binding so every press is handled exactly once.
      name: 'keybindsExclusive',
      find: 'Failed to register native keybind',
      replacement: [
        { match: /(?=let \i=\{\},\i=\{\},\i=0,\i=!0,\i=\{\},\i=!1)/, replace: 'window.__wispMark?.("keybindsExclusive");' },
        { match: /else\{(?=\i\(\i\.toString\(\)\);let \i=\(0,\i\.\i\)\(document\);)/, replace: 'else{if(window.__wispOwnsKeybinds?.())return;' },
      ],
    },
  ];
  const mainPatchesApplied = new Set();
  Object.defineProperty(window, '__wispMark', { value: (name) => mainPatchesApplied.add(name) });
  // Wisp's hook handles keybinds (focused or not) when the feature is on and the patch took.
  const ownsKeybinds = () => mainPatchesApplied.has('keybindsExclusive') && has('globalKeybinds') && S?.features?.globalKeybinds?.enabled !== false;
  Object.defineProperty(window, '__wispOwnsKeybinds', { value: ownsKeybinds });
  (async () => {
    const plugins = await waitFor(() => typeof window.Vencord?.Plugins?.addPatch === 'function' && window.Vencord.Plugins, 60000, 2);
    for (const p of MAIN_PATCHES) {
      try { plugins?.addPatch({ find: p.find, replacement: p.replacement }, `Wisp:${p.name}`); }
      catch (err) { console.error('[Wisp] main patch failed', p.name, err); }
    }
  })();
  const appliedPatches = [];

  const patchedChunks = new WeakSet();
  const stalePatches = new Set();

  function patchChunk(chunk) {
    if (!chunk || typeof chunk !== 'object' || patchedChunks.has(chunk)) return;
    patchedChunks.add(chunk);
    if (appliedPatches.length === EARLY_PATCHES.length) return;
    const modules = chunk[1];
    if (!modules || typeof modules !== 'object') return;
    for (const id of Object.keys(modules)) {
      const factory = modules[id];
      if (typeof factory !== 'function') continue;
      let src = null;
      for (const p of EARLY_PATCHES) {
        if (appliedPatches.includes(p.name)) continue;
        src ??= Function.prototype.toString.call(factory);
        if (!src.includes(p.find)) continue;
        if (!p.match.test(src)) {
          // Its code is here but has changed: a Discord update broke this patch. Tell the host,
          // which looks for a fix right away.
          if (!stalePatches.has(p.name)) {
            stalePatches.add(p.name);
            setTimeout(() => { report(`code patch no longer matches: ${p.name}`); host.send({ t: 'patch:stale', name: p.name }); }, 0);
          }
          continue;
        }
        const patched = src.replace(p.match, p.replace);
        try {
          // Factories are arrow functions, `function(…){…}`, or object-method shorthand
          // (`309154(e,t,n){…}`); the last isn't an expression on its own, so name → `function`.
          const isExpr = /^(async\s+)?function\b/.test(patched) || /^(\([^)]*\)|[\w$]+)\s*=>/.test(patched);
          const expr = isExpr ? patched : patched.replace(/^[^(]+/, 'function');
          modules[id] = (0, eval)(`(${expr})\n//# sourceURL=WispPatched_${id}`);
          src = patched;
          appliedPatches.push(p.name);
          setTimeout(() => report(`code patch applied: ${p.name}`), 0);
        } catch (err) {
          console.error('[Wisp] patch failed', p.name, err);
        }
      }
    }
  }

  (() => {
    const hookArray = (arr) => {
      if (!Array.isArray(arr) || arr.__wisp) return;
      Object.defineProperty(arr, '__wisp', { value: true });
      for (const chunk of arr) patchChunk(chunk);   // pushed before we got here
      // Whatever function is assigned to `push` (webpack's loader, or anything wrapping it) is
      // itself wrapped so chunks are patched first. Callers that keep the previous `push` get the
      // previous wrapper, so the chain behaves exactly as it would without Wisp.
      const wrap = (fn) => function (...chunks) {
        for (const c of chunks) patchChunk(c);
        return fn.apply(this, chunks);
      };
      let pushFn = wrap(Array.prototype.push);
      Object.defineProperty(arr, 'push', { configurable: true, get: () => pushFn, set: (fn) => { pushFn = wrap(fn); } });
    };
    let current = window.webpackChunkdiscord_app;
    if (current) hookArray(current);
    Object.defineProperty(window, 'webpackChunkdiscord_app', {
      configurable: true,
      get: () => current,
      set: (v) => { current = v; hookArray(v); },
    });
  })();

  // Discord deletes window.localStorage/sessionStorage once it loads; this script runs first.
  const session = (() => { try { return window.sessionStorage; } catch { return null; } })();
  const MiB = 1024 * 1024;
  let init = null;       // host init payload
  let S = null;          // settings (host-owned; page sends patches)
  let accounts = [];
  const handlers = new Map();
  const on = (type, fn) => handlers.set(type, fn);

  host.on((msg, objects) => {
    const fn = msg && handlers.get(msg.t);
    if (fn) Promise.resolve(fn(msg, objects)).catch(err => { console.error('[Wisp]', err); report(`handler ${msg.t}: ${err}`); });
  });

  const ready = new Promise(resolve => on('init', (msg) => {
    const again = !!init;
    init = msg;
    S = msg.settings;
    accounts = msg.accounts || [];
    resolve();
    if (again) ui.refresh();   // e.g. a new Vencord version was installed
  }));
  // Messages posted while the document is still being created can be dropped, so keep saying
  // hello until the host answers.
  (async () => {
    for (let i = 0; !init && i < 60; i++) {
      try { host.send({ t: 'hello' }); } catch { }
      await sleep(i < 10 ? 250 : 1000);
    }
  })();

  const settingsListeners = new Set();
  on('settings', (msg) => {
    S = msg.settings;
    applySettings();
    ui.refresh();
    titlebar.render();
    for (const fn of settingsListeners) try { fn(S); } catch { }
  });
  on('accounts', (msg) => { accounts = msg.accounts; ui.refresh(); });

  function setSettings(patch) {
    host.send({ t: 'settings:set', patch });
  }

  const has = (cap) => !!init?.capabilities?.includes(cap);

  // GET through the host, for APIs that don't allow cross-origin requests from discord.com.
  // The host only fetches from its own allowlist (theme stores and their file hosts).
  const fetchJobs = new Map();
  on('fetch:done', (m) => {
    const job = fetchJobs.get(m.id);
    if (!job) return;
    fetchJobs.delete(m.id);
    if (m.ok) job.resolve({ status: m.status, body: m.body });
    else job.reject(new Error(m.error || `HTTP ${m.status}`));
  });
  /** opts.binary: body comes back base64-encoded (for images). */
  function hostFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const id = uid();
      fetchJobs.set(id, { resolve, reject });
      host.send({ t: 'fetch', id, url, binary: !!opts.binary });
      setTimeout(() => { if (fetchJobs.delete(id)) reject(new Error('Request timed out')); }, 30000);
    });
  }

  // ---- Spotify auto-pause -----------------------------------------------------------------
  // Discord pauses your Spotify after you've been transmitting in voice for a while. Wisp patches
  // that one function (through Vencord, before Discord's code runs) to check a setting first, so
  // the behaviour can be switched back on live. Only the auto-pause is touched.
  // (The patch itself is "spotifyNoAutoPause" in EARLY_PATCHES above.)
  Object.defineProperty(window, '__wispSpotifyNoPause', {
    value: () => S?.features?.spotifyNoAutoPause?.enabled !== false,
  });

  // ---- screen-share audio ---------------------------------------------------------------
  // The engine's own "share system audio" would include the call itself, so viewers hear an
  // echo. When the host supports it, Wisp swaps that for audio captured natively: the shared
  // window's app only, or for a full screen everything except Wisp. Patched here at document
  // start so Discord's and Vencord's wrappers end up calling this version.

  const WORKLET = `
    class WispAppAudio extends AudioWorkletProcessor {
      constructor() {
        super();
        this.queue = []; this.offset = 0; this.frames = 0; this.playing = false;
        this.port.onmessage = (e) => {
          this.queue.push(e.data); this.frames += e.data.length / 2;
          // Keep latency bounded if the capture clock runs ahead of ours: drop the oldest audio.
          while (this.frames > sampleRate * 0.25 && this.queue.length > 1) {
            const old = this.queue.shift(); this.frames -= (old.length - this.offset) / 2; this.offset = 0;
          }
        };
      }
      process(_, outputs) {
        const [left, right] = outputs[0];
        if (!this.playing && this.frames < sampleRate * 0.06) { left.fill(0); right.fill(0); return true; }
        this.playing = true;
        for (let i = 0; i < left.length; i++) {
          const chunk = this.queue[0];
          if (!chunk) { left[i] = right[i] = 0; this.playing = false; continue; }
          left[i] = chunk[this.offset]; right[i] = chunk[this.offset + 1];
          this.offset += 2; this.frames--;
          if (this.offset >= chunk.length) { this.queue.shift(); this.offset = 0; }
        }
        return true;
      }
    }
    registerProcessor('wisp-app-audio', WispAppAudio);`;

  const appAudio = {
    ctx: null,
    pending: new Map(),
    streams: new Map(),
    async ensureContext() {
      if (!this.ctx) {
        this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        await this.ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
      }
      if (this.ctx.state !== 'running') await this.ctx.resume();
    },
    async attach(stream) {
      const video = stream.getVideoTracks()[0];
      if (!video) return;
      const id = uid();
      const started = new Promise(res => this.pending.set(id, res));
      host.send({ t: 'appaudio:start', id, surface: video.getSettings().displaySurface || '', label: video.label });
      const result = await Promise.race([started, sleep(4000).then(() => ({ ok: false, error: 'timed out' }))]);
      this.pending.delete(id);
      if (!result.ok) {
        // Keep whatever audio the engine provided rather than sending none.
        report(`app audio unavailable: ${result.error}`);
        host.send({ t: 'appaudio:stop', id });
        return;
      }
      await this.ensureContext();
      const node = new AudioWorkletNode(this.ctx, 'wisp-app-audio', { numberOfInputs: 0, outputChannelCount: [2] });
      const dest = this.ctx.createMediaStreamDestination();
      node.connect(dest);
      const track = dest.stream.getAudioTracks()[0];
      this.streams.set(id, { node, track });
      for (const t of stream.getAudioTracks()) { stream.removeTrack(t); t.stop(); }
      stream.addTrack(track);

      const stop = () => this.stop(id);
      video.addEventListener('ended', stop, { once: true });
      for (const t of [video, track]) {
        const original = t.stop.bind(t);
        t.stop = () => { stop(); original(); };
      }
      log('screen-share audio:', result.mode === 'app' ? 'shared app only' : 'system audio without Wisp');
    },
    feed(id, base64) {
      const s = this.streams.get(id);
      if (!s) return;
      const bin = atob(base64);
      const pcm = new Int16Array(bin.length / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) << 16 >> 16;
      const f32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
      s.node.port.postMessage(f32, [f32.buffer]);
    },
    stop(id) {
      const s = this.streams.get(id);
      if (!s) return;
      this.streams.delete(id);
      host.send({ t: 'appaudio:stop', id });
      s.node.disconnect();
      if (!this.streams.size) this.ctx?.suspend();
    },
  };
  on('appaudio:started', (m) => appAudio.pending.get(m.id)?.(m));
  on('appaudio:data', (m) => appAudio.feed(m.id, m.d));

  const nativeGetDisplayMedia = window.MediaDevices?.prototype.getDisplayMedia;
  if (nativeGetDisplayMedia) {
    MediaDevices.prototype.getDisplayMedia = async function (constraints) {
      const stream = await nativeGetDisplayMedia.call(this, constraints);
      if (constraints?.audio && has('appAudio') && S?.features?.appAudio?.enabled !== false) {
        try { await appAudio.attach(stream); } catch (err) { report(`appAudio: ${err?.stack || err}`); }
      }
      return stream;
    };
  }

  // ---- Discord access (through Vencord) ----------------------------------------------

  let V = null;

  // Discord registers its keybind actions (push-to-talk, toggle mute, …) exactly once, early in
  // startup, through a Flux event; the table isn't reachable afterwards. Subscribe as soon as
  // Vencord can hand us the dispatcher so global keybinds can call the same handlers.
  let keybindActions = null;
  (async () => {
    const W = await waitFor(() => window.Vencord?.Webpack?.waitFor && window.Vencord.Webpack, 60000, 5);
    W?.waitFor(['dispatch', 'subscribe'], (fd) => {
      try {
        fd.subscribe('KEYBINDS_REGISTER_GLOBAL_KEYBIND_ACTIONS', (e) => {
          keybindActions = e.keybinds;
          globalKeybinds.sync();
        });
      } catch (err) { report(`keybind capture: ${err}`); }
    });
  })();
  const C = new Proxy({}, { get: (_, k) => V?.Webpack?.Common?.[k] });

  function findStore(name) {
    try { return V?.Webpack?.findStore?.(name) ?? null; } catch { return null; }
  }
  function findByProps(...props) {
    try { return V?.Webpack?.findByProps?.(...props) ?? null; } catch { return null; }
  }

  const checks = {
    flux: () => typeof C.FluxDispatcher?.subscribe === 'function',
    users: () => typeof C.UserStore?.getCurrentUser === 'function',
    channels: () => typeof C.ChannelStore?.getChannel === 'function' && typeof C.SelectedChannelStore?.getChannelId === 'function',
    guilds: () => typeof C.GuildStore?.getGuild === 'function',
    voice: () => typeof C.VoiceStateStore?.getVoiceStatesForChannel === 'function' && typeof C.SelectedChannelStore?.getVoiceChannelId === 'function',
    router: () => typeof C.NavigationRouter?.transitionTo === 'function',
    upload: () => typeof C.UploadHandler?.promptToUpload === 'function',
    send: () => typeof C.MessageActions?.sendMessage === 'function',
    drafts: () => typeof C.DraftStore?.getDraft === 'function',
    componentDispatch: () => typeof C.ComponentDispatch?.dispatchToLastSubscribed === 'function',
    messageEvents: () => typeof V?.Api?.MessageEvents?.addMessagePreSendListener === 'function',
    contextMenu: () => typeof V?.Api?.ContextMenu?.addContextMenuPatch === 'function',
    menu: () => !!C.Menu?.MenuItem && typeof C.React?.createElement === 'function',
    keybinds: () => typeof findStore('KeybindsStore')?.getUserAgnosticState === 'function' && !!keybindActions,
  };

  const FEATURES = {
    keywordAlerts: { label: 'Keyword alerts', needs: ['flux', 'users', 'channels', 'guilds', 'router'] },
    voiceLog: { label: 'Voice log', needs: ['flux', 'users', 'voice', 'channels'] },
    linkCleaning: { label: 'Link cleaning', needs: ['messageEvents'] },
    splitMessages: { label: 'Split long messages', needs: ['users', 'channels', 'send', 'drafts', 'componentDispatch'] },
    compressUploads: { label: 'Upload compression', needs: ['users', 'channels', 'guilds', 'upload'] },
    splitView: { label: 'Split view menu', needs: ['contextMenu', 'menu', 'channels', 'router'] },
    globalKeybinds: { label: 'Global keybinds', needs: ['keybinds'] },
    richPresence: { label: 'Game activity & Rich Presence', needs: ['flux'] },
    animations: { label: 'Pause GIFs & animations', needs: ['flux', 'contextMenu', 'menu', 'channels'] },
    overlay: { label: 'In-game overlay', needs: ['users', 'voice', 'channels'] },
  };
  const healthy = {};   // feature -> boolean
  const isOn = (f) => !!(healthy[f] && S?.features?.[f]?.enabled);

  function runChecks() {
    const results = {};
    for (const [name, fn] of Object.entries(checks)) {
      try { results[name] = !!fn(); } catch { results[name] = false; }
    }
    const ok = [], failed = [];
    for (const [f, def] of Object.entries(FEATURES)) {
      healthy[f] = def.needs.every(n => results[n]);
      (healthy[f] ? ok : failed).push(f);
    }
    return { ok, failed, results };
  }

  function isPluginEnabled(name) {
    try {
      if (typeof V.Plugins?.isPluginEnabled === 'function') return V.Plugins.isPluginEnabled(name);
      return !!V.Settings?.plugins?.[name]?.enabled;
    } catch { return false; }
  }

  /**
   * Vencord only patches Discord for API plugins that are switched on, and patches apply at page
   * load. If a feature needs one that's off, switch it on and reload once.
   */
  function ensureVencordApis() {
    const needed = ['MessageEventsAPI'].filter(n => !isPluginEnabled(n));
    if (!needed.length) return false;
    const key = 'wisp:api-reload';
    if (session?.getItem(key)) {
      report(`Vencord APIs still off after reload: ${needed.join(', ')}`);
      return false;
    }
    try {
      for (const n of needed) V.Settings.plugins[n].enabled = true;
    } catch (err) {
      report(`Couldn't enable ${needed.join(', ')}: ${err}`);
      return false;
    }
    session?.setItem(key, '1');
    toast('Wisp switched on a Vencord API it needs. Reloading once…');
    setTimeout(() => location.reload(), 1500);
    return true;
  }

  // ---- startup -------------------------------------------------------------------------

  (async () => {
    await ready;
    await domReady();
    ui.mount();
    installShortcuts();
    titlebar.start();
    applySettings();

    V = await waitFor(() => window.Vencord?.Webpack?.Common && window.Vencord, 45000);
    if (!V) {
      log('Vencord not found; extra features are off.');
      host.send({ t: 'health', ok: [], failed: [], vencord: false });
      ui.refresh();
      return;
    }
    if (V.Webpack.onceReady) await V.Webpack.onceReady;
    await waitFor(() => checks.flux() && checks.users() && C.UserStore.getCurrentUser(), 60000, 250);

    if (ensureVencordApis()) return;
    session?.removeItem('wisp:api-reload');

    const health = runChecks();
    log('health', health);
    host.send({ t: 'health', ok: health.ok, failed: health.failed, vencord: true });

    voiceState.start();
    settingsHome.start();
    if (healthy.keywordAlerts) keywordAlerts.start();
    if (healthy.voiceLog) voiceLog.start();
    if (healthy.linkCleaning) linkCleaning.start();
    if (healthy.splitMessages) splitMessages.start();
    if (healthy.compressUploads) compress.start();
    if (healthy.splitView) splitView.start();
    if (healthy.globalKeybinds) { globalKeybinds.start(); webNotices.start(); inPageKeybinds.start(); globalKeybinds.sync(); }
    if (healthy.richPresence) richPresence.start();
    if (healthy.animations) animations.start();
    if (healthy.overlay && has('overlay') && init?.role === 'main') overlayFeed.start();

    // Further feature modules (core/library.js, …) register on window.__wispModules and get
    // this context once Discord and Vencord are ready.
    const ctx = {
      V, C, host, on, log, report, toast, hostFetch, has, findStore, findByProps, setSettings,
      get settings() { return S; },
      get init() { return init; },
      onSettings: (fn) => settingsListeners.add(fn),
      // Shared helpers for modules.
      channelLabel, displayName, avatarUrl, currentChannel, channelPath,
      dialog: (...a) => ui.dialog(...a),
      /** Add an icon button to the title bar (left of the memory readout). */
      addTitlebarButton: (btn) => { titlebar.extra.push(btn); titlebar.render(); },
    };
    for (const mod of window.__wispModules || []) {
      try { mod(ctx); } catch (err) { report(`module failed: ${err?.stack || err}`); }
    }
    applySettings();
    ui.refresh();
  })().catch(err => { console.error('[Wisp] startup failed', err); report(`startup failed: ${err?.stack || err}`); });

  function domReady() {
    return document.readyState === 'loading'
      ? new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }))
      : Promise.resolve();
  }

  function applySettings() {
    // Data attributes, not classes: Discord rewrites <html>'s className when it applies themes.
    const root = document.documentElement;
    root.dataset.wispPane = init?.role ?? 'main';
    root.toggleAttribute('data-wisp-compact',
      init?.role === 'split' && !!S?.features?.splitView?.compactPane && !splitView.sidebarsShown);
    keywordAlerts.compile();
    inPageKeybinds.reconcile();
    globalKeybinds.sync();
    if (healthy.animations) animations.sync();
    if (richPresence.started && !isOn('richPresence')) richPresence.clearAll();
    overlayFeed.kick?.();
  }

  // ---- helpers over Discord state --------------------------------------------------------

  const me = () => C.UserStore?.getCurrentUser?.();
  const currentChannel = () => {
    const id = C.SelectedChannelStore?.getChannelId?.();
    return id ? C.ChannelStore.getChannel(id) : null;
  };
  const displayName = (u) => u?.globalName || u?.global_name || u?.username || 'Someone';
  const avatarUrl = (u) => {
    if (!u) return undefined;
    try { if (typeof u.getAvatarURL === 'function') return u.getAvatarURL(undefined, 64, false); } catch { }
    return u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : 'https://cdn.discordapp.com/embed/avatars/0.png';
  };
  const channelPath = (ch, messageId) =>
    `/channels/${ch.guild_id || '@me'}/${ch.id}${messageId ? '/' + messageId : ''}`;
  function channelLabel(ch) {
    if (!ch) return 'a channel';
    if (ch.guild_id) {
      const g = C.GuildStore.getGuild(ch.guild_id);
      return `#${ch.name}${g ? ' · ' + g.name : ''}`;
    }
    if (ch.name) return ch.name;
    const other = ch.recipients?.[0] && C.UserStore.getUser(ch.recipients[0]);
    return other ? `DM with ${displayName(other)}` : 'a DM';
  }

  async function notify({ title, body, icon, tag, path }) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return;
    const n = new Notification(title, { body, icon, tag });
    n.onclick = () => {
      window.focus();
      if (path) C.NavigationRouter?.transitionTo(path);
    };
  }

  // ---- voice state → host (idle mode must never throttle a call) ------------------------

  const voiceState = {
    last: null,
    start() {
      const push = () => {
        let inVoice = false;
        try { inVoice = !!C.SelectedChannelStore?.getVoiceChannelId?.(); } catch { }
        if (inVoice !== this.last) {
          this.last = inVoice;
          host.send({ t: 'state', inVoice });
        }
        voiceLog.sync();
      };
      try { C.FluxDispatcher.subscribe('VOICE_CHANNEL_SELECT', () => setTimeout(push, 0)); } catch { }
      setInterval(push, 2000);
      push();
    },
  };

  // ---- feature: keyword alerts ------------------------------------------------------------

  const keywordAlerts = {
    rules: [],
    recent: new Map(),   // channelId -> last alert time
    compile() {
      const list = S?.features?.keywordAlerts?.keywords || [];
      this.rules = list.map(raw => String(raw).trim()).filter(Boolean).map(raw => {
        const m = /^\/(.+)\/([a-z]*)$/.exec(raw);
        try {
          if (m) return { label: raw, re: new RegExp(m[1], m[2].replace(/[gy]/g, '')) };
          const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return { label: raw, re: new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'iu') };
        } catch {
          return null;
        }
      }).filter(Boolean);
    },
    start() {
      this.compile();
      C.FluxDispatcher.subscribe('MESSAGE_CREATE', (e) => {
        try { this.onMessage(e); } catch (err) { report(`keywordAlerts: ${err}`); }
      });
    },
    isMuted(guildId, ch) {
      const ugs = findStore('UserGuildSettingsStore');
      if (!ugs) return false;
      try {
        return (guildId && ugs.isMuted?.(guildId))
          || ugs.isChannelMuted?.(guildId ?? null, ch.id)
          || (ch.parent_id && ugs.isChannelMuted?.(guildId ?? null, ch.parent_id))
          || false;
      } catch { return false; }
    },
    onMessage({ message, optimistic, isPushNotification }) {
      const cfg = S?.features?.keywordAlerts;
      if (optimistic || isPushNotification || !isOn('keywordAlerts') || !this.rules.length || !message) return;
      const self = me(), author = message.author;
      if (!self || !author || author.id === self.id) return;
      if (author.bot && cfg.ignoreBots) return;
      // Discord already notifies for direct mentions.
      if (message.mention_everyone || (message.mentions || []).some(u => (u?.id ?? u) === self.id)) return;
      if (C.RelationshipStore?.isBlocked?.(author.id)) return;

      const ch = C.ChannelStore.getChannel(message.channel_id);
      if (!ch) return;
      const guildId = message.guild_id || ch.guild_id;
      if (cfg.ignoreMuted && this.isMuted(guildId, ch)) return;
      if (document.hasFocus() && C.SelectedChannelStore.getChannelId() === ch.id) return;

      const text = [message.content, ...(message.embeds || []).flatMap(e => [e.title, e.description])]
        .filter(Boolean).join('\n');
      const rule = this.rules.find(r => r.re.test(text));
      if (!rule) return;

      const now = Date.now();
      if (now - (this.recent.get(ch.id) || 0) < 10000) return;
      this.recent.set(ch.id, now);

      const m = rule.re.exec(text);
      const at = m ? m.index : 0;
      const start = Math.max(0, at - 60);
      const snippet = (start > 0 ? '…' : '') + text.slice(start, start + 180).replace(/\s+/g, ' ') + (text.length > start + 180 ? '…' : '');
      notify({
        title: `"${rule.label}" in ${channelLabel(ch)}`,
        body: `${displayName(author)}: ${snippet}`,
        icon: avatarUrl(author),
        tag: `wisp-kw-${message.id}`,
        path: channelPath(ch, message.id),
      });
    },
  };

  // ---- feature: voice log --------------------------------------------------------------

  const voiceLog = {
    entries: [],
    channelId: null,
    members: new Map(),  // userId -> { selfStream, selfVideo }
    started: false,
    start() {
      this.started = true;
      C.FluxDispatcher.subscribe('VOICE_STATE_UPDATES', ({ voiceStates }) => {
        try { this.onUpdates(voiceStates || []); } catch (err) { report(`voiceLog: ${err}`); }
      });
      this.sync();
    },
    add(kind, userId, extra) {
      const user = userId ? C.UserStore.getUser(userId) : null;
      this.entries.unshift({ ts: Date.now(), kind, userId, name: displayName(user), avatar: avatarUrl(user), extra });
      if (this.entries.length > 500) this.entries.length = 500;
      ui.voiceLogChanged();
    },
    snapshot(channelId) {
      this.members.clear();
      if (!channelId) return;
      const states = C.VoiceStateStore.getVoiceStatesForChannel(channelId) || {};
      for (const vs of Object.values(states)) {
        const id = vs.userId ?? vs.user_id;
        if (id) this.members.set(id, { selfStream: !!(vs.selfStream ?? vs.self_stream), selfVideo: !!(vs.selfVideo ?? vs.self_video) });
      }
    },
    /** Notice our own join/leave/move. Returns true when the channel changed. */
    sync() {
      if (!this.started) return false;
      const now = C.SelectedChannelStore.getVoiceChannelId() || null;
      if (now === this.channelId) return false;
      const prev = this.channelId;
      this.channelId = now;
      if (now) this.add(prev ? 'self-move' : 'self-join', me()?.id, channelLabel(C.ChannelStore.getChannel(now)));
      else this.add('self-leave', me()?.id, channelLabel(C.ChannelStore.getChannel(prev)));
      this.snapshot(now);
      return true;
    },
    onUpdates(states) {
      const changed = this.sync();
      const mine = this.channelId;
      const selfId = me()?.id;
      for (const vs of states) {
        const id = vs.userId ?? vs.user_id;
        const ch = vs.channelId ?? vs.channel_id ?? null;
        if (!id || id === selfId) continue;
        const next = { selfStream: !!(vs.selfStream ?? vs.self_stream), selfVideo: !!(vs.selfVideo ?? vs.self_video) };
        const prev = this.members.get(id);
        if (mine && ch === mine) {
          if (!changed) {
            if (!prev) this.add('join', id);
            else {
              if (next.selfStream !== prev.selfStream) this.add(next.selfStream ? 'stream-on' : 'stream-off', id);
              if (next.selfVideo !== prev.selfVideo) this.add(next.selfVideo ? 'video-on' : 'video-off', id);
            }
          }
          this.members.set(id, next);
        } else if (prev) {
          this.members.delete(id);
          if (!changed) this.add(ch ? 'move' : 'leave', id, ch ? channelLabel(C.ChannelStore.getChannel(ch)) : undefined);
        }
      }
    },
  };

  // ---- feature: link cleaning ----------------------------------------------------------------

  const linkCleaning = {
    generic: /^(utm_[a-z_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|yclid|_hsenc|_hsmi|mkt_tok|vero_id|vero_conv|oly_anon_id|oly_enc_id|rb_clickid|s_cid|twclid|ttclid|li_fat_id|wickedid|igshid|igsh|ref_src|ref_url|__s|_openstat|spm)$/i,
    perHost: [
      [/(^|\.)youtube\.com$|^youtu\.be$/, /^(si|pp|feature)$/],
      [/^open\.spotify\.com$/, /^(si|context|nd)$/],
      [/(^|\.)(twitter|x)\.com$/, /^(s|t)$/],
      [/(^|\.)instagram\.com$/, /^(igsh|igshid|img_index)$/],
      [/(^|\.)tiktok\.com$/, /^(_r|_t|is_from_webapp|sender_device|is_copy_url|share_[a-z_]+)$/],
      [/(^|\.)reddit\.com$/, /^(share_id|rdt|ref|ref_source)$/],
      [/(^|\.)music\.apple\.com$/, /^(ls|app)$/],
      [/(^|\.)amazon\.[a-z.]+$/, /^(ref_?|pd_rd_[a-z]+|pf_rd_[a-z]+|content-id|psc|th|crid|sprefix|qid|sr|keywords|dib|dib_tag)$/i],
    ],
    start() {
      const api = V.Api.MessageEvents;
      api.addMessagePreSendListener((_, msg) => { if (isOn('linkCleaning') && msg?.content) msg.content = this.clean(msg.content); });
      api.addMessagePreEditListener?.((_, __, msg) => { if (isOn('linkCleaning') && msg?.content) msg.content = this.clean(msg.content); });
    },
    /** Clean URLs outside code blocks and inline code. */
    clean(text) {
      return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) =>
        i % 2 ? part : part.replace(/https?:\/\/[^\s<>]+/g, (url) => this.cleanUrl(url))).join('');
    },
    cleanUrl(raw) {
      // Keep trailing punctuation (and a closing paren that isn't part of the URL) out of the URL.
      const tail = /[.,!?:;'"]+$|\)+$/.exec(raw)?.[0] ?? '';
      let urlText = tail ? raw.slice(0, -tail.length) : raw;
      if (tail.startsWith(')') && (urlText.match(/\(/g) || []).length > (urlText.match(/\)/g) || []).length) return raw;
      let url;
      try { url = new URL(urlText); } catch { return raw; }
      const qIndex = urlText.indexOf('?');
      if (qIndex < 0) return raw;
      const hashIndex = urlText.indexOf('#', qIndex);
      const query = urlText.slice(qIndex + 1, hashIndex < 0 ? undefined : hashIndex);
      const hostRule = this.perHost.find(([h]) => h.test(url.hostname))?.[1];
      const kept = query.split('&').filter(pair => {
        if (!pair) return false;
        let key = pair.split('=')[0];
        try { key = decodeURIComponent(key); } catch { }
        return !(this.generic.test(key) || hostRule?.test(key));
      });
      if (kept.length === query.split('&').filter(Boolean).length) return raw;
      const base = urlText.slice(0, qIndex);
      const hash = hashIndex < 0 ? '' : urlText.slice(hashIndex);
      return base + (kept.length ? '?' + kept.join('&') : '') + hash + tail;
    },
  };

  // ---- feature: split long messages -------------------------------------------------------------

  const splitMessages = {
    busy: false,
    start() {
      window.addEventListener('keydown', (e) => this.onKeyDown(e), true);
    },
    limit() {
      return me()?.premiumType === 2 ? 4000 : 2000;
    },
    onKeyDown(e) {
      if (!isOn('splitMessages') || e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      const target = e.target;
      const editor = target?.closest?.('[role="textbox"][data-slate-editor="true"]');
      // Only the channel composer (inside a form), not the inline message editor.
      if (!editor || !editor.closest('form') || editor.closest('[id^="chat-messages-"]')) return;
      const ch = currentChannel();
      if (!ch) return;
      const draft = C.DraftStore.getDraft(ch.id, 0) || '';
      const limit = this.limit();
      if (draft.length <= limit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!this.busy) this.send(ch, draft, limit);
    },
    split(text, limit) {
      const parts = [];
      let rest = text.replace(/^\s+/, '');
      let openLang = null;
      while (rest.length) {
        const prefix = openLang === null ? '' : '```' + openLang + '\n';
        if (prefix.length + rest.length <= limit) { parts.push(prefix + rest); break; }
        const room = limit - prefix.length - 4;   // leave space to close a code block
        let cut = this.findCut(rest, room);
        let chunk = rest.slice(0, cut).replace(/\s+$/, '');
        rest = rest.slice(cut).replace(/^\s*\n/, '').replace(/^ +/, '');
        const lang = this.unclosedFence(prefix + chunk);
        if (lang !== null) chunk += '\n```';
        openLang = lang;
        parts.push(prefix + chunk);
      }
      return parts.filter(p => p.trim().length);
    },
    findCut(s, max) {
      const window_ = s.slice(0, max);
      const min = Math.floor(max * 0.5);
      for (const sep of ['\n\n', '\n', '. ', '! ', '? ', ' ']) {
        const i = window_.lastIndexOf(sep);
        if (i >= min) return i + sep.length;
      }
      let cut = max;
      const code = s.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;   // don't split a surrogate pair
      return cut;
    },
    /** Language tag of a ``` block left open at the end of text, '' for no tag, or null. */
    unclosedFence(text) {
      let open = null;
      for (const m of text.matchAll(/```([\w+-]*)/g)) open = open === null ? m[1] : null;
      return open;
    },
    async send(ch, draft, limit) {
      const parts = this.split(draft, limit);
      const confirmAbove = S.features.splitMessages.confirmAbove ?? 3;
      if (parts.length > confirmAbove && !(await ui.confirm(`Send as ${parts.length} messages?`,
        `This message is ${draft.length.toLocaleString()} characters; the limit is ${limit.toLocaleString()}.`))) return;

      this.busy = true;
      try {
        const parser = findByProps('parse', 'parsePreprocessor');
        const reply = findStore('PendingReplyStore')?.getPendingReply?.(ch.id);
        for (let i = 0; i < parts.length; i++) {
          let msg = { content: parts[i], tts: false, invalidEmojis: [], validNonShortcutEmojis: [] };
          try { if (parser) msg = { ...parser.parse(ch, parts[i]), tts: false }; } catch { }
          const options = {};
          if (i === 0 && reply?.message) {
            options.messageReference = { guild_id: ch.guild_id, channel_id: ch.id, message_id: reply.message.id };
            if (reply.shouldMention === false) options.allowedMentions = { parse: ['users', 'roles', 'everyone'], replied_user: false };
          }
          await C.MessageActions.sendMessage(ch.id, msg, undefined, options);
          if (i < parts.length - 1) await sleep(400);
        }
        if (reply) C.FluxDispatcher.dispatch({ type: 'DELETE_PENDING_REPLY', channelId: ch.id });
        C.ComponentDispatch.dispatchToLastSubscribed('CLEAR_TEXT');
        C.FluxDispatcher.dispatch({ type: 'DRAFT_CLEAR', channelId: ch.id, draftType: 0 });
      } catch (err) {
        report(`splitMessages: ${err}`);
        toast('Couldn\'t send all parts of the message: ' + (err?.message || err), 'error');
      } finally {
        this.busy = false;
      }
    },
  };

  // ---- feature: upload compression -------------------------------------------------------------

  const compress = {
    jobs: new Map(),
    start() {
      window.addEventListener('drop', (e) => this.onTransfer(e, e.dataTransfer), true);
      window.addEventListener('paste', (e) => this.onTransfer(e, e.clipboardData), true);
      window.addEventListener('change', (e) => this.onInputChange(e), true);
      on('compress:progress', ({ id, progress }) => this.jobs.get(id)?.progress(progress));
      on('compress:done', async ({ id }, objects) => {
        const job = this.jobs.get(id);
        if (!job) return;
        this.jobs.delete(id);
        try {
          const file = await objects[0].getFile();
          job.resolve(new File([file], rename(job.name, 'mp4'), { type: 'video/mp4' }));
        } catch (err) { job.reject(err); }
      });
      on('compress:error', ({ id, message }) => {
        const job = this.jobs.get(id);
        if (!job) return;
        this.jobs.delete(id);
        job.reject(new Error(message));
      });
    },
    limitFor(ch) {
      const t = me()?.premiumType;
      let limit = t === 2 ? 500 * MiB : (t === 1 || t === 3) ? 50 * MiB : 10 * MiB;
      const tier = ch?.guild_id ? C.GuildStore.getGuild(ch.guild_id)?.premiumTier : 0;
      if (tier === 2) limit = Math.max(limit, 50 * MiB);
      if (tier === 3) limit = Math.max(limit, 100 * MiB);
      return limit;
    },
    compressible(f) {
      const cfg = S.features.compressUploads;
      if (/^image\/(jpeg|png|webp|bmp)$/.test(f.type)) return cfg.images;
      if (f.type.startsWith('video/')) return cfg.videos && has('compressVideo');
      return false;
    },
    needsWork(files, ch) {
      const limit = this.limitFor(ch);
      return files.some(f => f.size > limit && this.compressible(f));
    },
    onTransfer(e, data) {
      if (!isOn('compressUploads')) return;
      const files = [...(data?.files || [])];
      const ch = currentChannel();
      if (!files.length || !ch || !this.needsWork(files, ch)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'drop') {
        // Let Discord take down its "drop to upload" overlay.
        window.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
        document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      }
      this.handle(files, ch);
    },
    onInputChange(e) {
      const input = e.target;
      if (!isOn('compressUploads') || !(input instanceof HTMLInputElement) || input.type !== 'file') return;
      // Only the chat composer's upload input; avatars, emoji and banners have their own limits.
      if (!input.closest('form') || input.closest('[role="dialog"]')) return;
      const files = [...(input.files || [])];
      const ch = currentChannel();
      if (!files.length || !ch || !this.needsWork(files, ch)) return;
      e.stopImmediatePropagation();
      input.value = '';
      this.handle(files, ch);
    },
    async handle(files, ch) {
      const limit = this.limitFor(ch);
      const target = Math.floor(limit * 0.95);
      const out = [];
      for (const f of files) {
        if (f.size <= limit || !this.compressible(f)) { out.push(f); continue; }
        const t = toast(`Compressing ${f.name}…`, 'progress');
        try {
          const small = f.type.startsWith('image/')
            ? await this.image(f, target)
            : await this.video(f, target, p => t.progress(p));
          t.done(`${f.name}: ${fmtSize(f.size)} → ${fmtSize(small.size)}`);
          out.push(small);
        } catch (err) {
          t.fail(`${f.name}: ${err?.message || err}`);
        }
      }
      if (out.length) C.UploadHandler.promptToUpload(out, ch, 0);
    },
    async image(file, target) {
      const bmp = await createImageBitmap(file);
      const maxDim = 4096;
      let scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      let quality = 0.9;
      for (let i = 0; i < 10; i++) {
        const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
        if (blob.size <= target) {
          bmp.close();
          return new File([blob], rename(file.name, 'webp'), { type: 'image/webp' });
        }
        if (quality > 0.72) quality -= 0.08;
        else scale *= Math.max(0.5, Math.sqrt(target / blob.size) * 0.95);
      }
      bmp.close();
      throw new Error('couldn\'t shrink the image enough');
    },
    video(file, target, onProgress) {
      const id = uid();
      return new Promise((resolve, reject) => {
        this.jobs.set(id, { name: file.name, resolve, reject, progress: onProgress });
        host.send({ t: 'compress', id, targetBytes: target }, [file]);
      });
    },
  };

  const rename = (name, ext) => name.replace(/\.[^.]+$/, '') + '.' + ext;
  const fmtSize = (b) => b >= MiB ? (b / MiB).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';

  // ---- feature: split view -------------------------------------------------------------------

  const splitView = {
    sidebarsShown: false,
    start() {
      on('navigate', ({ path }) => { if (typeof path === 'string' && path.startsWith('/channels/')) C.NavigationRouter.transitionTo(path); });
      if (init.role !== 'main' || !has('splitView')) return;
      const h = C.React.createElement;
      const item = (path) => h(C.Menu.MenuItem, {
        id: 'wisp-open-split',
        label: 'Open in split view',
        action: () => host.send({ t: 'split:open', path }),
      });
      const patch = (pathOf) => (children, props) => {
        if (!isOn('splitView')) return;
        const path = pathOf(props);
        if (path) children.push(h(C.Menu.MenuGroup, null, item(path)));
      };
      const cm = V.Api.ContextMenu;
      cm.addContextMenuPatch(['channel-context', 'thread-context', 'gdm-context'], patch(p => p?.channel && channelPath(p.channel)));
      cm.addContextMenuPatch('user-context', patch(p => {
        const dm = p?.user && C.ChannelStore.getDMFromUserId?.(p.user.id);
        return dm ? `/channels/@me/${dm}` : null;
      }));
    },
    toggle() {
      if (init?.role === 'split') host.send({ t: 'split:close' });
      else host.send({ t: 'split:open', path: '/channels/@me' });
    },
    toggleSidebars() {
      this.sidebarsShown = !this.sidebarsShown;
      applySettings();
    },
  };

  // ---- feature: in-game overlay feed ---------------------------------------------------------
  // The host draws the overlay over games; the page tells it who's in your voice channel, who's
  // speaking and who's muted, whenever that changes.

  const overlayFeed = {
    last: '',
    start() {
      const speaking = findStore('SpeakingStore');
      let timer = null;
      const push = () => { if (!timer) timer = setTimeout(() => { timer = null; this.push(speaking); }, 60); };
      this.kick = () => { this.last = ''; push(); };   // after the setting changes
      for (const store of [speaking, C.VoiceStateStore, C.SelectedChannelStore, C.MediaEngineStore, C.GuildMemberStore])
        store?.addChangeListener?.(push);
      push();
    },
    push(speaking) {
      if (!isOn('overlay')) return;
      const channelId = C.SelectedChannelStore.getVoiceChannelId?.();
      const ch = channelId && C.ChannelStore.getChannel(channelId);
      const members = [];
      if (ch) {
        const states = C.VoiceStateStore.getVoiceStatesForChannel(channelId) || {};
        const myId = me()?.id;
        for (const [userId, vs] of Object.entries(states)) {
          const u = C.UserStore.getUser(userId);
          if (!u) continue;
          const self = userId === myId;
          members.push({
            id: userId,
            name: (ch.guild_id && C.GuildMemberStore?.getNick?.(ch.guild_id, userId)) || displayName(u),
            avatar: avatarUrl(u),
            speaking: !!speaking?.isSpeaking?.(userId),
            mute: !!(vs.mute || vs.selfMute || vs.suppress || (self && C.MediaEngineStore?.isSelfMute?.())),
            deaf: !!(vs.deaf || vs.selfDeaf || (self && C.MediaEngineStore?.isSelfDeaf?.())),
            self,
          });
        }
        members.sort((a, b) => (b.self - a.self) || a.name.localeCompare(b.name));
      }
      const msg = { t: 'overlay:voice', channel: ch ? channelLabel(ch) : null, members };
      const key = JSON.stringify(msg);
      if (key === this.last) return;
      this.last = key;
      host.send(msg);
    },
  };

  // ---- fix: User Settings open at the top ----------------------------------------------------
  // Discord's settings remember the last page visited and replay its highlight-and-scroll every
  // time they open, so after visiting Voice & Video, the gear keeps opening there. Opening without
  // a page now starts from the top; requests for a specific page navigate after this runs.

  const settingsHome = {
    store: null,
    start() {
      C.FluxDispatcher.subscribe('USER_SETTINGS_MODAL_OPEN', () => {
        try {
          this.store ??= V.Webpack.find(e => typeof e?.getState === 'function' && typeof e.setState === 'function'
            && e.getState() && 'currentPanelKey' in e.getState() && 'requestFlashKey' in e.getState());
          this.store?.setState({
            currentPanelKey: undefined, currentCategoryKey: undefined, requestAccordionOpenKey: undefined,
            requestFlashKey: undefined, scrollPositionSnapshots: new Map(),
          });
        } catch (err) { report(`settingsHome: ${err}`); }
      });
    },
  };

  // ---- feature: global keybinds ----------------------------------------------------------------
  // Sends the user's own Discord keybinds to the host, which watches for them system-wide while
  // Wisp isn't focused and reports back "binding N down/up". Only the main pane registers, so a
  // toggle never fires twice when split view is open.

  /**
   * Keep Discord's in-page keybinds in line with ownership (in every pane): when Wisp's hook owns
   * keybinds they're unbound in the page; otherwise Discord binds them as usual. Discord re-runs its
   * registration when keybinds are switched off and on again, which the patch above then skips.
   */
  const inPageKeybinds = {
    owned: null,
    settingsOpen: false,
    start() {
      C.FluxDispatcher.subscribe('KEYBINDS_ENABLE_ALL_KEYBINDS', ({ enable }) => { if (!this.cycling) this.settingsOpen = !enable; });
      this.reconcile();
    },
    reconcile() {
      if (!V || !mainPatchesApplied.has('keybindsExclusive')) return;
      const owned = ownsKeybinds();
      if (owned === this.owned || this.settingsOpen) return;
      this.owned = owned;
      this.cycling = true;
      try {
        C.FluxDispatcher.dispatch({ type: 'KEYBINDS_ENABLE_ALL_KEYBINDS', enable: false });
        C.FluxDispatcher.dispatch({ type: 'KEYBINDS_ENABLE_ALL_KEYBINDS', enable: true });
      } catch (err) { report(`keybind rebind: ${err}`); }
      finally { this.cycling = false; }
    },
  };

  const globalKeybinds = {
    store: null,
    started: false,
    last: '',
    start() {
      if (init.role !== 'main' || !has('globalKeybinds')) return;
      this.store = findStore('KeybindsStore');
      this.started = true;
      this.store.addChangeListener(() => this.sync());
      // Discord switches every keybind off while its keybind settings page is open (so new
      // ones can be recorded); the global hook follows suit.
      C.FluxDispatcher.subscribe('KEYBINDS_ENABLE_ALL_KEYBINDS', ({ enable }) => {
        if (inPageKeybinds.cycling) return;   // Wisp re-registering, not the settings page
        this.paused = !enable;
        this.sync();
      });
      on('keybind', ({ id, down }) => this.trigger(id, down));
      this.sync();
      // Hosts that can't see which window is focused (the browser helper) are told directly, so
      // keys aren't handled twice while Discord itself has focus.
      if (has('focusEvents')) {
        const report = () => host.send({ t: 'focus', focused: document.hasFocus() });
        window.addEventListener('focus', report);
        window.addEventListener('blur', report);
        report();
      }
    },
    sync() {
      if (!this.started) return;
      const list = [];
      if (S.features.globalKeybinds?.enabled && keybindActions && !this.paused) {
        for (const kb of Object.values(this.store.getUserAgnosticState() || {})) {
          const act = keybindActions[kb.action];
          if (!kb?.enabled || !kb.shortcut?.length || !act?.keyEvents) continue;
          const { keydown, keyup } = act.keyEvents;
          if (!keydown && !keyup) continue;
          list.push({
            id: +kb.id,
            keys: kb.shortcut.filter(s => s[0] !== 1).map(s => s[1]),
            mouse: kb.shortcut.filter(s => s[0] === 1).map(s => s[1]),
            down: !!keydown,
            up: !!keyup,
          });
        }
      }
      // exclusive: Discord isn't handling these in the page, so the host fires them even while
      // Wisp itself is focused.
      const exclusive = ownsKeybinds();
      const json = JSON.stringify([list, exclusive]);
      if (json === this.last) return;
      this.last = json;
      host.send({ t: 'keybinds', list, exclusive });
      log('global keybinds', list.length, exclusive ? '(exclusive)' : '');
    },
    trigger(id, down) {
      const kb = this.store?.getUserAgnosticState()?.[String(id)];
      const act = kb && keybindActions?.[kb.action];
      if (!act) return;
      try { act.onTrigger(down, kb); } catch (err) { report(`keybind ${kb.action}: ${err}`); }
    },
  };

  // ---- feature: pause GIFs & animations per server ---------------------------------------------
  // Autoplay stays on by default. In servers the user picks (right-click a server → Pause GIFs &
  // animations), or everywhere, GIFs only play while hovered and animated emoji show a still
  // frame, which saves CPU and memory in busy, GIF-heavy servers.

  const animations = {
    hooked: new WeakSet(),
    active: false,
    observer: null,
    pending: false,
    start() {
      C.FluxDispatcher.subscribe('CHANNEL_SELECT', () => setTimeout(() => this.sync(), 0));
      setInterval(() => this.sync(), 3000);
      const h = C.React.createElement;
      const Item = C.Menu.MenuCheckboxItem || C.Menu.MenuItem;
      V.Api.ContextMenu.addContextMenuPatch('guild-context', (children, props) => {
        const g = props?.guild;
        if (!g) return;
        children.push(h(C.Menu.MenuGroup, null, h(Item, {
          id: 'wisp-pause-animations', label: 'Pause GIFs & animations',
          checked: this.pausedIn(g.id), action: () => this.toggleGuild(g.id),
        })));
      });
      this.sync();
    },
    cfg() { return S?.features?.animations || {}; },
    pausedIn(guildId) {
      const cfg = this.cfg();
      return !!cfg.everywhere || (!!guildId && (cfg.pausedGuilds || []).includes(guildId));
    },
    toggleGuild(guildId) {
      const list = new Set(this.cfg().pausedGuilds || []);
      if (list.has(guildId)) list.delete(guildId); else list.add(guildId);
      setSettings({ features: { animations: { pausedGuilds: [...list] } } });
    },
    sync() {
      const guildId = C.SelectedGuildStore?.getGuildId?.() ?? currentChannel()?.guild_id ?? null;
      const want = this.pausedIn(guildId);
      if (want === this.active) return;
      this.active = want;
      document.documentElement.toggleAttribute('data-wisp-noanim', want);
      if (want) {
        this.observer = new MutationObserver(() => this.schedule());
        this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        this.apply();
      } else {
        this.observer?.disconnect();
        this.observer = null;
        this.restore();
      }
    },
    schedule() {
      if (this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => { this.pending = false; this.apply(); });
    },
    /** Only Discord's main content: never Wisp's own UI or the settings layers. */
    inScope: (el) => !!el.closest('[class*="baseLayer"]') && !el.closest('wisp-ui'),
    apply() {
      if (!this.active) return;
      for (const v of document.querySelectorAll('video:not([data-wisp-anim])')) {
        if (!this.inScope(v) || !(v.loop || v.autoplay)) continue;   // GIFs are looping/autoplaying videos
        v.dataset.wispAnim = v.autoplay ? 'auto' : 'manual';
        v.autoplay = false;
        v.pause();
        if (this.hooked.has(v)) continue;
        this.hooked.add(v);
        let hovered = false;
        v.addEventListener('mouseenter', () => { hovered = true; if (this.active) v.play().catch(() => { }); });
        v.addEventListener('mouseleave', () => { hovered = false; if (this.active) v.pause(); });
        // Discord restarts GIFs when they scroll into view; keep them still unless hovered.
        v.addEventListener('play', () => { if (this.active && !hovered) v.pause(); });
      }
      for (const img of document.querySelectorAll('img[src*="animated=true"]:not([data-wisp-anim]), img[src*=".gif"]:not([data-wisp-anim])')) {
        if (!this.inScope(img)) continue;
        const still = this.stillUrl(img.src);
        if (!still) continue;
        img.dataset.wispAnim = img.src;
        img.src = still;
      }
    },
    /** A non-animated version of an image URL from Discord's CDN or media proxy. */
    stillUrl(src) {
      try {
        const u = new URL(src);
        if (!/(^|\.)discordapp\.(com|net)$/.test(u.hostname)) return null;
        if (u.searchParams.get('animated') === 'true') u.searchParams.set('animated', 'false');
        else if (/\.gif$/i.test(u.pathname) && u.hostname.startsWith('media.')) u.searchParams.set('format', 'png');
        else return null;
        return u.href;
      } catch { return null; }
    },
    restore() {
      for (const el of document.querySelectorAll('[data-wisp-anim]')) {
        const mark = el.dataset.wispAnim;
        delete el.dataset.wispAnim;
        if (el instanceof HTMLVideoElement) {
          if (mark === 'auto') { el.autoplay = true; el.play().catch(() => { }); }
        } else if (mark && el instanceof HTMLImageElement) {
          el.src = mark;
        }
      }
    },
  };

  // ---- feature: Rich Presence ----------------------------------------------------------------
  // The host runs the local RPC server and game detection; activities arrive here as arRPC
  // messages and go through Vencord's arRPC client plugin, which looks up the app's name and
  // artwork before showing the activity (without opening its WebSocket).

  const richPresence = {
    started: false,
    queue: [],
    sockets: new Set(),
    start() {
      this.started = true;
      for (const msg of this.queue.splice(0)) this.handle(msg);
    },
    async handle(msg) {
      if (!this.started) { this.queue.push(msg); return; }
      if (!isOn('richPresence') || !msg) return;
      if (msg.activity) this.sockets.add(msg.socketId); else this.sockets.delete(msg.socketId);
      try {
        const plugin = V.Plugins?.plugins?.['WebRichPresence (arRPC)'];
        if (typeof plugin?.handleEvent === 'function') await plugin.handleEvent({ data: JSON.stringify(msg) });
        else C.FluxDispatcher.dispatch({ type: 'LOCAL_ACTIVITY_UPDATE', ...msg });
      } catch (err) { report(`richPresence: ${err}`); }
    },
    clearAll() {
      for (const socketId of this.sockets)
        C.FluxDispatcher?.dispatch({ type: 'LOCAL_ACTIVITY_UPDATE', activity: null, socketId });
      this.sockets.clear();
    },
  };
  on('rpc', ({ msg }) => richPresence.handle(msg));

  // ---- web-only notices ------------------------------------------------------------------------
  // Discord's web app warns that push-to-talk only works while the tab is focused and that custom
  // keybinds need the desktop app. With global keybinds those aren't true, so: relabel
  // "Push to Talk (Limited)", trim the warning from the mode description, dismiss the
  // "quick heads up" popup with its own Okay button, and hide the keybinds banner. Messages are
  // looked up through Discord's translations, so this works in any language.

  const webNotices = {
    pending: false,
    handled: new WeakSet(),
    start() {
      if (!has('globalKeybinds') || typeof V.Util?.getIntlMessage !== 'function') return;
      const msg = (key) => { try { return V.Util.getIntlMessage(key) || ''; } catch { return ''; } };
      const plain = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
      // The text before a message's first link is what appears as one text node on the page.
      const lead = (s) => plain(s.split('[')[0]).slice(0, 32);
      this.limitedLabel = msg('INPUT_MODE_PTT_LIMITED');
      this.pttLabel = msg('INPUT_MODE_PTT') || this.limitedLabel.replace(/\s*\(.*\)\s*$/, '');
      this.warnings = [msg('PTT_LIMITED_WARNING'), msg('PTT_LIMITED_BODY')].map(lead).filter(s => s.length >= 12);
      // Vencord's WebPWA plugin swaps the keybinds banner for its own (browser-extension) advice.
      this.notices = [lead(msg('KEYBIND_IN_BROSWER_NOTICE')), 'Custom global Push To X keybinds are supported'].filter(s => s.length >= 12);
      new MutationObserver(() => this.schedule()).observe(document.body, { childList: true, subtree: true, characterData: true });
      this.schedule();
    },
    schedule() {
      if (this.pending) return;
      this.pending = true;
      setTimeout(() => { this.pending = false; this.scan(); }, 120);
    },
    /** Only settings and modal layers are scanned, never the (large) main chat UI. */
    scan() {
      for (const root of document.querySelectorAll('[class*="layer_"]:not([class*="baseLayer"])')) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        for (let n; (n = walker.nextNode());) nodes.push(n);
        for (const t of nodes) this.fix(t, root);
      }
    },
    fix(t, root) {
      const text = t.nodeValue;
      if (!text) return;
      if (this.limitedLabel && text === this.limitedLabel) { t.nodeValue = this.pttLabel; return; }

      for (const w of this.warnings) {
        const at = text.indexOf(w);
        if (at < 0) continue;
        // The "quick heads up" popup: dismiss it with its own Okay (non-submit) button.
        const form = t.parentElement?.closest('[role="dialog"] form');
        if (form && form.textContent.length < 600) {
          if (this.handled.has(form)) return;
          this.handled.add(form);
          const okay = [...form.querySelectorAll('button[type="button"]')].pop();
          okay?.click();
          return;
        }
        // The mode description: keep the sentence before the warning, drop the warning and link.
        t.nodeValue = text.slice(0, at).trimEnd();
        for (let s = t.nextSibling; s; s = s.nextSibling) {
          if (s.nodeType === Node.TEXT_NODE) s.nodeValue = '';
          else if (s instanceof HTMLElement) s.style.display = 'none';
        }
        if (!t.nodeValue && t.parentElement) t.parentElement.style.display = 'none';
        return;
      }

      for (const n of this.notices) {
        if (!text.includes(n)) continue;
        // Hide the whole banner: climb while the parent holds no other text.
        const len = (el) => el.textContent.replace(/\s+/g, '').length;
        let el = t.parentElement;
        while (el?.parentElement && el.parentElement !== root && len(el.parentElement) === len(el)) el = el.parentElement;
        if (el) el.style.display = 'none';
        return;
      }
    },
  };

  // ---- Discord-style title bar ------------------------------------------------------------
  // With the native caption removed, Discord's own top bar (already `app-region: drag`) is the
  // title bar (Discord already draws back/forward in it). Wisp adds the window buttons on the
  // right, plus the memory readout. They live in Wisp's overlay rather than inside Discord's React
  // tree, so Discord re-rendering the bar can't remove them.

  const ICONS = {
    minimize: '<svg width="12" height="12" viewBox="0 0 12 12"><rect fill="currentColor" x="1" y="5.5" width="10" height="1"/></svg>',
    maximize: '<svg width="12" height="12" viewBox="0 0 12 12"><rect fill="none" stroke="currentColor" x="1.5" y="1.5" width="9" height="9"/></svg>',
    restore: '<svg width="12" height="12" viewBox="0 0 12 12"><rect fill="none" stroke="currentColor" x="1.5" y="3.5" width="7" height="7"/><path fill="none" stroke="currentColor" d="M3.5 3.5V1.5h7v7h-2"/></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 12 12"><path stroke="currentColor" stroke-width="1.1" d="M1.5 1.5l9 9M10.5 1.5l-9 9"/></svg>',
  };

  const titlebar = {
    extra: [],   // module buttons: { title, svg, onClick }
    state: null,
    mb: 0,
    el: null,
    lastBg: null,
    started: false,
    start() {
      this.started = true;
      this.render();
      setInterval(() => this.sync(), 1000);
    },
    /** Discord's top bar: a full-width strip at the top of the page. */
    discordBar() {
      for (const el of document.querySelectorAll('[class^="bar_"], [class*=" bar_"]')) {
        const r = el.getBoundingClientRect();
        if (r.top <= 1 && r.height >= 20 && r.height <= 56 && r.width > innerWidth * 0.5) return el;
      }
      return null;
    },
    render() {
      if (!this.started) return;
      const s = this.state;
      const root = document.documentElement;
      if (!s?.frameless) {
        this.el?.remove();
        this.el = null;
        root.removeAttribute('data-wisp-titlebar');
        return;
      }
      if (!this.el) {
        this.el = h('div', { class: 'titlebar' });
        ui.rootEl.append(this.el);
      }
      const btn = (name, title, onclick, cls = '') => {
        const b = h('button', { class: 'tb ' + cls, title, onclick });
        b.innerHTML = ICONS[name];
        return b;
      };
      this.ramEl = h('span', { class: 'ram', title: 'Memory used by Wisp' });
      const extra = this.extra.filter(x => !x.visible || x.visible()).map(x => {
        const b = h('button', { class: 'tb is-extra', title: x.title, onclick: x.onClick });
        b.innerHTML = x.svg;
        return b;
      });
      this.el.replaceChildren(
        h('div', { class: 'drag' }),
        s.controls ? h('div', { class: 'controls' },
          ...extra,
          this.ramEl,
          btn('minimize', 'Minimize', () => host.send({ t: 'window', cmd: 'minimize' })),
          btn(s.maximized ? 'restore' : 'maximize', s.maximized ? 'Restore' : 'Maximize', () => host.send({ t: 'window', cmd: 'maximize' })),
          btn('close', 'Close', () => host.send({ t: 'window', cmd: 'close' }), 'close')) : null,
      );
      this.el.classList.toggle('blurred', !s.focused);
      this.renderRam();
      this.sync();
    },
    renderRam() {
      if (!this.ramEl) return;
      this.ramEl.textContent = this.mb > 0 ? `${this.mb} MB` : '';
    },
    /** Keep space reserved in Discord's bar for our buttons, and the resize band's colour in sync. */
    sync() {
      if (!this.el) return;
      const root = document.documentElement;
      const bar = this.discordBar();
      const height = bar ? Math.round(bar.getBoundingClientRect().height) : 32;
      this.el.style.setProperty('--tb-h', height + 'px');
      // Without Discord's bar (login, loading screens) the overlay itself becomes the drag area.
      this.el.classList.toggle('standalone', !bar);
      const controls = this.el.querySelector('.controls');
      root.style.setProperty('--wisp-tb-right', (controls ? controls.offsetWidth : 0) + 'px');
      root.toggleAttribute('data-wisp-titlebar', true);

      let el = bar, bg = null;
      while (el && !bg) {
        const c = getComputedStyle(el).backgroundColor;
        if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) bg = c;
        el = el.parentElement;
      }
      bg ??= getComputedStyle(document.body).backgroundColor;
      if (bg && bg !== this.lastBg) {
        this.lastBg = bg;
        host.send({ t: 'chrome', bg });
      }
    },
  };

  on('window', (m) => { titlebar.state = m; titlebar.render(); });
  on('ram', ({ mb }) => { titlebar.mb = mb; titlebar.renderRam(); });

  // ---- keyboard shortcuts --------------------------------------------------------------------

  /** Tell the host when the user is using this pane (at most every 20 s), for idle handling. */
  function reportActivity() {
    let last = 0;
    const ping = () => {
      const now = Date.now();
      if (now - last < 20000) return;
      last = now;
      host.send({ t: 'activity' });
    };
    for (const type of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(type, ping, { capture: true, passive: true });
  }

  function installShortcuts() {
    reportActivity();
    window.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      let handled = true;
      switch (e.code) {
        case 'Comma': ui.toggleSettings(); break;
        case 'KeyL': if (healthy.voiceLog) ui.toggleVoiceLog(); else handled = false; break;
        case 'Backslash': if (has('splitView') && S.features.splitView.enabled) splitView.toggle(); else handled = false; break;
        case 'KeyB': if (init?.role === 'split') splitView.toggleSidebars(); else handled = false; break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    on('ui', ({ open }) => {
      if (open === 'settings') ui.toggleSettings(true);
      if (open === 'voiceLog') ui.toggleVoiceLog(true);
    });
  }

  // ---- UI (shadow DOM, styled with Discord's own theme variables) ------------------------------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: var(--w-bg3) transparent; }
    .root { font-family: var(--font-primary, "gg sans", "Segoe UI", sans-serif); color: var(--w-text); font-size: 14px;
      --w-bg: var(--modal-background, var(--background-base-low, var(--background-primary, #313338)));
      --w-bg2: var(--background-base-lower, var(--background-secondary, #2b2d31));
      --w-bg3: var(--background-base-lowest, var(--background-tertiary, #1e1f22));
      --w-text: var(--text-default, var(--text-normal, #dbdee1));
      --w-muted: var(--text-muted, #949ba4);
      --w-border: var(--border-subtle, rgba(255,255,255,.08));
      --w-accent: #3fb5a3; --w-danger: #f23f43; }
    button { font: inherit; color: inherit; cursor: pointer; border: 0; border-radius: 6px; padding: 6px 12px;
      background: var(--w-bg3); }
    button:hover { filter: brightness(1.15); }
    button.primary { background: var(--w-accent); color: #04221d; font-weight: 600; }
    button.danger { color: var(--w-danger); }
    button.icon { background: transparent; padding: 4px 8px; font-size: 18px; line-height: 1; color: var(--w-muted); }
    input[type=text], input[type=number], textarea, select { font: inherit; color: var(--w-text); background: var(--w-bg3);
      border: 1px solid var(--w-border); border-radius: 6px; padding: 6px 8px; width: 100%; }
    input[type=number] { width: 80px; }
    select { width: auto; cursor: pointer; }
    textarea { min-height: 84px; resize: vertical; font-family: var(--font-code, Consolas, monospace); font-size: 13px; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 2147483000; display: grid; place-items: center; }
    .modal { width: min(640px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow: auto; background: var(--w-bg);
      border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.5); }
    .modal header { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px 20px; }
    .modal h2 { margin: 0; font-size: 20px; }
    .modal .body { padding: 0 20px 20px; }
    section { margin-top: 18px; }
    h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--w-muted); }
    .row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--w-border); }
    .row:last-child { border-bottom: 0; }
    .row .grow { flex: 1; min-width: 0; }
    .row .desc { color: var(--w-muted); font-size: 12px; margin-top: 2px; }
    .sub { padding: 4px 0 8px 16px; }
    .notice { background: var(--w-bg2); border-left: 3px solid var(--w-accent); padding: 8px 12px; border-radius: 4px; font-size: 13px; }
    .notice.warn { border-left-color: #f0b232; }
    .switch { position: relative; width: 40px; height: 24px; flex: none; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .switch span { position: absolute; inset: 0; background: #80848e; border-radius: 12px; transition: .15s; }
    .switch span::after { content: ""; position: absolute; left: 3px; top: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: .15s; }
    .switch input:checked + span { background: var(--w-accent); }
    .switch input:checked + span::after { transform: translateX(16px); }
    .switch input:disabled + span { opacity: .4; }
    .panel { position: fixed; right: 16px; bottom: 80px; width: 320px; max-height: 60vh; display: flex; flex-direction: column;
      background: var(--w-bg); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.45); z-index: 2147482000; }
    .panel header { display: flex; align-items: center; gap: 8px; padding: 10px 8px 8px 14px; border-bottom: 1px solid var(--w-border); cursor: move; user-select: none; }
    .panel header b { flex: 1; }
    .panel .list { overflow: auto; padding: 4px 0; }
    .entry { display: flex; align-items: center; gap: 8px; padding: 5px 14px; font-size: 13px; }
    .entry img { width: 22px; height: 22px; border-radius: 50%; flex: none; }
    .entry .time { color: var(--w-muted); font-size: 11px; font-variant-numeric: tabular-nums; flex: none; }
    .entry .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .k-join { color: #23a55a; } .k-leave { color: var(--w-danger); } .k-move, .k-stream-on, .k-video-on { color: #5aa9e6; }
    .empty { color: var(--w-muted); padding: 16px 14px; font-size: 13px; }
    .toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px;
      align-items: center; z-index: 2147483500; pointer-events: none; }
    .toast { pointer-events: auto; background: var(--w-bg3); color: var(--w-text); border-radius: 8px; padding: 10px 14px; min-width: 260px;
      max-width: 520px; box-shadow: 0 4px 16px rgba(0,0,0,.4); font-size: 14px; }
    .toast.error { border-left: 3px solid var(--w-danger); }
    .toast .bar { height: 4px; background: var(--w-bg2); border-radius: 2px; margin-top: 8px; overflow: hidden; }
    .toast .bar i { display: block; height: 100%; width: 0; background: var(--w-accent); transition: width .2s; }
    .accounts .row button { padding: 4px 10px; font-size: 13px; }
    .titlebar { position: fixed; top: 0; left: 0; right: 0; height: var(--tb-h, 32px); z-index: 2147481000; pointer-events: none; }
    .titlebar .drag { display: none; position: absolute; inset: 0; app-region: drag; pointer-events: auto; }
    .titlebar.standalone .drag { display: block; }
    .titlebar .controls { position: absolute; top: 0; right: 0; height: 100%; display: flex; align-items: center;
      pointer-events: auto; app-region: no-drag; }
    .titlebar .tb { width: 28px; height: 100%; display: grid; place-items: center; padding: 0; border-radius: 0;
      background: transparent; color: var(--interactive-normal, var(--interactive-icon-default, #b5bac1)); }
    .titlebar .tb:hover { filter: none; background: var(--background-modifier-hover, rgba(255,255,255,.08));
      color: var(--interactive-hover, var(--interactive-icon-hover, #dbdee1)); }
    .titlebar .tb.close:hover { background: #d83c3e; color: #fff; }
    .titlebar .tb.is-extra { width: 32px; border-radius: 6px; height: 26px; }
    .titlebar .tb.is-extra svg { width: 18px; height: 18px; }
    .titlebar.blurred .tb { opacity: .65; }
    .titlebar .ram { font-size: 12px; color: var(--text-muted, #949ba4); padding: 0 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .titlebar .ram:empty { display: none; }
  `;

  const ui = {
    shadow: null,
    rootEl: null,
    settingsEl: null,
    voiceEl: null,
    toastsEl: null,
    mount() {
      const hostEl = document.createElement('wisp-ui');
      // Keep Discord's "type anywhere to focus the composer" from stealing keystrokes from our inputs.
      for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
        hostEl.addEventListener(type, (e) => { if (e.composedPath()[0] !== hostEl) e.stopPropagation(); });
      }
      this.shadow = hostEl.attachShadow({ mode: 'open' });
      this.shadow.append(h('style', null, CSS));
      this.rootEl = h('div', { class: 'root' });
      this.toastsEl = h('div', { class: 'toasts' });
      this.rootEl.append(this.toastsEl);
      this.shadow.append(this.rootEl);
      document.documentElement.append(hostEl);
      const style = document.createElement('style');
      style.textContent = COMPACT_CSS;
      document.head.append(style);
    },
    refresh() {
      if (this.settingsEl) this.renderSettings();
      if (this.voiceEl) this.renderVoiceLog();
    },

    // -- settings --
    toggleSettings(forceOpen) {
      if (this.settingsEl && !forceOpen) return this.closeSettings();
      if (!this.settingsEl) {
        this.settingsEl = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === this.settingsEl) this.closeSettings(); } });
        this.rootEl.append(this.settingsEl);
      }
      this.renderSettings();
    },
    closeSettings() {
      this.settingsEl?.remove();
      this.settingsEl = null;
    },
    renderSettings() {
      if (!S) return;
      const f = S.features;
      const patchFeature = (name, patch) => setSettings({ features: { [name]: patch } });
      const toggle = (checked, onChange, disabled) => h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked, disabled, onchange: (e) => onChange(e.target.checked) }), h('span'));
      const row = (title, desc, control) => h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('div', null, title), desc && h('div', { class: 'desc' }, desc)), control);
      const featureRow = (name, desc, sub) => {
        const broken = V && healthy[name] === false;
        return [
          row(FEATURES[name].label + (broken ? ' (paused: Discord changed)' : ''), desc,
            toggle(f[name].enabled, v => patchFeature(name, { enabled: v }), !V || broken)),
          f[name].enabled && sub ? h('div', { class: 'sub' }, sub) : null,
        ];
      };
      const debounce = (fn, ms = 500) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
      const saveKeywords = debounce((text) => patchFeature('keywordAlerts', { keywords: text.split('\n').map(s => s.trim()).filter(Boolean) }));

      const vencordNotice = !V
        ? h('div', { class: 'notice warn' }, 'Vencord isn\'t loaded, so these features are off. ',
          init?.vencord?.folder ? 'It is configured but didn\'t start; check the log.' : 'Choose its folder below.')
        : null;

      const body = h('div', { class: 'body' },
        h('section', null, h('h3', null, 'Features'), vencordNotice,
          featureRow('keywordAlerts', 'Get a notification when a word or phrase appears, not only @mentions.', [
            h('div', { class: 'desc' }, 'One per line. Plain words match whole words, any case. Use /regex/ for patterns.'),
            h('textarea', { spellcheck: false, oninput: (e) => saveKeywords(e.target.value) }, (f.keywordAlerts.keywords || []).join('\n')),
            row('Skip muted servers and channels', null, toggle(f.keywordAlerts.ignoreMuted, v => patchFeature('keywordAlerts', { ignoreMuted: v }))),
            row('Skip bots', null, toggle(f.keywordAlerts.ignoreBots, v => patchFeature('keywordAlerts', { ignoreBots: v }))),
          ]),
          featureRow('voiceLog', 'Timestamped list of who joined, left or started streaming while you\'re in a voice channel. Ctrl+Shift+L.'),
          V && row('Channel tabs', 'Middle-click a channel or DM (or right-click → Open in new tab) to open it in a tab. Ctrl+T new tab, Ctrl+W close, Ctrl+Tab switch.',
            toggle(f.tabs?.enabled ?? true, v => patchFeature('tabs', { enabled: v }))),
          V && (f.tabs?.enabled ?? true) && h('div', { class: 'sub' },
            row('Show the tab bar with only one tab', null, toggle(!!f.tabs?.alwaysShow, v => patchFeature('tabs', { alwaysShow: v })))),
          V && row('Bookmarks', 'Right-click a message → Bookmark… to save it with a note and tags. Kept on this device, even if the message is edited or deleted. Ctrl+Shift+K.',
            h('div', { style: 'display:flex;align-items:center;gap:10px' },
              (f.bookmarks?.enabled ?? true) && h('button', { onclick: () => { this.closeSettings(); dispatchEvent(new Event('wisp:bookmarks')); } }, 'Open'),
              toggle(f.bookmarks?.enabled ?? true, v => patchFeature('bookmarks', { enabled: v })))),
          featureRow('linkCleaning', 'Remove tracking parameters (utm_, fbclid, si, …) from links you send.'),
          featureRow('splitMessages', 'Send messages over the length limit as several messages instead of being blocked.', [
            row('Ask first when it would send more than', null,
              h('input', { type: 'number', min: 1, max: 50, value: f.splitMessages.confirmAbove,
                onchange: (e) => patchFeature('splitMessages', { confirmAbove: Math.max(1, +e.target.value || 3) }) })),
          ]),
          featureRow('compressUploads', 'Shrink images and videos that are over your upload limit before they upload.', [
            row('Images', 'Re-encoded as WebP, scaled down if needed.', toggle(f.compressUploads.images, v => patchFeature('compressUploads', { images: v }))),
            row('Videos', has('compressVideo') ? 'Re-encoded with the system video encoder.' : 'Not supported on this platform yet.',
              toggle(f.compressUploads.videos && has('compressVideo'), v => patchFeature('compressUploads', { videos: v }), !has('compressVideo'))),
          ]),
          V && h('div', { class: 'row' },
            h('div', { class: 'grow' },
              h('div', null, 'Pause GIFs & animations'),
              h('div', { class: 'desc' }, 'GIFs and animated emoji play normally. To pause them in a busy server, right-click it → Pause GIFs & animations; they then play only while hovered.'),
              (f.animations?.pausedGuilds || []).length > 0 && h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px' },
                f.animations.pausedGuilds.map(id => h('button', {
                  title: 'Resume animations in this server',
                  onclick: () => patchFeature('animations', { pausedGuilds: f.animations.pausedGuilds.filter(g => g !== id) }),
                }, `${C.GuildStore?.getGuild?.(id)?.name ?? 'Unknown server'} ×`)))),
            h('label', { style: 'display:flex;align-items:center;gap:8px;white-space:nowrap' }, 'Everywhere',
              toggle(!!f.animations?.everywhere, v => patchFeature('animations', { everywhere: v })))),
          row('Keep Spotify playing in voice', 'Discord normally pauses your Spotify after you\'ve been talking or streaming for a while. This stops that.',
            toggle(f.spotifyNoAutoPause?.enabled ?? true, v => patchFeature('spotifyNoAutoPause', { enabled: v }), !V)),
          row('Redesigned Plugins & Themes tabs',
            'Wisp\'s versions of Vencord\'s Plugins and Themes tabs, with the BetterDiscord theme store. Off: Vencord\'s originals (reopen settings to switch).',
            toggle(f.library?.enabled ?? true, v => patchFeature('library', { enabled: v }), !V)),
          (f.library?.enabled ?? true) && h('div', { class: 'sub' },
            row('Keep installed themes updated', 'Checks the store once a day.',
              toggle(f.library?.autoUpdateThemes ?? true, v => patchFeature('library', { autoUpdateThemes: v })))),
          has('appAudio') && row('Screen share audio without echo',
            'Sharing a window sends only that app\'s sound; sharing a screen sends everything except Discord itself. Turn on audio in Discord\'s stream settings as usual.',
            toggle(f.appAudio?.enabled ?? true, v => patchFeature('appAudio', { enabled: v }))),
          has('richPresence') && featureRow('richPresence', 'Show the game you\'re playing, and Rich Presence from apps and games that support Discord, on your profile. Only on your first account.', [
            row('Detect games', 'Recognises games from Discord\'s list of detectable games.',
              toggle(f.richPresence?.detectGames ?? true, v => patchFeature('richPresence', { detectGames: v }))),
          ]),
          has('globalKeybinds') && featureRow('globalKeybinds', 'Your Discord keybinds (push-to-talk, mute, deafen, …) work while another app is focused, like the official client. Set them in Discord\'s Keybinds and Voice settings.'
            + (init?.hostNote ? ' ' + init.hostNote : '')),
          has('overlay') && healthy.overlay !== undefined && featureRow('overlay',
            'Shows who\'s in your voice channel (and who\'s talking) and new messages over games. It\'s a separate window, never injected into the game, so it\'s safe with anti-cheat. '
            + 'Shift+F9 hides or shows it while playing. Works over windowed and borderless games; Wisp offers to switch games that use exclusive fullscreen.'
            + (f.richPresence?.enabled && f.richPresence?.detectGames ? '' : ' Needs game detection (Game activity above) to know when you\'re in a game.'), [
            row('Voice channel', null, toggle(f.overlay?.voiceWidget ?? true, v => patchFeature('overlay', { voiceWidget: v }))),
            row('Message notifications', null, toggle(f.overlay?.notifications ?? true, v => patchFeature('overlay', { notifications: v }))),
            row('Voice channel position', null,
              h('select', { onchange: (e) => patchFeature('overlay', { corner: e.target.value }) },
                [['topLeft', 'Top left'], ['topRight', 'Top right'], ['bottomLeft', 'Bottom left'], ['bottomRight', 'Bottom right']]
                  .map(([value, label]) => h('option', { value, selected: (f.overlay?.corner ?? 'topLeft') === value }, label)))),
          ]),
          has('splitView') && featureRow('splitView', 'Two channels side by side: right-click a channel or DM → Open in split view, or Ctrl+Shift+\\.', [
            row('Hide server and channel lists in the split pane', 'Ctrl+Shift+B in the pane shows them again.',
              toggle(f.splitView.compactPane, v => patchFeature('splitView', { compactPane: v }))),
            row('Release the pane\'s memory after (minutes unused)', '0 = never.',
              h('input', { type: 'number', min: 0, max: 600, value: f.splitView.idleMinutes ?? 5,
                onchange: (e) => patchFeature('splitView', { idleMinutes: Math.max(0, +e.target.value || 0) }) })),
            row('Close the pane after (minutes unused)', 'Frees its memory entirely. 0 = never.',
              h('input', { type: 'number', min: 0, max: 1440, value: f.splitView.autoCloseMinutes ?? 30,
                onchange: (e) => patchFeature('splitView', { autoCloseMinutes: Math.max(0, +e.target.value || 0) }) })),
          ]),
        ),

        has('idle') && h('section', null, h('h3', null, 'Memory'),
          row('Idle memory mode', 'When Wisp is minimised or in the tray, ask the browser engine to release memory. Never while you\'re in a call.',
            toggle(S.idle.enabled, v => setSettings({ idle: { enabled: v } }))),
          S.idle.enabled && h('div', { class: 'sub' },
            row('Start after (seconds)', null, h('input', { type: 'number', min: 5, max: 3600, value: S.idle.delaySeconds,
              onchange: (e) => setSettings({ idle: { delaySeconds: Math.max(5, +e.target.value || 30) } }) })),
            row('Also when in the background', 'Release memory when Wisp is visible but you\'ve been in another app (e.g. a game) for a while.',
              toggle(S.idle.background ?? true, v => setSettings({ idle: { background: v } }))),
            (S.idle.background ?? true) && row('Background after (minutes)', null, h('input', { type: 'number', min: 1, max: 240, value: S.idle.backgroundMinutes ?? 5,
              onchange: (e) => setSettings({ idle: { backgroundMinutes: Math.max(1, +e.target.value || 5) } }) })),
            row('Deep sleep', 'Fully pause Discord after a longer idle period. Uses the least memory, but notifications stop until you open the window.',
              toggle(S.idle.deepSleep, v => setSettings({ idle: { deepSleep: v } }))),
            S.idle.deepSleep && row('Deep sleep after (minutes)', null, h('input', { type: 'number', min: 1, max: 1440, value: S.idle.deepSleepMinutes,
              onchange: (e) => setSettings({ idle: { deepSleepMinutes: Math.max(1, +e.target.value || 15) } }) })),
          ),
          row('Show memory use in the title bar', null, toggle(S.showRamInTitle, v => setSettings({ showRamInTitle: v }))),
        ),

        has('tray') && h('section', null, h('h3', null, 'Window'),
          row('Discord-style title bar', 'Use Discord\'s own top bar with its window buttons instead of the Windows title bar.',
            toggle(S.customTitleBar ?? true, v => setSettings({ customTitleBar: v }))),
          row('Close to tray', 'The close button hides Wisp so notifications keep arriving.', toggle(S.closeToTray, v => setSettings({ closeToTray: v }))),
          has('startup') && row('Start with Windows', null, toggle(S.startWithWindows, v => setSettings({ startWithWindows: v }))),
          row('Start minimised', null, toggle(S.startMinimized, v => setSettings({ startMinimized: v }))),
        ),

        has('accounts') && h('section', { class: 'accounts' }, h('h3', null, 'Accounts'),
          h('div', { class: 'desc' }, 'Each account has its own window and login. All of them can be open at once.'),
          accounts.map(a => row(
            a.name + (a.id === init.account.id ? ' (this window)' : ''),
            a.open ? 'Open' : 'Closed',
            h('div', { style: 'display:flex;gap:6px' },
              a.id !== init.account.id && h('button', { onclick: () => host.send({ t: 'account:open', id: a.id }) }, 'Open'),
              h('button', { onclick: async () => {
                const name = await this.prompt('Rename account', a.name);
                if (name) host.send({ t: 'account:rename', id: a.id, name });
              } }, 'Rename'),
              accounts.length > 1 && h('button', { class: 'danger', onclick: () => host.send({ t: 'account:remove', id: a.id }) }, 'Remove'),
            ))),
          h('div', { style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: async () => {
            const name = await this.prompt('Add account', `Account ${accounts.length + 1}`);
            if (name) host.send({ t: 'account:add', name });
          } }, 'Add account')),
        ),

        !has('vencordManager') && h('section', null, h('h3', null, 'Vencord'),
          row(V ? 'Vencord extension: loaded' : 'Vencord extension: not found',
            'Wisp\'s features run on Vencord. In the browser edition, install Vencord\'s own browser extension; it keeps itself up to date.', null),
          init?.platform !== 'windows' && !init?.helper && h('div', { class: 'notice warn' },
            'The Wisp helper isn\'t installed, so Rich Presence and global keybinds are off. Run the installer from the Wisp download.'),
        ),

        has('vencordManager') && h('section', null, h('h3', null, 'Vencord'),
          row(init?.vencord?.version ? `Loaded: v${init.vencord.version}` : 'Not installed',
            'Wisp\'s features run on Vencord. Updates come from Vencord\'s GitHub releases and are checked against GitHub\'s published checksum.',
            h('button', { onclick: () => host.send({ t: 'vencord:check' }) }, init?.vencord?.version ? 'Check now' : 'Download')),
          row('Check for updates', 'Every 6 hours.',
            toggle(S.vencordUpdates?.checkForUpdates ?? true, v => setSettings({ vencordUpdates: { checkForUpdates: v } }))),
          row('Install updates without asking', 'Off: Wisp asks before each download. Windows in a call reload when the call ends.',
            toggle(!!S.vencordUpdates?.autoUpdate, v => setSettings({ vencordUpdates: { autoUpdate: v } }))),
          row('Use your own build', 'Point Wisp at an unzipped extension folder instead.',
            h('button', { onclick: () => host.send({ t: 'vencord:choose' }) }, 'Choose folder…')),
        ),
        has('wispUpdates') && h('section', null, h('h3', null, 'Wisp updates'),
          row(`Wisp ${init?.version ?? ''}`,
            'New versions come from Wisp\'s GitHub releases and are checked against GitHub\'s published checksum. Wisp restarts to install them, never during a call.',
            h('button', { onclick: () => host.send({ t: 'wisp:check' }) }, 'Check now')),
          row('Check for updates', 'At startup and every 6 hours.',
            toggle(S.wispUpdates?.checkForUpdates ?? true, v => setSettings({ wispUpdates: { checkForUpdates: v } }))),
          row('Install updates without asking', 'Off: Wisp asks first and shows what\'s new.',
            toggle(!!S.wispUpdates?.autoUpdate, v => setSettings({ wispUpdates: { autoUpdate: v } }))),
          has('coreUpdates') && row('Fix features after Discord or Vencord updates', `When a Discord or Vencord update breaks a feature, Wisp downloads the fix (signed by Wisp) and reloads, without a reinstall. Windows in a call wait until it ends. Scripts: build ${init?.coreBuild ?? '?'}.`,
            toggle(S.coreUpdates?.enabled ?? true, v => setSettings({ coreUpdates: { enabled: v } }))),
        ),
        h('div', { class: 'desc', style: 'margin-top:16px' }, `Wisp ${init?.version ?? ''} · ${init?.platform ?? ''}`),
      );

      const modal = h('div', { class: 'modal', role: 'dialog' },
        h('header', null, h('h2', null, 'Wisp settings'), h('button', { class: 'icon', title: 'Close', onclick: () => this.closeSettings() }, '×')),
        body);
      const scroll = this.settingsEl.firstChild?.scrollTop ?? 0;
      this.settingsEl.replaceChildren(modal);
      modal.scrollTop = scroll;
    },

    // -- voice log --
    toggleVoiceLog(forceOpen) {
      if (this.voiceEl && !forceOpen) { this.voiceEl.remove(); this.voiceEl = null; return; }
      if (!this.voiceEl) {
        this.voiceEl = h('div', { class: 'panel' });
        this.rootEl.append(this.voiceEl);
      }
      this.renderVoiceLog();
    },
    voiceLogChanged() {
      if (this.voiceEl) this.renderVoiceLog();
    },
    renderVoiceLog() {
      const words = {
        join: 'joined', leave: 'left', move: 'moved to', 'stream-on': 'started streaming', 'stream-off': 'stopped streaming',
        'video-on': 'turned on camera', 'video-off': 'turned off camera', 'self-join': 'You joined', 'self-leave': 'You left', 'self-move': 'You moved to',
      };
      const fmt = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const list = voiceLog.entries.length
        ? voiceLog.entries.map(e => h('div', { class: 'entry' },
          h('span', { class: 'time' }, fmt(e.ts)),
          e.kind.startsWith('self-') ? null : h('img', { src: e.avatar, alt: '' }),
          h('span', { class: `what k-${e.kind.replace('self-', '')}`, title: `${e.name} ${words[e.kind]} ${e.extra ?? ''}` },
            e.kind.startsWith('self-') ? `${words[e.kind]} ${e.extra ?? ''}` : `${e.name} ${words[e.kind]}${e.extra ? ' ' + e.extra : ''}`)))
        : [h('div', { class: 'empty' }, voiceLog.channelId ? 'Nobody has joined or left yet.' : 'Join a voice channel to start logging.')];
      const header = h('header', null,
        h('b', null, 'Voice log'),
        h('button', { class: 'icon', title: 'Clear', onclick: () => { voiceLog.entries = []; this.renderVoiceLog(); } }, '⌫'),
        h('button', { class: 'icon', title: 'Close', onclick: () => this.toggleVoiceLog() }, '×'));
      this.makeDraggable(header, this.voiceEl);
      this.voiceEl.replaceChildren(header, h('div', { class: 'list' }, list));
    },
    makeDraggable(handle, el) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        const move = (ev) => {
          el.style.left = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx)) + 'px';
          el.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + 'px';
          el.style.right = el.style.bottom = 'auto';
        };
        const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
      });
    },

    // -- dialogs --
    dialog(title, text, { input, okText = 'OK' } = {}) {
      return new Promise(resolve => {
        const field = input !== undefined ? h('input', { type: 'text', value: input }) : null;
        const done = (v) => { el.remove(); resolve(v); };
        const el = h('div', { class: 'backdrop', style: 'z-index:2147483200' },
          h('div', { class: 'modal', role: 'dialog', style: 'width:min(440px,calc(100vw - 32px))' },
            h('header', null, h('h2', null, title)),
            h('div', { class: 'body' },
              text && h('p', { style: 'margin-top:0;color:var(--w-muted)' }, text),
              field,
              h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px' },
                h('button', { onclick: () => done(null) }, 'Cancel'),
                h('button', { class: 'primary', onclick: () => done(field ? field.value.trim() : true) }, okText)))));
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') done(null);
          if (e.key === 'Enter') done(field ? field.value.trim() : true);
        });
        this.rootEl.append(el);
        (field ?? el.querySelector('button.primary')).focus();
        field?.select();
      });
    },
    prompt(title, value) { return this.dialog(title, null, { input: value, okText: 'Save' }); },
    async confirm(title, text) { return !!(await this.dialog(title, text, { okText: 'Send' })); },
  };

  /** Bottom-centre toast. Returns a handle for progress/done/fail. */
  function toast(text, kind = 'info') {
    if (!ui.toastsEl) { log(text); return { progress() { }, done() { }, fail() { }, close() { } }; }
    const label = h('div', null, text);
    const bar = kind === 'progress' ? h('div', { class: 'bar' }, h('i')) : null;
    const el = h('div', { class: 'toast' + (kind === 'error' ? ' error' : '') }, label, bar);
    ui.toastsEl.append(el);
    const close = () => el.remove();
    if (kind !== 'progress') setTimeout(close, kind === 'error' ? 8000 : 4000);
    return {
      progress(p) { if (bar) bar.firstChild.style.width = Math.round(p * 100) + '%'; },
      done(msg) { label.textContent = msg; bar?.remove(); setTimeout(close, 4000); },
      fail(msg) { label.textContent = msg; bar?.remove(); el.classList.add('error'); setTimeout(close, 8000); },
      close,
    };
  }

  Object.assign(debug.features, { keywordAlerts, voiceLog, linkCleaning, splitMessages, compress, splitView, globalKeybinds, richPresence, appAudio });
  debug.healthy = healthy;
  debug.appliedPatches = appliedPatches;
  debug.mainPatches = mainPatchesApplied;

  // Compact split pane: hide the server list and channel sidebar. Matched by class prefix
  // because Discord's class names carry a hash suffix that changes between builds.
  const COMPACT_CSS = `
    html[data-wisp-compact] nav[class^="guilds_"], html[data-wisp-compact] nav[class*=" guilds_"],
    html[data-wisp-compact] [class^="sidebar_"]:has(nav), html[data-wisp-compact] [class*=" sidebar_"]:has(nav),
    html[data-wisp-compact] [class^="sidebarList_"], html[data-wisp-compact] [class*=" sidebarList_"] { display: none !important; }

    /* Room in Discord's top bar for Wisp's window buttons. */
    html[data-wisp-titlebar] [class^="bar_"]:has(> [class^="trailing_"]) { padding-right: var(--wisp-tb-right, 0px) !important; }
  `;
})();

/*
 * Wisp library: redesigned Plugins and Themes tabs for Vencord's settings section, with a
 * built-in theme store.
 *
 * - Plugins: search, status filters, category chips and cards for Vencord's plugins, using
 *   Vencord's own enable/disable logic (dependencies, restart-required handling).
 * - Themes: a Library of installed themes (plus Vencord's QuickCSS and theme links) and a Browse
 *   view of theme stores. Store themes are downloaded, kept in IndexedDB and applied by Wisp.
 *   Where the host offers "sharedThemes" it keeps the installed themes for every account, and
 *   IndexedDB is this account's cache of them (so they still apply instantly at page start).
 *
 * Everything is drawn with Discord's colour variables and fonts, so installed themes restyle these
 * pages along with the rest of Discord. Theme stores sit behind a small "source" interface
 * (see SOURCES) so more can be added later (e.g. GitHub topics) with the same entry shape.
 *
 * Loaded after core/wisp.js, which calls the registered function with its context once Discord
 * and Vencord are ready. Installed themes are applied immediately at page start, before that.
 */
(() => {
  'use strict';
  if (window.top !== window || !window.WispHost) return;

  // ---- storage --------------------------------------------------------------------------
  // IndexedDB rather than localStorage, which Discord removes from the page.

  const db = {
    promise: null,
    open() {
      return this.promise ??= new Promise((resolve, reject) => {
        const req = indexedDB.open('WispLibrary', 2);
        req.onupgradeneeded = (e) => {
          if (e.oldVersion < 1) {
            req.result.createObjectStore('themes', { keyPath: 'id' });
            req.result.createObjectStore('kv');
          }
          if (e.oldVersion < 2) req.result.createObjectStore('images');   // src → compressed previews
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async run(store, mode, fn) {
      const conn = await this.open();
      return new Promise((resolve, reject) => {
        const tx = conn.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
      });
    },
    all: (store) => db.run(store, 'readonly', s => s.getAll()),
    get: (store, key) => db.run(store, 'readonly', s => s.get(key)),
    put: (store, value, key) => db.run(store, 'readwrite', s => key === undefined ? s.put(value) : s.put(value, key)),
    del: (store, key) => db.run(store, 'readwrite', s => s.delete(key)),
  };

  // ---- theme sources ----------------------------------------------------------------------
  // A source lists themes in one shape; adding another store means adding an entry here.
  //   entry: { key, source, name, description, version, author: { name, avatar }, tags[], likes,
  //            downloads, thumbnail, cssUrl, pageUrl, updatedAt, createdAt }

  const OUTDATED_BEFORE = Date.parse('2025-03-01');   // Discord's 2025 redesign changed most selectors

  const SOURCES = {
    betterdiscord: {
      label: 'BetterDiscord',
      reviewed: true,
      async list(ctx) {
        const res = await ctx.hostFetch('https://api.betterdiscord.app/v3/store/themes');
        const raw = JSON.parse(res.body);
        const origin = 'https://betterdiscord.app';
        return raw.filter(t => t.type === 'theme' && t.latest_source_url).map(t => {
          const a = t.author || {};
          return {
            key: `betterdiscord:${t.id}`,
            source: 'betterdiscord',
            name: t.name,
            description: t.description || '',
            version: t.version || '',
            author: {
              name: a.display_name || a.github_name || a.discord_name || 'Unknown',
              avatar: a.discord_snowflake && a.discord_avatar_hash
                ? `https://cdn.discordapp.com/avatars/${a.discord_snowflake}/${a.discord_avatar_hash}.png?size=64` : null,
            },
            tags: t.tags || [],
            likes: Number(t.likes) || 0,
            downloads: Number(t.downloads) || 0,
            thumbnail: t.thumbnail_url ? new URL(t.thumbnail_url, origin).href : null,
            cssUrl: t.latest_source_url,
            pageUrl: `${origin}/theme/${encodeURIComponent(t.name)}`,
            updatedAt: Date.parse(t.latest_release_date) || 0,
            createdAt: Date.parse(t.initial_release_date) || 0,
          };
        });
      },
    },
  };

  // ---- theme manager --------------------------------------------------------------------------

  const themes = {
    installed: new Map(),    // key → { ...entry, css, enabled, installedAt, installedUrl }
    store: { entries: null, at: 0, loading: false, error: null },
    preview: null,           // { key, name, css }
    listeners: new Set(),
    container: null,
    ctx: null,
    shared: false,           // the host keeps themes for all accounts (IndexedDB is then a local cache)

    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit() { for (const fn of this.listeners) { try { fn(); } catch { } } },

    async load() {
      try {
        for (const t of await db.all('themes')) this.installed.set(t.id, t);
      } catch (err) {
        console.error('[Wisp] theme library unavailable', err);
      }
      this.apply();
      this.emit();
    },

    /** Installed, enabled themes (and any preview) as <style> elements at the end of <html>. */
    apply() {
      const root = document.documentElement;
      if (!root) { document.addEventListener('readystatechange', () => this.apply(), { once: true }); return; }
      if (!this.container?.isConnected) {
        this.container = document.createElement('wisp-themes');
        this.container.hidden = true;
        root.append(this.container);
      }
      const wanted = [...this.installed.values()].filter(t => t.enabled).sort((a, b) => a.installedAt - b.installedAt);
      if (this.preview && !wanted.some(t => t.id === this.preview.key)) wanted.push({ id: 'preview', css: this.preview.css });
      const existing = new Map([...this.container.children].map(el => [el.dataset.id, el]));
      for (const [id, el] of existing) if (!wanted.some(w => w.id === id)) el.remove();
      for (const w of wanted) {
        let el = existing.get(w.id);
        if (!el) { el = document.createElement('style'); el.dataset.id = w.id; }
        if (el.textContent !== w.css) el.textContent = w.css;
        this.container.append(el);
      }
    },

    async fetchCss(url) {
      let text;
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      } catch {
        text = (await this.ctx.hostFetch(url)).body;   // host allowlist covers the theme file hosts
      }
      if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('The theme file isn\'t CSS.');
      if (text.length > 4 * 1024 * 1024) throw new Error('The theme file is too large.');
      return text;
    },

    async install(entry) {
      const css = await this.fetchCss(entry.cssUrl);
      const record = { ...entry, id: entry.key, css, enabled: true, installedAt: Date.now(), installedUrl: entry.cssUrl };
      await this.persist(record);
      this.installed.set(record.id, record);
      if (this.preview?.key === entry.key) this.preview = null;
      this.apply();
      this.emit();
    },

    async update(entry) {
      const old = this.installed.get(entry.key);
      if (!old) return;
      const css = await this.fetchCss(entry.cssUrl);
      const record = { ...old, ...entry, id: entry.key, css, installedUrl: entry.cssUrl };
      await this.persist(record);
      this.installed.set(record.id, record);
      this.apply();
      this.emit();
    },

    async setEnabled(key, enabled) {
      const t = this.installed.get(key);
      if (!t) return;
      t.enabled = enabled;
      await this.persist(t);
      this.apply();
      this.emit();
    },

    async remove(key) {
      await this.forget(key);
      this.installed.delete(key);
      this.apply();
      this.emit();
    },

    /** Save a theme locally and, when shared, for the other accounts. */
    async persist(record) {
      await db.put('themes', record);
      if (this.shared) this.ctx.host.send({ t: 'themes:put', theme: record });
    },

    async forget(key) {
      await db.del('themes', key);
      if (this.shared) this.ctx.host.send({ t: 'themes:delete', id: key });
    },

    /**
     * Start sharing through the host: its list wins, except that the first time, themes this
     * account installed before sharing existed are added to it.
     */
    async startSharing(ctx) {
      ctx.on('themes', (m) => this.syncFrom(m.themes || []));
      ctx.on('theme:put', async (m) => {
        if (!m.theme?.id) return;
        this.installed.set(m.theme.id, m.theme);
        await db.put('themes', m.theme).catch(() => { });
        this.apply();
        this.emit();
      });
      ctx.on('theme:delete', async (m) => {
        this.installed.delete(m.id);
        await db.del('themes', m.id).catch(() => { });
        this.apply();
        this.emit();
      });
      ctx.host.send({ t: 'themes:list' });
    },

    async syncFrom(list) {
      const shared = new Map(list.filter(t => t?.id).map(t => [t.id, t]));
      const migrated = await db.get('kv', 'sharedThemesMigrated').catch(() => null);
      if (!migrated) {
        for (const [id, t] of this.installed) {
          if (shared.has(id)) continue;
          shared.set(id, t);
          this.ctx.host.send({ t: 'themes:put', theme: t });
        }
        await db.put('kv', Date.now(), 'sharedThemesMigrated').catch(() => { });
      }
      this.shared = true;
      for (const id of this.installed.keys()) if (!shared.has(id)) await db.del('themes', id).catch(() => { });
      for (const t of shared.values()) await db.put('themes', t).catch(() => { });
      this.installed = shared;
      this.apply();
      this.emit();
    },

    async startPreview(entry) {
      const css = await this.fetchCss(entry.cssUrl);
      this.preview = { key: entry.key, name: entry.name, css, entry };
      this.apply();
      this.emit();
    },

    stopPreview() {
      if (!this.preview) return;
      this.preview = null;
      this.apply();
      this.emit();
    },

    updateFor(key) {
      const t = this.installed.get(key);
      const e = this.store.entries?.find(x => x.key === key);
      return t && e && (e.cssUrl !== t.installedUrl || e.version !== t.version) ? e : null;
    },

    /** Store listings, cached for six hours. */
    async loadStore(force = false) {
      if (this.store.loading) return;
      const cacheKey = 'store:betterdiscord';
      if (!force && !this.store.entries) {
        const cached = await db.get('kv', cacheKey).catch(() => null);
        if (cached?.entries) Object.assign(this.store, { entries: cached.entries, at: cached.at });
      }
      if (!force && this.store.entries && Date.now() - this.store.at < 6 * 3600_000) { this.emit(); return; }
      this.store.loading = true;
      this.store.error = null;
      this.emit();
      try {
        const lists = await Promise.all(Object.values(SOURCES).map(s => s.list(this.ctx)));
        this.store.entries = lists.flat();
        this.store.at = Date.now();
        await db.put('kv', { entries: this.store.entries, at: this.store.at }, cacheKey).catch(() => { });
      } catch (err) {
        this.store.error = err?.message || String(err);
      } finally {
        this.store.loading = false;
        this.emit();
      }
    },

    /** Bring installed store themes up to date (on start, at most once a day). */
    async autoUpdate() {
      if (!this.installed.size) return;
      const last = await db.get('kv', 'lastAutoUpdate').catch(() => 0);
      if (Date.now() - (last || 0) < 24 * 3600_000) return;
      await this.loadStore(true);
      if (!this.store.entries) return;
      let updated = 0;
      for (const key of this.installed.keys()) {
        const e = this.updateFor(key);
        if (!e) continue;
        try { await this.update(e); updated++; } catch (err) { this.ctx.report(`theme update failed (${key}): ${err}`); }
      }
      await db.put('kv', Date.now(), 'lastAutoUpdate').catch(() => { });
      if (updated) this.ctx.toast(`Updated ${updated} theme${updated === 1 ? '' : 's'}.`);
    },
  };

  // Apply installed themes right away, before Discord finishes loading.
  themes.load();

  // ---- preview images -----------------------------------------------------------------------
  // Store screenshots are full-size PNGs (often 1–2 MB). Each is downloaded once, through the
  // host because the image server doesn't allow the page to read pixels cross-origin, and
  // re-encoded into a small card image and a large viewer image, cached in IndexedDB. Cards and
  // the full-size view then load from local blobs: instant, and far lighter than the originals.

  const images = {
    ready: new Map(),     // src → { thumb, large, width, height } (object URLs)
    jobs: new Map(),      // src → Promise
    queue: [],
    active: 0,
    maxActive: 3,

    /** opts.prefetch: queue behind on-screen images instead of ahead of them. */
    get(src, opts = {}) {
      if (this.ready.has(src)) return Promise.resolve(this.ready.get(src));
      if (!this.jobs.has(src)) this.jobs.set(src, new Promise((resolve, reject) => {
        const job = { src, resolve, reject };
        if (opts.prefetch) this.queue.push(job); else this.queue.unshift(job);
        this.pump();
      }).finally(() => this.jobs.delete(src)));
      else if (!opts.prefetch) this.prioritise(src);   // a prefetched image just came on screen
      return this.jobs.get(src);
    },

    /** Move a pending image to the front (e.g. the user is hovering it). */
    prioritise(src) {
      const i = this.queue.findIndex(j => j.src === src);
      if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
    },

    pump() {
      while (this.active < this.maxActive && this.queue.length) {
        const job = this.queue.shift();
        this.active++;
        this.process(job.src).then(job.resolve, job.reject).finally(() => { this.active--; this.pump(); });
      }
    },

    async process(src) {
      let rec = await db.get('images', src).catch(() => null);
      if (!rec) {
        const res = await themes.ctx.hostFetch(src, { binary: true });
        const original = await (await fetch(`data:application/octet-stream;base64,${res.body}`)).blob();
        const bmp = await createImageBitmap(original);
        try {
          rec = {
            thumb: await this.encode(bmp, 640, 0.8),
            large: await this.encode(bmp, 1920, 0.88),
            width: bmp.width,
            height: bmp.height,
            at: Date.now(),
          };
        } finally {
          bmp.close();
        }
        db.put('images', rec, src).catch(() => { });
      }
      const urls = { thumb: URL.createObjectURL(rec.thumb), large: URL.createObjectURL(rec.large), width: rec.width, height: rec.height };
      this.ready.set(src, urls);
      return urls;
    },

    async encode(bmp, maxWidth, quality) {
      const scale = Math.min(1, maxWidth / bmp.width);
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const canvas = new OffscreenCanvas(w, h);
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, w, h);
      return canvas.convertToBlob({ type: 'image/webp', quality });
    },

    /** Drop previews not regenerated for 30 days (store screenshots change rarely). */
    async prune() {
      const conn = await db.open();
      const tx = conn.transaction('images', 'readwrite');
      const store = tx.objectStore('images');
      store.openCursor().onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return;
        if (Date.now() - (cur.value?.at || 0) > 30 * 86400000) cur.delete();
        cur.continue();
      };
    },
  };

  // ---- UI ---------------------------------------------------------------------------------------

  (window.__wispModules ||= []).push((ctx) => {
    const { V, C } = ctx;
    themes.ctx = ctx;
    if (ctx.has('sharedThemes')) themes.startSharing(ctx).catch(err => ctx.report(`shared themes: ${err}`));
    const VP = V.Plugins;
    const settingsPlugin = VP?.plugins?.Settings;
    const R = C.React;
    if (!R || typeof settingsPlugin?.buildLayout !== 'function' || typeof settingsPlugin.buildEntry !== 'function') {
      ctx.report('library: Vencord settings layout not found; keeping Vencord\'s tabs');
      return;
    }
    const h = R.createElement;
    const { useState, useEffect, useMemo } = R;
    const VC = V.Components || {};
    const libraryOn = () => ctx.settings?.features?.library?.enabled !== false;

    mountStyles();
    if (ctx.settings?.features?.library?.autoUpdateThemes !== false) setTimeout(() => themes.autoUpdate(), 15000);
    setTimeout(() => images.prune().catch(() => { }), 30000);

    // -- helpers --

    const cx = (...c) => c.filter(Boolean).join(' ');
    const fmtCount = (n) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    function fmtAgo(ts) {
      if (!ts) return '';
      const days = Math.round((ts - Date.now()) / 86400000);
      if (Math.abs(days) < 1) return 'today';
      if (Math.abs(days) < 30) return rtf.format(days, 'day');
      if (Math.abs(days) < 365) return rtf.format(Math.round(days / 30), 'month');
      return rtf.format(Math.round(days / 365), 'year');
    }
    const openExternal = (url) => window.open(url, '_blank', 'noopener');

    function useRerender(subscribe) {
      const [, set] = useState(0);
      useEffect(() => subscribe(() => set(n => n + 1)), []);
    }

    async function confirmDialog(title, body, confirmText) {
      const Alerts = C.Alerts;
      if (typeof Alerts?.show !== 'function') return window.confirm(`${title}\n\n${body}`);
      return new Promise(resolve => Alerts.show({
        title, body, confirmText, cancelText: 'Cancel',
        onConfirm: () => resolve(true), onCancel: () => resolve(false), onCloseCallback: () => resolve(false),
      }));
    }

    // -- small components --

    const Icon = (name, size = 16) => VC[name] ? h(VC[name], { width: size, height: size, className: 'wisp-lib-icon' }) : null;

    function Button({ kind = 'secondary', size, onClick, disabled, children, title }) {
      return h('button', { type: 'button', className: cx('wisp-lib-btn', `is-${kind}`, size && `is-${size}`), onClick, disabled, title }, children);
    }

    function Toggle({ checked, onChange, disabled }) {
      if (VC.Switch) return h(VC.Switch, { checked, onChange, disabled });
      return h('input', { type: 'checkbox', checked, disabled, onChange: e => onChange(e.target.checked) });
    }

    function Search({ value, onChange, placeholder }) {
      return h('label', { className: 'wisp-lib-search' },
        Icon('SearchIcon', 18),
        h('input', { value, placeholder, onChange: e => onChange(e.target.value), spellCheck: false }),
        value && h('button', { type: 'button', className: 'wisp-lib-search-clear', onClick: () => onChange(''), title: 'Clear' }, '×'));
    }

    function Segmented({ options, value, onChange }) {
      return h('div', { className: 'wisp-lib-seg', role: 'tablist' },
        options.map(o => h('button', {
          key: o.id, type: 'button', role: 'tab', 'aria-selected': value === o.id,
          className: cx('wisp-lib-seg-item', value === o.id && 'is-active'), onClick: () => onChange(o.id),
        }, o.label, o.count != null && h('span', { className: 'wisp-lib-seg-count' }, o.count))));
    }

    function Chips({ items, value, onChange, limit }) {
      const [more, setMore] = useState(false);
      const shown = limit && !more ? items.slice(0, limit) : items;
      return h('div', { className: 'wisp-lib-chips' },
        shown.map(it => h('button', {
          key: it.id, type: 'button', className: cx('wisp-lib-chip', value === it.id && 'is-active'), onClick: () => onChange(value === it.id && it.id !== 'all' ? 'all' : it.id),
        }, it.label, it.count != null && h('span', { className: 'wisp-lib-chip-count' }, it.count))),
        limit && items.length > limit && h('button', { type: 'button', className: 'wisp-lib-chip is-ghost', onClick: () => setMore(!more) }, more ? 'Fewer' : `+${items.length - limit} more`));
    }

    function SelectBox({ value, onChange, options, label }) {
      return h('label', { className: 'wisp-lib-select' },
        label && h('span', null, label),
        h('select', { value, onChange: e => onChange(e.target.value) }, options.map(o => h('option', { key: o.id, value: o.id }, o.label))));
    }

    const Badge = ({ kind, children, title }) => h('span', { className: cx('wisp-lib-badge', `is-${kind}`), title }, children);

    function Empty({ title, children }) {
      return h('div', { className: 'wisp-lib-empty' }, h('div', { className: 'wisp-lib-empty-title' }, title), children);
    }

    function Header({ title, subtitle, actions }) {
      return h('div', { className: 'wisp-lib-header' },
        h('div', null, h('h2', { className: 'wisp-lib-title' }, title), subtitle && h('div', { className: 'wisp-lib-subtitle' }, subtitle)),
        actions && h('div', { className: 'wisp-lib-header-actions' }, actions));
    }

    // Falls back to Vencord's original tab if anything here throws.
    class Boundary extends R.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(err) { ctx.report(`library: ${this.props.name} crashed: ${err?.stack || err}`); }
      render() {
        if (this.state.failed) return this.props.fallback ? h(this.props.fallback) : h('div', null, 'Something went wrong.');
        return this.props.children;
      }
    }

    // ===== Plugins ===========================================================================

    const pendingRestart = new Set();
    let firstSeen = null;   // plugin name → first time Wisp saw it (for the "New" filter)

    async function loadFirstSeen() {
      const now = Date.now();
      const stored = await db.get('kv', 'pluginsFirstSeen').catch(() => null);
      const names = Object.keys(VP.plugins);
      const map = stored || Object.fromEntries(names.map(n => [n, 0]));   // first run: nothing is "new"
      let changed = !stored;
      for (const n of names) if (!(n in map)) { map[n] = now; changed = true; }
      if (changed) await db.put('kv', map, 'pluginsFirstSeen').catch(() => { });
      firstSeen = map;
    }
    loadFirstSeen();
    const isNewPlugin = (name) => !!firstSeen?.[name] && Date.now() - firstSeen[name] < 14 * 86400000;
    const isApi = (p) => /API$/.test(p.name);

    /** Vencord's own toggle logic (from its plugin card), so behaviour matches exactly. */
    function togglePlugin(p, onRestart) {
      const settings = V.Settings.plugins[p.name];
      const wasEnabled = VP.isPluginEnabled(p.name);
      if (!wasEnabled) {
        const { restartNeeded, failures } = VP.startDependenciesRecursive(p);
        if (failures.length) {
          ctx.toast(`Couldn't start what ${p.name} needs: ${failures.join(', ')}`, 'error');
          return;
        }
        if (restartNeeded) { settings.enabled = true; onRestart(p.name); return; }
      }
      if (VP.pluginRequiresRestart(p)) { settings.enabled = !wasEnabled; onRestart(p.name); return; }
      if (wasEnabled && !p.started) { settings.enabled = false; return; }
      const ok = wasEnabled ? VP.stopPlugin(p) : VP.startPlugin(p);
      if (!ok) {
        settings.enabled = false;
        ctx.toast(`Error while ${wasEnabled ? 'stopping' : 'starting'} ${p.name}`, 'error');
        return;
      }
      settings.enabled = !wasEnabled;
    }

    // Hand-picked Vencord plugins, grouped by what they're for. Only ones present in the loaded
    // Vencord build are shown. Nothing that unlocks paid features or exposes hidden content.
    const FEATURED = [
      ['Chat', [
        ['Translate', 'Translate any message into your language with one click.'],
        ['SilentTyping', 'Type without showing "is typing…" to others. Toggle it from the chat bar.'],
        ['ViewRaw', 'See and copy the raw text and formatting of any message.'],
        ['MessageLinkEmbeds', 'Links to messages show a preview of the message itself.'],
        ['NoReplyMention', 'Replies don\'t ping the person you reply to unless you choose to.'],
        ['SendTimestamps', 'Send a time that everyone sees in their own time zone.'],
      ]],
      ['Organise', [
        ['PinDMs', 'Pin DMs to the top of the list and sort them into categories.'],
        ['BetterFolders', 'Open server folders in their own sidebar.'],
        ['ReadAllNotificationsButton', 'One button to mark every server as read.'],
      ]],
      ['Voice & media', [
        ['VolumeBooster', 'Turn people and streams up past 200%.'],
        ['SpotifyControls', 'Spotify playback controls above your user panel.'],
        ['CallTimer', 'Shows how long you\'ve been in a call.'],
        ['ImageZoom', 'A magnifier for images in chat.'],
        ['VoiceMessages', 'Record and send voice messages, like on mobile.'],
      ]],
      ['People & servers', [
        ['PlatformIndicators', 'See whether someone is on desktop, mobile or web.'],
        ['WhoReacted', 'Shows who reacted, right on each reaction.'],
        ['TypingIndicator', 'Typing indicators on channels in the sidebar.'],
        ['ShowConnections', 'Connected accounts (Steam, Spotify, …) in profile popouts.'],
        ['PermissionsViewer', 'See exactly which permissions someone has, and from which roles.'],
      ]],
      ['Privacy & safety', [
        ['ReverseImageSearch', 'Right-click an image to find where else it appears online.'],
        ['MessageLogger', 'Keeps deleted and edited messages visible. Note: this shows things people chose to remove.'],
      ]],
    ];

    function FeaturedView({ onRestart, query }) {
      const [, bump] = useState(0);
      const q = query.trim().toLowerCase();
      const groups = FEATURED.map(([title, items]) => [title, items
        .map(([name, blurb]) => [VP.plugins[name], blurb])
        .filter(([p, blurb]) => p && !p.hidden && (!q || `${p.name} ${blurb} ${p.description}`.toLowerCase().includes(q)))])
        .filter(([, items]) => items.length);
      if (!groups.length) return h(Empty, { title: 'No featured plugins match' });
      return h('div', { className: 'wisp-lib-stack' }, groups.map(([title, items]) =>
        h('section', { key: title, className: 'wisp-lib-featured' },
          h('h3', { className: 'wisp-lib-section-title' }, title),
          h('div', { className: 'wisp-lib-grid' }, items.map(([p, blurb]) => {
            const on = VP.isPluginEnabled(p.name);
            return h('div', { key: p.name, className: cx('wisp-lib-card', 'wisp-lib-plugin', 'is-featured', on && 'is-on') },
              h('div', { className: 'wisp-lib-card-head' },
                h('div', { className: 'wisp-lib-card-name' }, p.name),
                pendingRestart.has(p.name) && h(Badge, { kind: 'warn' }, 'Reload'),
                h('div', { className: 'wisp-lib-spacer' }),
                h(Toggle, { checked: on, onChange: () => { togglePlugin(p, onRestart); bump(n => n + 1); } })),
              h('div', { className: 'wisp-lib-card-desc is-blurb' }, blurb),
              h('div', { className: 'wisp-lib-card-foot' },
                h('span', { className: 'wisp-lib-muted wisp-lib-ellipsis', title: p.description }, p.description),
                h('div', { className: 'wisp-lib-spacer' }),
                h('button', { type: 'button', className: 'wisp-lib-iconbtn', title: 'Settings & details', onClick: () => VC.openPluginModal?.(p, onRestart) }, Icon('CogWheel', 18))));
          })))));
    }

    function PluginsPage() {
      const [view, setView] = useState('featured');
      const [query, setQuery] = useState('');
      const [status, setStatus] = useState('all');
      const [category, setCategory] = useState('all');
      const [sort, setSort] = useState('name');
      const [, bump] = useState(0);
      const refresh = () => bump(n => n + 1);
      const onRestart = (name) => { pendingRestart.add(name); refresh(); };

      const all = useMemo(() => Object.values(VP.plugins).filter(p => !p.hidden), []);
      const enabled = (p) => VP.isPluginEnabled(p.name);

      // Plugins that enabled plugins depend on can't be switched off.
      const neededBy = {};
      for (const p of all) if (enabled(p)) for (const d of p.dependencies || []) (neededBy[d] ||= []).push(p.name);

      const visible = all.filter(p => !p.required);
      const counts = { all: visible.length, enabled: visible.filter(enabled).length };
      const tagCounts = {};
      for (const p of visible) for (const t of (isApi(p) ? ['APIs'] : p.tags?.length ? p.tags : ['Other'])) tagCounts[t] = (tagCounts[t] || 0) + 1;
      const categories = [
        { id: 'all', label: 'All', count: visible.length },
        ...Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ id: t, label: t, count: n })),
        { id: 'required', label: 'Required', count: all.length - visible.length },
      ];

      const q = query.trim().toLowerCase();
      let list = category === 'required' ? all.filter(p => p.required) : visible;
      if (category !== 'all' && category !== 'required')
        list = list.filter(p => (isApi(p) ? ['APIs'] : p.tags?.length ? p.tags : ['Other']).includes(category));
      if (status === 'enabled') list = list.filter(enabled);
      if (status === 'disabled') list = list.filter(p => !enabled(p));
      if (status === 'new') list = list.filter(p => isNewPlugin(p.name));
      if (q) list = list.filter(p => [p.name, p.description, ...(p.tags || []), ...(p.authors || []).map(a => a.name)].join(' ').toLowerCase().includes(q));
      list = [...list].sort((a, b) => sort === 'enabled' && enabled(a) !== enabled(b) ? (enabled(a) ? -1 : 1) : a.name.localeCompare(b.name));

      const restartBanner = pendingRestart.size > 0 && h('div', { className: 'wisp-lib-banner is-warn' },
        h('div', null, h('strong', null, 'Reload to finish: '), [...pendingRestart].join(', ')),
        h(Button, { kind: 'primary', size: 'sm', onClick: () => location.reload() }, Icon('RestartIcon', 14), 'Reload Discord'));
      const header = h(Header, {
        title: 'Plugins',
        subtitle: `${counts.enabled} of ${counts.all} enabled · plugins come with Vencord and update with it`,
        actions: h(Segmented, {
          value: view, onChange: setView, options: [
            { id: 'featured', label: 'Featured' }, { id: 'all', label: 'All plugins', count: counts.all },
          ],
        }),
      });

      if (view === 'featured') return h('div', { className: 'wisp-lib' },
        header, restartBanner,
        h('div', { className: 'wisp-lib-toolbar' }, h(Search, { value: query, onChange: setQuery, placeholder: 'Search featured plugins' })),
        h(FeaturedView, { onRestart, query }));

      return h('div', { className: 'wisp-lib' },
        header, restartBanner,
        h('div', { className: 'wisp-lib-toolbar' },
          h(Search, { value: query, onChange: setQuery, placeholder: `Search ${counts.all} plugins` }),
          h(Segmented, {
            value: status, onChange: setStatus, options: [
              { id: 'all', label: 'All' }, { id: 'enabled', label: 'Enabled', count: counts.enabled },
              { id: 'disabled', label: 'Disabled' }, { id: 'new', label: 'New', count: visible.filter(p => isNewPlugin(p.name)).length || null },
            ],
          }),
          h(SelectBox, { value: sort, onChange: setSort, options: [{ id: 'name', label: 'Name' }, { id: 'enabled', label: 'Enabled first' }] })),
        h(Chips, { items: categories, value: category, onChange: setCategory, limit: 12 }),
        list.length === 0
          ? h(Empty, { title: 'No plugins match' }, h(Button, { onClick: () => { setQuery(''); setStatus('all'); setCategory('all'); } }, 'Clear filters'))
          : h('div', { className: 'wisp-lib-grid' }, list.map(p => h(PluginCard, {
            key: p.name, p, on: enabled(p), lockedBy: neededBy[p.name],
            onToggle: () => { togglePlugin(p, onRestart); refresh(); }, onRestart,
          }))));
    }

    function PluginCard({ p, on, lockedBy, onToggle, onRestart }) {
      const hasSettings = typeof VP.hasAnyVisibleSettings === 'function' ? VP.hasAnyVisibleSettings(p) : !!p.options;
      const authors = (p.authors || []).map(a => a.name).filter(Boolean);
      const openSettings = () => VC.openPluginModal?.(p, (name) => onRestart(name));
      return h('div', { className: cx('wisp-lib-card', 'wisp-lib-plugin', on && 'is-on') },
        h('div', { className: 'wisp-lib-card-head' },
          h('div', { className: 'wisp-lib-card-name', title: p.name }, p.name),
          isNewPlugin(p.name) && h(Badge, { kind: 'brand' }, 'New'),
          pendingRestart.has(p.name) && h(Badge, { kind: 'warn', title: 'Reload Discord to apply' }, 'Reload'),
          h('div', { className: 'wisp-lib-spacer' }),
          h('span', { title: p.required ? 'Vencord needs this plugin' : lockedBy ? `Needed by ${lockedBy.join(', ')}` : '' },
            h(Toggle, { checked: on, onChange: onToggle, disabled: !!p.required || (!!lockedBy && on) }))),
        h('div', { className: 'wisp-lib-card-desc' }, p.description),
        h('div', { className: 'wisp-lib-card-foot' },
          (p.tags || []).slice(0, 3).map(t => h('span', { key: t, className: 'wisp-lib-tag' }, t)),
          h('div', { className: 'wisp-lib-spacer' }),
          authors.length > 0 && h('span', { className: 'wisp-lib-muted wisp-lib-ellipsis', title: authors.join(', ') }, authors.length > 2 ? `${authors[0]} +${authors.length - 1}` : authors.join(', ')),
          h('button', {
            type: 'button', className: 'wisp-lib-iconbtn', onClick: openSettings,
            title: hasSettings ? 'Settings' : 'Details',
          }, Icon(hasSettings ? 'CogWheel' : 'InfoIcon', 18))));
    }

    // ===== Themes ============================================================================

    function ThemesPage() {
      useRerender(fn => themes.subscribe(fn));
      const [tab, setTab] = useState(() => themes.installed.size ? 'library' : 'browse');
      useEffect(() => () => themes.stopPreview(), []);
      const updates = [...themes.installed.keys()].filter(k => themes.updateFor(k)).length;
      return h('div', { className: 'wisp-lib' },
        h(Header, {
          title: 'Themes',
          subtitle: 'Install themes from the BetterDiscord store, or add your own CSS.',
          actions: h(Segmented, {
            value: tab, onChange: setTab, options: [
              { id: 'library', label: 'Library', count: themes.installed.size || null },
              { id: 'browse', label: 'Browse' },
              { id: 'custom', label: 'Custom CSS' },
            ],
          }),
        }),
        themes.preview && h('div', { className: 'wisp-lib-banner is-brand' },
          h('div', null, h('strong', null, 'Previewing '), themes.preview.name, ' — this page and the rest of Discord show the theme until you stop.'),
          h('div', { className: 'wisp-lib-row' },
            !themes.installed.has(themes.preview.key) && h(InstallButton, { entry: themes.preview.entry }),
            h(Button, { size: 'sm', onClick: () => themes.stopPreview() }, 'Stop preview'))),
        updates > 0 && tab !== 'browse' && h('div', { className: 'wisp-lib-banner' },
          h('div', null, `${updates} theme update${updates === 1 ? '' : 's'} available.`),
          h(Button, { size: 'sm', kind: 'primary', onClick: () => updateAll() }, 'Update all')),
        tab === 'library' && h(ThemeLibrary, { goBrowse: () => setTab('browse') }),
        tab === 'browse' && h(ThemeBrowser, null),
        tab === 'custom' && h(CustomCss, null));
    }

    async function updateAll() {
      for (const key of themes.installed.keys()) {
        const e = themes.updateFor(key);
        if (e) await themes.update(e).catch(err => ctx.toast(`${e.name}: ${err.message}`, 'error'));
      }
    }

    function InstallButton({ entry, size = 'sm' }) {
      const [busy, setBusy] = useState(false);
      const install = async () => {
        setBusy(true);
        try { await themes.install(entry); ctx.toast(`Installed ${entry.name}.`); }
        catch (err) { ctx.toast(`Couldn't install ${entry.name}: ${err.message}`, 'error'); }
        finally { setBusy(false); }
      };
      return h(Button, { kind: 'primary', size, onClick: install, disabled: busy }, busy ? 'Installing…' : 'Install');
    }

    /**
     * Full-size view of a theme screenshot, styled after Discord's media viewer. Discord's own
     * viewer can't show the locally cached copy (it rewrites image URLs to fetch resized versions),
     * and would re-download the full original; this shows the cached image immediately.
     */
    function openImage(src, info, originalUrl) {
      const overlay = document.createElement('div');
      overlay.className = 'wisp-lib-lightbox';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Image preview');
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      if (info?.width) { img.width = info.width; img.height = info.height; }
      const bar = document.createElement('div');
      bar.className = 'wisp-lib-lightbox-bar';
      const button = (label, svgPath, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg>`;
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return b;
      };
      const close = () => {
        removeEventListener('keydown', onKey, true);
        overlay.classList.add('is-closing');
        setTimeout(() => overlay.remove(), 120);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
      if (originalUrl) bar.append(button('Open original in browser', '<path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/>', () => openExternal(originalUrl)));
      bar.append(button('Close', '<path d="M6 6l12 12M18 6 6 18"/>', close));
      // Click the image to toggle 100% zoom (scrollable when larger than the window).
      img.addEventListener('click', (e) => { e.stopPropagation(); overlay.classList.toggle('is-zoomed'); });
      overlay.addEventListener('click', close);
      addEventListener('keydown', onKey, true);
      overlay.append(img, bar);
      document.body.append(overlay);
    }

    /** The nearest scrolling ancestor (Discord's settings scroller), for visibility checks. */
    function scrollParent(el) {
      for (let p = el?.parentElement; p; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
      }
      return null;
    }

    /**
     * Preview image for a card. `order` is every preview in display order and `index` this card's
     * place in it, so when the card comes into view the next row's previews are prepared too.
     */
    function Thumb({ src, name, order, index }) {
      const ref = R.useRef(null);
      const [urls, setUrls] = useState(() => (src && images.ready.get(src)) || null);
      const [failed, setFailed] = useState(false);
      useEffect(() => {
        if (!src) return;
        let alive = true;
        const el = ref.current;
        const prefetchNextRow = () => {
          if (!order || index == null || !el) return;
          const grid = el.closest('.wisp-lib-grid, .wisp-lib-list');
          const cols = grid?.classList.contains('wisp-lib-grid')
            ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length) : 1;
          const nextRowStart = (Math.floor(index / cols) + 1) * cols;
          for (const next of order.slice(nextRowStart, nextRowStart + cols)) if (next) images.get(next, { prefetch: true }).catch(() => { });
        };
        const start = () => {
          prefetchNextRow();
          if (urls) return;
          images.get(src).then(u => alive && setUrls(u), () => alive && setFailed(true));
        };
        if (!el || typeof IntersectionObserver !== 'function') { start(); return () => { alive = false; }; }
        const io = new IntersectionObserver((entries) => {
          if (entries.some(e => e.isIntersecting)) { io.disconnect(); start(); }
        }, { root: scrollParent(el), rootMargin: '0px 0px 200px 0px' });
        io.observe(el);
        return () => { alive = false; io.disconnect(); };
      }, [src, index, order]);
      if (!src || failed) return h('div', { className: 'wisp-lib-thumb' }, h('div', { className: 'wisp-lib-thumb-fallback' }, (name || '?').slice(0, 1)));
      return h('button', {
        ref, type: 'button', className: 'wisp-lib-thumb is-zoomable', title: `View ${name} full size`,
        onMouseEnter: () => images.prioritise(src),
        onClick: async () => {
          const u = urls || await images.get(src).catch(() => null);
          openImage(u?.large || src, u, src);
        },
      }, urls ? h('img', { src: urls.thumb, alt: '', decoding: 'async' }) : h('div', { className: 'wisp-lib-thumb-loading' }));
    }

    function Author({ author }) {
      return h('span', { className: 'wisp-lib-author' },
        author.avatar && h('img', { src: author.avatar, alt: '', loading: 'lazy' }),
        h('span', { className: 'wisp-lib-ellipsis' }, author.name));
    }

    function ThemeLibrary({ goBrowse }) {
      const list = [...themes.installed.values()].sort((a, b) => a.name.localeCompare(b.name));
      useEffect(() => { themes.loadStore(); }, []);
      if (!list.length) return h(Empty, { title: 'No themes installed yet' },
        h('div', { className: 'wisp-lib-muted' }, 'Browse the BetterDiscord store to find one, or write your own in Custom CSS.'),
        h(Button, { kind: 'primary', onClick: goBrowse }, 'Browse themes'));
      const order = list.map(t => t.thumbnail);
      return h('div', { className: 'wisp-lib-list' }, list.map((t, i) => h(LibraryItem, { key: t.id, t, index: i, order })));
    }

    function LibraryItem({ t, index, order }) {
      const [busy, setBusy] = useState(false);
      const update = themes.updateFor(t.id);
      const run = async (fn, done) => {
        setBusy(true);
        try { await fn(); if (done) ctx.toast(done); } catch (err) { ctx.toast(err.message, 'error'); } finally { setBusy(false); }
      };
      return h('div', { className: cx('wisp-lib-card', 'wisp-lib-item', t.enabled && 'is-on') },
        h(Thumb, { src: t.thumbnail, name: t.name, index, order }),
        h('div', { className: 'wisp-lib-item-body' },
          h('div', { className: 'wisp-lib-card-head' },
            h('div', { className: 'wisp-lib-card-name' }, t.name),
            t.version && h('span', { className: 'wisp-lib-muted' }, `v${t.version}`),
            update && h(Badge, { kind: 'brand' }, `Update${update.version ? ' to v' + update.version : ''}`)),
          h('div', { className: 'wisp-lib-card-desc is-short' }, t.description),
          h('div', { className: 'wisp-lib-card-foot' },
            h(Author, { author: t.author || { name: 'Unknown' } }),
            h('span', { className: 'wisp-lib-muted' }, `· ${SOURCES[t.source]?.label ?? t.source}`),
            h('div', { className: 'wisp-lib-spacer' }),
            update && h(Button, { size: 'sm', kind: 'primary', disabled: busy, onClick: () => run(() => themes.update(update), `Updated ${t.name}.`) }, 'Update'),
            t.pageUrl && h('button', { type: 'button', className: 'wisp-lib-iconbtn', title: 'Open store page', onClick: () => openExternal(t.pageUrl) }, Icon('OpenExternalIcon', 18)),
            h('button', {
              type: 'button', className: 'wisp-lib-iconbtn is-danger', title: 'Remove', disabled: busy,
              onClick: async () => { if (await confirmDialog(`Remove ${t.name}?`, 'The theme is deleted from Wisp. You can install it again from Browse.', 'Remove')) run(() => themes.remove(t.id)); },
            }, Icon('DeleteIcon', 18)))),
        h('div', { className: 'wisp-lib-item-toggle' }, h(Toggle, { checked: !!t.enabled, onChange: v => themes.setEnabled(t.id, v) })));
    }

    function ThemeBrowser() {
      const [query, setQuery] = useState('');
      const [tag, setTag] = useState('all');
      const [sort, setSort] = useState('popular');
      const [hideOutdated, setHideOutdated] = useState(false);
      useEffect(() => { themes.loadStore(); }, []);
      const { entries, loading, error } = themes.store;

      if (!entries) {
        if (error) return h(Empty, { title: 'Couldn\'t load the theme store' },
          h('div', { className: 'wisp-lib-muted' }, error),
          h(Button, { kind: 'primary', onClick: () => themes.loadStore(true) }, 'Try again'));
        return h('div', { className: 'wisp-lib-grid is-themes' }, Array.from({ length: 6 }, (_, i) => h('div', { key: i, className: 'wisp-lib-card is-skeleton' })));
      }

      const tagCounts = {};
      for (const e of entries) for (const t of e.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
      const tags = [{ id: 'all', label: 'All', count: entries.length },
        ...Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ id: t, label: t[0].toUpperCase() + t.slice(1), count: n }))];

      const q = query.trim().toLowerCase();
      let list = entries;
      if (tag !== 'all') list = list.filter(e => e.tags.includes(tag));
      if (hideOutdated) list = list.filter(e => e.updatedAt >= OUTDATED_BEFORE);
      if (q) list = list.filter(e => [e.name, e.description, e.author.name, ...e.tags].join(' ').toLowerCase().includes(q));
      const sorters = {
        popular: (a, b) => b.downloads - a.downloads,
        liked: (a, b) => b.likes - a.likes,
        updated: (a, b) => b.updatedAt - a.updatedAt,
        newest: (a, b) => b.createdAt - a.createdAt,
        name: (a, b) => a.name.localeCompare(b.name),
      };
      list = [...list].sort(sorters[sort]);
      const order = list.map(e => e.thumbnail);

      return h(R.Fragment, null,
        h('div', { className: 'wisp-lib-toolbar' },
          h(Search, { value: query, onChange: setQuery, placeholder: `Search ${entries.length} themes` }),
          h(SelectBox, {
            label: 'Sort', value: sort, onChange: setSort, options: [
              { id: 'popular', label: 'Most downloaded' }, { id: 'liked', label: 'Most liked' },
              { id: 'updated', label: 'Recently updated' }, { id: 'newest', label: 'Newest' }, { id: 'name', label: 'Name' },
            ],
          }),
          h('label', { className: 'wisp-lib-check', title: `Hide themes not updated since Discord's ${new Date(OUTDATED_BEFORE).getFullYear()} redesign` },
            h(Toggle, { checked: hideOutdated, onChange: setHideOutdated }), 'Up to date only'),
          h('button', { type: 'button', className: 'wisp-lib-iconbtn', title: loading ? 'Refreshing…' : 'Refresh', disabled: loading, onClick: () => themes.loadStore(true) }, Icon('RestartIcon', 18))),
        h(Chips, { items: tags, value: tag, onChange: setTag, limit: 12 }),
        list.length === 0
          ? h(Empty, { title: 'No themes match' }, h(Button, { onClick: () => { setQuery(''); setTag('all'); setHideOutdated(false); } }, 'Clear filters'))
          : h('div', { className: 'wisp-lib-grid is-themes' }, list.map((e, i) => h(ThemeCard, { key: e.key, e, index: i, order }))),
        h('div', { className: 'wisp-lib-footnote' }, 'Themes from the ', h('a', { href: 'https://betterdiscord.app/themes', target: '_blank', rel: 'noopener' }, 'BetterDiscord store'), ', made by their authors. Themes change how Discord looks only.'));
    }

    function ThemeCard({ e, index, order }) {
      const [busy, setBusy] = useState(false);
      const installed = themes.installed.get(e.key);
      const previewing = themes.preview?.key === e.key;
      const outdated = e.updatedAt && e.updatedAt < OUTDATED_BEFORE;
      const update = installed && themes.updateFor(e.key);
      const preview = async () => {
        if (previewing) return themes.stopPreview();
        setBusy(true);
        try { await themes.startPreview(e); } catch (err) { ctx.toast(`Couldn't preview ${e.name}: ${err.message}`, 'error'); } finally { setBusy(false); }
      };
      return h('div', { className: cx('wisp-lib-card', 'wisp-lib-theme', installed && 'is-on') },
        h(Thumb, { src: e.thumbnail, name: e.name, index, order }),
        h('div', { className: 'wisp-lib-theme-body' },
          h('div', { className: 'wisp-lib-card-head' },
            h('div', { className: 'wisp-lib-card-name', title: e.name }, e.name),
            installed && h(Badge, { kind: 'ok' }, 'Installed'),
            outdated && h(Badge, { kind: 'warn', title: `Not updated since Discord's redesign; parts may look wrong` }, 'May be outdated')),
          h('div', { className: 'wisp-lib-card-desc is-short' }, e.description),
          h('div', { className: 'wisp-lib-stats' },
            h(Author, { author: e.author }),
            h('span', { title: `${e.likes} likes` }, '♥ ', fmtCount(e.likes)),
            h('span', { title: `${e.downloads} downloads` }, '↓ ', fmtCount(e.downloads)),
            h('span', { title: new Date(e.updatedAt).toLocaleDateString() }, fmtAgo(e.updatedAt))),
          h('div', { className: 'wisp-lib-card-foot' },
            installed
              ? (update ? h(Button, { kind: 'primary', size: 'sm', disabled: busy, onClick: async () => { setBusy(true); try { await themes.update(e); } finally { setBusy(false); } } }, 'Update')
                : h(Button, { size: 'sm', onClick: () => themes.setEnabled(e.key, !installed.enabled) }, installed.enabled ? 'Turn off' : 'Turn on'))
              : h(InstallButton, { entry: e }),
            h(Button, { size: 'sm', kind: previewing ? 'brand-outline' : 'secondary', disabled: busy || (installed?.enabled && !previewing), onClick: preview }, previewing ? 'Stop preview' : busy ? 'Loading…' : 'Preview'),
            h('div', { className: 'wisp-lib-spacer' }),
            h('button', { type: 'button', className: 'wisp-lib-iconbtn', title: 'Open store page', onClick: () => openExternal(e.pageUrl) }, Icon('OpenExternalIcon', 18)))));
    }

    function CustomCss() {
      const [links, setLinks] = useState(() => [...(V.Settings.themeLinks || [])]);
      const [draft, setDraft] = useState('');
      const [quick, setQuick] = useState(() => !!V.Settings.useQuickCss);
      const saveLinks = (next) => { V.Settings.themeLinks = next; setLinks(next); };
      const add = () => {
        const url = draft.trim();
        if (!/^https:\/\//.test(url)) { ctx.toast('Theme links must start with https://', 'error'); return; }
        if (!links.includes(url)) saveLinks([...links, url]);
        setDraft('');
      };
      return h('div', { className: 'wisp-lib-stack' },
        h('div', { className: 'wisp-lib-card wisp-lib-section' },
          h('div', { className: 'wisp-lib-card-head' },
            h('div', null, h('div', { className: 'wisp-lib-card-name' }, 'QuickCSS'),
              h('div', { className: 'wisp-lib-muted' }, 'Your own CSS, applied on top of every theme.')),
            h('div', { className: 'wisp-lib-spacer' }),
            h(Button, { kind: 'primary', size: 'sm', onClick: () => window.VencordNative?.quickCss?.openEditor?.() }, Icon('PencilIcon', 14), 'Edit QuickCSS'),
            h(Toggle, { checked: quick, onChange: v => { V.Settings.useQuickCss = v; setQuick(v); } }))),
        h('div', { className: 'wisp-lib-card wisp-lib-section' },
          h('div', { className: 'wisp-lib-card-name' }, 'Theme links'),
          h('div', { className: 'wisp-lib-muted' }, 'CSS files loaded from a URL (one theme each), handled by Vencord. Useful for themes that aren\'t in a store.'),
          h('div', { className: 'wisp-lib-linkadd' },
            h('input', { value: draft, placeholder: 'https://example.com/theme.css', onChange: e => setDraft(e.target.value), onKeyDown: e => { if (e.key === 'Enter') add(); }, spellCheck: false }),
            h(Button, { kind: 'primary', size: 'sm', onClick: add, disabled: !draft.trim() }, Icon('PlusIcon', 14), 'Add')),
          links.length === 0
            ? h('div', { className: 'wisp-lib-muted is-small' }, 'No theme links.')
            : h('div', { className: 'wisp-lib-links' }, links.map(url => h('div', { key: url, className: 'wisp-lib-link' },
              Icon('LinkIcon', 16), h('span', { className: 'wisp-lib-ellipsis', title: url }, url),
              h('div', { className: 'wisp-lib-spacer' }),
              h('button', { type: 'button', className: 'wisp-lib-iconbtn is-danger', title: 'Remove', onClick: () => saveLinks(links.filter(l => l !== url)) }, Icon('DeleteIcon', 16)))))));
    }

    // ===== wiring into Vencord's settings section =============================================

    const wrap = (name, Page, Fallback) => function WispLibraryTab() {
      return h(Boundary, { name, fallback: Fallback }, h(Page));
    };
    const PluginsTab = wrap('Plugins', PluginsPage, VC.PluginsTab);
    const ThemesTab = wrap('Themes', ThemesPage, VC.ThemesTab);

    // Discord calls Vencord's Settings.buildLayout each time it builds the settings sidebar; wrap
    // it and swap the Plugins and Themes entries for Wisp's pages.
    const originalBuildLayout = settingsPlugin.buildLayout;
    settingsPlugin.buildLayout = function (section) {
      const layout = originalBuildLayout.call(this, section);
      if (!libraryOn() || !Array.isArray(layout)) return layout;
      const vencord = layout.find(x => x?.key === 'vencord_section');
      if (!vencord || vencord.__wisp) return layout;
      const inner = vencord.buildLayout;
      vencord.buildLayout = () => inner().map(entry => {
        if (entry?.key === 'vencord_plugins')
          return this.buildEntry({ key: 'vencord_plugins', title: 'Plugins', Component: PluginsTab, Icon: VC.PluginsIcon || (() => null) });
        if (entry?.key === 'vencord_themes')
          return this.buildEntry({ key: 'vencord_themes', title: 'Themes', Component: ThemesTab, Icon: VC.PaintbrushIcon || (() => null) });
        return entry;
      });
      vencord.__wisp = true;
      return layout;
    };
    window.__wisp && (window.__wisp.library = { themes, SOURCES, images });
  });

  // ---- styles ----------------------------------------------------------------------------------
  // Discord's own colour variables (with fallbacks for older/newer names), so themes apply here.

  function mountStyles() {
    if (document.getElementById('wisp-library-css')) return;
    const style = document.createElement('style');
    style.id = 'wisp-library-css';
    style.textContent = `
.wisp-lib {
  --wl-text: var(--text-default, var(--text-normal, #dbdee1));
  --wl-strong: var(--text-strong, var(--header-primary, #f2f3f5));
  --wl-muted: var(--text-muted, #949ba4);
  --wl-card: var(--background-base-lower, var(--background-secondary, #2b2d31));
  --wl-card-hover: var(--background-mod-subtle, var(--background-modifier-hover, rgba(78,80,88,.3)));
  --wl-field: var(--input-background, var(--background-base-lowest, var(--background-tertiary, #1e1f22)));
  --wl-border: var(--border-subtle, var(--background-modifier-accent, rgba(255,255,255,.06)));
  --wl-border-strong: var(--border-normal, rgba(255,255,255,.12));
  --wl-brand: var(--brand-500, var(--brand-experiment, #5865f2));
  --wl-ok: var(--status-positive, var(--green-360, #23a55a));
  --wl-warn: var(--status-warning, var(--yellow-300, #f0b232));
  --wl-danger: var(--status-danger, var(--red-400, #f23f43));
  --wl-radius: var(--radius-md, 10px);
  color: var(--wl-text);
  font-family: var(--font-primary, "gg sans", "Noto Sans", sans-serif);
  display: flex; flex-direction: column; gap: 16px; padding-bottom: 24px;
}
.wisp-lib *, .wisp-lib *::before, .wisp-lib *::after { box-sizing: border-box; }
.wisp-lib-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.wisp-lib-title { margin: 0; font-family: var(--font-display, var(--font-primary)); font-size: 24px; font-weight: 700; color: var(--wl-strong); line-height: 1.2; }
.wisp-lib-subtitle { margin-top: 4px; color: var(--wl-muted); font-size: 14px; }
.wisp-lib-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wisp-lib-search { flex: 1 1 240px; display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border-radius: 8px;
  background: var(--wl-field); border: 1px solid var(--wl-border); color: var(--wl-muted); cursor: text; }
.wisp-lib-search:focus-within { border-color: var(--wl-brand); }
.wisp-lib-search input { flex: 1; min-width: 0; background: none; border: 0; outline: 0; color: var(--wl-text); font: inherit; font-size: 15px; }
.wisp-lib-search-clear { background: none; border: 0; color: var(--wl-muted); font-size: 20px; cursor: pointer; padding: 0 2px; line-height: 1; }
.wisp-lib-seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 8px; background: var(--wl-field); border: 1px solid var(--wl-border); }
.wisp-lib-seg-item { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 0; border-radius: 6px;
  background: none; color: var(--wl-muted); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }
.wisp-lib-seg-item:hover { color: var(--wl-text); background: var(--wl-card-hover); }
.wisp-lib-seg-item.is-active { background: var(--wl-card); color: var(--wl-strong); box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.wisp-lib-seg-count { font-size: 12px; padding: 0 6px; border-radius: 8px; background: var(--wl-card-hover); color: var(--wl-muted); }
.wisp-lib-select { display: inline-flex; align-items: center; gap: 8px; color: var(--wl-muted); font-size: 13px; }
.wisp-lib-select select { height: 40px; padding: 0 10px; border-radius: 8px; background: var(--wl-field); color: var(--wl-text);
  border: 1px solid var(--wl-border); font: inherit; font-size: 14px; cursor: pointer; }
.wisp-lib-check { display: inline-flex; align-items: center; gap: 8px; color: var(--wl-text); font-size: 14px; cursor: pointer; white-space: nowrap; }
.wisp-lib-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.wisp-lib-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 14px; cursor: pointer;
  border: 1px solid var(--wl-border); background: transparent; color: var(--wl-text); font: inherit; font-size: 13px; font-weight: 500; }
.wisp-lib-chip:hover { background: var(--wl-card-hover); }
.wisp-lib-chip.is-active { background: var(--wl-brand); border-color: var(--wl-brand); color: #fff; }
.wisp-lib-chip.is-ghost { border-style: dashed; color: var(--wl-muted); }
.wisp-lib-chip-count { font-size: 11px; opacity: .7; }
.wisp-lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.wisp-lib-grid.is-themes { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.wisp-lib-card { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 14px; border-radius: var(--wl-radius);
  background: var(--wl-card); border: 1px solid var(--wl-border); transition: border-color .12s, box-shadow .12s; min-width: 0; }
.wisp-lib-card:hover { border-color: var(--wl-border-strong); box-shadow: 0 4px 14px rgba(0,0,0,.18); }
.wisp-lib-card.is-on { border-color: color-mix(in srgb, var(--wl-brand) 45%, var(--wl-border)); }
.wisp-lib-card.is-skeleton { min-height: 260px; animation: wisp-lib-pulse 1.2s ease-in-out infinite; }
@keyframes wisp-lib-pulse { 50% { opacity: .55; } }
.wisp-lib-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wisp-lib-card-name { font-size: 16px; font-weight: 600; color: var(--wl-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wisp-lib-card-desc { color: var(--wl-text); font-size: 14px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; flex: 1; }
.wisp-lib-card-desc.is-short { -webkit-line-clamp: 2; flex: 0 0 auto; }
.wisp-lib-card-foot { display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: auto; }
.wisp-lib-spacer { flex: 1; }
.wisp-lib-muted { color: var(--wl-muted); font-size: 13px; }
.wisp-lib-muted.is-small { font-size: 12px; }
.wisp-lib-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wisp-lib-tag { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; padding: 2px 7px; border-radius: 4px;
  background: var(--wl-card-hover); color: var(--wl-muted); white-space: nowrap; }
.wisp-lib-badge { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 4px; white-space: nowrap; flex: none; }
.wisp-lib-badge.is-brand { background: var(--wl-brand); color: #fff; }
.wisp-lib-badge.is-ok { background: color-mix(in srgb, var(--wl-ok) 20%, transparent); color: var(--wl-ok); }
.wisp-lib-badge.is-warn { background: color-mix(in srgb, var(--wl-warn) 18%, transparent); color: var(--wl-warn); }
.wisp-lib-iconbtn { display: inline-grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 6px; background: transparent;
  color: var(--interactive-normal, var(--wl-muted)); cursor: pointer; flex: none; }
.wisp-lib-iconbtn:hover:not(:disabled) { background: var(--wl-card-hover); color: var(--interactive-hover, var(--wl-text)); }
.wisp-lib-iconbtn.is-danger:hover:not(:disabled) { color: var(--wl-danger); }
.wisp-lib-iconbtn:disabled { opacity: .4; cursor: default; }
.wisp-lib-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 16px; border-radius: 8px;
  border: 1px solid transparent; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: filter .12s, background .12s; }
.wisp-lib-btn.is-sm { height: 30px; padding: 0 12px; font-size: 13px; }
.wisp-lib-btn.is-primary { background: var(--wl-brand); color: #fff; }
.wisp-lib-btn.is-secondary { background: var(--button-secondary-background, var(--wl-card-hover)); color: var(--wl-text); border-color: var(--wl-border); }
.wisp-lib-btn.is-brand-outline { background: transparent; color: var(--wl-brand); border-color: var(--wl-brand); }
.wisp-lib-btn:hover:not(:disabled) { filter: brightness(1.1); }
.wisp-lib-btn:disabled { opacity: .5; cursor: default; }
.wisp-lib-icon { flex: none; }
.wisp-lib-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 10px 14px;
  border-radius: var(--wl-radius); background: var(--wl-card); border: 1px solid var(--wl-border); font-size: 14px; }
.wisp-lib-banner.is-warn { border-color: color-mix(in srgb, var(--wl-warn) 60%, transparent); background: color-mix(in srgb, var(--wl-warn) 10%, var(--wl-card)); }
.wisp-lib-banner.is-brand { border-color: color-mix(in srgb, var(--wl-brand) 60%, transparent); background: color-mix(in srgb, var(--wl-brand) 12%, var(--wl-card)); }
.wisp-lib-row { display: flex; gap: 8px; align-items: center; }
.wisp-lib-thumb { position: relative; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; background: var(--wl-field); flex: none; }
.wisp-lib-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .2s; }
.wisp-lib-thumb.is-zoomable { display: block; width: 100%; padding: 0; border: 0; cursor: zoom-in; }
.wisp-lib-thumb-loading { width: 100%; height: 100%; background: linear-gradient(100deg, var(--wl-field) 30%, var(--wl-card-hover) 50%, var(--wl-field) 70%);
  background-size: 300% 100%; animation: wisp-lib-shimmer 1.4s linear infinite; }
@keyframes wisp-lib-shimmer { from { background-position: 100% 0; } to { background-position: -50% 0; } }
.wisp-lib-item .wisp-lib-thumb.is-zoomable { width: 168px; }
.wisp-lib-thumb.is-zoomable:hover img { transform: scale(1.03); }
.wisp-lib-thumb.is-zoomable:focus-visible { outline: 2px solid var(--wl-brand); outline-offset: 2px; }
.wisp-lib-lightbox { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 56px 48px 40px;
  background: rgba(0,0,0,.85); overflow: auto; animation: wisp-lib-fade .12s ease-out; }
.wisp-lib-lightbox.is-closing { animation: wisp-lib-fade .12s ease-in reverse forwards; }
.wisp-lib-lightbox img { max-width: 100%; max-height: calc(100vh - 96px); width: auto; height: auto; border-radius: 6px; cursor: zoom-in;
  box-shadow: 0 8px 40px rgba(0,0,0,.6); animation: wisp-lib-pop .16s cubic-bezier(.2,.9,.3,1.2); }
.wisp-lib-lightbox.is-zoomed { place-items: start center; }
.wisp-lib-lightbox.is-zoomed img { max-width: none; max-height: none; cursor: zoom-out; }
.wisp-lib-lightbox-bar { position: fixed; top: 16px; right: 16px; display: flex; gap: 8px; }
.wisp-lib-lightbox-bar button { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 8px; border: 0; cursor: pointer;
  background: rgba(32,34,37,.9); color: #dbdee1; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
.wisp-lib-lightbox-bar button:hover { background: rgba(54,57,63,.95); color: #fff; }
@keyframes wisp-lib-fade { from { opacity: 0; } }
@keyframes wisp-lib-pop { from { transform: scale(.94); opacity: .4; } }
.wisp-lib-thumb-fallback { width: 100%; height: 100%; display: grid; place-items: center; font-size: 34px; font-weight: 700; color: var(--wl-muted);
  background: linear-gradient(135deg, color-mix(in srgb, var(--wl-brand) 25%, var(--wl-field)), var(--wl-field)); }
.wisp-lib-theme { padding: 10px; }
.wisp-lib-theme-body { display: flex; flex-direction: column; gap: 6px; padding: 2px 4px 2px; flex: 1; }
.wisp-lib-stats { display: flex; align-items: center; gap: 12px; color: var(--wl-muted); font-size: 12px; min-width: 0; }
.wisp-lib-author { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--wl-text); font-size: 13px; font-weight: 500; }
.wisp-lib-stats .wisp-lib-author { flex: 1; }
.wisp-lib-author img { width: 18px; height: 18px; border-radius: 50%; flex: none; }
.wisp-lib-list { display: flex; flex-direction: column; gap: 10px; }
.wisp-lib-item { flex-direction: row; align-items: stretch; gap: 14px; padding: 10px; }
.wisp-lib-item .wisp-lib-thumb { width: 168px; }
.wisp-lib-item-body { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; padding: 2px 0; }
.wisp-lib-item-toggle { display: flex; align-items: flex-start; padding: 4px 2px 0 0; }
.wisp-lib-stack { display: flex; flex-direction: column; gap: 12px; }
.wisp-lib-section { gap: 10px; }
.wisp-lib-linkadd { display: flex; gap: 8px; }
.wisp-lib-linkadd input { flex: 1; height: 36px; padding: 0 10px; border-radius: 8px; background: var(--wl-field); color: var(--wl-text);
  border: 1px solid var(--wl-border); font: inherit; outline: 0; }
.wisp-lib-linkadd input:focus { border-color: var(--wl-brand); }
.wisp-lib-links { display: flex; flex-direction: column; gap: 4px; }
.wisp-lib-link { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; background: var(--wl-field); font-size: 13px; color: var(--wl-text); }
.wisp-lib-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 48px 16px; text-align: center;
  border: 1px dashed var(--wl-border-strong); border-radius: var(--wl-radius); }
.wisp-lib-empty-title { font-size: 16px; font-weight: 600; color: var(--wl-strong); }
.wisp-lib-footnote { color: var(--wl-muted); font-size: 12px; text-align: center; }
.wisp-lib-section-title { margin: 4px 0 10px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--wl-muted); }
.wisp-lib-card.is-featured { min-height: 132px; }
.wisp-lib-card-desc.is-blurb { color: var(--wl-strong); font-size: 14px; -webkit-line-clamp: 2; }
.wisp-lib-footnote a { color: var(--text-link, var(--wl-brand)); }
@media (max-width: 720px) { .wisp-lib-item { flex-direction: column; } .wisp-lib-item .wisp-lib-thumb { width: 100%; } }
`;
    (document.head || document.documentElement).append(style);
  }
})();

/*
 * Wisp navigation: channel tabs and local message bookmarks.
 *
 * Tabs: a strip under the title bar (shown once a second tab is open). Clicking a channel as usual
 * changes the current tab, like a browser; middle-click a channel/DM or use "Open in new tab" to
 * open another. Ctrl+T duplicates the current tab, Ctrl+W closes it, Ctrl+Tab / Ctrl+Shift+Tab
 * switch. Tabs show unread and mention badges and can be dragged to reorder.
 *
 * Bookmarks: right-click a message → Bookmark… to save it with a note and tags. They're kept
 * locally (per account) with a copy of the message text, so they outlive edits and deletions.
 * Open the list from the title bar's bookmark icon or Ctrl+Shift+K.
 *
 * Both are drawn with Discord's colour variables so themes restyle them. Loaded after
 * core/wisp.js and started with its module context once Discord is ready (main pane only).
 */
(() => {
  'use strict';
  if (window.top !== window || !window.WispHost) return;

  const db = {
    promise: null,
    open() {
      return this.promise ??= new Promise((resolve, reject) => {
        const req = indexedDB.open('WispPage', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('bookmarks', { keyPath: 'id' });
          req.result.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async run(store, mode, fn) {
      const conn = await this.open();
      return new Promise((resolve, reject) => {
        const tx = conn.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
      });
    },
    all: (s) => db.run(s, 'readonly', st => st.getAll()),
    get: (s, k) => db.run(s, 'readonly', st => st.get(k)),
    put: (s, v, k) => db.run(s, 'readwrite', st => k === undefined ? st.put(v) : st.put(v, k)),
    del: (s, k) => db.run(s, 'readwrite', st => st.delete(k)),
  };

  /** Tiny DOM builder (these pages are outside React, so Discord re-renders can't remove them). */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : String(c));
    return node;
  }

  const ICON = {
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 9h15M4 15h15M10 3 8 21M16 3l-2 18"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  };

  (window.__wispModules ||= []).push((ctx) => {
    if (ctx.init?.role !== 'main') return;
    const { V, C } = ctx;
    const feature = (name) => ctx.settings?.features?.[name]?.enabled !== false;
    mountStyles();

    const parsePath = (path) => {
      const m = /^\/channels\/(@me|\d+)(?:\/(\d+))?(?:\/(\d+))?/.exec(path || '');
      return m ? { guildId: m[1] === '@me' ? null : m[1], channelId: m[2] || null, messageId: m[3] || null } : null;
    };
    const go = (path) => C.NavigationRouter.transitionTo(path);

    // ===== tabs ==========================================================================

    const tabs = {
      list: [],          // { id, path }
      active: null,
      bar: null,
      dragging: null,
      lastPath: null,
      switching: false,

      async start() {
        const saved = await db.get('kv', 'tabs').catch(() => null);
        if (saved?.list?.length) { this.list = saved.list; this.active = saved.active; }
        const path = this.currentPath();
        if (!this.list.length) this.list = [{ id: uid(), path }];
        if (!this.list.some(t => t.id === this.active)) this.active = this.list[0].id;
        // Restore the active tab's channel if Discord opened somewhere else.
        const act = this.activeTab();
        if (act.path !== path && parsePath(act.path)) { this.switching = true; go(act.path); }
        this.lastPath = this.currentPath();

        C.FluxDispatcher.subscribe('CHANNEL_SELECT', () => setTimeout(() => this.onRoute(), 0));
        addEventListener('popstate', () => this.onRoute());
        setInterval(() => this.onRoute(), 1000);
        const rerender = throttle(() => this.render(), 250);
        C.ReadStateStore?.addChangeListener?.(rerender);
        C.ChannelStore?.addChangeListener?.(rerender);
        C.GuildStore?.addChangeListener?.(rerender);

        // Middle-click a channel or DM link to open it in a background tab.
        document.addEventListener('auxclick', (e) => {
          if (e.button !== 1 || !feature('tabs')) return;
          const a = e.target.closest?.('a[href^="/channels/"]');
          if (!a || a.closest('.wisp-tabs')) return;
          e.preventDefault();
          e.stopPropagation();
          this.open(new URL(a.href).pathname, { background: true });
        }, true);
        document.addEventListener('mousedown', (e) => { if (e.button === 1 && e.target.closest?.('a[href^="/channels/"]')) e.preventDefault(); }, true);

        addEventListener('keydown', (e) => {
          if (!feature('tabs') || !e.ctrlKey || e.altKey || e.metaKey) return;
          let handled = true;
          if (e.code === 'KeyT' && !e.shiftKey) this.open(this.currentPath());
          else if (e.code === 'KeyW' && !e.shiftKey && this.list.length > 1) this.close(this.active);
          else if (e.code === 'Tab') this.cycle(e.shiftKey ? -1 : 1);
          else handled = false;
          if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
        }, true);

        const h = C.React.createElement;
        const item = (path) => h(C.Menu.MenuItem, { id: 'wisp-open-tab', label: 'Open in new tab', action: () => this.open(path, { background: true }) });
        const cm = V.Api.ContextMenu;
        cm.addContextMenuPatch(['channel-context', 'thread-context', 'gdm-context'], (children, props) => {
          if (feature('tabs') && props?.channel) children.push(h(C.Menu.MenuGroup, null, item(ctx.channelPath(props.channel))));
        });
        cm.addContextMenuPatch('user-context', (children, props) => {
          const dm = props?.user && C.ChannelStore.getDMFromUserId?.(props.user.id);
          if (feature('tabs') && dm) children.push(h(C.Menu.MenuGroup, null, item(`/channels/@me/${dm}`)));
        });
        ctx.onSettings(() => this.render());
        this.render();
      },

      currentPath: () => location.pathname.startsWith('/channels/') ? location.pathname.replace(/\/\d+$/, (m) => /\/channels\/[^/]+\/\d+\/\d+$/.test(location.pathname) ? '' : m) : '/channels/@me',
      activeTab() { return this.list.find(t => t.id === this.active) || this.list[0]; },

      /** Navigation inside the current tab updates it, like a browser. */
      onRoute() {
        const path = this.currentPath();
        if (path === this.lastPath) return;
        this.lastPath = path;
        if (this.switching) { this.switching = false; this.render(); return; }
        const t = this.activeTab();
        if (t && t.path !== path) { t.path = path; this.save(); this.render(); }
      },

      open(path, { background = false } = {}) {
        if (!parsePath(path)) return;
        const tab = { id: uid(), path };
        const i = this.list.findIndex(t => t.id === this.active);
        this.list.splice(i + 1, 0, tab);
        if (!background) this.activate(tab.id);
        this.save();
        this.render();
      },

      activate(id) {
        const t = this.list.find(x => x.id === id);
        if (!t) return;
        this.active = id;
        if (t.path !== this.currentPath()) { this.switching = true; go(t.path); }
        this.save();
        this.render();
      },

      close(id) {
        const i = this.list.findIndex(t => t.id === id);
        if (i < 0 || this.list.length <= 1) return;
        this.list.splice(i, 1);
        if (this.active === id) this.activate(this.list[Math.min(i, this.list.length - 1)].id);
        this.save();
        this.render();
      },

      cycle(dir) {
        const i = this.list.findIndex(t => t.id === this.active);
        this.activate(this.list[(i + dir + this.list.length) % this.list.length].id);
      },

      save: throttle(function () { db.put('kv', { list: tabs.list, active: tabs.active }, 'tabs').catch(() => { }); }, 500),

      describe(path) {
        const p = parsePath(path);
        if (p?.guildId && !p.channelId) {
          const g = C.GuildStore.getGuild(p.guildId);
          return { label: g?.name || 'Server', icon: g?.icon ? { img: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=32` } : { text: (g?.name || 'S').slice(0, 1) } };
        }
        if (!p?.channelId) return { label: 'Friends', icon: { svg: ICON.home } };
        const ch = C.ChannelStore.getChannel(p.channelId);
        if (!ch) return { label: 'Channel', icon: { svg: ICON.hash } };
        const mentions = C.ReadStateStore?.getMentionCount?.(ch.id) || 0;
        const unread = !!C.ReadStateStore?.hasUnread?.(ch.id);
        if (ch.guild_id) {
          const g = C.GuildStore.getGuild(ch.guild_id);
          return {
            label: ch.name, sub: g?.name, mentions, unread,
            icon: g?.icon ? { img: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=32` } : { text: (g?.name || '#').slice(0, 1) },
          };
        }
        if (ch.type === 1) {
          const u = C.UserStore.getUser(ch.recipients?.[0]);
          return { label: ctx.displayName(u), mentions, unread, icon: { img: ctx.avatarUrl(u), round: true } };
        }
        return { label: ctx.channelLabel(ch), mentions, unread, icon: { text: (ch.name || 'G').slice(0, 1), round: true } };
      },

      render() {
        const show = feature('tabs') && (this.list.length > 1 || ctx.settings?.features?.tabs?.alwaysShow);
        document.documentElement.toggleAttribute('data-wisp-tabs', !!show);
        if (!show) { this.bar?.remove(); this.bar = null; return; }
        if (!this.bar) { this.bar = el('div', { class: 'wisp-tabs', role: 'tablist' }); document.body.append(this.bar); }
        // Sit right under Discord's top bar, whatever its height.
        const top = document.querySelector('[class^="base__"] > [class^="bar_"]')?.getBoundingClientRect().bottom;
        document.documentElement.style.setProperty('--wisp-tabs-top', (top > 0 ? Math.round(top) : 32) + 'px');
        this.bar.replaceChildren(...this.list.map(t => {
          const d = this.describe(t.path);
          const icon = d.icon.img ? el('img', { class: 'wisp-tab-icon' + (d.icon.round ? ' is-round' : ''), src: d.icon.img, alt: '' })
            : d.icon.svg ? el('span', { class: 'wisp-tab-icon is-svg', html: d.icon.svg })
              : el('span', { class: 'wisp-tab-icon is-text' + (d.icon.round ? ' is-round' : '') }, d.icon.text);
          return el('div', {
            class: 'wisp-tab' + (t.id === this.active ? ' is-active' : '') + (d.unread ? ' is-unread' : ''),
            role: 'tab', 'aria-selected': t.id === this.active ? 'true' : 'false', title: d.sub ? `${d.label} · ${d.sub}` : d.label,
            draggable: 'true',
            onclick: () => this.activate(t.id),
            onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); this.close(t.id); } },
            ondragstart: (e) => { this.dragging = t.id; e.dataTransfer.effectAllowed = 'move'; },
            ondragover: (e) => { e.preventDefault(); },
            ondrop: (e) => { e.preventDefault(); this.move(this.dragging, t.id); },
          },
          icon,
          el('span', { class: 'wisp-tab-label' }, d.label),
          d.mentions > 0 && el('span', { class: 'wisp-tab-badge' }, d.mentions > 99 ? '99+' : String(d.mentions)),
          this.list.length > 1 && el('button', {
            class: 'wisp-tab-close', title: 'Close tab (Ctrl+W)', html: ICON.close,
            onclick: (e) => { e.stopPropagation(); this.close(t.id); },
          }));
        }), el('button', { class: 'wisp-tab-new', title: 'New tab (Ctrl+T)', onclick: () => this.open(this.currentPath()) }, '+'));
      },

      move(fromId, toId) {
        if (!fromId || fromId === toId) return;
        const from = this.list.findIndex(t => t.id === fromId), to = this.list.findIndex(t => t.id === toId);
        if (from < 0 || to < 0) return;
        const [t] = this.list.splice(from, 1);
        this.list.splice(to, 0, t);
        this.save();
        this.render();
      },
    };

    // ===== bookmarks =======================================================================

    const bookmarks = {
      items: new Map(),
      panel: null,
      query: '',
      tag: null,

      async start() {
        for (const b of await db.all('bookmarks').catch(() => [])) this.items.set(b.id, b);
        const h = C.React.createElement;
        V.Api.ContextMenu.addContextMenuPatch('message', (children, props) => {
          if (!feature('bookmarks')) return;
          const m = props?.message, ch = props?.channel;
          if (!m || !ch) return;
          const saved = this.items.has(m.id);
          children.push(h(C.Menu.MenuGroup, null,
            h(C.Menu.MenuItem, { id: 'wisp-bookmark', label: saved ? 'Edit bookmark…' : 'Bookmark…', action: () => this.edit(m, ch) }),
            saved ? h(C.Menu.MenuItem, { id: 'wisp-bookmark-remove', label: 'Remove bookmark', color: 'danger', action: () => this.remove(m.id) }) : null));
        });
        addEventListener('keydown', (e) => {
          if (feature('bookmarks') && e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyK') {
            e.preventDefault(); e.stopImmediatePropagation(); this.toggle();
          }
        }, true);
        addEventListener('wisp:bookmarks', () => this.toggle());
        ctx.on('ui', (m) => { if (m.open === 'bookmarks') this.toggle(true); });
        ctx.addTitlebarButton({ title: 'Bookmarks (Ctrl+Shift+K)', svg: ICON.bookmark, onClick: () => this.toggle(), visible: () => feature('bookmarks') });
      },

      async edit(m, ch) {
        const existing = this.items.get(m.id);
        const res = await this.dialog(existing);
        if (!res) return;
        const author = m.author;
        const image = (m.attachments || []).find(a => /^image\//.test(a.content_type || '') || /\.(png|jpe?g|gif|webp)$/i.test(a.filename || ''));
        const rec = existing ? { ...existing, note: res.note, tags: res.tags } : {
          id: m.id, channelId: ch.id, guildId: ch.guild_id || null,
          channelLabel: ctx.channelLabel(ch), author: ctx.displayName(author), avatar: ctx.avatarUrl(author),
          content: (m.content || '').slice(0, 4000), image: image?.proxy_url || image?.url || null,
          attachments: m.attachments?.length || 0, timestamp: +new Date(m.timestamp) || Date.now(), savedAt: Date.now(),
          note: res.note, tags: res.tags,
        };
        await db.put('bookmarks', rec);
        this.items.set(rec.id, rec);
        this.renderPanel();
        ctx.toast(existing ? 'Bookmark updated.' : 'Bookmarked. Ctrl+Shift+K shows your bookmarks.');
      },

      async remove(id) {
        await db.del('bookmarks', id);
        this.items.delete(id);
        this.renderPanel();
      },

      /** Note + tags dialog. Resolves { note, tags } or null. */
      dialog(existing) {
        return new Promise((resolve) => {
          const note = el('textarea', { class: 'wisp-nav-input', rows: '3', placeholder: 'Note (optional)' });
          note.value = existing?.note || '';
          const tags = el('input', { class: 'wisp-nav-input', placeholder: 'Tags, separated by commas (optional)' });
          tags.value = (existing?.tags || []).join(', ');
          const done = (v) => { overlay.remove(); resolve(v); };
          const save = () => done({ note: note.value.trim(), tags: tags.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 12) });
          const overlay = el('div', { class: 'wisp-nav-overlay', onmousedown: (e) => { if (e.target === overlay) done(null); } },
            el('div', { class: 'wisp-nav-dialog', role: 'dialog' },
              el('div', { class: 'wisp-nav-title' }, existing ? 'Edit bookmark' : 'Bookmark message'),
              note, tags,
              el('div', { class: 'wisp-nav-row is-end' },
                el('button', { class: 'wisp-nav-btn', onclick: () => done(null) }, 'Cancel'),
                el('button', { class: 'wisp-nav-btn is-primary', onclick: save }, 'Save'))));
          overlay.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') done(null);
            if (e.key === 'Enter' && (e.ctrlKey || e.target === tags)) { e.preventDefault(); save(); }
          });
          document.body.append(overlay);
          note.focus();
        });
      },

      toggle(forceOpen) {
        if (this.panel && !forceOpen) { this.panel.remove(); this.panel = null; return; }
        if (!this.panel) {
          this.panel = el('div', { class: 'wisp-nav-overlay', onmousedown: (e) => { if (e.target === this.panel) this.toggle(); } });
          this.panel.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.toggle(); });
          document.body.append(this.panel);
        }
        this.renderPanel(true);
      },

      renderPanel(focusSearch) {
        if (!this.panel) return;
        const all = [...this.items.values()].sort((a, b) => b.savedAt - a.savedAt);
        const tagCounts = {};
        for (const b of all) for (const t of b.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
        const q = this.query.trim().toLowerCase();
        const list = all.filter(b => (!this.tag || (b.tags || []).includes(this.tag))
          && (!q || [b.content, b.note, b.author, b.channelLabel, ...(b.tags || [])].join(' ').toLowerCase().includes(q)));
        const search = el('input', { class: 'wisp-nav-input is-search', placeholder: `Search ${all.length} bookmarks`, value: this.query });
        search.addEventListener('input', () => { this.query = search.value; this.renderPanel(true); });
        const fmt = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

        const body = el('div', { class: 'wisp-nav-panel', role: 'dialog', 'aria-label': 'Bookmarks' },
          el('div', { class: 'wisp-nav-head' },
            el('div', { class: 'wisp-nav-title' }, 'Bookmarks'),
            el('button', { class: 'wisp-nav-iconbtn', title: 'Close', html: ICON.close, onclick: () => this.toggle() })),
          search,
          Object.keys(tagCounts).length > 0 && el('div', { class: 'wisp-nav-chips' },
            Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => el('button', {
              class: 'wisp-nav-chip' + (this.tag === t ? ' is-active' : ''), onclick: () => { this.tag = this.tag === t ? null : t; this.renderPanel(); },
            }, `#${t} `, el('span', { class: 'wisp-nav-muted' }, String(n))))),
          el('div', { class: 'wisp-nav-list' }, list.length ? list.map(b => el('div', {
            class: 'wisp-nav-item', title: 'Jump to message', onclick: () => { this.toggle(); go(`/channels/${b.guildId || '@me'}/${b.channelId}/${b.id}`); },
          },
          el('img', { class: 'wisp-nav-avatar', src: b.avatar || '', alt: '' }),
          el('div', { class: 'wisp-nav-item-body' },
            el('div', { class: 'wisp-nav-meta' }, el('strong', null, b.author), el('span', { class: 'wisp-nav-muted' }, ` in ${b.channelLabel} · ${fmt(b.timestamp)}`)),
            b.content && el('div', { class: 'wisp-nav-content' }, b.content),
            !b.content && b.attachments > 0 && el('div', { class: 'wisp-nav-muted' }, `${b.attachments} attachment${b.attachments === 1 ? '' : 's'}`),
            b.note && el('div', { class: 'wisp-nav-note' }, b.note),
            (b.tags || []).length > 0 && el('div', { class: 'wisp-nav-tags' }, b.tags.map(t => el('span', { class: 'wisp-nav-tag' }, `#${t}`)))),
          el('div', { class: 'wisp-nav-actions' },
            el('button', { class: 'wisp-nav-iconbtn', title: 'Edit note & tags', onclick: async (e) => {
              e.stopPropagation();
              const res = await this.dialog(b);
              if (res) { const rec = { ...b, ...res }; await db.put('bookmarks', rec); this.items.set(rec.id, rec); this.renderPanel(); }
            } }, '✎'),
            el('button', { class: 'wisp-nav-iconbtn is-danger', title: 'Remove', html: ICON.close, onclick: (e) => { e.stopPropagation(); this.remove(b.id); } }))))
            : el('div', { class: 'wisp-nav-empty' }, all.length ? 'No bookmarks match.' : 'No bookmarks yet. Right-click a message → Bookmark… to save one.')));
        this.panel.replaceChildren(body);
        if (focusSearch) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
      },
    };

    tabs.start().catch(err => ctx.report(`tabs: ${err?.stack || err}`));
    bookmarks.start().catch(err => ctx.report(`bookmarks: ${err?.stack || err}`));
    window.__wisp && (window.__wisp.navigation = { tabs, bookmarks });
  });

  function uid() { return Math.random().toString(36).slice(2, 10); }
  function throttle(fn, ms) {
    let t = null;
    return function (...a) { if (t) return; t = setTimeout(() => { t = null; fn.apply(this, a); }, ms); };
  }

  function mountStyles() {
    if (document.getElementById('wisp-nav-css')) return;
    const style = document.createElement('style');
    style.id = 'wisp-nav-css';
    style.textContent = `
:root {
  --wn-text: var(--text-default, var(--text-normal, #dbdee1));
  --wn-strong: var(--text-strong, var(--header-primary, #f2f3f5));
  --wn-muted: var(--text-muted, #949ba4);
  --wn-bar: var(--background-base-lowest, var(--background-tertiary, #1e1f22));
  --wn-tab: transparent;
  --wn-tab-hover: var(--background-mod-subtle, var(--background-modifier-hover, rgba(78,80,88,.3)));
  --wn-tab-active: var(--background-mod-strong, var(--background-modifier-selected, rgba(78,80,88,.6)));
  --wn-panel: var(--modal-background, var(--background-base-low, var(--background-primary, #313338)));
  --wn-field: var(--input-background, var(--background-base-lowest, #1e1f22));
  --wn-border: var(--border-subtle, rgba(255,255,255,.06));
  --wn-brand: var(--brand-500, var(--brand-experiment, #5865f2));
  --wn-danger: var(--status-danger, #f23f43);
}
html[data-wisp-tabs] [class^="base__"] > [class^="content__"] { margin-top: 34px; }
.wisp-tabs { box-sizing: border-box; position: fixed; top: var(--wisp-tabs-top, 32px); left: 0; right: 0; height: 34px; z-index: 100; display: flex; align-items: flex-end; gap: 2px;
  padding: 0 8px; background: var(--wn-bar); border-bottom: 1px solid var(--wn-border); overflow-x: auto; scrollbar-width: none;
  font-family: var(--font-primary, "gg sans", sans-serif); }
.wisp-tab { display: flex; align-items: center; gap: 6px; height: 30px; min-width: 80px; max-width: 220px; padding: 0 6px 0 10px;
  border-radius: 8px 8px 0 0; background: var(--wn-tab); color: var(--wn-muted); font-size: 13px; font-weight: 500; cursor: pointer; flex: 0 1 auto; user-select: none; }
.wisp-tab:hover { background: var(--wn-tab-hover); color: var(--wn-text); }
.wisp-tab.is-active { background: var(--wn-tab-active); color: var(--wn-strong); }
.wisp-tab.is-unread:not(.is-active) .wisp-tab-label { color: var(--wn-strong); font-weight: 600; }
.wisp-tab-icon { width: 18px; height: 18px; border-radius: 6px; flex: none; object-fit: cover; }
.wisp-tab-icon.is-round { border-radius: 50%; }
.wisp-tab-icon.is-svg { display: grid; place-items: center; } .wisp-tab-icon.is-svg svg { width: 16px; height: 16px; }
.wisp-tab-icon.is-text { display: grid; place-items: center; background: var(--wn-tab-hover); font-size: 11px; font-weight: 700; color: var(--wn-text); }
.wisp-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.wisp-tab-badge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--wn-danger); color: #fff; font-size: 11px; font-weight: 700;
  display: grid; place-items: center; flex: none; }
.wisp-tab-close { display: grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: 4px; background: none; color: var(--wn-muted); cursor: pointer; flex: none; opacity: 0; }
.wisp-tab:hover .wisp-tab-close, .wisp-tab.is-active .wisp-tab-close { opacity: 1; }
.wisp-tab-close:hover { background: var(--wn-tab-hover); color: var(--wn-text); }
.wisp-tab-close svg { width: 12px; height: 12px; }
.wisp-tab-new { align-self: center; width: 26px; height: 26px; border: 0; border-radius: 6px; background: none; color: var(--wn-muted); font-size: 18px; cursor: pointer; flex: none; }
.wisp-tab-new:hover { background: var(--wn-tab-hover); color: var(--wn-text); }

.wisp-nav-overlay { position: fixed; inset: 0; z-index: 2147482500; display: grid; place-items: center; background: rgba(0,0,0,.6);
  font-family: var(--font-primary, "gg sans", sans-serif); color: var(--wn-text); }
.wisp-nav-dialog, .wisp-nav-panel { background: var(--wn-panel); border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.5); border: 1px solid var(--wn-border); }
.wisp-nav-dialog { width: min(440px, calc(100vw - 32px)); padding: 18px; display: flex; flex-direction: column; gap: 10px; }
.wisp-nav-panel { width: min(640px, calc(100vw - 32px)); height: min(720px, calc(100vh - 80px)); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.wisp-nav-head { display: flex; align-items: center; justify-content: space-between; }
.wisp-nav-title { font-size: 18px; font-weight: 700; color: var(--wn-strong); }
.wisp-nav-input { width: 100%; box-sizing: border-box; padding: 9px 11px; border-radius: 8px; border: 1px solid var(--wn-border); background: var(--wn-field);
  color: var(--wn-text); font: inherit; font-size: 14px; outline: 0; resize: vertical; }
.wisp-nav-input:focus { border-color: var(--wn-brand); }
.wisp-nav-row { display: flex; gap: 8px; } .wisp-nav-row.is-end { justify-content: flex-end; }
.wisp-nav-btn { height: 34px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--wn-border); background: var(--wn-tab-hover); color: var(--wn-text);
  font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.wisp-nav-btn.is-primary { background: var(--wn-brand); border-color: var(--wn-brand); color: #fff; }
.wisp-nav-iconbtn { display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 6px; background: none; color: var(--wn-muted); cursor: pointer; font-size: 15px; flex: none; }
.wisp-nav-iconbtn svg { width: 16px; height: 16px; }
.wisp-nav-iconbtn:hover { background: var(--wn-tab-hover); color: var(--wn-text); }
.wisp-nav-iconbtn.is-danger:hover { color: var(--wn-danger); }
.wisp-nav-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.wisp-nav-chip { height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--wn-border); background: none; color: var(--wn-text); font: inherit; font-size: 13px; cursor: pointer; }
.wisp-nav-chip.is-active { background: var(--wn-brand); border-color: var(--wn-brand); color: #fff; }
.wisp-nav-list { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 6px; scrollbar-width: thin; }
.wisp-nav-item { display: flex; gap: 10px; padding: 10px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
.wisp-nav-item:hover { background: var(--wn-tab-hover); border-color: var(--wn-border); }
.wisp-nav-avatar { width: 36px; height: 36px; border-radius: 50%; flex: none; }
.wisp-nav-item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.wisp-nav-meta { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wisp-nav-meta strong { color: var(--wn-strong); }
.wisp-nav-muted { color: var(--wn-muted); font-size: 12px; }
.wisp-nav-content { font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.wisp-nav-note { font-size: 13px; font-style: italic; color: var(--wn-text); border-left: 3px solid var(--wn-brand); padding-left: 8px; }
.wisp-nav-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.wisp-nav-tag { font-size: 12px; color: var(--text-link, var(--wn-brand)); }
.wisp-nav-actions { display: flex; flex-direction: column; gap: 2px; opacity: 0; }
.wisp-nav-item:hover .wisp-nav-actions { opacity: 1; }
.wisp-nav-empty { color: var(--wn-muted); text-align: center; padding: 48px 16px; }
`;
    (document.head || document.documentElement).append(style);
  }
})();
