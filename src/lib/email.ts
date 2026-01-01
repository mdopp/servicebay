import nodemailer from 'nodemailer';
import { getConfig } from './config';

export async function sendEmailAlert(subject: string, message: string) {
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

    await transporter.sendMail({
      from: emailConfig.from,
      to: emailConfig.to.join(', '), // Join with comma for better compatibility
      subject: `[ServiceBay Alert] ${subject}`,
      text: message,
      html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
        <h2 style="color: #e53e3e;">${subject}</h2>
        <p style="font-size: 16px; line-height: 1.5;">${message.replace(/\n/g, '<br>')}</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #718096; font-size: 12px;">Sent by ServiceBay Monitoring</p>
      </div>`
    });

    console.log(`[Email] Sent alert to ${emailConfig.to}`);
  } catch (error) {
    console.error('[Email] Failed to send alert:', error);
  }
}
