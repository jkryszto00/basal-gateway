// Browser smoke test of sign up, email confirmation, password reset and the dashboard against a running app.
// Start the app without RESEND_API_KEY, so emails are printed to its log, and point WEB_LOG at that log:
//   RESEND_API_KEY= bun run start > /tmp/web.log 2>&1 &
//   WEB_LOG=/tmp/web.log [GATEWAY_URL=http://localhost:8787] bun run e2e
// Uses the locally installed Chrome (no browser download). The test account is deleted at the end.
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.env.WEB_URL ?? "http://localhost:3000";
const KEY_PREFIX = process.env.API_KEY_PREFIX ?? "bg_live_";
const log = process.env.WEB_LOG;
if (!log) throw new Error("set WEB_LOG to the app's log file (emails are printed there)");
const browser = await chromium.launch({ channel: "chrome", headless: true });
// a fresh client IP per run (the app reads x-forwarded-for unless CLIENT_IP_HEADER says otherwise), so repeated runs
// do not hit the per-IP sign up limit
const page = await browser.newPage({ extraHTTPHeaders: { "x-forwarded-for": `10.${Date.now() % 250}.${Math.floor(Math.random() * 250)}.1` } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const step = (s) => console.log("✓", s);

/** Waits for the next email to `to` in the app log and returns the first link in it. */
async function emailLink(to, after) {
  for (let i = 0; i < 50; i++) {
    const mails = readFileSync(log, "utf8").slice(after).split("[email] to ").slice(1);
    const mail = mails.findLast((m) => m.startsWith(`${to}:`));
    if (mail) return mail.match(/https?:\/\/\S+/)[0];
    await page.waitForTimeout(200);
  }
  throw new Error(`no email to ${to}`);
}
/** With Turnstile configured (Cloudflare's always-pass test keys locally), waits for the widget's token. */
async function turnstileDone() {
  if (!(await page.locator("[data-turnstile]").count())) return;
  await page.waitForFunction(() => document.querySelector('input[name="cf-turnstile-response"]')?.value);
}
async function signOut() {
  await page.click('button[aria-haspopup="menu"]');
  await page.getByRole("menuitem", { name: "Sign out" }).click();
}
const logSize = () => readFileSync(log, "utf8").length;
// the first form with fields: GitHub / Google buttons are submit buttons of field-less forms
const submit = () => page.locator('form:has(input:not([type="hidden"])) button[type="submit"]').first().click();
// inside main: Next's route announcer is a role="alert" element too
const status = () => page.locator('main [role="status"]').textContent();
const alert = () => page.locator('main [role="alert"]').textContent();

const email = `e2e-${Date.now()}@example.com`;
await page.goto(`${base}/signup`);
await page.fill('input[name="name"]', "E2E");
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', "short");
await submit();
// browser validation blocks a too-short password (minLength), so the page stays
if (!page.url().endsWith("/signup")) throw new Error("short password accepted");
await page.fill('input[name="password"]', "password1234"); // in haveibeenpwned.com
await turnstileDone();
await submit();
if (!(await alert()).includes("data breach")) throw new Error("breached password accepted");
step("breached password refused at sign up");
await page.fill('input[name="password"]', "correct-horse-battery");
await turnstileDone();
let mark = logSize();
await submit();
await page.getByText("Check your inbox").waitFor();
const verifyLink = await emailLink(email, mark);
step("signup -> check your inbox, confirmation email sent");

await page.goto(`${base}/login`);
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', "correct-horse-battery");
mark = logSize();
await submit();
if (!(await alert()).includes("Confirm your email first")) throw new Error("unconfirmed account signed in");
await emailLink(email, mark);
step("unconfirmed sign in refused, new link sent");

await page.goto(`${base}/signup`);
await page.fill('input[name="name"]', "Someone else");
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', "another-password-123");
await turnstileDone();
await submit();
await page.getByText("Check your inbox").waitFor();
step("signup with a taken email looks the same");

await page.goto(verifyLink);
await page.waitForURL(`${base}/dashboard?welcome=1`);
if (!(await status()).includes("Your account is ready")) throw new Error("no welcome banner");
step("confirmation link -> signed in");

await page.click("text=API keys");
await page.waitForURL(`${base}/dashboard/keys`);
await page.fill('input[name="name"]', "to-revoke");
await page.click("text=Create key");
await page.locator("code", { hasText: KEY_PREFIX }).waitFor();
await page.fill('input[name="name"]', "e2e");
await page.click("text=Create key");
await page.locator("strong", { hasText: "e2e" }).waitFor();
const key = (await page.locator("code", { hasText: KEY_PREFIX }).textContent()).trim();
step(`created keys, shown once: ${key.slice(0, 14)}…`);
const rows = page.locator("tbody tr");
if ((await rows.count()) !== 2) throw new Error(`expected 2 rows, got ${await rows.count()}`);

await rows.filter({ hasText: "to-revoke" }).getByRole("button", { name: "Revoke" }).click();
await rows.filter({ hasText: "to-revoke" }).waitFor({ state: "detached" });
if ((await rows.count()) !== 1) throw new Error("revoke did not remove the row");
step("revoked one key");

await page.reload();
if (await page.locator("code", { hasText: KEY_PREFIX }).count()) throw new Error("full key visible after reload");
step("full key not shown after reload");

await signOut();
await page.waitForURL(`${base}/login`); // / redirects to the dashboard, which sends signed-out visitors here
await page.goto(`${base}/dashboard`);
if (!page.url().endsWith("/login")) throw new Error("dashboard reachable after sign out");
step("sign out");

await page.click("text=Forgot password?");
await page.waitForURL(`${base}/forgot-password`);
await page.fill('input[name="email"]', `nobody-${Date.now()}@example.com`);
await submit();
const unknown = await status();
await page.fill('input[name="email"]', email);
mark = logSize();
await submit();
await page.locator('main [role="status"]', { hasText: email }).waitFor();
if (!unknown.startsWith("If an account exists")) throw new Error(`reset for an unknown email: ${unknown}`);
const resetLink = await emailLink(email, mark);
step("reset request answers the same for unknown and known emails");

await page.goto(resetLink);
await page.waitForURL(/\/reset-password\?token=/);
await page.fill('input[name="password"]', "password1234");
await page.fill('input[name="confirm"]', "password1234");
await submit();
if (!(await alert()).includes("data breach")) throw new Error("breached password accepted on reset");
await page.fill('input[name="password"]', "new-horse-battery-staple");
await page.fill('input[name="confirm"]', "something-else-entirely");
await submit();
await page.locator('main [role="alert"]', { hasText: "do not match" }).waitFor(); // replaces the breach message
await page.fill('input[name="password"]', "new-horse-battery-staple"); // passwords are cleared after an error
await page.fill('input[name="confirm"]', "new-horse-battery-staple");
await submit();
await page.waitForURL(`${base}/login?reset=1`);
step("password reset (a breached password refused without using up the link)");

await page.goto(resetLink);
await page.waitForURL(/\/reset-password\?error=/);
step("reset link works once");

await page.goto(`${base}/login`);
await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', "correct-horse-battery");
await submit();
if (!(await alert()).includes("Wrong email or password")) throw new Error("old password still works");
if ((await page.inputValue('input[name="email"]')) !== email) throw new Error("email not kept after an error");
await page.fill('input[name="password"]', "new-horse-battery-staple");
await Promise.all([page.waitForURL(`${base}/dashboard`), submit()]);
step("old password refused, new password signs in");

await page.goto(`${base}/dashboard/settings`);
await page.fill('input[name="current"]', "not-my-password");
await page.fill('input[name="password"]', "third-horse-battery");
await page.fill('input[name="confirm"]', "third-horse-battery");
await submit();
if (!(await alert()).includes("current password is wrong")) throw new Error("password changed with a wrong current one");
await page.fill('input[name="current"]', "new-horse-battery-staple");
await page.fill('input[name="password"]', "third-horse-battery");
await page.fill('input[name="confirm"]', "third-horse-battery");
await submit();
await page.locator('main [role="status"]', { hasText: "Password changed" }).waitFor();
await page.reload(); // still signed in on this device
if (!page.url().endsWith("/dashboard/settings")) throw new Error("signed out after changing the password");
step("password changed in settings (wrong current password refused)");

const del = page.locator("form", { hasText: "Delete account" });
await del.locator('input[name="confirm"]').fill("someone@else.com");
await del.locator('input[name="password"]').fill("third-horse-battery");
await del.locator('button[type="submit"]').click();
if (!(await del.locator('[role="alert"]').textContent()).includes("Type your email")) throw new Error("deleted without confirmation");
await del.locator('input[name="confirm"]').fill(email);
await del.locator('input[name="password"]').fill("wrong-password-123");
await del.locator('button[type="submit"]').click();
await del.locator('[role="alert"]', { hasText: "Wrong password" }).waitFor();
await del.locator('input[name="confirm"]').fill(email);
await del.locator('input[name="password"]').fill("third-horse-battery");
await Promise.all([page.waitForURL(`${base}/login?deleted=1`), del.locator('button[type="submit"]').click()]);
step("account deleted (confirmation and password checked)");

if (process.env.GATEWAY_URL) {
  const res = await fetch(`${process.env.GATEWAY_URL}/v1/systemone`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: "{}",
  });
  if (res.status !== 401) throw new Error(`API key of a deleted account: ${res.status}`);
  step("API key of the deleted account refused by the gateway");
}

await page.fill('input[name="email"]', email);
await page.fill('input[name="password"]', "third-horse-battery");
await submit();
if (!(await alert()).includes("Wrong email or password")) throw new Error("deleted account signed in");
const victim = `victim-${Date.now()}@example.com`;
let limited = "";
for (let i = 0; i < 11 && !limited.startsWith("Too many"); i++) {
  await page.goto(`${base}/login`);
  await page.fill('input[name="email"]', victim);
  await page.fill('input[name="password"]', `guess-${i}`);
  await submit();
  limited = await alert();
}
if (!limited.startsWith("Too many attempts")) throw new Error(`no sign in limit: ${limited}`);
step(`sign in limited per email: "${limited}"`);

// GitHub / Google, when configured: the redirect to the provider (stubbed) and a forged callback
for (const [name, host, id] of [["GitHub", "github.com", "github"], ["Google", "accounts.google.com", "google"]]) {
  await page.goto(`${base}/login`);
  if (!(await page.getByText(`Continue with ${name}`).count())) continue;
  let target;
  await page.route(`https://${host}/**`, (r) => {
    target = new URL(r.request().url());
    return r.fulfill({ body: "provider" });
  });
  await page.click(`text=Continue with ${name}`);
  await page.waitForFunction(() => document.body.innerText === "provider");
  if (target.searchParams.get("redirect_uri") !== `${base}/api/auth/callback/${id}` || !target.searchParams.get("state"))
    throw new Error(`${name} redirect: ${target}`);
  await page.goto(`${base}/api/auth/callback/${id}?code=forged&state=forged`);
  await page.waitForURL(`${base}/login?error=state_mismatch`);
  step(`${name}: redirect to the provider, forged callback refused`);
}

if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
await browser.close();
