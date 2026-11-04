import { Injectable, Logger, BadRequestException } from '@nestjs/common';
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
      throw new BadRequestException(`Failed to deliver email to ${to}: ${error.message || 'SMTP error'}`);
    }
  }

  async sendCustomerWelcomeEmail(to: string, custNo: string, recipientName?: string): Promise<boolean> {
    if (!this.transporter) {
      this.initTransporter();
    }

    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@justmobile.com.au';
    const sender = `"JustMobile Welcome" <${fromEmail}>`;
    const nameGreeting = recipientName ? `G'day ${recipientName},` : "G'day,";

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Welcome to JustMobile – Your Customer Number</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f7fa; margin: 0; padding: 24px; color: #142420; }
    .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 18px; overflow: hidden; border: 1px solid #e1e7de; box-shadow: 0 4px 20px rgba(20,36,32,0.06); }
    .header { background-color: #142420; padding: 32px; text-align: left; }
    .logo-text { color: #ffffff; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
    .logo-accent { color: #D5F879; }
    .content { padding: 36px 32px; }
    h1 { font-size: 22px; font-weight: 800; margin-top: 0; margin-bottom: 14px; color: #142420; letter-spacing: -0.3px; }
    p { font-size: 15px; line-height: 1.55; color: #495746; margin: 0 0 18px 0; }
    .cust-card { background: #f7faf3; border: 2px solid #789937; border-radius: 14px; padding: 24px; text-align: center; margin: 26px 0; }
    .cust-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: #547523; margin-bottom: 8px; }
    .cust-no { font-family: 'Courier New', Courier, monospace; font-size: 32px; font-weight: 800; letter-spacing: 4px; color: #142420; }
    .cust-sub { font-size: 13px; color: #6b7c68; margin-top: 8px; }
    .next-steps { background: #fafbf9; border-radius: 12px; padding: 18px 20px; border: 1px solid #e8ede5; margin-bottom: 24px; }
    .next-steps h2 { font-size: 14px; font-weight: 700; color: #142420; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.5px; }
    .next-steps ul { margin: 0; padding-left: 20px; color: #4f5f4d; font-size: 14px; line-height: 1.6; }
    .btn-wrap { text-align: center; margin: 28px 0 10px; }
    .btn { display: inline-block; background-color: #142420; color: #D5F879; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 700; font-size: 15px; }
    .footer { padding: 22px 32px; background: #f9fbf8; border-top: 1px solid #edf2ea; font-size: 12px; color: #82927f; text-align: center; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-text">justmobile<span class="logo-accent">.</span></div>
    </div>
    <div class="content">
      <h1>${nameGreeting}</h1>
      <p>Welcome to <strong>JustMobile</strong>! Your account and telco carrier profile have been created successfully.</p>
      
      <div class="cust-card">
        <div class="cust-label">Your JustMobile Customer Number</div>
        <div class="cust-no">${custNo}</div>
        <div class="cust-sub">Keep this reference handy whenever managing services or contacting support.</div>
      </div>

      <div class="next-steps">
        <h2>What's next?</h2>
        <ul>
          <li><strong>Sign in anytime:</strong> Use your email and password to access your JustMobile web portal.</li>
          <li><strong>Activate eSIM / Plan:</strong> Choose your preferred data plan and download your digital eSIM profile in minutes.</li>
          <li><strong>Need assistance?</strong> Bele, our digital assistant, is ready to help you 24/7.</li>
        </ul>
      </div>

      <div class="btn-wrap">
        <a href="http://localhost:3000/account" class="btn">Go to My Account &rarr;</a>
      </div>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} JustMobile Australia · Less telco. More you.<br/>
      Standard terms, Fair Use Policy, and Critical Information Summaries apply.
    </div>
  </div>
</body>
</html>
    `;

    try {
      const info = await this.transporter!.sendMail({
        from: sender,
        to,
        subject: `Welcome to JustMobile – Your Customer Number is ${custNo}`,
        text: `Welcome to JustMobile! Your customer number is ${custNo}. You can sign in using your registered email and password.`,
        html,
      });

      this.logger.log(`✓ Customer welcome email sent to ${to} (Customer #${custNo}): messageId ${info.messageId}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to send customer welcome email to ${to}:`, error.message);
      return false;
    }
  }
}
