import "server-only";
import { APP_NAME } from "./app-name";

// Transactional email through Resend's HTTP API. Without RESEND_API_KEY the message is printed to the server log
// instead, so sign up and password reset work locally without an email account.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM ?? `${APP_NAME} <onboarding@resend.dev>`;

type Email = { to: string; subject: string; text: string; html: string };

export async function sendEmail(email: Email) {
  if (!RESEND_API_KEY) {
    console.info(`[email] to ${email.to}: ${email.subject}\n${email.text}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}

/** Logs instead of throwing: a failed send must not fail the sign up, the user can ask for a new link. */
export async function trySendEmail(email: Email) {
  try {
    await sendEmail(email);
  } catch (e) {
    console.error(`[email] sending "${email.subject}" failed`, e);
  }
}

// Only fixed text and our own links go into the messages: user-chosen fields such as the name are left out, so an
// attacker cannot use sign up to send arbitrary text from our domain.
function linkEmail(to: string, subject: string, intro: string, action: string, url: string, outro: string): Email {
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917;max-width:480px">
<p>${intro}</p>
<p><a href="${url}" style="display:inline-block;background:#0a7d5a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">${action}</a></p>
<p style="color:#78716c;font-size:13px">${outro}<br>If the button does not work, open this link:<br><a href="${url}" style="color:#78716c;word-break:break-all">${url}</a></p>
</div>`;
  return { to, subject, html, text: `${intro}\n\n${action}: ${url}\n\n${outro}` };
}

export const verificationEmail = (to: string, url: string) =>
  linkEmail(
    to,
    `Confirm your email for ${APP_NAME}`,
    `Confirm your email address to activate your ${APP_NAME} account.`,
    "Confirm email",
    url,
    "The link expires in 24 hours. If you did not create an account, ignore this email.",
  );

export const resetPasswordEmail = (to: string, url: string) =>
  linkEmail(
    to,
    `Reset your ${APP_NAME} password`,
    `Someone asked to reset the password of your ${APP_NAME} account.`,
    "Choose a new password",
    url,
    "The link expires in 1 hour and works once. If you did not ask for it, ignore this email: your password stays the same.",
  );
