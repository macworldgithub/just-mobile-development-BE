import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import * as QRCode from 'qrcode';

export interface EsimWelcomeEmailInput {
  to: string;
  recipientName?: string;
  custNo: string;
  orderId: string;
  msn: string;
  planName: string;
  pricePerMonth: number;
  lpaString: string;
  smdpAddress?: string;
  activationCode?: string;
  isEsim?: boolean;
}

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

  async sendPasswordResetEmail(to: string, code: string, recipientName?: string): Promise<boolean> {
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
  <title>Reset Your JustMobile Password</title>
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
      <p>We received a request to reset the password for your JustMobile account. Use the following 6-digit verification code to select a new password:</p>
      
      <div class="code-box">
        <div class="code">${code}</div>
        <div class="expiry">Valid for 10 minutes</div>
      </div>

      <div class="security-note">
        <strong>Security Notice:</strong> If you did not request a password reset, you can safely ignore this email. Your current password will remain unchanged.
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
      if (this.transporter) {
        const info = await this.transporter.sendMail({
          from: sender,
          to,
          subject: `Reset Your JustMobile Password – Code: ${code}`,
          text: `Your JustMobile password reset code is: ${code}. It expires in 10 minutes. If you did not request this, please ignore this email.`,
          html,
        });
        this.logger.log(`✓ Password reset email sent to ${to}: messageId ${info.messageId}`);
      } else {
        this.logger.warn(`Transporter not initialized; password reset code for ${to} is ${code}`);
      }
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to send password reset email to ${to}:`, error.message);
      // Still return true so user enumeration is mitigated if SMTP temporary failure
      return false;
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

  /**
   * Send Automated eSIM Welcome Email with Scannable QR Code & LPA String (INT-07)
   */
  async sendEsimWelcomeEmail(input: EsimWelcomeEmailInput): Promise<boolean> {
    if (!this.transporter) {
      this.initTransporter();
    }

    const {
      to,
      recipientName,
      custNo,
      orderId,
      msn,
      planName,
      pricePerMonth,
      lpaString,
      isEsim = true,
    } = input;

    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@justmobile.com.au';
    const sender = `"JustMobile Provisioning" <${fromEmail}>`;
    const nameGreeting = recipientName ? `G'day ${recipientName},` : "G'day,";
    const smdpAddress = input.smdpAddress || 'smdp.telcoinabox.com.au';
    const activationCode = input.activationCode || `JM-AU-${orderId.replace(/[^a-zA-Z0-9]/g, '')}`;

    const cleanMsn = msn.replace(/\s+/g, '');
    const formattedMsn = cleanMsn.length === 10
      ? `${cleanMsn.slice(0, 4)} ${cleanMsn.slice(4, 7)} ${cleanMsn.slice(7)}`
      : msn;

    // IF Physical SIM: Dispatch physical delivery confirmation (no QR code)
    if (!isEsim) {
      const physicalHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Your JustMobile SIM is on its way</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f7fa; margin: 0; padding: 24px; color: #142420; }
    .container { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 18px; overflow: hidden; border: 1px solid #e1e7de; box-shadow: 0 4px 20px rgba(20,36,32,0.06); }
    .header { background-color: #142420; padding: 32px; text-align: left; }
    .logo-text { color: #ffffff; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
    .logo-accent { color: #D5F879; }
    .content { padding: 36px 32px; }
    h1 { font-size: 22px; font-weight: 800; margin-top: 0; margin-bottom: 12px; color: #142420; }
    p { font-size: 15px; line-height: 1.55; color: #495746; margin: 0 0 16px 0; }
    .badge-card { background: #f7faf3; border: 2px solid #789937; border-radius: 14px; padding: 20px; margin: 24px 0; }
    .detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #d8e5d3; font-size: 14px; }
    .detail-row:last-child { border-bottom: none; }
    .btn-wrap { text-align: center; margin: 28px 0 10px; }
    .btn { display: inline-block; background-color: #142420; color: #D5F879; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 700; font-size: 15px; }
    .footer { padding: 22px 32px; background: #f9fbf8; border-top: 1px solid #edf2ea; font-size: 12px; color: #82927f; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-text">justmobile<span class="logo-accent">.</span></div>
    </div>
    <div class="content">
      <h1>${nameGreeting}</h1>
      <p>Thank you for choosing JustMobile. Your physical triple-cut SIM card order is confirmed and currently being prepared for dispatch.</p>
      
      <div class="badge-card">
        <div class="detail-row"><span>Mobile Number:</span><strong>${formattedMsn}</strong></div>
        <div class="detail-row"><span>Mobile Plan:</span><strong>${planName} ($${pricePerMonth.toFixed(2)}/mth)</strong></div>
        <div class="detail-row"><span>Customer ID:</span><strong>${custNo}</strong></div>
        <div class="detail-row"><span>Delivery:</span><strong>Australia Post Express (1–3 business days)</strong></div>
      </div>

      <p>Once your SIM arrives in the mail, simply pop it into your handset and you'll be connected to Telstra Wholesale 5G.</p>

      <div class="btn-wrap">
        <a href="http://localhost:3000/account" class="btn">View Customer Portal &rarr;</a>
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
        if (this.transporter) {
          await this.transporter.sendMail({
            from: sender,
            to,
            subject: `Your JustMobile Physical SIM is on its way (Order #${orderId})`,
            html: physicalHtml,
          });
          this.logger.log(`✓ Physical SIM dispatch email sent to ${to} for ${formattedMsn}`);
        }
        return true;
      } catch (err: any) {
        this.logger.error(`Failed to send physical SIM email to ${to}:`, err.message);
        return false;
      }
    }

    // Generate high-resolution scannable QR Code PNG Buffer for attachment & inline CID
    let qrBuffer: Buffer;
    try {
      qrBuffer = await QRCode.toBuffer(lpaString, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 340,
        color: {
          dark: '#142420',
          light: '#FFFFFF',
        },
      });
    } catch (err: any) {
      this.logger.error(`QRCode buffer generation failed: ${err.message}`);
      qrBuffer = Buffer.from('');
    }

    const esimHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Your JustMobile eSIM Profile</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f7f2; margin: 0; padding: 24px; color: #142420; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; border: 1.5px solid #dce8d5; box-shadow: 0 8px 30px rgba(20,36,32,0.08); }
    .header { background-color: #142420; padding: 32px 36px; text-align: left; }
    .logo-text { color: #ffffff; font-size: 28px; font-weight: 800; letter-spacing: -0.5px; }
    .logo-accent { color: #D5F879; }
    .header-sub { color: #a4b89f; font-size: 13.5px; margin-top: 4px; }
    .content { padding: 36px; }
    h1 { font-size: 22px; font-weight: 800; margin-top: 0; margin-bottom: 12px; color: #142420; }
    p { font-size: 15px; line-height: 1.55; color: #495746; margin: 0 0 18px 0; }
    
    .plan-summary { background: #fbfdfa; border: 1.5px solid #dce8d5; border-radius: 14px; padding: 18px 22px; margin-bottom: 24px; }
    .summary-grid { width: 100%; border-collapse: collapse; }
    .summary-grid td { padding: 6px 0; font-size: 14px; }
    .summary-grid td.label { color: #687766; width: 45%; }
    .summary-grid td.val { font-weight: 700; color: #142420; text-align: right; }

    .qr-card { background: #ffffff; border: 2px solid #789937; border-radius: 16px; padding: 26px 20px; text-align: center; margin: 28px 0; box-shadow: 0 6px 18px rgba(120,153,55,0.08); }
    .qr-title { font-size: 17px; font-weight: 800; color: #142420; margin-bottom: 6px; }
    .qr-tip { font-size: 13px; color: #556253; margin-bottom: 16px; line-height: 1.45; }
    .qr-img-wrap { display: inline-block; padding: 12px; background: #ffffff; border: 1px solid #dce4d8; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    
    .manual-box { background: #f7faf3; border: 1.5px solid #d8e5d3; border-radius: 12px; padding: 18px 20px; margin: 24px 0; text-align: left; }
    .manual-title { font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px; color: #3b6b14; margin-bottom: 8px; }
    .manual-row { font-size: 13px; margin-bottom: 6px; color: #445441; word-break: break-all; }
    .lpa-code { font-family: monospace; font-size: 12px; background: #ffffff; padding: 8px 12px; border-radius: 6px; border: 1px solid #c9d8c4; display: block; margin-top: 4px; }

    .steps-card { background: #fafbf8; border: 1px solid #e3ebe0; border-radius: 12px; padding: 20px; margin-bottom: 26px; }
    .steps-card h3 { font-size: 15px; font-weight: 700; color: #142420; margin: 0 0 10px 0; }
    .steps-card ol { margin: 0; padding-left: 20px; font-size: 13.5px; line-height: 1.6; color: #4c5a49; }
    .steps-card ol li { margin-bottom: 4px; }

    .btn-wrap { text-align: center; margin: 30px 0 12px; }
    .btn { display: inline-block; background-color: #142420; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 700; font-size: 15px; }
    .footer { padding: 24px 36px; background: #f9fbf8; border-top: 1px solid #edf2ea; font-size: 12px; color: #82927f; text-align: center; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-text">justmobile<span class="logo-accent">.</span></div>
      <div class="header-sub">Telstra Wholesale 5G Mobile Network · Direct Carrier eSIM Provisioning</div>
    </div>
    
    <div class="content">
      <h1>${nameGreeting}</h1>
      <p>Welcome to <strong>JustMobile</strong>! Your digital eSIM profile for mobile line <strong>${formattedMsn}</strong> is ready to install.</p>
      
      <div class="plan-summary">
        <table class="summary-grid">
          <tr>
            <td class="label">Allocated Mobile Number:</td>
            <td class="val">${formattedMsn}</td>
          </tr>
          <tr>
            <td class="label">Mobile Plan:</td>
            <td class="val">${planName} ($${pricePerMonth.toFixed(2)}/mth)</td>
          </tr>
          <tr>
            <td class="label">Telco Cust No:</td>
            <td class="val">${custNo}</td>
          </tr>
          <tr>
            <td class="label">Order Reference:</td>
            <td class="val">${orderId}</td>
          </tr>
        </table>
      </div>

      <!-- Scannable QR Code Card -->
      <div class="qr-card">
        <div class="qr-title">Scan this QR Code with your Phone</div>
        <div class="qr-tip">
          💡 <strong>Tip for scanning:</strong> If you are viewing this on your smartphone, open this email on a computer, tablet, or another phone screen, then point your mobile camera at this code.
        </div>
        <div class="qr-img-wrap">
          <img src="cid:esim-qr-code" alt="JustMobile eSIM Activation QR" width="220" height="220" style="display: block; border-radius: 8px;" />
        </div>
      </div>

      <!-- Manual Setup Details -->
      <div class="manual-box">
        <div class="manual-title">Or Enter Details Manually on Your Device</div>
        <div class="manual-row"><strong>SM-DP+ Address:</strong> ${smdpAddress}</div>
        <div class="manual-row"><strong>Activation Code:</strong> ${activationCode}</div>
        <div class="manual-row">
          <strong>Full LPA String:</strong>
          <span class="lpa-code">${lpaString}</span>
        </div>
      </div>

      <!-- Device Step by Step Setup -->
      <div class="steps-card">
        <h3>Quick Device Setup Guide</h3>
        <p style="font-size: 13.5px; font-weight: 700; color: #142420; margin: 8px 0 4px 0;">Apple iPhone / iPad (iOS 16+):</p>
        <ol>
          <li>Go to <strong>Settings &rarr; Mobile</strong> (or <strong>Cellular</strong>).</li>
          <li>Tap <strong>Add eSIM</strong> (or <strong>Set Up Mobile Service</strong>).</li>
          <li>Select <strong>Use QR Code</strong> and scan the code above (or tap <em>Enter Details Manually</em>).</li>
          <li>Follow the prompts to label your line and start surfing on 5G.</li>
        </ol>

        <p style="font-size: 13.5px; font-weight: 700; color: #142420; margin: 14px 0 4px 0;">Samsung Galaxy & Google Pixel (Android):</p>
        <ol>
          <li>Go to <strong>Settings &rarr; Connections / Network & Internet &rarr; SIMs</strong>.</li>
          <li>Tap <strong>Add eSIM</strong> (or <strong>Download SIM</strong>).</li>
          <li>Scan the QR code above or paste the SM-DP+ code.</li>
          <li>Confirm activation.</li>
        </ol>
      </div>

      <div class="btn-wrap">
        <a href="http://localhost:3000/account" class="btn">Open Customer Portal &rarr;</a>
      </div>
    </div>

    <div class="footer">
      &copy; ${new Date().getFullYear()} JustMobile Australia · Less telco. More you.<br/>
      Connected to Telstra 5G Wholesale Network · ABN 48 672 819 204.
    </div>
  </div>
</body>
</html>
    `;

    try {
      if (this.transporter) {
        const mailOptions: any = {
          from: sender,
          to,
          subject: `Your JustMobile Telstra 5G eSIM is ready! – Scan QR Code to Activate (${formattedMsn})`,
          text: `G'day! Your JustMobile eSIM for ${formattedMsn} is ready. Open your device Settings > Mobile > Add eSIM and scan your QR code. SM-DP+ Address: ${smdpAddress}, Activation Code: ${activationCode}, LPA String: ${lpaString}. View in portal: http://localhost:3000/account`,
          html: esimHtml,
          attachments: qrBuffer && qrBuffer.length > 0 ? [
            {
              filename: `JustMobile-eSIM-QR-${orderId}.png`,
              content: qrBuffer,
              cid: 'esim-qr-code',
            },
          ] : [],
        };

        const info = await this.transporter.sendMail(mailOptions);
        this.logger.log(`✓ Automated eSIM Welcome Email sent to ${to} (${formattedMsn}): messageId ${info.messageId}`);
      } else {
        this.logger.warn(`Transporter not initialized; eSIM welcome email for ${to} skipped.`);
      }
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to send eSIM welcome email to ${to}:`, error.message);
      return false;
    }
  }

  async sendBroadcastEmail(
    to: string,
    subject: string,
    messageBody: string,
  ): Promise<boolean> {
    if (!this.transporter) {
      this.initTransporter();
    }

    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@justmobile.com.au';
    const sender = `"JustMobile Updates" <${fromEmail}>`;

    const formattedBody = messageBody
      .split('\n')
      .filter((p) => p.trim().length > 0)
      .map((p) => `<p style="font-size: 15px; line-height: 1.6; color: #374151; margin-bottom: 16px;">${p}</p>`)
      .join('');

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${subject}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #FAFBF8; margin: 0; padding: 24px; color: #142420; }
    .container { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #dfe5d7; box-shadow: 0 4px 20px rgba(20,36,32,0.06); }
    .header { background-color: #142420; padding: 26px 32px; }
    .logo-text { color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
    .logo-accent { color: #D5F879; }
    .content { padding: 36px 32px; }
    .title { font-size: 22px; font-weight: 800; color: #142420; margin-top: 0; margin-bottom: 20px; line-height: 1.3; }
    .cta-btn { display: inline-block; background-color: #142420; color: #ffffff !important; padding: 14px 28px; border-radius: 8px; font-weight: 700; font-size: 14.5px; text-decoration: none; }
    .footer { padding: 24px 32px; background: #F1F3ED; border-top: 1px solid #dfe5d7; font-size: 11.5px; color: #6b7280; line-height: 1.5; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-text">justmobile<span class="logo-accent">.</span></div>
    </div>
    <div class="content">
      <h1 class="title">${subject}</h1>
      <div>
        ${formattedBody}
      </div>
      <div style="text-align: center; margin: 32px 0 16px;">
        <a href="https://justmobile.com.au" class="cta-btn">Visit JustMobile &rarr;</a>
      </div>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} JustMobile Australia · Less telco. More you.<br/>
      Connected to Telstra 5G Wholesale Network · ABN 48 672 819 204.<br/>
      You received this update because you subscribed at justmobile.com.au.
    </div>
  </div>
</body>
</html>
    `;

    try {
      if (this.transporter) {
        const info = await this.transporter.sendMail({
          from: sender,
          to,
          subject,
          text: messageBody,
          html,
        });
        this.logger.log(`✓ Broadcast email sent to ${to}: ${info.messageId}`);
        return true;
      }
      return false;
    } catch (err: any) {
      this.logger.error(`Failed to send broadcast email to ${to}: ${err.message}`);
      return false;
    }
  }
}
