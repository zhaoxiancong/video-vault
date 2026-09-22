/**
 * 极简 DOM 垫片 —— 让前端模块能在 Node 里"跑起来"。
 *
 * ══════════════════════════════════════════════════════════════════
 *  为什么需要它
 *
 *  这个项目的 UI 测试（test/ui/smoke.js）要真实 Chrome，而受限沙箱里
 *  Chrome 起不来（crashpad 要 OpenProcess，被拒）。于是前端有这么一大块
 *  **从来没被执行过**：
 *    · 模块级代码在 import 时就跑（`$('#tabs').addEventListener(...)`）
 *    · 板子里某个 #id 拼错 → 运行时 "Cannot read properties of null"
 *    · 事件处理器里读了不存在的属性
 *
 *  静态检查（tools/check-frontend.js）能挡住"#id 对不上"，
 *  但挡不住"模块加载时抛异常"和"事件处理器一跑就崩"。
 *
 *  所以写一个够用的 DOM 垫片，把前端真的 import 进来、真的点几下。
 *  它替代不了真实浏览器（布局、CSS、渲染都没有），但能挡住上面那三类。
 *
 *  ⚠️ 刻意保持"够用就好"：不实现 CSS 级联、不做布局、不模拟渲染。
 *     需要那些东西的测试请用 test/ui/smoke.js（真实 Chrome）。
 * ══════════════════════════════════════════════════════════════════
 */

// ---------------------------------------------------------------- 元素

let seq = 0;

/**
 * DOM 的 `Node` 基类。
 *
 * ⚠️ 必须提供：前端 dom.js 里用 `c instanceof Node` 来区分
 *    "已经是一个节点" 还是 "需要包成文本节点"。
 *    而 **Node.js 自己没有 `Node` 这个全局**（它有 `globalThis.Node`？没有 ——
 *    名字还跟运行时撞车，很容易以为存在）。缺了它前端一渲染就抛
 *    "ReferenceError: Node is not defined"。
 */
export class FakeNode {}

class ClassList {
  constructor(el) { this.el = el; this._set = new Set(); }
  get value() { return [...this._set].join(' '); }
  add(...names) { for (const n of names) this._set.add(n); this._sync(); }
  remove(...names) { for (const n of names) this._set.delete(n); this._sync(); }
  contains(n) { return this._set.has(n); }
  toggle(n, force) {
    const on = force === undefined ? !this._set.has(n) : Boolean(force);
    if (on) this._set.add(n); else this._set.delete(n);
    this._sync();
    return on;
  }
  _sync() { this.el._attrs.class = this.value; }
}

/**
 * `element.style` —— 返回值**本身就是一个 Proxy**。
 *
 * ⚠️ 第一版返回的是 `{ _props: proxy, setProperty() {...} }` 这种包装对象，
 *    结果 `style.display = 'none'` 是把属性**设到包装对象上**、把内层 proxy
 *    整个遮住了：读 `style.display` 能读到，读 `style._props.display` 永远是
 *    undefined。于是测试报"选仅音频后应隐藏清晰度"，而代码其实是对的。
 *
 *    教训：要拦截 `obj.x = v` 这种赋值，那个对象**必须自己就是 Proxy**，
 *    不能是"持有 Proxy 的普通对象"。
 */
function makeStyle() {
  const props = {};
  const handler = {
    get: (t, k) => {
      if (k === '_props') return t;                       // 给测试一个读全部属性的口子
      if (k === 'setProperty') return (key, v) => { t[key] = v; };
      if (k === 'getPropertyValue') return (key) => (t[key] ?? '');
      if (k === 'removeProperty') return (key) => { delete t[key]; };
      return t[k];
    },
    set: (t, k, v) => { t[k] = v; return true; },
  };
  return new Proxy(props, handler);
}

export class FakeElement extends FakeNode {
  constructor(tag, doc) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this._attrs = {};
    this._children = [];
    this._parent = null;
    this._listeners = new Map();
    this._id = `el${++seq}`;
    this.classList = new ClassList(this);
    this.style = makeStyle();
    /**
     * dataset 必须**双向**映射到 data-* 属性，而且必须遵守 **kebab-case 转换**。
     *
     * 前端大量用 `closest('[data-view]')`、`querySelectorAll('[data-action]')`
     * 这类**属性选择器**做事件委托。如果 dataset 只是个普通对象、不落到
     * _attrs 上，属性选择器就永远匹配不到 → 事件委托全部失效。
     * 表现出来是"点了没反应"，而真实浏览器里是好的。
     * （第一版就是这个毛病，测试报"库视图应该被激活"。）
     *
     * ⚠️ 多词属性要转 kebab-case（真实 DOM 规范如此）：
     *    `dataset.pageUrl = 'x'` 落到 HTML 上是 `data-page-url="x"`。
     *    第一版只做 `data-${k}`，于是属性变成 `data-pageUrl`，
     *    而 `querySelectorAll('[data-page-url]')` 永远匹配不到 ——
     *    **同一个坑的第二次**，只是这次藏得更深（单词属性看不出问题）。
     *    所以 set / get / has / ownKeys 四条路径都要转。
     */
    const kebab = (k) => String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const camel = (k) => String(k).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    this.dataset = new Proxy({}, {
      get: (_t, k) => this._attrs[`data-${kebab(k)}`],
      set: (_t, k, v) => { this._attrs[`data-${kebab(k)}`] = String(v); return true; },
      has: (_t, k) => `data-${kebab(k)}` in this._attrs,
      ownKeys: () => Object.keys(this._attrs)
        .filter((k) => k.startsWith('data-'))
        .map((k) => camel(k.slice(5))),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
    // value / checked / hidden / textContent 都是**原型上的访问器**，
    // 这里不能再用普通属性盖掉它们（盖掉之后 `_attrs` 同步就断了，
    // 会得到"代码明明做了、测试说没做"那类假失败）。下面这几行只是把它们初始化。
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.href = '';
    this.src = '';
    this.files = [];
    this.options = [];
    this.selectedIndex = -1;
  }

  /** 前端会调它（校验失败时把焦点移回输入框）。垫片只需不报错。 */
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  select() { /* 输入框全选，垫片无需实现 */ }
  scrollIntoView() { /* 同上 */ }

  // ---- 属性
  get className() { return this._attrs.class || ''; }
  set className(v) {
    this._attrs.class = String(v);
    this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  get id() { return this._attrs.id || ''; }
  set id(v) { this._attrs.id = String(v); }

  get type() { return this._attrs.type || ''; }
  set type(v) { this._attrs.type = String(v); }

  /**
   * `value` 与 `checked` 同样必须是**访问器**，不能只是普通属性 ——
   * 与 `hidden` 是同一类缺口（见下），只是表现更隐蔽。
   *
   * 踩过的坑：`el('option', { value: '9' })` 只写了个 JS 属性，`_attrs` 里没有，
   * 于是 `querySelectorAll('option')` 拿到的选项 `getAttribute('value')` 是空字符串。
   * 表现是"下拉里明明有这一项，测试却说没有" —— 而按 `value` 找选项是很自然的写法。
   *
   * 真相放在 `_attrs` 上，两种写法（读写属性 / 读写 attribute）就一致了。
   */
  get value() { return 'value' in this._attrs ? this._attrs.value : ''; }
  set value(v) { this._attrs.value = String(v); }

  get checked() { return this.hasAttribute('checked'); }
  set checked(v) {
    if (v) this._attrs.checked = '';
    else delete this._attrs.checked;
  }

  /**
   * `hidden` 必须是**访问器**，不能只是普通属性。
   *
   * 真实 DOM 里 `el.hidden = true` 和 `el.setAttribute('hidden','')` 是同一件事，
   * 但垫片里两者曾是分开的：`el()` 会转成属性，而**手写 `.hidden = true` 只写了个
   * JS 属性**，`_attrs` 里没有 → `hasAttribute('hidden')` 为假 →
   * `querySelectorAll('.grp-body[hidden]')` 永远匹配不到。
   *
   * 这个坑的表现是"代码明明把元素藏了，测试却说没藏" —— 又一类
   * **垫片不够真导致的假失败**（本项目已经为这类问题吃过好几次亏）。
   * 现在两者的真相都在 `_attrs` 上，怎么写都一致。
   */
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) {
    if (v) this._attrs.hidden = '';
    else delete this._attrs.hidden;
  }

  /**
   * `textContent` 必须**递归**收集子节点的文本 —— 这是它区别于 `innerText` 的
   * 核心语义，也是这个垫片里最容易写错、错了最难发现的一处。
   *
   * 踩过的坑：它曾经只是个普通字符串属性（构造里 `this.textContent = ''`），
   * 于是 `el('div', {}, [el('span', {text: '已选 1 条'})])` 这种**有子节点**的元素，
   * `textContent` 读出来是空字符串。表现是"断言文案失败，但界面其实是对的"，
   * 而且用 `children.length` 一看又是对的 —— 非常费解。
   *
   * 现在：读 = 自己所有子孙文本拼接（与规范一致，不含注释）；
   *      写 = 清空子节点并放一个文本节点（这正是 `replace(bar, [...])` 依赖的行为）。
   */
  get textContent() {
    let out = '';
    for (const c of this._children) {
      if (c instanceof FakeText) out += c.textContent;
      else if (c instanceof FakeElement) out += c.textContent;
    }
    return out;
  }

  set textContent(v) {
    this._children = [];
    if (v === null || v === undefined) return;
    const s = String(v);
    if (s) this._children.push(new FakeText(s, this.ownerDocument));
  }

  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  hasAttribute(k) { return k in this._attrs; }
  removeAttribute(k) { delete this._attrs[k]; }
  get attributes() { return { ...this._attrs }; }

  /** 只有这些属性会影响可见性判断（垫片不做 CSS 级联） */
  get isDisplayed() {
    return !this.hasAttribute('hidden') && this.style._props.display !== 'none';
  }

  // ---- 树
  get children() { return this._children.filter((c) => c instanceof FakeElement); }
  get parentNode() { return this._parent; }
  get firstChild() { return this._children[0] || null; }
  get nextSibling() {
    if (!this._parent) return null;
    const i = this._parent._children.indexOf(this);
    return this._parent._children[i + 1] || null;
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      const node = typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n;
      // 换爹前先从旧爹那里摘掉。⚠️ 旧爹可能是 **document 自己**
      // （body 的 _parent 就是它，见 FakeDocument 的注释），而 document
      // 没有 removeChild —— 所以这里直接操作 _children，不再走 removeChild。
      if (node._parent) {
        const sib = node._parent._children;
        if (Array.isArray(sib)) {
          const i = sib.indexOf(node);
          if (i >= 0) sib.splice(i, 1);
        }
        node._parent = null;
      }
      node._parent = this;
      this._children.push(node);
    }
  }

  appendChild(n) { this.append(n); return n; }
  prepend(...nodes) { this._children.unshift(...nodes); }
  removeChild(n) {
    const i = this._children.indexOf(n);
    if (i >= 0) { this._children.splice(i, 1); n._parent = null; }
    return n;
  }
  remove() { if (this._parent) this._parent.removeChild(this); }
  replaceWith(n) {
    if (!this._parent) return;
    const i = this._parent._children.indexOf(this);
    if (i >= 0) { this._parent._children[i] = n; n._parent = this._parent; this._parent = null; }
  }
  insertAdjacentHTML(pos, html) {
    // 只支持前端真正用到的那种：往末尾追加一段 HTML
    if (pos === 'beforeend') {
      for (const el of parseHTML(html, this.ownerDocument)) this.append(el);
    }
  }

  contains(n) {
    if (n === this) return true;
    return this._children.some((c) => c.contains && c.contains(n));
  }

  // ---- 事件
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    if (this._listeners.has(type)) this._listeners.get(type).delete(fn);
  }
  /**
   * 派发事件。会**冒泡到祖先** —— 前端大量用事件委托
   * （比如整个 document 上监听 [data-action]），不冒泡就测不到。
   */
  dispatchEvent(event) {
    const e = { type: event.type, target: event.target || this, ...event };
    e.currentTarget = this;
    e.preventDefault = () => { e.defaultPrevented = true; };
    e.stopPropagation = () => { e._stopped = true; };

    let node = this;
    while (node) {
      const set = node._listeners.get(e.type);
      if (set) {
        e.currentTarget = node;
        for (const fn of [...set]) fn.call(node, e);
      }
      if (e._stopped) break;
      node = node._parent;
    }
    return !e.defaultPrevented;
  }
  /** 便捷方法：真的"点"一下 */
  click() { return this.dispatchEvent({ type: 'click' }); }

  // ---- 查询
  _match(sel) {
    // 去掉伪类（垫片不实现）
    const s = sel.split(':')[0].trim();
    if (!s) return false;

    /**
     * ⚠️ 「组合选择器」必须**先于** `.类名` 判断，否则永远匹配不到。
     *
     * 踩过的坑：`_match('.grp-body[hidden]')` 先命中 `s.startsWith('.')` 分支，
     * 于是它拿整个字符串 `.grp-body[hidden]` 去当类名查 —— 当然查不到，
     * 而且**不报错、只是静默返回 false**。表现是"代码明明把元素藏了，
     * 测试却说没藏"，而 `el.hidden` 读出来是对的，非常难查。
     *
     * 现在 `.类名[属性]` 与 `#id[属性]` 先在这里处理。
     *
     * ⚠️ 属性部分必须**同时支持无值和有值**两种写法 —— 第一版的正则写成了
     *    `(?:\[[\w-]+\])+`（只认 `[hidden]` 这种），于是
     *    `.tab[data-view=library]` 匹配不上、掉进下面的 `.类名` 分支、
     *    **静默返回 false**。那是个能力回归：旧代码本来是支持它的，
     *    而现有用例恰好都写成 `querySelectorAll('.tab')` 再 find，所以没被踩到。
     *
     * 本垫片支持的组合选择器形态（写在这里当清单，改之前先看）：
     *   `.类名`  `.类名[属性]`  `.类名[属性=值]`  `.类名[属性="值"]`
     *   `#id`    `#id[属性]`    `#id[属性=值]`
     *   标签      `标签.类名`     `标签#id`          `标签[属性=值]`
     *   `后代 组合`（空格分隔）· 逗号分隔的并列
     * 不支持：`>` `+` `~`（会退化成"只看最后一段"，见 matchesSelector）、伪类、`*`。
     */
    const combo = s.match(/^([.#][\w-]+)((?:\[[^\]]+\])+)$/);
    if (combo) {
      const base = combo[1].startsWith('.')
        ? this.classList.contains(combo[1].slice(1))
        : this.id === combo[1].slice(1);
      if (!base) return false;
      return [...combo[2].matchAll(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g)]
        .every(([, name, val]) => (val === undefined
          ? this.hasAttribute(name)
          : this.getAttribute(name) === val));
    }

    if (s.startsWith('#')) return this.id === s.slice(1);
    if (s.startsWith('.')) return this.classList.contains(s.slice(1));
    if (s.startsWith('[')) {
      const m = s.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
      if (!m) return false;
      return m[2] === undefined ? this.hasAttribute(m[1]) : this.getAttribute(m[1]) === m[2];
    }
    // tag / tag.class / tag#id
    const tm = s.match(/^([a-zA-Z][\w-]*)([.#][\w-]+)?$/);
    if (tm) {
      if (this.tagName !== tm[1].toUpperCase()) return false;
      if (!tm[2]) return true;
      return tm[2].startsWith('.')
        ? this.classList.contains(tm[2].slice(1))
        : this.id === tm[2].slice(1);
    }
    // 形如 "div[data-view=x]" 与 "div[hidden]" 的组合
    const cm = s.match(/^([a-zA-Z][\w-]*)((?:\[[^\]]+\])+)$/);
    if (cm) {
      if (this.tagName !== cm[1].toUpperCase()) return false;
      return [...cm[2].matchAll(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g)]
        .every(([, name, val]) => (val === undefined
          ? this.hasAttribute(name)
          : this.getAttribute(name) === val));
    }
    return false;
  }

  _walk(fn) {
    for (const c of this._children) {
      if (!(c instanceof FakeElement)) continue;
      if (fn(c) === false) return;   // 返回 false 停止
      c._walk(fn);
    }
  }

  querySelectorAll(sel) {
    // 支持逗号分隔与后代组合（`#queueList [data-id="42"]`）
    const groups = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    this._walk((el) => {
      if (groups.some((g) => matchesSelector(el, g))) out.push(el);
    });
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  /** 从自身往上找最近的匹配祖先 */
  closest(sel) {
    const sels = String(sel).split(',').map((s) => s.trim());
    let node = this;
    while (node) {
      if (sels.some((s) => node._match && node._match(s))) return node;
      node = node._parent;
    }
    return null;
  }

  /** 前端只在"取元素坐标"时用到，垫片给个假值即可 */
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 };
  }
}

/**
 * 带**后代组合**的选择器匹配：`#queueList [data-id="42"]`、`.a .b`。
 *
 * ⚠️ 这个必须支持，不能只做单段匹配。
 *    前端大量用 `$('#queueList [data-id="' + id + '"]')` 这种带作用域的查询。
 *    第一版只按最后一段匹配，于是 `#queueList [data-id="42"]` 返回 0 个 ——
 *    测试报"队列里应该出现这条任务"，**而渲染其实完全正常**。
 *    这种"垫片不够真"导致的假失败，比被测代码有 bug 更浪费时间。
 *
 * 只处理空格分隔的后代关系；`>` / `+` / `~` 这些本项目没用，遇到就退回"只匹配最后一段"。
 */
function matchesSelector(el, selector) {
  const parts = String(selector).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (parts.length === 1) return el._match(parts[0]);
  if (parts.some((p) => /[>+~]/.test(p))) return el._match(parts[parts.length - 1]);

  // 最后一段匹配自己
  if (!el._match(parts[parts.length - 1])) return false;
  // 前面的各段要能在祖先里按顺序找到
  let node = el._parent;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    let found = false;
    while (node) {
      if (node._match && node._match(parts[i])) { found = true; node = node._parent; break; }
      node = node._parent;
    }
    if (!found) return false;
  }
  return true;
}

export class FakeText extends FakeNode {  constructor(text, doc) { super(); this.nodeType = 3; this.textContent = String(text); this.ownerDocument = doc; }
  get parentNode() { return this._parent || null; }
  contains() { return false; }
}

// ---------------------------------------------------------------- 文档

export class FakeDocument {
  constructor() {
    this._listeners = new Map();
    this.activeElement = null;
    this.hidden = false;
    this.body = new FakeElement('body', this);
    this.documentElement = new FakeElement('html', this);
    /**
     * ⚠️ 父链必须是 `…元素 → body → html → document`，且**不能有环**。
     *
     * `dispatchEvent` 顺着 `_parent` 往上冒泡，走到 document 才停。
     * 这里踩过两次：
     *   ① 最早写 `body._parent = null` —— 事件走到 body 就停了，**永远到不了
     *      document**。而项目里大量交互（库页的播放/收藏/更多）正挂在 document
     *      的委托监听上，于是它们在测试里从来没被触发过（"点了没反应"）。
     *   ② 改成先给 body 设父、再 `documentElement.append(body)` ——
     *      append 会把 body 的父**改回 html**，形成 `BODY → HTML → BODY` 的死循环。
     *
     * 正确写法：body 的父 = documentElement，documentElement 的父 = document。
     */
    this.body._parent = this.documentElement;
    this.documentElement._parent = this;
  }

  createElement(tag) { return new FakeElement(tag, this); }
  createTextNode(text) { return new FakeText(text, this); }
  getElementById(id) {
    let found = null;
    this.body._walk((el) => { if (el.id === id) { found = el; return false; } });
    return found;
  }
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    if (this._listeners.has(type)) this._listeners.get(type).delete(fn);
  }
  dispatchEvent(event) {
    const set = this._listeners.get(event.type);
    if (!set) return true;
    for (const fn of [...set]) fn.call(this, { ...event, target: event.target || this });
    return true;
  }
}

// ---------------------------------------------------------------- HTML 解析

/**
 * 解析 HTML 片段/文档成一个元素数组。
 *
 * ⚠️ 这是个**玩具解析器**：只处理自闭合、注释、属性引号这几种常见形态，
 *    够解析本项目的 index.html 就行。要真正解析 HTML 请用浏览器（smoke.js）。
 */
export function parseHTML(html, doc = new FakeDocument()) {
  const roots = [];
  const stack = [];
  // 去掉注释和 DOCTYPE
  let src = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');

  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)(\/?)>/g;
  let last = 0;
  let m;

  const pushText = (text) => {
    const t = text.trim();
    if (!t) return;
    const parent = stack.length ? stack[stack.length - 1] : null;
    if (parent) parent.append(doc.createTextNode(t));
  };

  while ((m = tagRe.exec(src)) !== null) {
    pushText(src.slice(last, m.index));
    last = tagRe.lastIndex;

    const [, closing, tag, rawAttrs, selfClose] = m;
    const name = tag.toLowerCase();

    if (closing) {
      // 关到匹配的那一层
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tagName === name.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const el = new FakeElement(name, doc);
    for (const am of rawAttrs.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const key = am[1];
      const val = am[2] ?? am[3] ?? am[4] ?? '';
      if (key === 'class') el.className = val;
      else if (key === 'id') el.id = val;
      else if (key === 'hidden') el.setAttribute('hidden', '');
      else if (key.startsWith('data-')) el.dataset[key.slice(5)] = val;
      else el.setAttribute(key, val);
      if (key === 'value') el.value = val;
      if (key === 'checked') el.checked = true;
    }

    const parent = stack.length ? stack[stack.length - 1] : null;
    if (parent) parent.append(el); else roots.push(el);

    // 这些标签不用闭合
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'param', 'source', 'track', 'wbr']);
    if (!selfClose && !VOID.has(name)) stack.push(el);
  }
  pushText(src.slice(last));
  return roots;
}

/**
 * 装一个全局环境，让前端模块能 import。
 *
 * @param {object} [opts]
 * @param {string} [opts.html]        页面 HTML（默认读 src/web/index.html）
 * @param {object} [opts.responses]   fetch 的假响应： `{'GET /api/health': {...}}`
 *                                    key 可以不带查询串（会剥掉再匹配）
 * @returns {{document, window, restore:Function, calls:Array}}
 */
export function installDom({ html = '', responses = {}, webRoot } = {}) {
  const document = new FakeDocument();
  if (html) {
    for (const el of parseHTML(html, document)) document.body.append(el);
  }

  /**
   * 垫片装出来的所有定时器 —— restore 时要全部清掉，否则会泄漏到别的测试里。
   *
   * ⚠️ 必须先把原生函数**存下来**再包装。
   *    第一版直接写 `const trackTimeout = (fn, ms) => setTimeout(fn, ms)`，
   *    而 `setTimeout` 在调用时才解析到 `globalThis.setTimeout` —— 那时它已经被
   *    换成 trackTimeout 了，于是**无限递归** → "Maximum call stack size exceeded"。
   */
  const nativeSetTimeout = setTimeout;
  const nativeSetInterval = setInterval;

  const liveTimers = new Set();
  const trackTimeout = (fn, ms, ...rest) => {
    const t = nativeSetTimeout(fn, ms, ...rest);
    liveTimers.add(t);
    return t;
  };
  const trackInterval = (fn, ms, ...rest) => {
    const t = nativeSetInterval(fn, ms, ...rest);
    liveTimers.add(t);
    return t;
  };

  // ---- localStorage
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };

  // ---- fetch：按 responses 表返回，并记录所有调用
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });

    /**
     * 查假响应时**要把查询串去掉**。
     * 前端请求的是 `/api/queue?history=20`，而测试里按 `/api/queue` 写 key ——
     * 不剥查询串就一直匹配不上，返回空对象，表现为"统计全是 0"。
     */
    const bare = String(url).split('?')[0];
    const hit = responses[`${method} ${url}`]
      ?? responses[`${method} ${bare}`]
      ?? responses[`* ${bare}`];
    /**
     * 响应值可以是**函数**：`(req) => body`，req 带 `{method, url, bare, params}`。
     *
     * 为什么需要这个：有些响应**必须跟着请求走**，不能写死。
     * 例如分组接口要回显 `by=site|group` —— 写死的话，前端拿到的维度与它请求的
     * 对不上就会走错渲染分支（表现为"选了 group 却按 site 渲染"），
     * 而那种失败看起来像产品 bug，其实只是假响应撒了谎。
     */
    let body;
    if (typeof hit === 'function') {
      body = hit({ method, url: String(url), bare, params: new URLSearchParams(String(url).split('?')[1] || '') });
    } else {
      body = hit === undefined ? {} : hit;
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
      headers: { get: () => 'application/json' },
    };
  };

  // ---- EventSource：记录监听器，测试可以手动触发
  const streams = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this._listeners = new Map();
      streams.push(this);
    }
    addEventListener(type, fn) { this._listeners.set(type, fn); }
    emit(type, data) {
      const fn = this._listeners.get(type);
      if (fn) fn({ data: JSON.stringify(data) });
    }
    close() { this.closed = true; }
  }

  const saved = {};
  const globals = {
    document, localStorage, fetch: fetchImpl, EventSource: FakeEventSource,
    navigator: { clipboard: { writeText: async () => {} } },
    Node: FakeNode,
    // 用跟踪版：restore 时要把它们全部清掉，否则会泄漏到别的测试
    requestAnimationFrame: (fn) => trackTimeout(fn, 0),
    setTimeout: trackTimeout, clearTimeout, setInterval: trackInterval, clearInterval,
    console, URLSearchParams, URL, TextDecoder, TextEncoder, AbortController,
  };

  /**
   * ⚠️ 必须用 defineProperty，不能直接赋值。
   *    Node 21+ 把 `navigator`、`fetch` 这类定义成了**只有 getter** 的属性，
   *    直接 `globalThis.navigator = x` 会抛
   *    "Cannot set property navigator of #<Object> which has only a getter"。
   */
  const descriptors = {};
  for (const [k, v] of Object.entries(globals)) {
    descriptors[k] = Object.getOwnPropertyDescriptor(globalThis, k) || null;
    Object.defineProperty(globalThis, k, {
      value: v, writable: true, configurable: true, enumerable: false,
    });
  }
  globalThis.window = globalThis;

  return {
    document,
    calls,
    streams,
    restore() {
      /**
       * 停掉所有还活着的定时器。
       *
       * 为什么必需：前端会 `setInterval`（SSE 心跳那类）和 `setTimeout`
       * （toast 淡出）。测试跑完就 restore，而这些定时器还会醒过来，
       * 去访问已经被拆掉的 document → 抛 "document is not defined"，
       * 而且是在**别的测试里**炸，报错位置完全指不到真正的原因。
       */
      for (const t of liveTimers) { try { clearTimeout(t); clearInterval(t); } catch { /* 忽略 */ } }
      liveTimers.clear();
      for (const es of streams) { try { es.close(); } catch { /* 忽略 */ } }

      for (const k of Object.keys(globals)) {
        const d = descriptors[k];
        if (d) Object.defineProperty(globalThis, k, d);
        else delete globalThis[k];
      }
      delete globalThis.window;
    },
  };
}
