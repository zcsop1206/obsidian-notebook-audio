// A mock of the parts of the Obsidian API the plugin uses, for test/harness.html. Files live in
// the in-memory `fs` map (path -> string | Uint8Array) and folders in `dirs`; the vault API and
// vault.adapter share them. Only one leaf is shown at a time, in #leaf. Tests can delete
// adapter.appendBinary to simulate an Obsidian before 1.12.3, and set window.obsidian.Platform
// fields (isMobile, isIosApp) before loadPlugin() to simulate the iPad.
(() => {
  // ---- Obsidian's DOM helpers
  const P = HTMLElement.prototype;
  P.empty = function () { this.innerHTML = ''; };
  P.addClass = function (...c) { this.classList.add(...c); };
  P.removeClass = function (...c) { this.classList.remove(...c); };
  P.toggleClass = function (c, on) { this.classList.toggle(c, on); };
  P.hasClass = function (c) { return this.classList.contains(c); };
  P.setText = function (t) { this.textContent = t; };
  P.setAttr = function (k, v) { this.setAttribute(k, v); };
  P.hide = function () { this.style.display = 'none'; };
  P.show = function () { this.style.display = ''; };
  P.createEl = function (tag, o = {}) {
    const el = document.createElement(tag);
    if (typeof o === 'string') o = { cls: o };
    if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls;
    if (o.text) el.textContent = o.text;
    if (o.type) el.type = o.type;
    if (o.href) el.href = o.href;
    if (o.title) el.title = o.title;
    if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
  P.createDiv = function (o = {}) { return this.createEl('div', o); };
  P.createSpan = function (o = {}) { return this.createEl('span', o); };
  window.createDiv = o => document.createElement('div').createDiv(o);
  window.createSpan = o => document.createElement('div').createSpan(o);
  window.activeDocument = document;
  window.activeWindow = window;

  // Notices are recorded in window.notices (text) and window.noticeEls (elements, so tests can
  // click a button inside one, as the recovery notice has).
  window.notices = [];
  window.noticeEls = [];
  class Notice {
    constructor(m, timeout) {
      this.noticeEl = document.body.createDiv({ cls: 'notice' });
      if (m instanceof DocumentFragment) this.noticeEl.appendChild(m); else this.noticeEl.setText(String(m));
      notices.push(this.noticeEl.textContent);
      noticeEls.push(this.noticeEl);
    }
    hide() { this.noticeEl.remove(); }
    setMessage(m) { this.noticeEl.setText(String(m)); notices.push(String(m)); return this; }
  }

  // ---- files
  window.fs = new Map();
  window.dirs = new Set();
  const dirname = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const basename = p => p.slice(p.lastIndexOf('/') + 1);
  const adapter = {
    async exists(p) { return fs.has(p) || dirs.has(p); },
    async stat(p) { if (fs.has(p)) { const d = fs.get(p); return { type: 'file', size: d.length, mtime: 0, ctime: 0 }; } if (dirs.has(p)) return { type: 'folder', size: 0, mtime: 0, ctime: 0 }; return null; },
    async mkdir(p) { dirs.add(p); },
    async write(p, d) { fs.set(p, String(d)); },
    async read(p) { if (!fs.has(p)) throw new Error('ENOENT ' + p); return fs.get(p); },
    async append(p, d) { if (!fs.has(p)) throw new Error('append to missing ' + p); fs.set(p, fs.get(p) + d); },
    async writeBinary(p, b) { fs.set(p, new Uint8Array(b.slice(0))); },
    async appendBinary(p, b) { const old = fs.get(p); if (!old) throw new Error('appendBinary to missing ' + p); const n = new Uint8Array(old.length + b.byteLength); n.set(old); n.set(new Uint8Array(b), old.length); fs.set(p, n); },
    async readBinary(p) { if (!fs.has(p)) throw new Error('ENOENT ' + p); return fs.get(p).slice().buffer; },
    async list(p) {
      const kids = q => q.startsWith(p + '/') && !q.slice(p.length + 1).includes('/');
      return { files: [...fs.keys()].filter(kids), folders: [...dirs].filter(kids) };
    },
    async remove(p) { fs.delete(p); },
    async rmdir(p, rec) { for (const k of [...fs.keys()]) if (k.startsWith(p + '/')) fs.delete(k); for (const k of [...dirs]) if (k === p || k.startsWith(p + '/')) dirs.delete(k); },
    getResourcePath(p) { const d = fs.get(p); if (d instanceof Uint8Array) return URL.createObjectURL(new Blob([d])); return 'app://mock/' + p; },
  };
  window.adapter = adapter;

  class Events {
    constructor() { this._handlers = {}; }
    on(name, cb, ctx) { (this._handlers[name] ??= []).push(cb); return { e: this, name, cb }; }
    off(name, cb) { this.offref({ name, cb }); }
    offref(ref) { const l = this._handlers[ref.name] || []; const i = l.indexOf(ref.cb); if (i >= 0) l.splice(i, 1); }
    trigger(name, ...args) { for (const cb of [...(this._handlers[name] || [])]) cb(...args); }
  }

  class TAbstractFile {
    constructor(path) { this.path = path; this.name = basename(path); }
    get parent() { return this.path === '/' ? null : vault.getFolder(dirname(this.path)); }
  }
  class TFile extends TAbstractFile {
    get basename() { return this.name.includes('.') ? this.name.slice(0, this.name.lastIndexOf('.')) : this.name; }
    get extension() { return this.name.includes('.') ? this.name.slice(this.name.lastIndexOf('.') + 1) : ''; }
    get stat() { const d = fs.get(this.path); return { size: d ? d.length : 0, mtime: 0, ctime: 0 }; }
  }
  class TFolder extends TAbstractFile {
    isRoot() { return this.path === '/'; }
    get children() {
      const prefix = this.isRoot() ? '' : this.path + '/';
      const kids = q => q.startsWith(prefix) && q.length > prefix.length && !q.slice(prefix.length).includes('/');
      return [...[...dirs].filter(kids).map(p => vault.getFolder(p)), ...[...fs.keys()].filter(kids).map(p => vault.getFile(p))];
    }
  }

  const fileObjects = new Map();
  const vault = new Events();
  Object.assign(vault, {
    adapter,
    configDir: '.obsidian',
    getName() { return 'mock vault'; },
    getFile(p) { let f = fileObjects.get(p); if (!(f instanceof TFile)) { f = new TFile(p); fileObjects.set(p, f); } return f; },
    getFolder(p) { if (p === '' || p === '/') p = '/'; let f = fileObjects.get('dir:' + p); if (!f) { f = new TFolder(p); fileObjects.set('dir:' + p, f); } return f; },
    getRoot() { return this.getFolder('/'); },
    getAbstractFileByPath(p) { if (fs.has(p)) return this.getFile(p); if (dirs.has(p) || p === '/' || p === '') return this.getFolder(p); return null; },
    getFileByPath(p) { return fs.has(p) ? this.getFile(p) : null; },
    getFolderByPath(p) { return dirs.has(p) ? this.getFolder(p) : null; },
    getResourcePath(file) { return adapter.getResourcePath(file.path); },
    async read(file) { if (!fs.has(file.path)) throw new Error('ENOENT ' + file.path); return fs.get(file.path); },
    async cachedRead(file) { return this.read(file); },
    async modify(file, text) {
      if (!fs.has(file.path)) throw new Error('modify: no file ' + file.path);
      vault.writes.push(file.path);
      fs.set(file.path, text);
      this.trigger('modify', file);
    },
    async append(file, text) { return this.modify(file, fs.get(file.path) + text); },
    async process(file, fn) { const out = fn(await this.read(file)); await this.modify(file, out); return out; },
    async create(path, text) {
      if (fs.has(path) || dirs.has(path)) throw new Error('File already exists.');
      const dir = dirname(path);
      if (dir && !dirs.has(dir)) throw new Error('create: no folder ' + dir);
      vault.writes.push(path);
      fs.set(path, text);
      const f = this.getFile(path);
      this.trigger('create', f);
      return f;
    },
    async createFolder(path) {
      if (fs.has(path) || dirs.has(path)) throw new Error('Folder already exists.');
      const dir = dirname(path);
      if (dir && !dirs.has(dir)) throw new Error('createFolder: no parent ' + dir);
      dirs.add(path);
      const f = this.getFolder(path);
      this.trigger('create', f);
      return f;
    },
    async delete(file) { fs.delete(file.path); this.trigger('delete', file); },
    async rename(file, newPath) {
      const old = file.path;
      if (fs.has(newPath) || dirs.has(newPath)) throw new Error('Destination file already exists!');
      if (!fs.has(old)) throw new Error('rename: no file ' + old);
      const d = fs.get(old); fs.delete(old); fs.set(newPath, d);
      fileObjects.delete(old); file.path = newPath; file.name = basename(newPath); fileObjects.set(newPath, file);
      this.trigger('rename', file, old);
    },
    async createBinary(path, data) {
      if (fs.has(path) || dirs.has(path)) throw new Error('File already exists.');
      const dir = dirname(path);
      if (dir && !dirs.has(dir)) throw new Error('createBinary: no folder ' + dir);
      vault.writes.push(path);
      fs.set(path, new Uint8Array(data.slice(0)));
      const f = this.getFile(path);
      this.trigger('create', f);
      return f;
    },
    async readBinary(file) { const d = fs.get(file.path); if (!(d instanceof Uint8Array)) throw new Error('readBinary: not binary ' + file.path); return d.slice().buffer; },
    getFiles() { return [...fs.keys()].map(p => this.getFile(p)); },
    getMarkdownFiles() { return [...fs.keys()].filter(p => p.endsWith('.md')).map(p => this.getFile(p)); },
    /** Paths written through modify/create, in order (for tests). */
    writes: [],
  });
  /** Tests: change a file as a sync would, with the vault's modify event. */
  window.externalWrite = (path, text) => {
    const existed = fs.has(path);
    fs.set(path, text);
    vault.trigger(existed ? 'modify' : 'create', vault.getFile(path));
  };

  // Frontmatter as Obsidian's metadata cache would see it, and link resolution the way
  // Obsidian does it for markdown links: relative to the note's folder, then vault-absolute.
  const metadataCache = new Events();
  metadataCache.getFileCache = file => {
    const text = fs.get(file.path);
    if (typeof text !== 'string') return null;
    const lines = text.split(/\r?\n/);
    if (!/^---\s*$/.test(lines[0])) return {};
    const frontmatter = {};
    for (let i = 1; i < lines.length && !/^---\s*$/.test(lines[i]); i++) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
      if (m) frontmatter[m[1]] = m[2];
    }
    return { frontmatter };
  };
  metadataCache.getFirstLinkpathDest = (linkpath, sourcePath) => {
    let p;
    try { p = decodeURIComponent(linkpath); } catch (e) { p = linkpath; }
    p = p.split('#')[0];
    const dir = dirname(sourcePath);
    const rel = normalizePath((dir ? dir + '/' : '') + p);
    if (fs.has(rel)) return vault.getFile(rel);
    const abs = normalizePath(p);
    if (fs.has(abs)) return vault.getFile(abs);
    const byName = [...fs.keys()].find(k => basename(k) === basename(p));
    return byName ? vault.getFile(byName) : null;
  };

  // ---- components and views
  class Component {
    constructor() { this._cleanups = []; this._children = []; this._loaded = false; }
    load() { if (this._loaded) return; this._loaded = true; return this.onload?.(); }
    unload() { for (const c of this._children) c.unload(); for (const f of this._cleanups.splice(0)) f(); this._loaded = false; this.onunload?.(); }
    register(cb) { this._cleanups.push(cb); }
    registerEvent(ref) { this._cleanups.push(() => ref.e.offref(ref)); }
    registerDomEvent(el, type, cb, opts) { el.addEventListener(type, cb, opts); this._cleanups.push(() => el.removeEventListener(type, cb, opts)); }
    registerInterval(id) { this._cleanups.push(() => clearInterval(id)); return id; }
    addChild(c) { this._children.push(c); c.load(); return c; }
    removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) { this._children.splice(i, 1); c.unload(); } return c; }
  }
  class View extends Component {
    constructor(leaf) {
      super();
      this.leaf = leaf;
      this.app = leaf.app;
      this.navigation = false;
      this.containerEl = document.createElement('div');
      this.containerEl.className = 'workspace-leaf-content';
      this.headerEl = this.containerEl.createDiv({ cls: 'view-header' });
      this.titleEl = this.headerEl.createDiv({ cls: 'view-header-title' });
      this.actionsEl = this.headerEl.createDiv({ cls: 'view-actions' });
      this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
    }
    getState() { return {}; }
    async setState(state, result) {}
    getEphemeralState() { return {}; }
    setEphemeralState(s) {}
    getIcon() { return ''; }
    addAction(icon, title, cb) {
      const b = this.actionsEl.createEl('button', { cls: 'view-action', attr: { 'aria-label': title, 'data-icon': icon } });
      b.textContent = title;
      b.addEventListener('click', cb);
      return b;
    }
    async open() { this.load(); await this.onOpen?.(); }
    async close() { await this.onClose?.(); this.unload(); }
    async onOpen() {}
    async onClose() {}
  }
  class ItemView extends View {}
  class FileView extends ItemView {
    constructor(leaf) { super(leaf); this.file = null; this.allowNoFile = false; this.navigation = true; }
    getDisplayText() { return this.file ? this.file.basename : 'No file'; }
    getState() { return this.file ? { file: this.file.path } : {}; }
    async setState(state, result) {
      if (state && typeof state.file === 'string') {
        const f = vault.getAbstractFileByPath(state.file);
        if (f instanceof TFile) await this.loadFile(f);
      }
    }
    async loadFile(file) {
      if (this.file === file) return;
      if (this.file) await this.onUnloadFile(this.file);
      this.file = file;
      await this.onLoadFile(file);
    }
    async close() {
      await this.onClose?.();
      if (this.file) { const f = this.file; this.file = null; await this.onUnloadFile(f); }
      this.unload();
    }
    async onLoadFile(file) {}
    async onUnloadFile(file) {}
    canAcceptExtension(ext) { return false; }
  }
  // The markdown view shows the file's text in a <pre> and offers a minimal `editor` (the parts
  // the plugin uses to insert at the cursor). Edits write straight to the vault. `mode` is
  // 'source' by default; set view.mode = 'preview' to simulate reading view.
  class Editor {
    constructor(view) { this.view = view; this.cursor = { line: 0, ch: 0 }; }
    get text() { return fs.get(this.view.file.path) || ''; }
    getValue() { return this.text; }
    setValue(t) { void vault.modify(this.view.file, t); this.view.render(); }
    lineCount() { return this.text.split('\n').length; }
    lastLine() { return this.lineCount() - 1; }
    getLine(n) { return this.text.split('\n')[n] || ''; }
    getCursor() { return { ...this.cursor }; }
    setCursor(line, ch = 0) { this.cursor = typeof line === 'object' ? { ...line } : { line, ch }; }
    posToOffset(pos) { const lines = this.text.split('\n'); let o = 0; for (let i = 0; i < pos.line; i++) o += lines[i].length + 1; return o + pos.ch; }
    offsetToPos(off) { const lines = this.text.split('\n'); let line = 0; while (line < lines.length - 1 && off > lines[line].length) { off -= lines[line].length + 1; line++; } return { line, ch: off }; }
    getRange(from, to) { return this.text.slice(this.posToOffset(from), this.posToOffset(to)); }
    replaceRange(text, from, to) {
      const a = this.posToOffset(from), b = to ? this.posToOffset(to) : a;
      const t = this.text;
      this.setValue(t.slice(0, a) + text + t.slice(b));
    }
    replaceSelection(text) { this.replaceRange(text, this.cursor); }
    getSelection() { return ''; }
    somethingSelected() { return false; }
    focus() {}
    hasFocus() { return false; }
  }
  class MarkdownView extends FileView {
    constructor(leaf) { super(leaf); this.mode = 'source'; this.editor = new Editor(this); }
    getViewType() { return 'markdown'; }
    getMode() { return this.mode; }
    getState() { return { ...super.getState(), mode: this.mode }; }
    render() { this.contentEl.empty(); this.contentEl.createEl('pre', { cls: 'mock-markdown', text: fs.get(this.file.path) }); }
    async onLoadFile(file) { this.render(); }
  }

  const viewTypes = { markdown: leaf => new MarkdownView(leaf) };
  const host = () => document.getElementById('leaf');
  let leafIds = 0;

  class WorkspaceLeaf extends Events {
    constructor(app) {
      super();
      this.app = app;
      this.id = 'leaf' + (++leafIds);
      this.view = null;
      this.containerEl = document.createElement('div');
      this.containerEl.className = 'workspace-leaf';
      this.containerEl.style.cssText = 'height:100%;display:flex;flex-direction:column';
    }
    async setViewState(state, eState) {
      const ws = this.app.workspace;
      if (!ws.leaves.includes(this)) ws.leaves.push(this);
      const type = state.type;
      if (this.view && this.view.getViewType() === type) {
        await this.view.setState(state.state || {}, {});
      } else {
        if (this.view) await this.view.close();
        this.containerEl.innerHTML = '';
        const make = viewTypes[type];
        if (!make) throw new Error('mock: no view type ' + type);
        const v = make(this);
        this.view = v;
        v.containerEl.style.cssText = 'height:100%;display:flex;flex-direction:column';
        v.contentEl.style.cssText = 'flex:1;min-height:0';
        this.containerEl.appendChild(v.containerEl);
        ws.show(this);
        await v.open();
        await v.setState(state.state || {}, {});
      }
      ws.setActiveLeaf(this);
      window.view = this.view;
    }
    getViewState() { return { type: this.view ? this.view.getViewType() : 'empty', state: this.view ? this.view.getState() : {} }; }
    async openFile(file, openState) {
      const type = file.extension === 'md' ? 'markdown' : file.extension;
      await this.setViewState({ type, state: { file: file.path }, active: true, ...(openState || {}) });
    }
    async detach() {
      const ws = this.app.workspace;
      if (this.view) await this.view.close();
      this.view = null;
      this.containerEl.remove();
      ws.leaves = ws.leaves.filter(l => l !== this);
      if (ws.activeLeaf === this) ws.activeLeaf = null;
      const next = ws.leaves[ws.leaves.length - 1];
      if (next) { ws.show(next); ws.setActiveLeaf(next); }
    }
    getDisplayText() { return this.view ? this.view.getDisplayText() : ''; }
  }

  class Workspace extends Events {
    constructor(app) { super(); this.app = app; this.leaves = []; this.activeLeaf = null; this.containerEl = document.body; }
    onLayoutReady(cb) { cb(); }
    getLeavesOfType(type) { return this.leaves.filter(l => l.view && l.view.getViewType() === type); }
    getLeaf(newLeaf) {
      if (!newLeaf && this.activeLeaf) return this.activeLeaf;
      const leaf = new WorkspaceLeaf(this.app);
      this.leaves.push(leaf);
      return leaf;
    }
    getRightLeaf() { return this.getLeaf(true); }
    show(leaf) { const h = host(); if (leaf.containerEl.parentElement !== h) { h.innerHTML = ''; h.appendChild(leaf.containerEl); } }
    revealLeaf(leaf) { this.show(leaf); this.setActiveLeaf(leaf); }
    setActiveLeaf(leaf) { if (this.activeLeaf !== leaf) { this.activeLeaf = leaf; this.trigger('active-leaf-change', leaf); } }
    getActiveFile() { const v = this.activeLeaf && this.activeLeaf.view; return v && v.file ? v.file : null; }
    getActiveViewOfType(cls) { const v = this.activeLeaf && this.activeLeaf.view; return v instanceof cls ? v : null; }
    getMostRecentLeaf() { return this.activeLeaf; }
    async openLinkText(linktext, sourcePath, newLeaf) {
      const f = metadataCache.getFirstLinkpathDest(linktext, sourcePath || '');
      if (f) await this.getLeaf(newLeaf).openFile(f);
    }
  }

  const app = { vault, metadataCache };
  app.workspace = new Workspace(app);
  window.app = app;

  // ---- menus, modals, settings
  class Menu {
    constructor() { this.items = []; }
    addItem(cb) { const item = { title: '', icon: '', click: null, setTitle(t) { this.title = t; return this; }, setIcon(i) { this.icon = i; return this; }, onClick(f) { this.click = f; return this; } }; cb(item); this.items.push(item); return this; }
    addSeparator() { return this; }
    showAtMouseEvent() {}
    showAtPosition() {}
  }
  window.modals = [];
  class Modal {
    constructor(app) { this.app = app; this.modalEl = document.createElement('div'); this.modalEl.className = 'modal'; this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' }); this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' }); }
    setTitle(t) { this.titleEl.setText(t); return this; }
    open() { document.body.appendChild(this.modalEl); modals.push(this); this.onOpen?.(); }
    close() { this.onClose?.(); this.modalEl.remove(); const i = modals.indexOf(this); if (i >= 0) modals.splice(i, 1); }
  }
  // Lists every item as a .suggestion-item (no filtering); clicking one closes the modal and
  // chooses it, as selecting a suggestion does in Obsidian.
  class FuzzySuggestModal extends Modal {
    constructor(app) { super(app); this.placeholder = ''; }
    setPlaceholder(p) { this.placeholder = p; }
    renderSuggestion(match, el) { el.setText(this.getItemText(match.item)); }
    onOpen() {
      for (const item of this.getItems()) {
        const el = this.contentEl.createDiv({ cls: 'suggestion-item' });
        this.renderSuggestion({ item, match: { score: 0, matches: [] } }, el);
        el.addEventListener('click', evt => { this.close(); this.onChooseItem(item, evt); });
      }
    }
    onClose() { this.contentEl.empty(); }
  }
  class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement('div'); } }
  class Setting {
    constructor(el) { this.settingEl = el.createDiv({ cls: 'setting-item' }); this.nameEl = this.settingEl.createDiv({ cls: 'setting-item-name' }); this.descEl = this.settingEl.createDiv({ cls: 'setting-item-description' }); this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' }); }
    setName(n) { this.settingEl.dataset.name = n; this.nameEl.setText(n); return this; }
    setDesc(d) { if (d instanceof DocumentFragment) this.descEl.appendChild(d); else this.descEl.setText(d); return this; }
    setHeading() { this.settingEl.classList.add('setting-item-heading'); return this; }
    setClass(c) { this.settingEl.classList.add(c); return this; }
    addToggle(cb) {
      const input = this.controlEl.createEl('input', { type: 'checkbox', cls: 'checkbox-container' });
      const t = { toggleEl: input, setValue(v) { input.checked = !!v; return t; }, getValue() { return input.checked; }, onChange(f) { input.addEventListener('change', () => f(input.checked)); return t; } };
      cb(t);
      return this;
    }
    addDropdown(cb) {
      const sel = this.controlEl.createEl('select');
      const d = { selectEl: sel, addOption(v, t) { const o = sel.createEl('option', { text: t }); o.value = v; return d; }, addOptions(o) { for (const [v, t] of Object.entries(o)) d.addOption(v, t); return d; }, setValue(v) { sel.value = v; return d; }, getValue() { return sel.value; }, onChange(f) { sel.addEventListener('change', () => f(sel.value)); return d; } };
      cb(d);
      return this;
    }
    addText(cb) {
      const input = this.controlEl.createEl('input', { type: 'text' });
      const t = { inputEl: input, setValue(v) { input.value = v; return t; }, getValue() { return input.value; }, setPlaceholder(p) { input.placeholder = p; return t; }, onChange(f) { input.addEventListener('input', () => f(input.value)); return t; } };
      cb(t);
      return this;
    }
    addButton(cb) {
      const btn = this.controlEl.createEl('button');
      const b = { buttonEl: btn, setButtonText(t) { btn.textContent = t; return b; }, setCta() { btn.classList.add('mod-cta'); return b; }, setWarning() { btn.classList.add('mod-warning'); return b; }, setIcon(i) { btn.dataset.icon = i; return b; }, setTooltip(t) { btn.title = t; return b; }, onClick(f) { btn.addEventListener('click', f); return b; } };
      cb(b);
      return this;
    }
  }

  // ---- plugin
  const commands = {};
  window.commands = commands;
  window.pluginData = null;
  window.postProcessors = [];
  class Plugin extends Component {
    constructor() { super(); this.app = app; this.manifest = { id: 'notebook-audio', name: 'Notebook Audio', version: '0.0.0-test' }; this.settingTabs = []; this.ribbon = []; this.statusBarItems = []; }
    registerView(t, f) { viewTypes[t] = f; }
    registerMarkdownPostProcessor(f) { postProcessors.push(f); return f; }
    registerMarkdownCodeBlockProcessor() {}
    registerExtensions() {}
    registerEditorExtension() {}
    addRibbonIcon(icon, title, cb) { const el = document.createElement('div'); el.className = 'side-dock-ribbon-action'; el.setAttribute('aria-label', title); el.addEventListener('click', cb); this.ribbon.push({ icon, title, el }); return el; }
    addStatusBarItem() { const el = document.getElementById('statusbar').createSpan({ cls: 'status-bar-item plugin-notebook-audio' }); this.statusBarItems.push(el); return el; }
    addCommand(c) { commands[c.id] = c; return c; }
    addSettingTab(t) { this.settingTabs.push(t); }
    async loadData() { return window.pluginData; }
    async saveData(d) { window.pluginData = JSON.parse(JSON.stringify(d)); }
  }
  /** Tests: render `markdown` for `sourcePath` the way reading view does: each paragraph becomes
   * a block with Obsidian's markup for markdown links and embeds, then every registered
   * post-processor runs on it. Returns the container. */
  window.renderMarkdown = (markdown, sourcePath) => {
    const root = document.createElement('div');
    root.className = 'markdown-preview-view markdown-rendered';
    for (const para of markdown.split(/\n{2,}/)) {
      const p = root.createEl('p');
      for (const line of para.split('\n')) {
        const m = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line.trim());
        if (m && m[1]) { const e = p.createSpan({ cls: 'internal-embed media-embed', attr: { src: m[3], alt: m[2] } }); e.createEl('audio', { attr: { controls: '' } }); }
        else if (m) p.createEl('a', { cls: 'internal-link', text: m[2], attr: { href: m[3], 'data-href': m[3] } });
        else p.appendChild(document.createTextNode(line));
        p.createEl('br');
      }
      for (const f of postProcessors) f(p, { sourcePath, docId: 'mock', frontmatter: null, addChild() {}, getSectionInfo() { return null; } });
    }
    document.getElementById('leaf').appendChild(root);
    return root;
  };

  const normalizePath = p => {
    p = p.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
    return p === '' ? '/' : p;
  };
  // A stand-in icon: an svg with the icon name's first two letters, so screenshots show the buttons.
  const setIcon = (el, name) => {
    el.setAttribute('data-icon', name);
    el.querySelector(':scope > svg.mock-icon')?.remove();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'mock-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.innerHTML = `<rect x="1" y="1" width="22" height="22" rx="5" fill="none" stroke="currentColor"/><text x="12" y="16" font-size="10" text-anchor="middle" fill="currentColor">${name.slice(0, 2)}</text>`;
    el.prepend(svg);
  };
  const setTooltip = (el, t) => { el.setAttribute('aria-label', t); };
  // Mutable so a test can simulate the iPad before loadPlugin(): Platform.isMobile = Platform.isIosApp = true.
  const Platform = { isMobile: false, isMobileApp: false, isIosApp: false, isAndroidApp: false, isPhone: false, isTablet: false, isDesktop: true, isDesktopApp: true, isMacOS: false, isWin: false, isLinux: true, isSafari: false };
  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; };
  const requestUrl = async () => { throw new Error('requestUrl is not mocked'); };

  window.obsidian = {
    Plugin, Component, View, ItemView, FileView, MarkdownView, Notice, Events, TAbstractFile, TFile, TFolder,
    WorkspaceLeaf, Menu, Modal, FuzzySuggestModal, PluginSettingTab, Setting, Platform, normalizePath, setIcon, setTooltip,
    debounce, requestUrl,
  };

  window.loadPlugin = async () => {
    const code = await (await fetch('../main.js?' + Date.now())).text();
    const module = { exports: {} };
    new Function('module', 'exports', 'require', code)(module, module.exports, m => { if (m !== 'obsidian') throw new Error(m); return window.obsidian; });
    // esbuild's cjs output puts `export default` on module.exports.default, as Obsidian expects.
    const P = module.exports.default ?? module.exports;
    const p = new P();
    await p.load();
    return p;
  };
})();
