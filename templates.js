// Word (.docx) drafts filled from the case. Every draft is for the attorney to review and edit before filing.
const causeNo = c => /^PRE-/.test(String(c.cause_no || "")) ? "__________" : c.cause_no;   // not filed yet: a blank to fill in
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, AlignmentType, WidthType, BorderStyle, ImageRun } = require("docx");

const LIST = [
  { key: "notice_appearance", label: "Notice of appearance of counsel" },
  { key: "notice_hearing", label: "Notice of hearing", ask: ["motion", "date", "time"] },
  { key: "cert_service", label: "Certificate of service (TRCP 21a)" },
  { key: "client_letter", label: "Case status letter to the client" },
  { key: "case_summary", label: "Case summary (all dates, people, status)" }
];
const list = () => LIST;

const FONT = "Times New Roman";
const run = (text, o = {}) => new TextRun({ text: String(text ?? ""), font: FONT, size: o.size || 24, bold: o.bold, italics: o.italics, color: o.color });
const para = (text, o = {}) => new Paragraph({ alignment: o.align, spacing: { after: o.after ?? 200, line: o.line || 276 }, indent: o.indent ? { firstLine: 720 } : undefined,
  children: Array.isArray(text) ? text : [run(text, o)] });
const blank = () => para("", { after: 0 });
const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
const cell = (lines, w, align) => new TableCell({ width: { size: w, type: WidthType.PERCENTAGE }, borders: noBorders,
  children: lines.map(l => new Paragraph({ alignment: align, spacing: { after: 0 }, children: [run(l, { bold: true })] })) });

function parties(style) {
  const s = String(style || "").trim();
  const m = s.split(/\s+v(?:s)?\.?\s+/i);
  if (m.length === 2) return { left: [m[0].toUpperCase() + ",", "     Plaintiff,", "", "v.", "", m[1].toUpperCase() + ",", "     Defendant."], two: true, p: m[0], d: m[1] };
  return { left: [s.toUpperCase() || "________________"], two: false };
}
function caption(c) {
  const pt = parties(c.style);
  const court = String(c.court || "").trim();
  const right = ["IN THE " + (court ? court.toUpperCase() : "________ COURT"), "", "", "", "", "", `${String(c.county || "").toUpperCase()} COUNTY, TEXAS`];
  const rows = Math.max(pt.left.length, right.length);
  const L = Array.from({ length: rows }, (_, i) => pt.left[i] ?? ""), Rr = Array.from({ length: rows }, (_, i) => right[i] ?? "");
  return [
    para([run(`CAUSE NO. ${causeNo(c)}`, { bold: true })], { align: AlignmentType.CENTER, after: 240 }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: noBorders, rows: [new TableRow({ children: [
      cell(L, 46), cell(Array.from({ length: rows }, () => "§"), 8, AlignmentType.CENTER), cell(Rr, 46)] })] }),
    blank()
  ];
}
const title = t => para([run(t.toUpperCase(), { bold: true })], { align: AlignmentType.CENTER, after: 240 });
const draftNote = () => para([run("DRAFT prepared by TX Case Desk from the case file — review, complete the blanks, and delete this line before filing.", { italics: true, size: 18, color: "888888" })], { after: 200 });
// firm block from the firm profile: name, address lines, phone / fax
const lines = s => String(s || "").split(/\n+/).map(x => x.trim()).filter(Boolean);
// "456 Oak Ave, Edinburg, TX 78539" -> street on one line, city/state/ZIP on the next; typed line breaks win
const addrLines = a => { const s = String(a || "").trim(); if (/\n/.test(s)) return lines(s); const i = s.indexOf(","); return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()].filter(Boolean) : [s]; };
function firmBlock(s) {
  return [...(s.firm ? [para([run(s.firm.toUpperCase(), { bold: true })], { after: 0 })] : []), ...lines(s.address).map(l => para(l, { after: 0 })),
    ...(s.firmPhone ? [para(`Telephone: ${s.firmPhone}`, { after: 0 })] : []), ...(s.fax ? [para(`Facsimile: ${s.fax}`, { after: 0 })] : [])];
}
function signature(s, forWho) {
  return [para("Respectfully submitted,", { after: 120 }), ...firmBlock(s), blank(),
    para(`By: /s/ ${s.name}`, { after: 0 }), para(s.name, { after: 0 }), ...(s.title ? [para(s.title, { after: 0 })] : []), para(`State Bar No. ${s.bar || "________"}`, { after: 0 }),
    ...(s.phone && s.phone !== s.firmPhone ? [para(`Direct: ${s.phone}`, { after: 0 })] : []), para(s.email || "", { after: 0 }),
    para(`ATTORNEY FOR ${forWho ? forWho.toUpperCase() : "________"}`, { bold: true, after: 240 })];
}
// letterhead for letters: logo (if the firm uploaded one), firm name, address, phone
function letterhead(s) {
  const out = [];
  if (s.logo && s.logo.data && s.logo.w && s.logo.h) {
    let h = 64, w = Math.round(h * s.logo.w / s.logo.h); if (w > 320) { w = 320; h = Math.round(w * s.logo.h / s.logo.w); }
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new ImageRun({ type: s.logo.type, data: s.logo.data, transformation: { width: w, height: h } })] }));
  }
  if (s.firm) out.push(para([run(s.firm.toUpperCase(), { bold: true, size: 26 })], { align: AlignmentType.CENTER, after: 0 }));
  const contact = [lines(s.address).join(", "), [s.firmPhone && `Tel. ${s.firmPhone}`, s.fax && `Fax ${s.fax}`, s.website].filter(Boolean).join("  ·  ")].filter(Boolean);
  contact.forEach(l => out.push(para([run(l, { size: 20, color: "444444" })], { align: AlignmentType.CENTER, after: 0 })));
  if (out.length) out.push(new Paragraph({ spacing: { after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 4 } }, children: [] }));
  return out;
}
function certificate(s) {
  return [title("Certificate of Service"),
    para(`I certify that on ______________, a true and correct copy of this document was served on all counsel of record and unrepresented parties in accordance with Texas Rule of Civil Procedure 21a.`, { indent: true }),
    para(`/s/ ${s.name}`, { after: 0 }), para(s.name, { after: 0 })];
}
const clientOf = contacts => contacts.find(x => x.role === "client");

async function render(key, { c, contacts, events, signer, opts }) {
  const client = clientOf(contacts);
  const hearing = events.find(e => e.kind === "hearing");
  let body, name;
  if (key === "notice_appearance") {
    name = "Notice of Appearance";
    body = [...caption(c), title("Notice of Appearance of Counsel"), para("TO THE HONORABLE JUDGE OF SAID COURT:", { after: 200 }),
      para(`${signer.name}${signer.firm ? ` of ${signer.firm}` : ""} enters an appearance as counsel for ${client ? client.name : "________"} in this cause and asks that all notices, pleadings and correspondence be served on the undersigned.`, { indent: true }),
      ...signature(signer, client && client.name), ...certificate(signer)];
  } else if (key === "notice_hearing") {
    name = "Notice of Hearing";
    const motion = String(opts.motion || "").trim() || (hearing ? hearing.title : "________");
    const date = String(opts.date || "").trim() || (hearing ? hearing.date : "________");
    const time = String(opts.time || "").trim() || (hearing && hearing.time) || "________";
    body = [...caption(c), title("Notice of Hearing"),
      para(`PLEASE TAKE NOTICE that ${motion} is set for hearing on ${date} at ${time} in the ${c.court || "________ Court"}, ${c.county} County, Texas.`, { indent: true }),
      ...signature(signer, client && client.name), ...certificate(signer)];
  } else if (key === "cert_service") {
    name = "Certificate of Service";
    body = [...caption(c), ...certificate(signer)];
  } else if (key === "client_letter") {
    name = "Client Status Letter";
    const upcoming = events.filter(e => e.kind === "hearing" || e.kind === "meeting").slice(0, 4);
    body = [...letterhead(signer), para(new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago" })), blank(),
      para(client ? client.name : "________", { after: 0 }), ...(client && client.address ? addrLines(client.address).map(l => para(l, { after: 0 })) : []), blank(),
      para([run(`Re: ${c.style || causeNo(c)}, Cause No. ${causeNo(c)}, ${c.court ? c.court + ", " : ""}${c.county} County, Texas`, { bold: true })]),
      para(`Dear ${client ? client.name.split(" ")[0] : "________"}:`),
      para(`I am writing to update you on your case. ${c.status ? `The case is currently at this stage: ${c.status}.` : ""}`, { indent: true }),
      para(upcoming.length ? `Upcoming court dates: ${upcoming.map(e => `${e.date}${e.time ? " at " + e.time : ""} — ${e.title}`).join("; ")}. Please plan to be available, and contact me if you have a conflict.` : "There are no court dates set at this time. I will let you know as soon as one is scheduled.", { indent: true }),
      para("Please call or email me with any questions.", { indent: true }), para("Sincerely,"), blank(), blank(), para(signer.name, { after: 0 }), ...(signer.title ? [para(signer.title, { after: 0 })] : []), para(signer.firm || "", { after: 0 }), ...(signer.phone || signer.firmPhone ? [para(signer.phone || signer.firmPhone, { after: 0 })] : []), para(signer.email || "", { after: 0 })];
  } else if (key === "case_summary") {
    name = "Case Summary";
    body = [para([run(c.style || causeNo(c), { bold: true, size: 30 })]), para(`Cause No. ${causeNo(c)} · ${c.court ? c.court + " · " : ""}${c.county} County, Texas`),
      para(`Status: ${c.status || "—"} · Type: ${c.case_type || "—"} · Attorney: ${c.attorney || "—"} · Filed: ${c.filed_date ? String(c.filed_date instanceof Date ? c.filed_date.toISOString() : c.filed_date).slice(0, 10) : "—"}`),
      para([run("People", { bold: true })], { after: 80 }), ...(contacts.length ? contacts.map(p => para(`${p.role}: ${p.name}${p.company ? ", " + p.company : ""}${p.phone ? " · " + p.phone : ""}${p.email ? " · " + p.email : ""}`, { after: 40 })) : [para("None added yet.")]),
      blank(), para([run("Upcoming dates and deadlines", { bold: true })], { after: 80 }),
      ...(events.length ? events.map(e => para(`${e.date}${e.time ? " " + e.time : ""} — ${e.kind === "deadline" ? "DEADLINE: " : ""}${e.title}${e.cite ? " (" + e.cite + ")" : ""}`, { after: 40 })) : [para("None scheduled.")]),
      ...(c.issues ? [blank(), para([run("Issues", { bold: true })], { after: 80 }), para(c.issues)] : []), ...(c.notes ? [blank(), para([run("Notes", { bold: true })], { after: 80 }), ...require("./richtext").toText(c.notes).split("\n").map(l => para(l, { after: 40 }))] : [])];
  } else throw new Error("Unknown template");
  const doc = new Document({ sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children: key === "case_summary" ? body : [draftNote(), ...body] }] });
  const buffer = await Packer.toBuffer(doc);
  return { buffer, filename: `${name} - ${String(causeNo(c)).replace(/[^\w.-]+/g, "_")}.docx` };
}
module.exports = { list, render };
