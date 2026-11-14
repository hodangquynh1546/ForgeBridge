// End-to-end: one account for SmartSpec and WorkHub (sign-up/sign-in both ways, password sync, verification, refresh).
// Needs the e2e stack with MAIL_ENABLED=false and AUTH_RATE_LIMIT=1000 on SmartSpec (see README).

const R = "../../SmartSpec/backend/node_modules/";
const { MongoClient } = require(R + "mongodb");
const jwt = require(R + "jsonwebtoken");
const SS = "http://localhost:8000", WH = "http://localhost:8080";
const ok = (c, m) => { if (!c) { console.error("✗ " + m); process.exit(1); } console.log("✓ " + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (base, path, body, headers = {}) => { const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); const t = await r.text(); let d; try { d = JSON.parse(t) } catch { d = t } return { s: r.status, d }; };
const get = async (base, path, tok) => { const r = await fetch(base + path, { headers: { Authorization: "Bearer " + tok } }); return { s: r.status, d: await r.json().catch(() => null) }; };
(async () => {
  const db = (await MongoClient.connect("mongodb://localhost:27017/smartspec_e2e?directConnection=true")).db();
  const id = Math.random().toString(36).slice(2, 8);
  const PW = "correct-horse-battery", PW2 = "another-strong-pass-9";

  // ---------- A. sign up in SmartSpec -> sign in to WorkHub ----------
  const a = `a-${id}@example.com`;
  let r = await post(SS, "/api/auth/register", { email: a, password: PW, confirmPassword: PW });
  ok(r.s === 200 && r.d.data.accessToken && r.d.data.emailVerified === false, "A1 SmartSpec sign-up with only email+password+confirm returns a session (email not verified yet)");
  r = await post(WH, "/api/auth/login", { email: a, password: PW });
  ok(r.s === 200, "A2 the same e-mail/password signs in to WorkHub (account created there automatically)");
  const st = await (await fetch("http://localhost:8090/v1/users/" + (await db.collection("users").findOne({ email: a }))._id, { headers: { "X-Bridge-Key": "dev-only-bridge-secret-change-me" } })).json();
  ok(st.linked === true, "A3 the WorkHub integration was linked automatically (no modal needed)");
  const me = await get(SS, "/api/auth/me", (await post(SS, "/api/auth/login", { email: a, password: PW })).d.data.accessToken);
  ok(me.d.data.email_verified === false && !me.d.data.password, "A4 profile shows email_verified=false and never exposes the password");

  // ---------- B. sign up in WorkHub -> sign in to SmartSpec ----------
  const b = `b-${id}@example.com`;
  r = await post(WH, "/api/auth/register", { email: b, password: PW, fullName: "Binh Tran" });
  ok(r.s === 201, "B1 sign-up in WorkHub");
  r = await post(SS, "/api/auth/login", { email: b, password: PW });
  ok(r.s === 200 && r.d.data.accessToken, "B2 the same account signs in to SmartSpec (created on first sign-in)");
  const bu = await db.collection("users").findOne({ email: b });
  ok(bu && bu.name === "Binh Tran", "B3 name carried over from WorkHub: " + (bu && bu.name));
  r = await post(SS, "/api/auth/login", { email: b.toUpperCase(), password: PW });
  ok(r.s === 200, "B4 e-mail is case-insensitive");

  // ---------- C. password changed in SmartSpec -> works in WorkHub ----------
  const tokenFor = (email, typ, exp) => jwt.sign({ email, typ }, "secret_jwt_email_key", { expiresIn: exp });
  r = await post(SS, "/api/auth/forgot-password", { email: a });
  ok(r.s === 200 && !JSON.stringify(r.d).includes("eyJ"), "C1 forgot-password never returns a token in the response");
  const unknown = await post(SS, "/api/auth/forgot-password", { email: `nobody-${id}@example.com` });
  ok(unknown.s === 200 && unknown.d.message === r.d.message, "C2 same answer for unknown e-mails (no account enumeration)");
  r = await post(SS, "/api/auth/reset-password?token=" + tokenFor(a, "verify", "1h"), { newPassword: PW2, confirmNewPassword: PW2 });
  ok(r.s === 400, "C3 a verification token cannot reset a password (" + r.s + ")");
  r = await post(SS, "/api/auth/reset-password?token=" + tokenFor(a, "reset", "1h"), { newPassword: PW2, confirmNewPassword: PW2 });
  ok(r.s === 200, "C4 password reset in SmartSpec");
  ok((await post(SS, "/api/auth/login", { email: a, password: PW })).s === 401, "C5 old password rejected in SmartSpec");
  ok((await post(WH, "/api/auth/login", { email: a, password: PW2 })).s === 200, "C6 the NEW password signs in to WorkHub (picked up from SmartSpec)");
  ok((await post(WH, "/api/auth/login", { email: a, password: PW })).s === 401, "C7 old password no longer works in WorkHub");

  // C8: and the other way: a password changed in WorkHub is adopted by SmartSpec, the old one stops working
  const wl = (await post(WH, "/api/auth/login", { email: a, password: PW2 })).d;
  const PW3 = "third-strong-password-3";
  const cp = await fetch(WH + "/api/me/password", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + wl.accessToken }, body: JSON.stringify({ currentPassword: PW2, newPassword: PW3 }) });
  ok(cp.status === 200, "C8 password changed in WorkHub (" + cp.status + ")");
  ok((await post(SS, "/api/auth/login", { email: a, password: PW3 })).s === 200, "C9 the new WorkHub password signs in to SmartSpec");
  ok((await post(SS, "/api/auth/login", { email: a, password: PW2 })).s === 401, "C10 the previous password is rejected in SmartSpec (no stale adoption)");
  ok((await post(WH, "/api/auth/login", { email: a, password: PW2 })).s === 401, "C11 and in WorkHub");
  // the verify step below uses the current password
  const PW2_ = PW3;

  // ---------- D. sign-up conflicts across systems ----------
  r = await post(SS, "/api/auth/register", { email: `b-${id}@example.com`, password: PW, confirmPassword: PW });
  ok(r.s === 409 && r.d.code === "EMAIL_TAKEN", "D1 duplicate e-mail refused with a clear code");
  const c = `c-${id}@example.com`;
  await post(WH, "/api/auth/register", { email: c, password: PW, fullName: "Chi" });
  r = await post(SS, "/api/auth/register", { email: c, password: "different-password-1", confirmPassword: "different-password-1" });
  ok(r.s === 409 && r.d.code === "EMAIL_TAKEN_ELSEWHERE", "D2 e-mail that exists in WorkHub with another password is refused: " + r.d.message);
  r = await post(SS, "/api/auth/register", { email: c, password: PW, confirmPassword: PW });
  ok(r.s === 200, "D3 same e-mail and password as WorkHub = same person, account is created");
  const d = `d-${id}@example.com`;
  await post(SS, "/api/auth/register", { email: d, password: PW, confirmPassword: PW });
  r = await post(WH, "/api/auth/register", { email: d, password: "different-password-1", fullName: "D" });
  ok(r.s === 409, "D4 and the other way round: WorkHub sign-up with an e-mail that exists in SmartSpec with another password is refused (" + r.s + ")");

  // ---------- E. validation ----------
  r = await post(SS, "/api/auth/register", { email: `e-${id}@example.com`, password: "short", confirmPassword: "short" });
  ok(r.s === 400 && r.d.code === "WEAK_PASSWORD", "E1 short password refused");
  r = await post(SS, "/api/auth/register", { email: `e-${id}@example.com`, password: PW, confirmPassword: PW + "x" });
  ok(r.s === 400 && r.d.code === "PASSWORD_MISMATCH", "E2 mismatching confirmation refused");
  r = await post(SS, "/api/auth/register", { email: "not-an-email", password: PW, confirmPassword: PW });
  ok(r.s === 400, "E3 invalid e-mail refused");
  r = await post(SS, "/api/auth/login", { email: a, password: "totally-wrong" });
  ok(r.s === 401 && r.d.code === "INVALID_CREDENTIALS", "E4 wrong password = 401 INVALID_CREDENTIALS");
  ok((await post(SS, "/api/auth/login", { email: `ghost-${id}@example.com`, password: PW })).d.message === r.d.message, "E5 unknown e-mail gets the identical message");

  // ---------- F. e-mail verification ----------
  const login = (await post(SS, "/api/auth/login", { email: a, password: PW3 })).d.data;
  r = await post(SS, "/api/auth/verify-email", { token: tokenFor(a, "verify", "24h") });
  ok(r.s === 200, "F1 verification link accepted");
  ok((await get(SS, "/api/auth/me", login.accessToken)).d.data.email_verified === true, "F2 profile now says verified");
  r = await post(SS, "/api/auth/verify-email", { token: tokenFor(a, "reset", "1h") });
  ok(r.s === 400, "F3 a reset token cannot verify an e-mail");
  r = await fetch(SS + "/api/auth/resend-verification", { method: "POST", headers: { Authorization: "Bearer " + login.accessToken } });
  ok(r.status === 200, "F4 resend-verification works for a signed-in user");

  // ---------- G. refresh keeps the role; reset signs out everywhere ----------
  const adminEmail = `admin-${id}@example.com`;
  await post(SS, "/api/auth/register", { email: adminEmail, password: PW, confirmPassword: PW });
  await db.collection("users").updateOne({ email: adminEmail }, { $set: { system_role: "ADMIN" } });
  const adm = (await post(SS, "/api/auth/login", { email: adminEmail, password: PW })).d.data;
  ok(JSON.parse(Buffer.from(adm.accessToken.split(".")[1], "base64").toString()).system_role === "ADMIN", "G1 admin token carries ADMIN");
  r = await post(SS, "/api/auth/token", { refreshToken: adm.refreshToken });
  ok(r.s === 200 && r.d.accessToken && r.d.access_token === r.d.accessToken, "G2 refresh answers with usable tokens (camelCase + snake_case)");
  ok(JSON.parse(Buffer.from(r.d.accessToken.split(".")[1], "base64").toString()).system_role === "ADMIN", "G3 refreshed token still carries ADMIN (used to be lost)");
  await post(SS, "/api/auth/reset-password?token=" + tokenFor(adminEmail, "reset", "1h"), { newPassword: PW2, confirmNewPassword: PW2 });
  r = await post(SS, "/api/auth/token", { refreshToken: r.d.refreshToken });
  ok(r.s === 401, "G4 after a password reset old sessions can no longer refresh (" + r.s + ")");
  console.log("\nAll good.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
