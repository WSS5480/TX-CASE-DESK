// Who can see which cases.
// Admins and managers see the whole firm. Everyone else sees their own cases plus cases they
// were added to (case team). The firm admin can widen one person's access to the cases of the
// attorneys they work with ("team") or to the whole firm ("firm"), and can grant trust access.
const seesFirm = u => !!u && (u.role === "admin" || u.role === "manager" || u.access === "firm");
const trustOk = u => !!u && (u.role === "admin" || !!u.trust_access);

// SQL condition limiting cases (table alias `alias`) to what user u may see.
// Pushes its values onto `params` and returns the condition text.
function caseCond(u, alias, params) {
  if (seesFirm(u)) return "TRUE";
  params.push(u.id); const me = "$" + params.length;
  let c = `(${alias}.user_id=${me} OR ${alias}.id IN (SELECT case_id FROM case_team WHERE user_id=${me})`;
  const ww = (u.works_with || []).map(Number).filter(Boolean);
  if (u.access === "team" && ww.length) { params.push(ww); c += ` OR ${alias}.user_id = ANY($${params.length}::int[])`; }
  return c + ")";
}

module.exports = { seesFirm, trustOk, caseCond };
