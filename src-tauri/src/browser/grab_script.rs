//! In-page element picker injected into a browser page's own world.
//!
//! WebView2 guests have no preload and no Node, so the picker must be plain JS
//! evaluated in the page. Extraction mirrors the Orca reference
//! (`src/main/browser/grab-guest-script.ts`) so a grabbed element produces the
//! same structured context an agent can act on: a unique CSS selector, the
//! React component chain, accessibility role/name, nearby text, bounded HTML,
//! and both the ancestor and full DOM paths.
//!
//! The payload leaves the page through a `vibelink-design://grab` navigation,
//! which `create_child_webview`'s `on_navigation` hook intercepts. Every string
//! is clamped in the page AND re-validated in `manager::validate_annotation_input`,
//! because the page is untrusted.

/// Install the overlay, hover highlight, and click handler.
#[cfg(windows)]
pub const ARM_SCRIPT: &str = r#"(() => {
'use strict';
if (window.__vibelinkDesignGrab) return;

var BUDGET = {
  textSnippet: 200,
  nearbyTextEntry: 200,
  nearbyTextEntries: 10,
  htmlSnippet: 4096,
  ancestorPathEntries: 10,
  selector: 700,
  path: 900,
  sourceFile: 500,
  reactComponents: 500
};

// Redaction list mirrors Orca: a grabbed element must never carry credentials
// into an agent prompt just because they were sitting in the DOM.
var SECRET_PATTERNS = ['access_token','auth_token','api_key','apikey','client_secret','oauth_state','x-amz-','session_id','sessionid','csrf','secret','password','passwd'];
var SAFE_ATTRS = ['id','class','name','type','role','href','src','alt','title','placeholder','for','action','method'];
var SAFE_URL_PROTOCOLS = ['http:','https:','file:'];
var STYLE_PROPS = ['display','position','width','height','margin','padding','color','background-color','border','border-radius','font-family','font-size','font-weight','line-height','text-align','z-index'];

function clampStr(value, max) {
  if (!value || typeof value !== 'string') return '';
  return value.length <= max ? value : value.slice(0, max) + ' (truncated)';
}

function containsSecret(value) {
  if (!value) return false;
  var lower = String(value).toLowerCase();
  for (var i = 0; i < SECRET_PATTERNS.length; i++) {
    if (lower.indexOf(SECRET_PATTERNS[i]) !== -1) return true;
  }
  return false;
}

function sanitizeUrl(raw) {
  try {
    var url = new URL(raw, location.href);
    if (url.protocol === 'about:') return url.toString() === 'about:blank' ? 'about:blank' : '';
    if (SAFE_URL_PROTOCOLS.indexOf(url.protocol) === -1) return '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (error) {
    // Never fall back to the raw value: that would preserve javascript: URIs.
    return '';
  }
}

// Bounded read: slice before normalizing so a huge subtree never materializes
// a huge intermediate string.
function boundedText(node, max) {
  try {
    var raw = (node.textContent || '').slice(0, max * 4);
    return clampStr(raw.replace(/\s+/g, ' ').trim(), max);
  } catch (error) {
    return '';
  }
}

function elementText(el) {
  return boundedText(el, BUDGET.textSnippet) || clampStr(el.value || '', BUDGET.textSnippet);
}

function htmlSnippet(el) {
  try {
    var clone = el.cloneNode(true);
    var scripts = clone.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) scripts[i].remove();
    // Inline base64 payloads carry no editable meaning and would otherwise eat
    // the entire snippet budget on any page with data-URI images or fonts.
    var html = (clone.outerHTML || '').replace(/data:[^"'\s>]{64,}/g, 'data:…');
    return clampStr(html, BUDGET.htmlSnippet);
  } catch (error) {
    return '';
  }
}

function safeAttributes(el) {
  var out = [];
  for (var i = 0; i < el.attributes.length; i++) {
    var attr = el.attributes[i];
    var name = attr.name.toLowerCase();
    if (SAFE_ATTRS.indexOf(name) === -1 && name.indexOf('aria-') !== 0) continue;
    var value = attr.value;
    if (containsSecret(value)) value = '[redacted]';
    else if (name === 'href' || name === 'src' || name === 'action') value = sanitizeUrl(value);
    else value = clampStr(value, 500);
    out.push([name, value]);
  }
  return out;
}

function accessibility(el) {
  var role = el.getAttribute('role') || el.tagName.toLowerCase();
  var ariaLabel = el.getAttribute('aria-label');
  var labelledBy = el.getAttribute('aria-labelledby');
  var name = '';
  if (ariaLabel) {
    name = ariaLabel;
  } else if (labelledBy) {
    var ids = labelledBy.split(/\s+/).slice(0, 32);
    var names = [];
    for (var i = 0; i < ids.length; i++) {
      var ref = ids[i] ? document.getElementById(ids[i]) : null;
      if (ref) names.push(boundedText(ref, 100));
    }
    name = names.join(' ');
  } else {
    var tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'label') name = boundedText(el, 100);
    else name = el.getAttribute('title') || el.getAttribute('alt') || '';
  }
  return { role: role, accessibleName: clampStr(name, 1000) };
}

function computedStyleSubset(el) {
  var styles = getComputedStyle(el);
  var out = [];
  for (var i = 0; i < STYLE_PROPS.length; i++) {
    out.push([STYLE_PROPS[i], styles.getPropertyValue(STYLE_PROPS[i]) || '']);
  }
  return out;
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\' + ch; });
}

// Build-hash classes (`css-1a2b3c`, `Button_root__x7Kq2`) change on every deploy,
// so a selector built from them is useless to an agent editing source.
function looksHashy(value) {
  return /^[A-Za-z0-9_-]{12,}$/.test(value) && /\d/.test(value) && /[A-Z]/.test(value);
}

function stableClasses(el, maxCount) {
  if (!el.classList) return [];
  var out = [];
  for (var i = 0; i < el.classList.length && out.length < maxCount; i++) {
    var cls = el.classList[i];
    if (!cls || cls.length > 60 || containsSecret(cls)) continue;
    if (/^css-[a-z0-9]+$/i.test(cls) || looksHashy(cls)) continue;
    out.push(cls);
  }
  return out;
}

function selectorPart(el) {
  var tag = el.tagName.toLowerCase();
  if (el.id && !containsSecret(el.id)) return tag + '#' + cssEscape(el.id);
  var classes = stableClasses(el, 2);
  if (classes.length > 0) {
    return tag + classes.map(function (cls) { return '.' + cssEscape(cls); }).join('');
  }
  return tag;
}

function isUnique(selector) {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch (error) {
    return false;
  }
}

function nthOfTypeSuffix(el) {
  var index = 1;
  var sibling = el.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === el.tagName) index++;
    sibling = sibling.previousElementSibling;
  }
  if (index > 1) return ':nth-of-type(' + index + ')';
  sibling = el.nextElementSibling;
  while (sibling) {
    if (sibling.tagName === el.tagName) return ':nth-of-type(1)';
    sibling = sibling.nextElementSibling;
  }
  return '';
}

// Walk up until the accumulated selector matches exactly one node, so the
// result can be pasted into `document.querySelector` or a test.
function buildSelector(el) {
  var parts = [];
  var current = el;
  while (current && current.nodeType === 1 && current !== document.body && parts.length < 10) {
    var part = selectorPart(current);
    var parent = current.parentElement;
    if (parent && !isUnique(parts.concat([part]).reverse().join(' > '))) {
      part += nthOfTypeSuffix(current);
    }
    parts.unshift(part);
    var selector = parts.join(' > ');
    if (isUnique(selector)) return clampStr(selector, BUDGET.selector);
    current = parent;
  }
  return clampStr(parts.join(' > ') || el.tagName.toLowerCase(), BUDGET.selector);
}

function buildFullPath(el) {
  var parts = [];
  var current = el;
  while (current && current.nodeType === 1 && current !== document.documentElement && parts.length < 20) {
    parts.unshift(selectorPart(current));
    current = current.parentElement;
  }
  return clampStr(parts.join(' > '), BUDGET.path);
}

function ancestorPath(el) {
  var path = [];
  var current = el.parentElement;
  while (current && current !== document.documentElement && path.length < BUDGET.ancestorPathEntries) {
    var tag = current.tagName.toLowerCase();
    var role = current.getAttribute('role');
    path.push(role ? tag + '[role=' + role + ']' : tag);
    current = current.parentElement;
  }
  return path;
}

function nearbyText(el) {
  var results = [];
  if (!el.parentElement) return results;
  var inspected = 0;
  var previous = el.previousElementSibling;
  var next = el.nextElementSibling;
  var add = function (sibling) {
    if (!sibling) return;
    var text = boundedText(sibling, BUDGET.nearbyTextEntry);
    if (text) results.push(text);
  };
  while (results.length < BUDGET.nearbyTextEntries && inspected < 80 && (previous || next)) {
    if (previous) {
      var previousSibling = previous;
      previous = previous.previousElementSibling;
      inspected++;
      add(previousSibling);
    }
    if (next && results.length < BUDGET.nearbyTextEntries && inspected < 80) {
      var nextSibling = next;
      next = next.nextElementSibling;
      inspected++;
      add(nextSibling);
    }
  }
  return results;
}

function fiberFor(el) {
  var keys = Object.keys(el);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
      try { return el[keys[i]] || null; } catch (error) { return null; }
    }
  }
  return null;
}

function fiberName(fiber) {
  var type = fiber && (fiber.type || fiber.elementType);
  if (!type || typeof type === 'string') return null;
  if (type.displayName || type.name) return type.displayName || type.name;
  if (type.render && (type.render.displayName || type.render.name)) return type.render.displayName || type.render.name;
  if (type.type && (type.type.displayName || type.type.name)) return type.type.displayName || type.type.name;
  return null;
}

// Infrastructure wrappers say nothing about where to edit; only product
// components are worth putting in front of an agent.
function skipReactName(name) {
  if (!name || name.length <= 2) return true;
  return /^(Fragment|Root|Routes|Route|Outlet|Provider|Consumer|Profiler|Suspense)$/.test(name)
    || /(Boundary|BoundaryHandler|Router|Provider|Consumer|Context|Wrapper)$/.test(name)
    || /^(Inner|Outer|Client|Server|RSC|Dev|React|Hot)/.test(name);
}

function cleanSourcePath(path) {
  if (!path) return '';
  return String(path)
    .replace(/[?#].*$/, '')
    .replace(/^[a-z-]+:\/\/\/?(\[project\]\/)?/i, '')
    .replace(/^\.\//, '');
}

function reactMetadata(el) {
  try {
    var fiber = fiberFor(el);
    var components = [];
    var sourceFile = '';
    var depth = 0;
    while (fiber && depth < 35) {
      var name = fiberName(fiber);
      if (name && !skipReactName(name) && components.indexOf(name) === -1 && components.length < 6) {
        components.push(name);
      }
      var source = fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource);
      if (!sourceFile && source && source.fileName && source.lineNumber) {
        var candidate = cleanSourcePath(source.fileName) + ':' + source.lineNumber
          + (source.columnNumber !== undefined ? ':' + source.columnNumber : '');
        if (!containsSecret(candidate)) sourceFile = clampStr(candidate, BUDGET.sourceFile);
      }
      fiber = fiber.return;
      depth++;
    }
    var chain = components.slice().reverse().map(function (name) { return '<' + name + '>'; }).join(' ');
    return { reactComponents: clampStr(chain, BUDGET.reactComponents), sourceFile: sourceFile };
  } catch (error) {
    return { reactComponents: '', sourceFile: '' };
  }
}

function buildSelection(el, comment) {
  var rect = el.getBoundingClientRect();
  var access = accessibility(el);
  var react = reactMetadata(el);
  var tag = el.tagName.toLowerCase();
  return {
    browserRef: tag + (el.id ? '#' + el.id : ''),
    tagName: tag,
    selector: buildSelector(el),
    fullPath: buildFullPath(el),
    role: access.role,
    reactComponents: react.reactComponents,
    htmlSnippet: htmlSnippet(el),
    accessibleName: access.accessibleName,
    nearbyText: nearbyText(el),
    ancestorPath: ancestorPath(el),
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      scaleFactorMilli: Math.round(devicePixelRatio * 1000)
    },
    computedStyles: computedStyleSubset(el),
    attributes: safeAttributes(el),
    text: elementText(el),
    comment: comment || '',
    sourceHints: react.sourceFile ? [react.sourceFile] : []
  };
}

// A capture-phase click listener is NOT enough: portals commonly navigate from
// `pointerdown`/`mousedown`, so the page moves before `click` ever fires and
// preventDefault arrives too late. Take every pointer event on a full-viewport
// overlay instead, and hit-test underneath it, so the page sees nothing at all.
var overlay = document.createElement('div');
overlay.setAttribute('data-vibelink-grab', '1');
overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent;pointer-events:auto';

var highlight = document.createElement('div');
highlight.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #737373;background:rgba(115,115,115,.14);border-radius:2px;display:none;box-sizing:border-box';
overlay.appendChild(highlight);

function elementUnder(event) {
  // The overlay owns the hit test, so drop out of it for one lookup.
  overlay.style.pointerEvents = 'none';
  var found = document.elementFromPoint(event.clientX, event.clientY);
  overlay.style.pointerEvents = 'auto';
  return found && found !== overlay && found !== highlight ? found : null;
}

function paintHighlight(element) {
  if (!element) {
    highlight.style.display = 'none';
    return;
  }
  var rect = element.getBoundingClientRect();
  highlight.style.display = 'block';
  highlight.style.left = rect.left + 'px';
  highlight.style.top = rect.top + 'px';
  highlight.style.width = rect.width + 'px';
  highlight.style.height = rect.height + 'px';
}

function onMove(event) {
  paintHighlight(elementUnder(event));
}

// One click is one grab. The comment belongs to the panel's annotation card, so
// the page collects nothing: a copy-intent grab must reach the clipboard without
// a second interaction, and an in-page form would also have to be styled and
// keyboard-trapped inside a hostile document.
function onClick(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  var target = elementUnder(event);
  if (!target) return;
  teardown();
  location.href = 'vibelink-design://grab?payload=' + encodeURIComponent(JSON.stringify(buildSelection(target, '')));
}

function swallow(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

var SWALLOWED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'dblclick', 'auxclick'];

function teardown() {
  overlay.removeEventListener('pointermove', onMove);
  overlay.removeEventListener('click', onClick, true);
  for (var i = 0; i < SWALLOWED.length; i++) overlay.removeEventListener(SWALLOWED[i], swallow, true);
  overlay.remove();
  delete window.__vibelinkDesignGrab;
}

overlay.addEventListener('pointermove', onMove);
overlay.addEventListener('click', onClick, true);
for (var index = 0; index < SWALLOWED.length; index++) {
  overlay.addEventListener(SWALLOWED[index], swallow, true);
}
document.documentElement.appendChild(overlay);
window.__vibelinkDesignGrab = { teardown: teardown };
})()"#;

/// Remove the overlay and every listener the arm script installed.
#[cfg(windows)]
pub const TEARDOWN_SCRIPT: &str = r#"(() => {
var grab = window.__vibelinkDesignGrab;
if (grab && typeof grab.teardown === 'function') grab.teardown();
})()"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// `eval` receives these verbatim, so a stray Rust raw-string terminator or
    /// an unbalanced brace would silently disable element picking at runtime.
    #[test]
    fn scripts_are_self_contained_expressions() {
        for script in [ARM_SCRIPT, TEARDOWN_SCRIPT] {
            assert!(script.starts_with("(() => {"), "script must be an IIFE");
            assert!(script.ends_with("})()"), "script must invoke itself");
            assert_eq!(
                script.matches('{').count(),
                script.matches('}').count(),
                "unbalanced braces"
            );
            assert_eq!(
                script.matches('(').count(),
                script.matches(')').count(),
                "unbalanced parentheses"
            );
        }
    }

    /// The payload must carry every field `BrowserAnnotationInput` deserializes;
    /// a missing key makes `browser_create_annotation` fail at runtime only.
    #[test]
    fn arm_script_emits_every_annotation_field() {
        for field in [
            "browserRef",
            "tagName",
            "selector",
            "fullPath",
            "role",
            "reactComponents",
            "htmlSnippet",
            "accessibleName",
            "nearbyText",
            "ancestorPath",
            "bounds",
            "computedStyles",
            "attributes",
            "text",
            "comment",
            "sourceHints",
        ] {
            assert!(
                ARM_SCRIPT.contains(&format!("{field}:")),
                "arm script is missing the {field} field"
            );
        }
    }

    #[test]
    fn arm_script_redacts_credentials_and_rejects_unsafe_urls() {
        assert!(ARM_SCRIPT.contains("'[redacted]'"));
        assert!(ARM_SCRIPT.contains("client_secret"));
        // sanitizeUrl must return empty rather than the raw value on parse
        // failure, otherwise a javascript: href would reach the clipboard.
        assert!(ARM_SCRIPT.contains("SAFE_URL_PROTOCOLS"));
    }
}
