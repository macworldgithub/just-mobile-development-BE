import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    this.initTransporter();
  }

  private initTransporter() {
    const host = process.env.SMTP_HOST || 'smtp.hostinger.com';
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!user || !pass) {
      this.logger.warn('SMTP credentials are not fully configured in .env');
      return;
    }

    try {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
          user,
          pass,
        },
      });

      this.logger.log(`✓ MailService initialized with host ${host}:${port} (${user})`);
    } catch (err: any) {
      this.logger.error('Failed to create nodemailer transporter:', err.message);
    }
  }

  async sendVerificationCode(to: string, code: string, recipientName?: string): Promise<boolean> {
    if (!this.transporter) {
      this.initTransporter();
    }

    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@justmobile.com.au';
    const sender = `"JustMobile Security" <${fromEmail}>`;
    const nameGreeting = recipientName ? `Hi ${recipientName},` : 'Hello,';

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Your JustMobile Verification Code</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f7fa; margin: 0; padding: 24px; color: #142420; }
    .container { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e1e7de; box-shadow: 0 4px 20px rgba(20,36,32,0.06); }
    .header { background-color: #142420; padding: 28px 32px; text-align: left; }
    .logo-text { color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
    .logo-accent { color: #D5F879; }
    .content { padding: 36px 32px; }
    h1 { font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 12px; color: #142420; }
    p { font-size: 15px; line-height: 1.5; color: #495746; margin: 0 0 20px 0; }
    .code-box { background-color: #f7faf3; border: 2px dashed #789937; border-radius: 12px; padding: 20px; text-align: center; margin: 28px 0; }
    .code { font-family: 'Courier New', Courier, monospace; font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #142420; display: inline-block; }
    .expiry { font-size: 13px; color: #789937; font-weight: 600; margin-top: 6px; }
    .security-note { background: #fafafa; border-radius: 8px; padding: 14px 18px; border-left: 4px solid #142420; font-size: 13px; color: #556253; line-height: 1.45; }
    .footer { padding: 20px 32px; background: #f9fbf8; border-top: 1px solid #edf2ea; font-size: 12px; color: #82927f; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-text">justmobile<span class="logo-accent">.</span></div>
    </div>
    <div class="content">
      <h1>${nameGreeting}</h1>
      <p>Use the following 6-digit verification code to complete your security verification with JustMobile:</p>
      
      <div class="code-box">
        <div class="code">${code}</div>
        <div class="expiry">Valid for 10 minutes</div>
      </div>

      <div class="security-note">
        <strong>Security Notice:</strong> Never share this code with anyone. JustMobile representatives will never ask for your verification code. If you did not request this, please ignore this email.
      </div>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} JustMobile Australia · Less telco. More you.
    </div>
  </div>
</body>
</html>
    `;

    try {
      const info = await this.transporter!.sendMail({
        from: sender,
        to,
        subject: `Your JustMobile Verification Code: ${code}`,
        text: `Your JustMobile verification code is: ${code}. It expires in 10 minutes. Do not share this code.`,
        html,
      });

      this.logger.log(`✓ Verification code email sent to ${to}: messageId ${info.messageId}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to send verification email to ${to}:`, error.message);
      throw error;
    }
  }
}
