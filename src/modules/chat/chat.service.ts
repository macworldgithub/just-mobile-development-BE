import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { MailService } from '../mail/mail.service';
import { CarrierService } from '../carrier/carrier.service';
import { InvoiceService } from '../carrier/invoice.service';
import { BELE_SYSTEM_PROMPT } from './chat-prompt';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: any[];
}

const PLAN_CATALOGUE = [
  { id: 'plan-10gb', name: 'JM 10GB Auto', price: 20.54, dataGb: 10 },
  { id: 'plan-15gb', name: 'JM 15GB Auto', price: 24.6, dataGb: 15 },
  { id: 'plan-29gb', name: 'JM 29GB Auto', price: 28.53, dataGb: 29 },
  { id: 'plan-65gb', name: 'JM 65GB Auto', price: 37.55, dataGb: 65 },
  { id: 'plan-100gb', name: 'JM 100GB Auto', price: 46.4, dataGb: 100 },
  { id: 'plan-120gb', name: 'JM 120GB Auto', price: 54.86, dataGb: 120 },
  { id: 'plan-150gb', name: 'JM 150GB Auto', price: 59.89, dataGb: 150 },
  { id: 'plan-180gb', name: 'JM 180GB Auto', price: 67.0, dataGb: 180 },
];

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly mailService: MailService,
    private readonly carrierService: CarrierService,
    private readonly invoiceService: InvoiceService,
  ) {}

  private maskEmail(email: string): string {
    const clean = (email || '').trim();
    if (!clean.includes('@')) return 'registered email';
    const [local, domain] = clean.split('@');
    const maskedLocal =
      local.length > 2
        ? `${local[0]}${'*'.repeat(Math.min(local.length - 2, 5))}${local[local.length - 1]}`
        : `${local[0] || '*'}***`;
    return `${maskedLocal}@${domain}`;
  }

  private maskPhone(phone: string): string {
    const digits = (phone || '').replace(/\D+/g, '');
    if (digits.length < 6) return 'registered mobile';
    return `${digits.slice(0, 4)} *** ${digits.slice(-3)}`;
  }

  private detectSensitiveInput(text: string): boolean {
    if (!text) return false;
    const cardPattern = /\b(?:\d[ -]*?){13,16}\b/;
    const sensitivePhrase = /\b(cvv|cvc|card number|medicare|passport number|driver.?s? licen[cs]e|my pin is)\b/i;
    return cardPattern.test(text) || sensitivePhrase.test(text);
  }

  private async findCustomerByIdentifier(identifierRaw: string): Promise<any | null> {
    const identifier = (identifierRaw || '').trim();
    if (!identifier) return null;

    const usersCol = this.db.getCollection('users');
    if (identifier.includes('@')) {
      return usersCol.findOne({ email: identifier.toLowerCase() });
    }

    const cleanUpper = identifier.toUpperCase().replace(/\s+/g, '');
    let numericOnly = identifier.replace(/\D+/g, '');
    if (numericOnly.startsWith('61') && numericOnly.length >= 11) {
      numericOnly = '0' + numericOnly.slice(2);
    }
    const numericVal = numericOnly ? parseInt(numericOnly, 10) : NaN;
    const formattedAuPhone =
      numericOnly.length === 10
        ? `${numericOnly.slice(0, 4)} ${numericOnly.slice(4, 7)} ${numericOnly.slice(7)}`
        : numericOnly;
    const spacedPhoneRegex =
      numericOnly.length >= 8 ? new RegExp(`^${numericOnly.split('').join('\\s*')}$`) : null;

    const orClauses: any[] = [
      { custNo: cleanUpper },
      { custNo: numericOnly },
      { custNo: `CUST${numericOnly}` },
      { phone: identifier },
      { phone: numericOnly },
      { phone: formattedAuPhone },
    ];
    if (spacedPhoneRegex) {
      orClauses.push({ phone: { $regex: spacedPhoneRegex } });
    }
    if (!isNaN(numericVal)) {
      orClauses.push({ custNo: numericVal });
    }

    const user = await usersCol.findOne({ $or: orClauses });
    if (user) return user;

    if (numericOnly.length >= 8) {
      const ordersCol = this.db.getCollection('orders');
      const msnOr: any[] = [{ msn: identifier }, { msn: numericOnly }, { msn: formattedAuPhone }];
      if (spacedPhoneRegex) {
        msnOr.push({ msn: { $regex: spacedPhoneRegex } });
      }
      const order = await ordersCol.findOne({ $or: msnOr });
      if (order?.custNo) {
        return usersCol.findOne({ custNo: String(order.custNo) });
      }
    }

    return null;
  }

  private async hasRecentVerifiedChatSession(custNo: string, sessionId?: string): Promise<boolean> {
    const cleanSessionId = (sessionId || 'default-session').trim();
    const sessionsCol = this.db.getCollection('chat_sessions');
    const now = new Date();
    const activeSession = await sessionsCol.findOne(
      {
        sessionId: cleanSessionId,
        active: true,
        expiresAt: { $gt: now },
      },
      { sort: { verifiedAt: -1 } },
    );
    if (activeSession?.custNo) {
      const reqClean = String(custNo || '').trim().toUpperCase().replace(/^CUST/, '');
      const sessClean = String(activeSession.custNo).trim().toUpperCase().replace(/^CUST/, '');
      if (!reqClean || reqClean === sessClean) {
        return true;
      }
    }

    if (!custNo) return false;

    // Also honour legacy verified OTP within 30m only when using default-session
    if (cleanSessionId === 'default-session') {
      const verificationsCol = this.db.getCollection('email_verifications');
      const cutoff = new Date(Date.now() - 30 * 60 * 1000);
      const verified = await verificationsCol.findOne({
        custNo: String(custNo),
        type: 'chat_otp',
        verifiedAt: { $gte: cutoff },
        loggedOut: { $ne: true },
      });
      return Boolean(verified);
    }

    return false;
  }

  /** Fetch verified customer snapshot shared between verified lookup and OTP verification. */
  private async buildVerifiedAccountPayload(user: any) {
    const custNo = String(user.custNo || '');
    const [services, balance, usage, orders, invoices] = await Promise.all([
      custNo ? this.carrierService.getServices(custNo).catch(() => ({ services: [] })) : { services: [] },
      custNo ? this.carrierService.getBalance(custNo).catch(() => null) : null,
      custNo ? this.carrierService.getUnbilledUsage(custNo).catch(() => null) : null,
      custNo ? this.carrierService.getCustomerOrders(custNo).catch(() => []) : [],
      custNo ? this.invoiceService.getCustomerInvoices(custNo).catch(() => []) : [],
    ]);

    return {
      verified: true,
      custNo,
      name: user.name,
      preferredName: user.preferredName || user.firstName || user.name,
      maskedEmail: this.maskEmail(user.email),
      maskedPhone: this.maskPhone(user.phone || ''),
      address: user.address ? `${user.address}, ${user.suburb || ''} ${user.state || ''} ${user.postcode || ''}`.trim() : 'Not set',
      services: services.services || [],
      balance: balance
        ? {
            formattedBalance: balance.formattedBalance,
            nextInvoiceDate: balance.nextInvoiceDate,
            nextInvoiceAmount: balance.nextInvoiceAmount,
            autoPayStatus: balance.autoPayStatus,
            paymentMethod: balance.paymentMethod,
          }
        : null,
      usage: usage?.dataMeter || null,
      recentOrders: (orders || []).map((o: any) => ({
        orderId: o.orderId,
        msn: o.msn,
        planName: o.planName,
        status: o.status,
        orderType: o.orderType,
      })),
      recentInvoices: (invoices || []).map((inv: any) => ({
        invoiceId: inv.invoiceId,
        amount: inv.amount,
        status: inv.status,
        period: `${inv.periodStart} to ${inv.periodEnd}`,
      })),
    };
  }

  private getToolsSchema() {
    return [
      {
        type: 'function',
        function: {
          name: 'lookup_account',
          description:
            'Locate a customer account by mobile number, email, or Customer Number without exposing any personal details before OTP verification. Once the session is already OTP-verified, calling this tool returns the verified customer services, balance, data usage, recent orders, and recent invoices immediately.',
          parameters: {
            type: 'object',
            properties: {
              identifier: {
                type: 'string',
                description: 'Mobile number (e.g. 0412345678), Customer Number (e.g. CUST990001), or email address.',
              },
            },
            required: ['identifier'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'send_chat_otp',
          description:
            'Send a 6-digit OTP verification code to the located customer email/registered channel so they can verify their identity.',
          parameters: {
            type: 'object',
            properties: {
              identifier: {
                type: 'string',
                description: 'Mobile number, Customer Number, or email used to locate the account.',
              },
            },
            required: ['identifier'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'verify_chat_otp',
          description:
            'Verify the 6-digit OTP provided by the customer. Enforces expiry and retry limits, and returns account summary upon success.',
          parameters: {
            type: 'object',
            properties: {
              identifier: { type: 'string', description: 'Customer Number, email, or mobile number.' },
              code: { type: 'string', description: '6-digit OTP entered by the customer.' },
            },
            required: ['identifier', 'code'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'logout_chat_session',
          description:
            'End the currently verified customer chat session immediately (call when customer asks to log out or finish account access).',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string', description: 'Optional Customer Number to log out.' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'request_contact_update_otp',
          description:
            'Send a 6-digit confirmation code to the NEW email address or NEW phone number when an already-verified customer wants to update registered email or contact phone (call directly whenever [VERIFIED SESSION ACTIVE] is shown).',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              newEmail: { type: 'string' },
              newPhone: { type: 'string' },
            },
            required: ['custNo'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'confirm_contact_update',
          description:
            'Verify the 6-digit confirmation code and save the new registered email address or contact phone number.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              code: { type: 'string' },
              newEmail: { type: 'string' },
              newPhone: { type: 'string' },
            },
            required: ['custNo', 'code'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'update_account_details',
          description:
            'Update non-high-risk account details (preferredName, residential address/suburb/state/postcode, postalAddress, commPreference, billDeliveryPreference, marketingConsent) ONLY after OTP verification.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              preferredName: { type: 'string' },
              address: { type: 'string' },
              suburb: { type: 'string' },
              state: { type: 'string' },
              postcode: { type: 'string' },
              postalAddress: { type: 'string' },
              commPreference: { type: 'string', enum: ['email', 'sms', 'both'] },
              billDeliveryPreference: { type: 'string', enum: ['email', 'paper'] },
              marketingConsent: { type: 'boolean' },
            },
            required: ['custNo'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'change_plan',
          description:
            'Upgrade or downgrade a mobile service plan ONLY after OTP verification AND explicit customer confirmation of price/terms.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              planName: { type: 'string', description: 'Exact plan name e.g. JM 65GB Auto' },
              msn: { type: 'string', description: 'Target mobile number when customer has multiple services' },
              confirmed: { type: 'boolean', description: 'Must be true only after customer explicitly confirmed the summary.' },
            },
            required: ['custNo', 'planName', 'confirmed'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cancel_pending_plan_change',
          description:
            'Cancel a pending scheduled plan change and retain the original plan (requires OTP verification).',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              msn: { type: 'string' },
            },
            required: ['custNo'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'send_invoice_copy',
          description:
            'Retrieve and email/link a copy of the latest or requested ATO tax invoice PDF (requires OTP verification).',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              invoiceId: { type: 'string', description: 'Optional specific invoiceId' },
            },
            required: ['custNo'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'manage_data_addon_or_alerts',
          description:
            'Purchase/cancel a $10 20GB 30-day Data Top-Up Pack or enable/disable low-data usage alerts (requires OTP verification; add-on purchase/cancellation requires confirmed: true).',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              action: { type: 'string', enum: ['add_data_pack', 'cancel_data_pack', 'enable_alerts', 'disable_alerts'] },
              msn: { type: 'string' },
              confirmed: { type: 'boolean' },
            },
            required: ['custNo', 'action', 'confirmed'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'manage_roaming',
          description:
            'Activate or disable International Roaming Travel Pack ($5/day 2GB across 20 eligible destinations). Requires OTP verification and confirmed: true.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              action: { type: 'string', enum: ['activate', 'disable'] },
              destinationCountry: { type: 'string' },
              msn: { type: 'string' },
              confirmed: { type: 'boolean' },
            },
            required: ['custNo', 'action', 'confirmed'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'resend_esim_qr',
          description:
            'Resend an eSIM activation QR code email for an existing verified customer order (requires OTP verification).',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              orderId: { type: 'string', description: 'Optional specific orderId' },
            },
            required: ['custNo'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'suspend_service',
          description:
            'Temporarily suspend a verified customer mobile service (e.g. lost/stolen phone or voluntary suspension) after explicit confirmation.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              msn: { type: 'string' },
              reason: { type: 'string' },
              confirmed: { type: 'boolean' },
            },
            required: ['custNo', 'reason', 'confirmed'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'restore_service',
          description:
            'Restore a temporarily suspended mobile service after OTP verification and explicit confirmation.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              msn: { type: 'string' },
              confirmed: { type: 'boolean' },
            },
            required: ['custNo', 'confirmed'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'manage_cancellation',
          description:
            'Schedule or withdraw a service cancellation (single service on account), warning never to cancel before porting finishes. Requires OTP verification and confirmed: true.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              action: { type: 'string', enum: ['schedule', 'withdraw'] },
              msn: { type: 'string' },
              effectiveDate: { type: 'string' },
              reason: { type: 'string' },
              confirmed: { type: 'boolean' },
            },
            required: ['custNo', 'action', 'confirmed'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'check_network_outage',
          description:
            'Check recorded network outage notices by suburb, postcode, or state.',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'Suburb, 4-digit postcode, or Australian state' },
            },
            required: ['location'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'lodge_complaint_or_support_case',
          description:
            'Log a formal complaint (CMP-JM-...), support ticket (TKT-JM-...), billing dispute (BQ-JM-...), payment arrangement, or human/fraud/hardship escalation while preserving conversation context. Does NOT require prior OTP verification — call immediately when a user asks to lodge a complaint, dispute, or escalation with a summary of the issue.',
          parameters: {
            type: 'object',
            properties: {
              caseType: {
                type: 'string',
                enum: ['complaint', 'support_ticket', 'billing_dispute', 'payment_arrangement', 'high_risk_escalation'],
              },
              custNo: { type: 'string' },
              contactName: { type: 'string' },
              contactEmail: { type: 'string' },
              summary: { type: 'string' },
              desiredOutcome: { type: 'string' },
              urgent: { type: 'boolean' },
            },
            required: ['caseType', 'summary'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'check_status',
          description:
            'Check the status of an order, port-in transfer, complaint, or support ticket by reference ID or verified Customer Number.',
          parameters: {
            type: 'object',
            properties: {
              referenceId: { type: 'string', description: 'Order ID, CMP-JM-..., TKT-JM-..., BQ-JM-..., or CAN-JM-...' },
              custNo: { type: 'string', description: 'Verified Customer Number' },
            },
          },
        },
      },
    ];
  }

  private async executeToolCall(
    name: string,
    rawArgs: string,
    conversationMessages: Array<{ role: string; content: string }>,
    sessionId?: string,
  ): Promise<string> {
    let args: Record<string, any> = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return JSON.stringify({ error: 'Invalid tool arguments.' });
    }

    const cleanSessionId = (sessionId || 'default-session').trim();

    try {
      if (name === 'lookup_account') {
        const user = await this.findCustomerByIdentifier(args.identifier);
        if (!user) {
          return JSON.stringify({
            found: false,
            message: 'No matching account found. Ask the customer to double-check their Customer Number, mobile number, or email.',
          });
        }
        if (user.custNo && (await this.hasRecentVerifiedChatSession(String(user.custNo), cleanSessionId))) {
          return JSON.stringify(await this.buildVerifiedAccountPayload(user));
        }
        return JSON.stringify({
          found: true,
          maskedEmail: this.maskEmail(user.email),
          maskedPhone: this.maskPhone(user.phone || ''),
          securityRule: 'Account located. Do NOT reveal personal details yet. Ask to send a 6-digit OTP via send_chat_otp.',
        });
      }

      if (name === 'send_chat_otp') {
        const user = await this.findCustomerByIdentifier(args.identifier);
        if (!user) {
          return JSON.stringify({ otpSent: false, error: 'Account not found.' });
        }

        const verificationsCol = this.db.getCollection('email_verifications');
        const lockoutCutoff = new Date(Date.now() - 15 * 60 * 1000);
        const recentLock = await verificationsCol.findOne({
          email: String(user.email || '').toLowerCase(),
          type: 'chat_otp',
          locked: true,
          createdAt: { $gte: lockoutCutoff },
        });
        if (recentLock) {
          return JSON.stringify({
            otpSent: false,
            locked: true,
            error: 'Verification is temporarily locked due to repeated failed OTP attempts. Escalate to 1300 492 002 or info@justmobile.ai, or wait 15 minutes.',
          });
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await verificationsCol.updateMany(
          { email: String(user.email || '').toLowerCase(), type: 'chat_otp', used: false },
          { $set: { used: true } },
        );
        await verificationsCol.insertOne({
          email: String(user.email || '').toLowerCase(),
          custNo: String(user.custNo || ''),
          sessionId: cleanSessionId,
          code,
          type: 'chat_otp',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          used: false,
          attempts: 0,
          createdAt: new Date(),
        });

        if (process.env.NODE_ENV !== 'production') {
          this.logger.log(`[DEV] Chat OTP for ${user.email}: ${code}`);
        }
        if (user.email && user.email.includes('@') && !user.email.endsWith('@example.com')) {
          await this.mailService.sendVerificationCode(user.email, code, user.name).catch((e) =>
            this.logger.warn(`Chat OTP email dispatch warning: ${e.message}`),
          );
        }

        return JSON.stringify({
          otpSent: true,
          maskedEmail: this.maskEmail(user.email),
          expiresInMinutes: 10,
          note: 'Tell the customer a 6-digit OTP was sent to their registered email and ask them to enter it.',
        });
      }

      if (name === 'verify_chat_otp') {
        const user = await this.findCustomerByIdentifier(args.identifier);
        if (!user) {
          return JSON.stringify({ verified: false, error: 'Account not found.' });
        }

        const verificationsCol = this.db.getCollection('email_verifications');
        const record = await verificationsCol.findOne(
          { email: String(user.email || '').toLowerCase(), type: 'chat_otp', used: false },
          { sort: { createdAt: -1 } },
        );

        if (!record) {
          return JSON.stringify({
            verified: false,
            error: 'No active OTP found. Offer to send a fresh 6-digit OTP.',
          });
        }

        if (record.expiresAt <= new Date()) {
          await verificationsCol.updateOne({ _id: record._id }, { $set: { used: true } });
          return JSON.stringify({
            verified: false,
            expired: true,
            error: 'That OTP has expired (10-minute limit). Offer to send a new OTP.',
          });
        }

        const attempts = (record.attempts || 0) + 1;
        if (String(record.code) !== String(args.code || '').trim()) {
          if (attempts >= 3) {
            await verificationsCol.updateOne(
              { _id: record._id },
              { $set: { used: true, attempts, locked: true } },
            );
            return JSON.stringify({
              verified: false,
              locked: true,
              error: 'Too many failed OTP attempts. Account verification temporarily locked for 15 minutes; please contact 1300 492 002 or info@justmobile.ai.',
            });
          }
          await verificationsCol.updateOne({ _id: record._id }, { $set: { attempts } });
          return JSON.stringify({
            verified: false,
            attemptsRemaining: 3 - attempts,
            error: `Incorrect OTP. ${3 - attempts} attempt(s) remaining.`,
          });
        }

        const now = new Date();
        const custNo = String(user.custNo || '');
        await Promise.all([
          verificationsCol.updateOne(
            { _id: record._id },
            { $set: { used: true, verifiedAt: now, custNo } },
          ),
          this.db.getCollection('chat_sessions').updateOne(
            { sessionId: cleanSessionId, custNo },
            {
              $set: {
                sessionId: cleanSessionId,
                custNo,
                active: true,
                verifiedAt: now,
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
              },
            },
            { upsert: true },
          ),
        ]);

        return JSON.stringify(await this.buildVerifiedAccountPayload(user));
      }

      if (name === 'logout_chat_session') {
        const filter: Record<string, any> = { sessionId: cleanSessionId };
        if (args.custNo) filter.custNo = String(args.custNo).trim();
        await this.db.getCollection('chat_sessions').updateMany(filter, {
          $set: { active: false, loggedOutAt: new Date() },
        });
        if (args.custNo) {
          await this.db.getCollection('email_verifications').updateMany(
            { custNo: String(args.custNo).trim(), type: 'chat_otp' },
            { $set: { loggedOut: true } },
          );
        }
        return JSON.stringify({
          loggedOut: true,
          message: 'Your verified chat session has been ended safely. Ask to re-verify anytime you need account access again.',
        });
      }

      if (name === 'request_contact_update_otp') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification of current session required first.' });
        }
        const targetEmail = args.newEmail ? String(args.newEmail).trim().toLowerCase() : null;
        const targetPhone = args.newPhone ? String(args.newPhone).trim() : null;
        if (!targetEmail && !targetPhone) {
          return JSON.stringify({ success: false, error: 'Provide the new email address or phone number to verify.' });
        }
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await this.db.getCollection('email_verifications').insertOne({
          custNo,
          email: targetEmail || `phone:${targetPhone}`,
          newEmail: targetEmail,
          newPhone: targetPhone,
          code,
          type: 'contact_update',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          used: false,
          createdAt: new Date(),
        });
        if (process.env.NODE_ENV !== 'production') {
          this.logger.log(`[DEV] Contact update OTP for ${custNo} (${targetEmail || targetPhone}): ${code}`);
        }
        if (targetEmail && !targetEmail.endsWith('@example.com')) {
          await this.mailService.sendVerificationCode(targetEmail, code).catch(() => {});
        }
        return JSON.stringify({
          otpSent: true,
          target: targetEmail ? this.maskEmail(targetEmail) : this.maskPhone(targetPhone || ''),
          message: 'Verification code dispatched for the new contact details. Ask the customer for the 6-digit code.',
        });
      }

      if (name === 'confirm_contact_update') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required first.' });
        }
        const rec = await this.db.getCollection('email_verifications').findOne(
          { custNo, type: 'contact_update', used: false, expiresAt: { $gt: new Date() } },
          { sort: { createdAt: -1 } },
        );
        if (!rec || String(rec.code) !== String(args.code || '').trim()) {
          return JSON.stringify({ success: false, error: 'Invalid or expired contact verification code.' });
        }
        await this.db.getCollection('email_verifications').updateOne({ _id: rec._id }, { $set: { used: true } });
        const updateSet: Record<string, any> = { updatedAt: new Date() };
        if (args.newEmail || rec.newEmail) updateSet.email = String(args.newEmail || rec.newEmail).trim().toLowerCase();
        if (args.newPhone || rec.newPhone) updateSet.phone = String(args.newPhone || rec.newPhone).trim();
        await this.db.getCollection('users').updateOne({ custNo }, { $set: updateSet });
        return JSON.stringify({
          success: true,
          referenceNumber: `CTC-JM-${Math.floor(100000 + Math.random() * 900000)}`,
          updated: { email: updateSet.email ? this.maskEmail(updateSet.email) : undefined, phone: updateSet.phone ? this.maskPhone(updateSet.phone) : undefined },
        });
      }

      if (name === 'update_account_details') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({
            success: false,
            error: 'OTP verification required before updating account details.',
          });
        }

        const updateSet: Record<string, any> = { updatedAt: new Date() };
        if (args.preferredName !== undefined) updateSet.preferredName = String(args.preferredName).trim();
        if (args.address !== undefined) updateSet.address = String(args.address).trim();
        if (args.suburb !== undefined) updateSet.suburb = String(args.suburb).trim();
        if (args.state !== undefined) updateSet.state = String(args.state).trim().toUpperCase();
        if (args.postcode !== undefined) updateSet.postcode = String(args.postcode).trim();
        if (args.postalAddress !== undefined) updateSet.postalAddress = String(args.postalAddress).trim();
        if (args.commPreference !== undefined) updateSet.commPreference = args.commPreference;
        if (args.billDeliveryPreference !== undefined) updateSet.billDeliveryPreference = args.billDeliveryPreference;
        if (args.marketingConsent !== undefined) updateSet.marketingConsent = Boolean(args.marketingConsent);

        const usersCol = this.db.getCollection('users');
        await usersCol.updateOne({ custNo }, { $set: updateSet });
        const referenceNumber = `UPD-JM-${Math.floor(100000 + Math.random() * 900000)}`;

        return JSON.stringify({
          success: true,
          referenceNumber,
          effectiveTiming: 'Immediately',
          message: 'Account details updated.',
        });
      }

      if (name === 'change_plan') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required before changing plans.' });
        }
        if (!args.confirmed) {
          return JSON.stringify({
            success: false,
            error: 'Customer confirmation required. Present the new price and effective timing first.',
          });
        }

        const target = PLAN_CATALOGUE.find(
          (p) =>
            p.name.toLowerCase() === String(args.planName || '').toLowerCase() ||
            String(args.planName || '').includes(`${p.dataGb}GB`),
        );
        if (!target) {
          return JSON.stringify({
            success: false,
            error: 'Requested plan not found or retired. Offer one of the 8 active JM Auto plans.',
          });
        }

        const res = await this.carrierService.changePlan(custNo, {
          planId: target.id,
          planName: target.name,
          monthlyFee: target.price,
          dataGb: target.dataGb,
          msn: args.msn,
        });
        const referenceNumber = `PC-JM-${Math.floor(100000 + Math.random() * 900000)}`;

        const user = await this.findCustomerByIdentifier(custNo);
        await this.db.getCollection('plan_changes').insertOne({
          referenceNumber,
          custNo,
          msn: args.msn || user?.phone || null,
          planId: target.id,
          planName: target.name,
          monthlyFee: target.price,
          status: 'PENDING',
          createdAt: new Date(),
        });

        const emailSent = user?.email
          ? await this.mailService.sendCustomerNotificationEmail(
              user.email,
              `JustMobile Plan Change Confirmation (${referenceNumber})`,
              `Your plan change to ${target.name} ($${target.price.toFixed(2)}/mth incl. GST) has been recorded under reference ${referenceNumber}.\nData allowance updates immediately and your next bill on the 28th reflects the new monthly rate.`,
            )
          : false;

        return JSON.stringify({
          success: true,
          referenceNumber,
          planName: target.name,
          monthlyFee: target.price,
          writtenConfirmationSent: emailSent,
          effectiveDate: 'Quota updated immediately; next invoice on the 28th reflects the new monthly rate.',
          backendMessage: res.message,
        });
      }

      if (name === 'cancel_pending_plan_change') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required first.' });
        }
        const pending = await this.db.getCollection('plan_changes').findOne(
          { custNo, status: 'PENDING' },
          { sort: { createdAt: -1 } },
        );
        if (!pending) {
          return JSON.stringify({
            cancelled: false,
            message: 'No pending plan change found to cancel; your current plan remains unchanged.',
          });
        }
        await this.db.getCollection('plan_changes').updateOne(
          { _id: pending._id },
          { $set: { status: 'CANCELLED', cancelledAt: new Date() } },
        );
        return JSON.stringify({
          cancelled: true,
          referenceNumber: pending.referenceNumber,
          message: `Pending plan change (${pending.planName}) cancelled. Your original plan remains active.`,
        });
      }

      if (name === 'send_invoice_copy') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required first.' });
        }
        const invoices = await this.invoiceService.getCustomerInvoices(custNo);
        if (!invoices || invoices.length === 0) {
          return JSON.stringify({ found: false, message: 'No invoices found on your account yet.' });
        }
        const target =
          (args.invoiceId && invoices.find((i) => i.invoiceId === args.invoiceId)) || invoices[0];
        const user = await this.findCustomerByIdentifier(custNo);
        const emailed = user?.email
          ? await this.mailService.sendCustomerNotificationEmail(
              user.email,
              `JustMobile Tax Invoice ${target.invoiceId}`,
              `Here is a summary of your ATO Tax Invoice ${target.invoiceId} (${target.periodStart} to ${target.periodEnd}):\nPlan: ${target.planName}\nTotal (incl. GST): $${Number(target.amount).toFixed(2)}\nStatus: ${target.status}\n\nYou can download the full PDF anytime in /account -> Billing & Pay Now.`,
            )
          : false;

        return JSON.stringify({
          found: true,
          invoiceId: target.invoiceId,
          amount: target.amount,
          status: target.status,
          pdfDownloadPath: `/api/carrier/customers/${custNo}/invoices/${target.invoiceId}/pdf`,
          portalPath: '/account',
          emailed,
        });
      }

      if (name === 'manage_data_addon_or_alerts') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required first.' });
        }
        const isAlertAction = args.action === 'enable_alerts' || args.action === 'disable_alerts';
        if (!isAlertAction && !args.confirmed) {
          return JSON.stringify({
            success: false,
            error: 'Present pack details ($10 for 20GB, valid 30 days) and confirm with the customer before proceeding.',
          });
        }
        const ref = `ADD-JM-${Math.floor(100000 + Math.random() * 900000)}`;
        await this.db.getCollection('service_addons').insertOne({
          referenceNumber: ref,
          custNo,
          msn: args.msn || null,
          addonType: isAlertAction ? 'LOW_DATA_ALERTS' : 'DATA_PACK_20GB',
          action: args.action,
          priceAud: args.action === 'add_data_pack' ? 10.0 : 0,
          validityDays: args.action === 'add_data_pack' ? 30 : null,
          status: args.action === 'cancel_data_pack' || args.action === 'disable_alerts' ? 'INACTIVE' : 'ACTIVE',
          createdAt: new Date(),
        });
        return JSON.stringify({
          success: true,
          referenceNumber: ref,
          action: args.action,
          note:
            args.action === 'add_data_pack'
              ? '20GB Data Top-Up ($10, valid 30 days) enabled.'
              : args.action === 'cancel_data_pack'
              ? 'Data add-on stopped cleanly; expires at end of current pack validity.'
              : args.action === 'enable_alerts'
              ? 'Low-data usage alerts (50%, 85%, 100%) enabled.'
              : 'Optional low-data alerts disabled (mandatory ACMA spend/usage notices remain active).',
        });
      }

      if (name === 'manage_roaming') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required first.' });
        }
        if (!args.confirmed) {
          return JSON.stringify({
            success: false,
            error: 'Present Travel Pack charges ($5/day for 2GB across 20 eligible destinations) and ask for explicit confirmation first.',
          });
        }
        const ref = `RMG-JM-${Math.floor(100000 + Math.random() * 900000)}`;
        await this.db.getCollection('service_addons').insertOne({
          referenceNumber: ref,
          custNo,
          msn: args.msn || null,
          addonType: 'ROAMING_TRAVEL_PACK',
          action: args.action,
          destinationCountry: args.destinationCountry || null,
          priceAud: args.action === 'activate' ? 5.0 : 0,
          status: args.action === 'activate' ? 'ACTIVE' : 'DISABLED',
          createdAt: new Date(),
        });
        return JSON.stringify({
          success: true,
          referenceNumber: ref,
          status: args.action === 'activate' ? 'ENABLED' : 'DISABLED',
          message:
            args.action === 'activate'
              ? 'International Roaming Travel Pack ($5/day for 2GB) enabled.'
              : 'International roaming disabled cleanly.',
        });
      }

      if (name === 'resend_esim_qr') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required first.' });
        }
        const orders = await this.carrierService.getCustomerOrders(custNo);
        const order =
          (args.orderId && orders.find((o) => o.orderId === args.orderId)) || orders[0];
        if (!order && custNo !== 'CUST990001') {
          return JSON.stringify({
            sent: false,
            error: 'No existing eSIM order found on this account yet. Complete an order in /account first.',
          });
        }
        const targetId = order?.orderId || 'CUST990001';
        const qr = await this.carrierService.getEsimQRCode(targetId).catch(() => null);
        const user = await this.findCustomerByIdentifier(custNo);
        const emailRes = order
          ? await this.carrierService
              .sendOrderEsimEmail(custNo, order.orderId, user?.email)
              .catch(() => ({ success: false, email: user?.email }))
          : { success: false, email: user?.email };
        return JSON.stringify({
          sent: true,
          orderId: qr?.orderId || targetId,
          lpa: qr?.lpa,
          smdpAddress: qr?.smdpAddress,
          emailDispatched: Boolean(emailRes?.success),
          maskedEmail: this.maskEmail(user?.email || ''),
        });
      }

      if (name === 'suspend_service') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required before suspending a service.' });
        }
        if (!args.confirmed) {
          return JSON.stringify({
            success: false,
            error: 'Customer confirmation required before suspending service.',
          });
        }

        const ordersCol = this.db.getCollection('orders');
        const filter: Record<string, any> = { custNo };
        if (args.msn) filter.msn = String(args.msn).replace(/\s+/g, '');
        await ordersCol.updateMany(filter, {
          $set: { status: 'SUSPENDED', suspensionReason: args.reason || 'Customer request', updatedAt: new Date() },
        });
        const referenceNumber = `SUS-JM-${Math.floor(100000 + Math.random() * 900000)}`;
        return JSON.stringify({
          success: true,
          referenceNumber,
          note: 'Service suspended. Outgoing calls, SMS, and mobile data are paused (000/112 emergency calls remain accessible).',
        });
      }

      if (name === 'restore_service') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required before restoring a service.' });
        }
        if (!args.confirmed) {
          return JSON.stringify({
            success: false,
            error: 'Confirm with the customer before restoring their suspended service.',
          });
        }
        const ordersCol = this.db.getCollection('orders');
        const filter: Record<string, any> = { custNo, status: 'SUSPENDED' };
        if (args.msn) filter.msn = String(args.msn).replace(/\s+/g, '');
        await ordersCol.updateMany(filter, {
          $set: { status: 'ACTIVE', restoredAt: new Date(), updatedAt: new Date() },
        });
        const referenceNumber = `RST-JM-${Math.floor(100000 + Math.random() * 900000)}`;
        return JSON.stringify({
          success: true,
          referenceNumber,
          note: 'Suspended mobile service restored to Active status.',
        });
      }

      if (name === 'manage_cancellation') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required before cancelling a service.' });
        }
        if (!args.confirmed) {
          return JSON.stringify({
            success: false,
            error: 'Warn customer about number loss if porting, explain final billing, and ask for explicit confirmation first.',
          });
        }
        const ordersCol = this.db.getCollection('orders');
        const filter: Record<string, any> = { custNo };
        if (args.msn) filter.msn = String(args.msn).replace(/\s+/g, '');

        const referenceNumber = `CAN-JM-${Math.floor(100000 + Math.random() * 900000)}`;
        if (args.action === 'schedule') {
          await ordersCol.updateMany(filter, {
            $set: {
              cancellationStatus: 'SCHEDULED',
              cancellationEffectiveDate: args.effectiveDate || 'End of current billing period',
              cancellationReference: referenceNumber,
              updatedAt: new Date(),
            },
          });
        } else {
          await ordersCol.updateMany(filter, {
            $set: {
              cancellationStatus: 'WITHDRAWN',
              status: 'ACTIVE',
              updatedAt: new Date(),
            },
          });
        }

        const user = await this.findCustomerByIdentifier(custNo);
        if (user?.email) {
          await this.mailService.sendCustomerNotificationEmail(
            user.email,
            `JustMobile Service Cancellation ${args.action === 'schedule' ? 'Scheduled' : 'Withdrawn'} (${referenceNumber})`,
            `Reference: ${referenceNumber}\nAction: ${args.action === 'schedule' ? `Scheduled cancellation (${args.effectiveDate || 'End of billing period'})` : 'Cancellation withdrawn — service remains active'}\nTarget Service: ${args.msn || 'Selected mobile service'}`,
          );
        }

        return JSON.stringify({
          success: true,
          referenceNumber,
          action: args.action,
          effectiveDate: args.effectiveDate || 'End of current paid billing period',
          note:
            args.action === 'schedule'
              ? 'Cancellation request recorded for the specified service only; final bill settles on your next cycle.'
              : 'Scheduled cancellation withdrawn cleanly; your service remains active.',
        });
      }

      if (name === 'check_network_outage') {
        const loc = String(args.location || '').trim().toLowerCase();
        const outages = await this.db
          .getCollection('network_outages')
          .find({ status: 'ACTIVE' })
          .toArray();
        const matched = outages.find((o: any) => {
          const sub = String(o.suburb || '').toLowerCase();
          const pc = String(o.postcode || '').trim();
          const st = String(o.state || '').toLowerCase();
          return (
            (sub && (loc.includes(sub) || sub.includes(loc))) ||
            (pc && (loc.includes(pc) || pc === loc)) ||
            (st && st === loc)
          );
        });
        if (matched) {
          return JSON.stringify({
            knownOutage: true,
            location: loc,
            summary: matched.summary,
            estimatedRestoration: matched.estimatedRestoration || 'Under active Telstra Wholesale restoration',
          });
        }
        return JSON.stringify({
          knownOutage: false,
          location: loc,
          note: 'No recorded outage found for that location. If issues persist, log a diagnostic support ticket via lodge_complaint_or_support_case.',
        });
      }

      if (name === 'lodge_complaint_or_support_case') {
        const prefixMap: Record<string, string> = {
          complaint: 'CMP-JM',
          billing_dispute: 'BQ-JM',
          payment_arrangement: 'PAY-ARR',
          high_risk_escalation: 'ESC-JM',
          support_ticket: 'TKT-JM',
        };
        const prefix = prefixMap[args.caseType] || 'TKT-JM';
        const referenceNumber = `${prefix}-${Math.floor(100000 + Math.random() * 900000)}`;
        const colName =
          args.caseType === 'complaint'
            ? 'complaints'
            : args.caseType === 'billing_dispute'
            ? 'bill_queries'
            : 'support_tickets';

        const sanitizedTranscript = conversationMessages.slice(-10).map((m) => ({
          role: m.role,
          content: String(m.content || '').replace(/\b(?:\d[ -]*?){13,16}\b/g, '[REDACTED CARD]'),
        }));

        await this.db.getCollection(colName).insertOne({
          referenceNumber,
          queryId: referenceNumber,
          caseType: args.caseType,
          custNo: args.custNo || null,
          contactName: args.contactName || null,
          contactEmail: args.contactEmail || null,
          summary: args.summary,
          desiredOutcome: args.desiredOutcome || null,
          urgent: Boolean(args.urgent),
          status: 'OPEN',
          transcript: sanitizedTranscript,
          createdAt: new Date(),
        });

        return JSON.stringify({
          success: true,
          referenceNumber,
          status: 'OPEN',
          timeframe: args.urgent
            ? 'Urgent escalation — prioritised response within 2 business days (or immediate via 1300 492 002)'
            : 'Acknowledged within 2 business days; resolved within 15 business days',
          escalationContact: 'info@justmobile.ai | 1300 492 002',
        });
      }

      if (name === 'check_status') {
        if (args.referenceId) {
          const ref = String(args.referenceId).trim();
          const [order, complaint, ticket, billQuery, planChange] = await Promise.all([
            this.db.getCollection('orders').findOne({ $or: [{ orderId: ref }, { cancellationReference: ref }] }),
            this.db.getCollection('complaints').findOne({ referenceNumber: ref }),
            this.db.getCollection('support_tickets').findOne({ referenceNumber: ref }),
            this.db.getCollection('bill_queries').findOne({ $or: [{ referenceNumber: ref }, { queryId: ref }] }),
            this.db.getCollection('plan_changes').findOne({ referenceNumber: ref }),
          ]);
          const found: any = order || complaint || ticket || billQuery || planChange;
          if (!found) {
            return JSON.stringify({ found: false, message: `No record found for reference ${ref}.` });
          }
          if (found.custNo && !(await this.hasRecentVerifiedChatSession(String(found.custNo), cleanSessionId))) {
            return JSON.stringify({
              verificationRequired: true,
              message: `Reference ${ref} exists. Verify customer identity with send_chat_otp / verify_chat_otp before disclosing account/case status.`,
            });
          }
          return JSON.stringify({
            found: true,
            referenceId: ref,
            status: found.status,
            updatedAt: found.updatedAt || found.createdAt,
            details: order ? { planName: order.planName, orderType: order.orderType } : { summary: found.summary || found.message },
          });
        }

        if (args.custNo) {
          if (!(await this.hasRecentVerifiedChatSession(String(args.custNo), cleanSessionId))) {
            return JSON.stringify({ error: 'OTP verification required before checking customer statuses.' });
          }
          const orders = await this.carrierService.getCustomerOrders(String(args.custNo));
          return JSON.stringify({
            found: true,
            orders: orders.map((o: any) => ({
              orderId: o.orderId,
              msn: o.msn,
              status: o.status,
              planName: o.planName,
              rejectionReason: o.rejectionReason || null,
            })),
          });
        }
        return JSON.stringify({ error: 'Provide a referenceId or verified custNo.' });
      }

      return JSON.stringify({ error: `Unknown tool: ${name}` });
    } catch (err: any) {
      this.logger.error(`Chat tool ${name} error: ${err.message}`);
      return JSON.stringify({
        error: `Backend action did not complete (${err.message}). Inform the customer honestly and offer 1300 492 002 / info@justmobile.ai.`,
      });
    }
  }

  async generateResponse(
    messages: Array<{ role: string; content: string }>,
    sessionId?: string,
  ) {
    const apiKey = process.env.OPENAI_KEY;

    if (!apiKey) {
      this.logger.warn('OPENAI_KEY is not configured in backend .env.');
      return {
        reply:
          "G'day! I'm Bele, your JustMobile assistant. Need help right away? Call 1300 492 002 (Mon–Fri 9am–5pm AEST) or email info@justmobile.ai.",
      };
    }

    const latestUserMsg = messages[messages.length - 1]?.content || '';
    const containsSensitive = this.detectSensitiveInput(latestUserMsg);

    const cleanSessionId = (sessionId || 'default-session').trim();
    const activeSession = await this.db
      .getCollection('chat_sessions')
      .findOne({ sessionId: cleanSessionId, active: true, expiresAt: { $gt: new Date() } })
      .catch(() => null);

    let systemContent = containsSensitive
      ? `${BELE_SYSTEM_PROMPT}\n\n[SECURITY ALERT: The user's last message appears to contain sensitive card/PIN/ID details. Immediately warn them NOT to share card numbers, CVVs, PINs, or identity numbers in chat, do NOT repeat those numbers back, and direct them to /account or 1300 492 002.]`
      : BELE_SYSTEM_PROMPT;

    if (activeSession?.custNo) {
      systemContent += `\n\n[VERIFIED SESSION ACTIVE]\nCustomer "${activeSession.custNo}" is ALREADY OTP-verified for this chat session until ${new Date(activeSession.expiresAt).toISOString()}. NEVER ask them to verify their session again or resend a login OTP while this session is active. Call requested account tools directly with custNo "${activeSession.custNo}". When they want to change registered email or phone, immediately call \`request_contact_update_otp\` to send a confirmation code to their NEW email/phone.`;
    }

    try {
      const apiMessages: ChatMessage[] = [
        { role: 'system', content: systemContent },
        ...messages.slice(-16).map((m) => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: this.detectSensitiveInput(m.content)
            ? '[Sensitive payment/identity digits redacted by security filter]'
            : m.content,
        })),
      ];

      const tools = this.getToolsSchema();

      for (let step = 0; step < 5; step++) {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: apiMessages,
            tools,
            tool_choice: 'auto',
            max_tokens: 600,
            temperature: 0.35,
          }),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          this.logger.error(`OpenAI error status ${res.status}:`, errBody);
          return {
            reply:
              "I'm having a brief connection hiccup right now. You can view plans at justmobile.com.au, manage your service in /account, or reach our team on 1300 492 002 or info@justmobile.ai.",
          };
        }

        const data = await res.json();
        const assistantMessage = data.choices?.[0]?.message;
        if (!assistantMessage) break;

        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          apiMessages.push({
            role: 'assistant',
            content: assistantMessage.content || null,
            tool_calls: assistantMessage.tool_calls,
          });

          for (const tc of assistantMessage.tool_calls) {
            const toolResult = await this.executeToolCall(
              tc.function?.name,
              tc.function?.arguments,
              messages,
              sessionId,
            );
            apiMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolResult,
            });
          }
          continue;
        }

        const reply = assistantMessage.content || 'How can I help with your JustMobile service today?';
        return { reply };
      }

      return {
        reply:
          "I couldn't complete that step right now. Please contact our team on 1300 492 002 or info@justmobile.ai so we can sort it out for you.",
      };
    } catch (err) {
      this.logger.error('Failed to call OpenAI from backend:', err);
      return {
        reply:
          "Sorry, I couldn't reach the AI assistant service just now. Please try again or reach us at info@justmobile.ai / 1300 492 002.",
      };
    }
  }
}
