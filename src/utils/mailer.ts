import sgMail from "@sendgrid/mail";
import nodemailer from "nodemailer";

const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = process.env.SENDGRID_FROM || process.env.NO_REPLY_EMAIL || process.env.SMTP_USER;

if (SENDGRID_KEY) {
  sgMail.setApiKey(SENDGRID_KEY);
}

/**
 * mailOptions shape matches nodemailer/sendgrid: { from, to, subject, text, html }
 */
export async function sendMail(mailOptions: { from?: string; to: string; subject: string; text?: string; html?: string }) {
  // prefer SendGrid (HTTP) when configured
  if (SENDGRID_KEY) {
    try {
      const msg: any = {
        to: mailOptions.to,
        from: mailOptions.from || SENDGRID_FROM,
        subject: mailOptions.subject,
      };
      if (mailOptions.text) msg.text = mailOptions.text;
      if (mailOptions.html) msg.html = mailOptions.html;
      await sgMail.send(msg);
      return;
    } catch (err) {
      console.error("SendGrid send error:", err);
      // fallthrough to try nodemailer if available
    }
  }

  // fallback to global nodemailer transporter if initialized in server.ts
  const transporter = (global as any).transporter as nodemailer.Transporter | null;
  if (transporter) {
    try {
      await transporter.sendMail({
        from: mailOptions.from || SENDGRID_FROM || "no-reply@example.com",
        to: mailOptions.to,
        subject: mailOptions.subject,
        text: mailOptions.text,
        html: mailOptions.html,
      });
      return;
    } catch (err) {
      console.error("Nodemailer send error:", err);
      return;
    }
  }

  // nothing available — log and continue
  console.log("No mailer configured; skipping email. Mail options:", mailOptions);
  return;
}