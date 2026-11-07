// Word-style notes: the browser editor saves simple HTML. Only plain formatting tags are kept (no attributes,
// no links, no images, no scripts), tags are always closed, so a note can never run code, load anything or
// spill its formatting onto the rest of the page. One pass over the text, so a huge paste can't stall the server.
const ALLOWED = new Set(["p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li", "div", "h3", "blockquote"]);
const DROP = /^(script|style|iframe|object|embed|template|svg|math|head|title|textarea|xml|noscript|select|option|noembed|noframes)$/;
const RICH = /<(p|br|b|strong|i|em|u|ul|ol|li|div|h3|blockquote)\b[^<>]*>/i;

const escText = t => t.replace(/&(?!#?[a-z0-9]+;)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function sanitize(input) {
  const s = String(input == null ? "" : input), low = s.toLowerCase(), out = [], open = [], tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^<>]*>/y;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { out.push(escText(s.slice(i))); break; }
    out.push(escText(s.slice(i, lt)));
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt + 4); i = e < 0 ? s.length : e + 3; continue; }
    tag.lastIndex = lt; const m = tag.exec(s);
    if (!m) { out.push("&lt;"); i = lt + 1; continue; }
    i = tag.lastIndex;
    const close = m[1] === "/", t = m[2].toLowerCase();
    if (!close && DROP.test(t)) { const e = low.indexOf("</" + t, i); if (e < 0) i = s.length; else { const g = s.indexOf(">", e); i = g < 0 ? s.length : g + 1; } continue; }
    if (!ALLOWED.has(t)) continue;
    if (t === "br") { out.push("<br>"); continue; }
    if (!close) { if (open.length >= 50) continue; out.push(`<${t}>`); open.push(t); continue; }   // nesting capped: keeps a hostile paste fast
    const k = open.lastIndexOf(t); if (k < 0) continue;   // a closing tag with nothing to close is dropped
    while (open.length > k) out.push(`</${open.pop()}>`);
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join("").replace(/^(\s|<br>|<p><\/p>|<div><\/div>|<p><br><\/p>|<div><br><\/div>)+$/, "").trim();
}

const isRich = s => RICH.test(String(s || ""));

// Notes from the editor are formatted; notes typed elsewhere (CSV import, older notes) are plain text and kept exactly.
const cleanNotes = s => { s = String(s == null ? "" : s); return isRich(s) ? sanitize(s) : s.trim(); };

// Plain text for Word drafts, CSV exports and short previews: paragraphs become lines, list items get "•".
function toText(s) {
  s = String(s || "");
  if (!isRich(s)) return s;
  return sanitize(s).replace(/<br>/g, "\n").replace(/<li>/g, "\n• ").replace(/<\/(p|div|h3|blockquote|ul|ol)>/g, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { sanitize, isRich, cleanNotes, toText };
