/**
 * Claude Design (.dc.html) -> React (TSX) converter.
 *
 * A .dc.html file is HTML plus a handful of invented tags, and a logic class in
 * a <script type="text/x-dc">. Claude Design's own support.js already renders it
 * with React: it compiles the template to React.createElement calls and drives
 * the logic class through a base class (StreamableLogic, exposed as DCLogic)
 * that has React's exact shape. So this is a spelling change, not a port.
 *
 *   support.js contract, read out of the bundle's own source, not guessed:
 *     class Component extends DCLogic
 *     DCLogic = StreamableLogic: constructor(props), this.props, this.state,
 *       setState(update, cb), forceUpdate(), componentDidMount(),
 *       componentDidUpdate(prev), componentWillUnmount(), renderVals()
 *     vals = { ...userProps, ...logic.renderVals() || {} }      (support.js:1085)
 *     style strings become objects via cssToObj                  (support.js:803)
 *     DOM attrs: class->className, for->htmlFor, on*->EVENT_MAP,
 *       and kebab attributes pass through UNCHANGED               (support.js:432)
 *
 * The directive surface, counted in AdmissionsOS App v2.dc.html:
 *   <x-dc>        410 <sc-if>   136 <sc-for>   7 <dc-import>   1 <x-import>
 *   <helmet>      {{ expr }}    style-hover=  onClick=         hint-* (dropped)
 *
 * Mustache expressions are not arbitrary JS. support.js resolves them with a
 * small grammar: dotted paths, parens, !, ===, !==, ==, != and true/false
 * (support.js:205). Rewriting root identifiers to `__v.x` is a strict superset
 * of that, so every expression a working design file can contain survives.
 */
import { parseFragment } from 'parse5';

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'typeof', 'new', 'in', 'of', 'void']);

/** Verbatim from support.js. parse5 lowercases attribute names, so `onClick`
 *  arrives as `onclick` and the casing has to be restored the same way. */
const EVENT_MAP = {
  onclick: 'onClick', onchange: 'onChange', oninput: 'onInput', onsubmit: 'onSubmit',
  onkeydown: 'onKeyDown', onkeyup: 'onKeyUp', onkeypress: 'onKeyPress',
  onmousedown: 'onMouseDown', onmouseup: 'onMouseUp', onmouseenter: 'onMouseEnter',
  onmouseleave: 'onMouseLeave', onfocus: 'onFocus', onblur: 'onBlur',
  ondoubleclick: 'onDoubleClick', oncontextmenu: 'onContextMenu',
  onmousemove: 'onMouseMove', onmouseover: 'onMouseOver', onmouseout: 'onMouseOut',
  onpointerdown: 'onPointerDown', onpointerup: 'onPointerUp', onpointermove: 'onPointerMove',
  onpointerenter: 'onPointerEnter', onpointerleave: 'onPointerLeave',
  onpointercancel: 'onPointerCancel', onpointerover: 'onPointerOver',
  onpointerout: 'onPointerOut', ongotpointercapture: 'onGotPointerCapture',
  onlostpointercapture: 'onLostPointerCapture', ontouchstart: 'onTouchStart',
  ontouchend: 'onTouchEnd', ontouchmove: 'onTouchMove', ontouchcancel: 'onTouchCancel',
  ondragstart: 'onDragStart', ondragend: 'onDragEnd', ondragenter: 'onDragEnter',
  ondragleave: 'onDragLeave', ondragover: 'onDragOver',
  onanimationstart: 'onAnimationStart', onanimationend: 'onAnimationEnd',
  onanimationiteration: 'onAnimationIteration', ontransitionend: 'onTransitionEnd',
};

const DROP_ATTR = new Set(['sc-name', 'data-dc-tpl', 'data-dc-script', 'data-props']);

/**
 * SVG presentation attributes React has a camelCase DOM property for.
 *
 * support.js passes kebab attributes straight through for DOM tags, and React
 * does still apply them, so rendering is identical either way. But it logs
 * "Invalid DOM property `stroke-width`" for each one, and this design carries
 * 552 of them across its icons, which buries real errors in the console. Mapping
 * only the names React knows keeps the output byte-identical in the DOM and the
 * console usable. Anything not listed here still passes through untouched.
 */
const SVG_CAMEL = {
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-opacity': 'strokeOpacity',
  'fill-opacity': 'fillOpacity',
  'fill-rule': 'fillRule',
  'clip-path': 'clipPath',
  'clip-rule': 'clipRule',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline',
  'baseline-shift': 'baselineShift',
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'letter-spacing': 'letterSpacing',
  'marker-start': 'markerStart',
  'marker-mid': 'markerMid',
  'marker-end': 'markerEnd',
  'vector-effect': 'vectorEffect',
  'shape-rendering': 'shapeRendering',
  'paint-order': 'paintOrder',
  'color-interpolation-filters': 'colorInterpolationFilters',
};

const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
/**
 * Component names must start with a capital. JSX reads a lowercase tag as a DOM
 * element, so `image-slot` becoming `imageSlot` would emit an unknown HTML tag
 * that renders nothing and reports no error.
 */
const pascal = (s) => {
  const joined = String(s).replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
  return joined.charAt(0).toUpperCase() + joined.slice(1);
};

/* ---------- expressions -------------------------------------------------- */

/**
 * Prefix root identifiers with `__v.` so `{{ l.name }}` inside a loop over `l`
 * stays `l.name` while `{{ crumb }}` becomes `__v.crumb`. Loop variables and
 * language keywords are left alone, and string literals are copied verbatim.
 */
export function rewriteExpr(src, scope) {
  let out = '';
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      while (j < s.length && !(s[j] === q && s[j - 1] !== '\\')) j++;
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
      const word = s.slice(i, j);
      const prev = out.replace(/\s+$/, '').slice(-1);
      const isProp = prev === '.';
      const isKey = /^\s*:/.test(s.slice(j));
      out += isProp || isKey || KEYWORDS.has(word) || scope.has(word) ? word : '__v.' + word;
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out.trim();
}

const MUSTACHE = /\{\{([\s\S]*?)\}\}/g;
const hasMustache = (v) => v != null && /\{\{[\s\S]*?\}\}/.test(v);
const wholeMustache = (v) => String(v).match(/^\s*\{\{([\s\S]*?)\}\}\s*$/);

/** A value as a JS expression string: whole mustache -> bare, mixed -> template. */
function valueExpr(value, scope) {
  const whole = wholeMustache(value);
  if (whole) return rewriteExpr(whole[1], scope);
  return (
    '`' +
    String(value)
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${')
      .replace(MUSTACHE, (_, e) => '${' + rewriteExpr(e, scope) + ' ?? ""}') +
    '`'
  );
}

/**
 * Text between tags has to survive the JSX parser.
 *   { }   would start and end an expression
 *   < >   are outright illegal as literal JSX text; esbuild rejects `->`
 *   &     would be read as the start of an entity
 * parse5 hands text nodes over already decoded, so re-encoding here round-trips
 * to the same characters the design renders. The ampersand pass runs first so it
 * cannot mangle the entities the later passes introduce.
 */
const escapeText = (t) =>
  t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');

function textToJsx(text, scope) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(MUSTACHE)) {
    out += escapeText(text.slice(last, m.index));
    out += '{' + rewriteExpr(m[1], scope) + '}';
    last = m.index + m[0].length;
  }
  return out + escapeText(text.slice(last));
}

/* ---------- style -------------------------------------------------------- */

/** cssToObj from support.js:391. Custom properties keep their name. */
export function cssToObj(css) {
  const o = {};
  for (const decl of String(css).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    if (!prop) continue;
    o[prop.startsWith('--') ? prop : kebabToCamel(prop)] = decl.slice(i + 1).trim();
  }
  return o;
}

const jsStr = (s) => JSON.stringify(String(s));

/**
 * importantify from support.js:1542, ported behaviour for behaviour.
 *
 * Claude Design appends !important to every declaration in a generated pseudo
 * rule, and it has to: these elements carry an inline `style` attribute built by
 * the logic class, and an inline style beats a plain stylesheet rule. Without
 * this, a hover that changes `background` on an element whose computed style
 * also sets `background` silently never fires.
 *
 * Splits on top-level semicolons only, so a semicolon inside quotes, inside
 * parentheses, or inside an unquoted url() does not split a declaration.
 */
export function importantify(css) {
  const s = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      decls.push(s.slice(start, i));
      start = i + 1;
    }
  }
  decls.push(s.slice(start));
  return decls
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (/!\s*important$/i.test(d) ? d : d + ' !important'))
    .join(';');
}

/**
 * React wants a style object, the design writes a string. A fully static string
 * is converted here at build time; anything with a mustache in it has to be
 * converted at run time by the same function, because the class assembles most
 * of the interesting styles itself ("connBtnStyle", "cardStyle").
 */
function styleProp(value, scope, extraDecls) {
  const dyn = extraDecls.length
    ? extraDecls.map(([k, v]) => `${k}:${v}`).join(';')
    : '';
  const merged = dyn ? String(value).replace(/;\s*$/, '') + ';' + dyn : String(value);
  if (!hasMustache(merged)) {
    const obj = cssToObj(merged);
    const body = Object.entries(obj).map(([k, v]) => `${jsStr(k)}: ${jsStr(v)}`).join(', ');
    return `{{ ${body} }}`;
  }
  return `{__dcStyle(${valueExpr(merged, scope)})}`;
}

/* ---------- conversion --------------------------------------------------- */

export function convert(html, opts = {}) {
  const { rewriteHref = (h) => h } = opts;

  const start = html.indexOf('<x-dc');
  if (start < 0) throw new Error('no <x-dc> root in this file');
  const end = html.lastIndexOf('</x-dc>');
  if (end < 0) throw new Error('unterminated <x-dc> root');
  const frag = parseFragment(html.slice(start, end + 7));

  const pseudoRules = [];
  const unportable = [];
  const helmet = extractHelmet(html);
  const imports = new Set();
  // Keyed by component name so the caller can find the source file without
  // reversing the PascalCase, which is lossy ("image-slot" -> "ImageSlot").
  const importSpecs = new Map();
  const stats = { scIf: 0, scFor: 0, dcImport: 0, xImport: 0, styleTags: 0, dynamicStyles: 0 };

  const attrsOf = (n) => Object.fromEntries(n.attrs.map((a) => [a.name, a.value]));

  /**
   * style-hover / style-focus have no React equivalent, so each becomes a
   * generated class with a real :hover rule. Where a declaration's value is
   * itself dynamic it cannot live in a static sheet, so the value moves to a
   * custom property on the element and the rule reads it back with var().
   */
  function pseudoClass(css, pseudo, dynDecls) {
    const raw = String(css).trim();

    /**
     * A value that is one whole mustache means the logic class computes the
     * entire declaration block at run time, so there is nothing to put in a
     * stylesheet. support.js does not handle this either: it passes the raw
     * attribute straight to insertRule (support.js:429 -> 1582), so the browser
     * gets `.scpN:hover{{{ x }}}` and throws. Recorded and skipped rather than
     * emitting css that breaks the build, and reported so the design can be
     * fixed at the source.
     */
    if (wholeMustache(raw)) {
      unportable.push({ kind: `style-${pseudo}`, value: raw });
      return null;
    }

    const name = `dc-${pseudo === 'hover' ? 'h' : 'f'}${pseudoRules.length}`;
    const decls = raw.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const i = d.indexOf(':');
      if (i < 0) return d;
      const prop = d.slice(0, i).trim();
      const value = d.slice(i + 1).trim();
      if (!hasMustache(value)) return `${prop}:${value}`;
      const varName = `--${name}-${prop.replace(/[^a-z0-9-]/gi, '')}`;
      dynDecls.push([varName, value]);
      return `${prop}:var(${varName})`;
    });
    // !important, because support.js does it and the inline style would win.
    pseudoRules.push(`.${name}:${pseudo}{${importantify(decls.join(';'))}}`);
    return name;
  }

  /** DOM element attributes, following support.js:432 exactly. */
  function domAttrs(node, scope, extraClass, dynDecls) {
    const parts = [];
    let classVal = null;
    let sawStyle = false;

    for (const { name, value } of node.attrs) {
      if (name.startsWith('hint-') || DROP_ATTR.has(name)) continue;
      if (name.startsWith('style-')) continue; // handled as a pseudo class

      if (name === 'class') { classVal = value; continue; }
      if (name === 'style') {
        sawStyle = true;
        if (hasMustache(value)) stats.dynamicStyles++;
        parts.push(`style=${styleProp(value, scope, dynDecls)}`);
        continue;
      }

      let key = name;
      if (key === 'for') key = 'htmlFor';
      else if (key.startsWith('on')) key = EVENT_MAP[key] || 'on' + key[2].toUpperCase() + key.slice(3);
      else if (SVG_CAMEL[key]) key = SVG_CAMEL[key];
      // Anything else, kebab included, passes through untouched, which is what
      // support.js does for DOM tags. data-* and aria-* land here.

      let v = value;
      if (key === 'href' || key === 'src') v = rewriteHref(v);

      if (hasMustache(v)) parts.push(`${key}=${'{' + valueExpr(v, scope) + '}'}`);
      else if (v === '') parts.push(key);
      else parts.push(`${key}=${jsStr(v)}`);
    }

    // A dynamic pseudo-class declaration needs its custom property on the
    // element. If the element had no style attribute at all, add one.
    if (!sawStyle && dynDecls.length) {
      parts.push(`style=${styleProp('', scope, dynDecls)}`);
    }

    const classes = [];
    if (classVal) classes.push(classVal);
    if (extraClass) classes.push(extraClass);
    if (classes.length) {
      const joined = classes.join(' ');
      parts.unshift(hasMustache(joined) ? `className={${valueExpr(joined, scope)}}` : `className=${jsStr(joined)}`);
    }
    return parts.length ? ' ' + parts.join(' ') : '';
  }

  /** Component tag attributes: kebab keys camel-case, aria-/data- do not. */
  function componentAttrs(a, scope, skip) {
    return Object.entries(a)
      .filter(([k]) => !k.startsWith('hint-') && !DROP_ATTR.has(k) && !skip.has(k))
      .map(([k, v]) => {
        const key = k.startsWith('aria-') || k.startsWith('data-') ? k : kebabToCamel(k);
        if (k === 'href' || k === 'src') v = rewriteHref(v);
        if (hasMustache(v)) return `${key}={${valueExpr(v, scope)}}`;
        return `${key}=${jsStr(v)}`;
      });
  }

  const kids = (node, scope, raw = false) =>
    (node.childNodes || []).map((c) => emit(c, scope, raw)).join('');

  function emit(node, scope, raw = false) {
    if (node.nodeName === '#text') return raw ? node.value : textToJsx(node.value, scope);
    if (node.nodeName === '#comment' || node.nodeName === '#documentType') return '';

    const tag = node.tagName;
    const a = attrsOf(node);

    if (tag === 'x-dc') return kids(node, scope);

    // The helmet holds <style> and <link>/<script> for the page head. It is not
    // markup, so it is handed back raw for the caller to turn into real css and
    // real imports rather than smuggled into the component tree.
    if (tag === 'helmet') return ''; // collected raw below, see extractHelmet

    // CSS braces would be read as JSX expressions, so stylesheet text goes in
    // through dangerouslySetInnerHTML rather than as children.
    if (tag === 'style') {
      stats.styleTags++;
      return `<style dangerouslySetInnerHTML={{ __html: ${jsStr(kids(node, scope, true))} }} />`;
    }

    if (tag === 'script') return ''; // the logic class is lifted separately

    if (tag === 'sc-if') {
      stats.scIf++;
      const cond = rewriteExpr((a.value || '').replace(/^\s*\{\{|\}\}\s*$/g, ''), scope);
      // Ternary, not &&: `&&` would render a literal 0 when the value is 0,
      // whereas support.js truthy-tests and renders nothing.
      return `{(${cond}) ? (<React.Fragment>${kids(node, scope)}</React.Fragment>) : null}`;
    }

    if (tag === 'sc-for') {
      stats.scFor++;
      const list = rewriteExpr((a.list || '').replace(/^\s*\{\{|\}\}\s*$/g, ''), scope);
      const as = a.as || 'item';
      const idx = a.index || '__i';
      const inner = new Set([...scope, as, idx]);
      return `{(${list} || []).map((${as}, ${idx}) => (<React.Fragment key={${idx}}>${kids(node, inner)}</React.Fragment>))}`;
    }

    if (tag === 'dc-import') {
      stats.dcImport++;
      const name = pascal(a.name);
      imports.add(name);
      importSpecs.set(name, { name, raw: a.name, kind: 'dc-import', file: `${a.name}.dc.html` });
      const props = componentAttrs(a, scope, new Set(['name']));
      return `<${name}${props.length ? ' ' + props.join(' ') : ''} />`;
    }

    if (tag === 'x-import' || tag === 'image-slot') {
      stats.xImport++;
      const raw = a['component-from-global-scope'] || tag;
      const name = pascal(raw);
      imports.add(name);
      importSpecs.set(name, { name, raw, kind: 'x-import', file: a.from || null });
      const props = componentAttrs(a, scope, new Set(['component-from-global-scope', 'from']));
      return `<${name}${props.length ? ' ' + props.join(' ') : ''} />`;
    }

    // plain DOM element
    const dynDecls = [];
    let extraClass = null;
    for (const [k, v] of Object.entries(a)) {
      if (!k.startsWith('style-')) continue;
      const cls = pseudoClass(v, k.slice(6), dynDecls);
      if (!cls) continue; // unportable, already recorded
      extraClass = extraClass ? `${extraClass} ${cls}` : cls;
    }

    const open = `<${tag}${domAttrs(node, scope, extraClass, dynDecls)}`;
    if (VOID.has(tag)) return open + ' />';
    return `${open}>${kids(node, scope)}</${tag}>`;
  }

  const markup = frag.childNodes.map((c) => emit(c, new Set())).join('');
  return {
    markup,
    helmet,
    pseudoCss: pseudoRules.join('\n'),
    imports: [...imports],
    importSpecs: [...importSpecs.values()],
    unportable,
    stats,
  };
}

/* ---------- logic class -------------------------------------------------- */

/**
 * The <helmet> block as literal source text.
 *
 * It cannot come from the tag emitter: that drops every <script>, and the
 * helmet's <script src> list is precisely the demo data the logic class reads
 * from window globals. Taken raw, in source order, which matters because these
 * files read each other's globals.
 */
export function extractHelmet(html) {
  const m = html.match(/<helmet[^>]*>([\s\S]*?)<\/helmet>/i);
  return m ? m[1] : '';
}

/** The <script type="text/x-dc"> body, verbatim. Never rewritten. */
export function extractLogic(html) {
  const m = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1].trim() : '';
}

/** The editor-facing prop schema on that script tag, used for defaults. */
export function extractProps(html) {
  const m = html.match(/data-props="([^"]*)"/);
  if (!m) return {};
  const json = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Default values from the prop schema, so the component renders standalone. */
export function propDefaults(schema) {
  const out = {};
  for (const [k, def] of Object.entries(schema || {})) {
    if (def && typeof def === 'object' && 'default' in def) out[k] = def.default;
  }
  return out;
}
