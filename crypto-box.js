// AES-256-GCM encryption for court-portal passwords. Key lives only in the CRED_KEY env var.
const crypto = require("crypto");

function key() {
  const k = process.env.CRED_KEY;
  if (!k) throw new Error("CRED_KEY is not set — court logins can't be stored.");
  const buf = Buffer.from(k, "base64");
  if (buf.length !== 32) throw new Error("CRED_KEY must be 32 bytes, base64-encoded.");
  return buf;
}
function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString("base64")).join(".");
}
function open(sealed) {
  const [iv, tag, enc] = String(sealed).split(".").map(s => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
module.exports = { seal, open };
