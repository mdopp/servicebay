import nodemailer from 'nodemailer';
import { getConfig } from './config';

/**
 * Operator-facing alert email. Always goes to the operator addresses
 * configured under `notifications.email.to` and is decorated with the
 * `[ServiceBay Alert]` subject prefix so the operator's inbox rules
 * can route them.
 */
export async function sendEmailAlert(subject: string, message: string) {
  await sendMailInternal({
    subject: `[ServiceBay Alert] ${subject}`,
    message,
    headingColor: '#e53e3e',
  });
}

/**
 * Transactional email to a specific recipient — used for confirmations
 * the operator's family members receive (e.g. access-request approval,
 * welcome emails). Unlike `sendEmailAlert` this does not prefix the
 * subject and uses a friendlier heading color, because the recipient
 * is a non-technical user, not the operator triaging system alerts.
 */
export async function sendTransactionalEmail(to: string, subject: string, message: string) {
  await sendMailInternal({
    overrideTo: to,
    subject,
    message,
    headingColor: '#3182ce',
  });
}

/**
 * Operator-triggered "Send test mail" from Settings → Notifications.
 * Unlike `sendEmailAlert` / `sendTransactionalEmail` this **throws** on
 * failure instead of swallowing into a console log — the caller is a
 * UI button that wants to surface auth/connection errors to the
 * operator immediately, so a silent fallback would defeat the entire
 * purpose ("did my SMTP config work?"). Also bypasses the
 * `email.enabled` gate so the operator can test before flipping the
 * master toggle on.
 */
export async function sendTestEmail(to: string): Promise<void> {
  const config = await getConfig();
  const emailConfig = config.notifications?.email;
  if (!emailConfig) {
    throw new Error('No SMTP settings stored yet — fill in host/port/user/pass first.');
  }
  if (!emailConfig.host || !emailConfig.user || !emailConfig.pass || !emailConfig.from) {
    throw new Error('SMTP settings incomplete — host, user, pass, and from are all required.');
  }
  const transporter = nodemailer.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: emailConfig.secure,
    auth: { user: emailConfig.user, pass: emailConfig.pass },
  });
  await transporter.sendMail({
    from: emailConfig.from,
    to,
    subject: '[ServiceBay] Test email',
    text: 'This is a test email from your ServiceBay instance — if you see this, your SMTP settings are working.',
    html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
      <h2 style="color: #3182ce;">ServiceBay test email</h2>
      <p style="font-size: 16px; line-height: 1.5;">If you can read this, your SMTP settings (<code>${emailConfig.host}:${emailConfig.port}</code>) are working. Alerts and transactional emails will go out the same way.</p>
      <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="color: #718096; font-size: 12px;">Triggered manually from Settings → Notifications → Email</p>
    </div>`,
  });
}

async function sendMailInternal(opts: {
  overrideTo?: string;
  subject: string;
  message: string;
  headingColor: string;
}) {
  const config = await getConfig();
  const emailConfig = config.notifications?.email;

  if (!emailConfig || !emailConfig.enabled) {
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: emailConfig.secure,
      auth: {
        user: emailConfig.user,
        pass: emailConfig.pass,
      },
    });

    const recipient = opts.overrideTo ?? emailConfig.to.join(', ');
    await transporter.sendMail({
      from: emailConfig.from,
      to: recipient,
      subject: opts.subject,
      text: opts.message,
      html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
        <h2 style="color: ${opts.headingColor};">${opts.subject}</h2>
        <p style="font-size: 16px; line-height: 1.5;">${opts.message.replace(/\n/g, '<br>')}</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #718096; font-size: 12px;">Sent by ServiceBay</p>
      </div>`
    });

    console.log(`[Email] Sent to ${recipient}`);
  } catch (error) {
    console.error('[Email] Failed to send:', error);
  }
}
