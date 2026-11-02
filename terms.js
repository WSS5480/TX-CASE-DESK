// TX Case Desk User Agreement (terms of service + privacy). Bump VERSION when the text changes:
// everyone is asked to accept the new version at their next sign-in.
const VERSION = "2026-11-02";
const UPDATED = "November 2, 2026";

const SECTIONS = [
  ["What TX Case Desk is", `
    <p>TX Case Desk ("TX Case Desk", "we", "us") is software for Texas attorneys and law firms. It keeps cases, court dates, deadlines, tasks, clients, time, billing, a trust ledger, email and public case law in one place. It reads court notices from your email to add and update cases, and it ranks public court opinions for an argument using fixed rules (no artificial intelligence).</p>
    <p>This agreement is between TX Case Desk and the firm or solo attorney that creates the account ("you"), including everyone the account adds. By creating an account, signing in, or clicking "I agree", you accept it for yourself and, if you add people, on behalf of your firm.</p>`],
  ["Accounts and who can use them", `
    <ul>
      <li>Each person gets their own sign-in, protected by a password and two-factor codes. Don't share sign-ins.</li>
      <li>The firm's admin adds and removes people and decides what each person can see. You're responsible for who you give access to, and for removing people who leave.</li>
      <li>Tell us right away if you think someone got into your account without permission.</li>
    </ul>`],
  ["You stay the lawyer", `
    <p>TX Case Desk is a tool. It is not a law firm, doesn't give legal advice, and doesn't replace your professional judgment. In particular:</p>
    <ul>
      <li><b>Deadlines and court dates:</b> the deadline calculator, calendar and court-date updates are aids. Check every deadline against the rules, the court's orders and the docket. We can miss or misread a court email, and courts change settings.</li>
      <li><b>Case law:</b> rankings and "ways forward" come from counting public opinions with fixed rules. Read and verify every authority (including that it is still good law) before relying on it or citing it.</li>
      <li><b>Court notices:</b> cases and updates built from emails depend on what the court sends. Notices can be incomplete, late or sorted to the wrong case.</li>
      <li><b>Trust ledger (beta):</b> it helps you track client funds but doesn't replace your own trust-account records, bank reconciliations or your duties under the Texas rules.</li>
    </ul>`],
  ["Your data and client confidentiality", `
    <ul>
      <li><b>It's yours.</b> You own everything you put in or connect. We use it only to run TX Case Desk for you. We don't sell it, don't use it for advertising, and don't use it to train artificial intelligence.</li>
      <li><b>Confidentiality.</b> We treat your data as confidential client information. You remain responsible for your duties under the Texas Disciplinary Rules of Professional Conduct, including deciding whether a cloud service is appropriate for each matter and getting any client consent you need.</li>
      <li><b>Security.</b> Data is sent over encrypted connections. Email passwords, saved court-portal passwords and Microsoft keys you give us are stored encrypted. Sign-ins require two-factor codes. Sign-ins and important account events are recorded in an activity log.</li>
      <li><b>Where it lives.</b> The app and its database are hosted in the United States by our hosting provider (Render).</li>
      <li><b>Export and deletion.</b> Your firm's admin can export your cases, contacts, calendar, tasks, time, invoices and trust records while your account is active (Firm settings → Export). If your plan ends or you close your account, ask us and we'll send you an export. On request we'll delete your firm's data, except what we must keep by law.</li>
      <li><b>Legal requests.</b> If we're legally required to disclose your data (for example, by subpoena), we'll tell you first when the law allows, so you can object.</li>
    </ul>`],
  ["When TX Case Desk can see your account (developer access)", `
    <p>To fix problems, answer your questions, set up your email and keep the service secure, the TX Case Desk developer can open a <b>developer view</b> of an account, seeing what that person sees.</p>
    <ul>
      <li>It is used only for support, troubleshooting, security, or when the law requires it.</li>
      <li>It is protected by a separate developer PIN that only the developer holds, and it ends after one hour.</li>
      <li>It is read-only, with one exception: the developer can set up your email connection for you (connect or disconnect a mailbox or the firm's court inbox, and connect the firm's Microsoft or Google mail). The developer can't change who handles your court inbox or your firm's Microsoft app keys. The developer can't send email or change, add or delete anything else as you, can't use the Export feature or download your data in bulk, and opening your emails doesn't mark them read. Like you, the developer can open individual documents and emails while viewing.</li>
      <li>Every developer view and every email-setup change made in it is recorded with the date and time, and we'll give your firm that record on request.</li>
    </ul>
    <p>Anyone who works on TX Case Desk is bound to keep what they see confidential.</p>`],
  ["Connecting your email", `
    <ul>
      <li>When you connect an email account (Outlook / Microsoft 365, Gmail / Google Workspace, or another provider by password), TX Case Desk reads court and clerk emails to add and update your cases.</li>
      <li>If you turn on full mail, you can also read, send, move and delete your email inside the app. We only send email when you press Send.</li>
      <li>A firm can connect one shared court inbox; notices from it go to the attorney on the case or wait for the people the admin picks to assign them.</li>
      <li>You can disconnect at any time; we then stop reading that account. Court notices already saved to your cases stay with your cases.</li>
    </ul>`],
  ["Other services we use", `
    <p>To run TX Case Desk we rely on: Render (hosting and database), Microsoft, Google and your email provider (email connection), CourtListener by the Free Law Project (public court opinions), Postmark (receiving forwarded court emails), and Stripe (if you take card payments from clients). Each handles only what it needs for its part, under its own terms.</p>
    <p>County and state court websites: if you give TX Case Desk your own court-portal login, it signs in as you only to read your cases. It stops at any human-verification check (such as a CAPTCHA) and never tries to get around one.</p>`],
  ["Trial, plans and payment", `
    <ul>
      <li>New accounts start with a free 14-day trial. After that, a paid plan or a valid code is needed to keep using the app. If you don't continue, ask us for an export of your data.</li>
      <li>Prices and plans are shown before you buy. Fees are not refundable except where the law requires.</li>
      <li>You can cancel at any time; access continues to the end of the paid period.</li>
    </ul>`],
  ["Using TX Case Desk responsibly", `
    <p>Don't use TX Case Desk to break the law or court rules, to get into accounts or data you aren't authorized to see, to overload or attack the service, or to copy or resell it. We may suspend an account that does, after notice when we reasonably can.</p>`],
  ["Changes, availability and beta features", `
    <p>We improve TX Case Desk often, so features can change. We aim to keep it available but can't promise it will never be down or error-free. Features marked "beta" are still being tested. If we change this agreement, we'll show the new version in the app and ask you to accept it before you continue.</p>`],
  ["Warranty disclaimer and limit of liability", `
    <p>TX Case Desk is provided "as is" and "as available", without warranties of any kind, to the fullest extent the law allows. TX Case Desk is not liable for missed deadlines, court dates or filings, for case-law results, or for indirect, special or consequential damages or lost profits. Our total liability for any claim is limited to the fees you paid us in the 12 months before the claim. Nothing in this agreement limits liability that can't be limited by law.</p>`],
  ["Ending the agreement", `
    <p>You can stop using TX Case Desk and close your account at any time. We may end or suspend accounts for non-payment or misuse of the service. The sections on your data, disclaimers and limits of liability continue after the agreement ends.</p>`],
  ["Texas law", `
    <p>This agreement is governed by the laws of the State of Texas. Any dispute will be resolved in the state or federal courts located in Texas.</p>`],
  ["Questions", `
    <p>Questions about this agreement or your data: contact us through the app.</p>`],
];

function page() {
  const toc = SECTIONS.map(([h], i) => `<li><a href="#s${i + 1}">${h}</a></li>`).join("");
  const body = SECTIONS.map(([h, b], i) => `<section id="s${i + 1}"><h2>${i + 1}. ${h}</h2>${b}</section>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>User Agreement · TX Case Desk</title>
<style>
  body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1b2333;background:#f6f7f9;overflow-wrap:break-word}
  main{max-width:760px;margin:0 auto;padding:28px 20px 60px}
  .card{background:#fff;border:1px solid #e3e6ec;border-radius:14px;padding:22px 24px;margin:0 0 16px}
  h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:22px 0 6px}section:first-of-type h2{margin-top:6px}
  .mute{color:#5b6475;font-size:14px}ul{padding-left:20px}li{margin:4px 0}a{color:#1f5fbf}
  ol.toc{padding-left:20px;margin:6px 0 0;font-size:15px}
  @media print{body{background:#fff}.card{border:0;padding:0}.toc,.noprint{display:none}h2{break-after:avoid;page-break-after:avoid}li,p{break-inside:avoid}}
</style></head><body><main>
<div class="card"><h1>TX Case Desk User Agreement</h1><div class="mute">Terms of service and privacy · Last updated ${UPDATED}</div>
<ol class="toc">${toc}</ol>
<p class="noprint mute" style="margin-bottom:0"><a href="/">← Back to TX Case Desk</a> · To keep a copy, use your browser's Print and choose "Save as PDF".</p></div>
<div class="card">${body}</div>
</main></body></html>`;
}

module.exports = { VERSION, UPDATED, page };
