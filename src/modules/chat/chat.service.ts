import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { MailService } from '../mail/mail.service';
import { CarrierService } from '../carrier/carrier.service';
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
    const numericOnly = identifier.replace(/\D+/g, '');
    const numericVal = numericOnly ? parseInt(numericOnly, 10) : NaN;

    const orClauses: any[] = [
      { custNo: cleanUpper },
      { custNo: numericOnly },
      { custNo: `CUST${numericOnly}` },
      { phone: identifier },
      { phone: numericOnly },
    ];
    if (!isNaN(numericVal)) {
      orClauses.push({ custNo: numericVal });
    }

    const user = await usersCol.findOne({ $or: orClauses });
    if (user) return user;

    // Fallback: match by msn inside orders collection
    if (numericOnly.length >= 8) {
      const ordersCol = this.db.getCollection('orders');
      const order = await ordersCol.findOne({
        $or: [{ msn: identifier }, { msn: numericOnly }],
      });
      if (order?.custNo) {
        return usersCol.findOne({ custNo: String(order.custNo) });
      }
    }

    return null;
  }

  private async hasRecentVerifiedChatSession(custNo: string): Promise<boolean> {
    if (!custNo) return false;
    const verificationsCol = this.db.getCollection('email_verifications');
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const verified = await verificationsCol.findOne({
      custNo: String(custNo),
      type: 'chat_otp',
      verifiedAt: { $gte: cutoff },
    });
    return Boolean(verified);
  }

  private getToolsSchema() {
    return [
      {
        type: 'function',
        function: {
          name: 'lookup_account',
          description:
            'Locate a customer account by mobile number, email, or Customer Number without exposing any personal details before OTP verification.',
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
            'Verify the 6-digit OTP provided by the customer. Enforces expiry and retry limits, and returns masked account summary upon success.',
          parameters: {
            type: 'object',
            properties: {
              identifier: {
                type: 'string',
                description: 'Customer Number, email, or mobile number.',
              },
              code: {
                type: 'string',
                description: '6-digit OTP entered by the customer.',
              },
            },
            required: ['identifier', 'code'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'update_account_details',
          description:
            'Update non-high-risk account details (preferredName, residential address/suburb/state/postcode, postalAddress, commPreference, marketingConsent) ONLY after OTP verification.',
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
          name: 'lodge_complaint_or_support_case',
          description:
            'Log a formal complaint (CMP-JM-...), support ticket (TKT-JM-...), billing dispute (BQ-JM-...), payment arrangement, or human/fraud/hardship escalation while preserving conversation context. Does NOT require prior OTP verification or account lookup — call immediately when a user asks to lodge a complaint, dispute, or escalation with a summary of the issue.',
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
              referenceId: { type: 'string', description: 'Order ID, CMP-JM-..., TKT-JM-..., or BQ-JM-...' },
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
  ): Promise<string> {
    let args: Record<string, any> = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return JSON.stringify({ error: 'Invalid tool arguments.' });
    }

    try {
      if (name === 'lookup_account') {
        const user = await this.findCustomerByIdentifier(args.identifier);
        if (!user) {
          return JSON.stringify({
            found: false,
            message: 'No matching account found. Ask the customer to double-check their Customer Number, mobile number, or email.',
          });
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
          email: user.email.toLowerCase(),
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
          { email: user.email.toLowerCase(), type: 'chat_otp', used: false },
          { $set: { used: true } },
        );
        await verificationsCol.insertOne({
          email: user.email.toLowerCase(),
          custNo: String(user.custNo || ''),
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
          { email: user.email.toLowerCase(), type: 'chat_otp', used: false },
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

        await verificationsCol.updateOne(
          { _id: record._id },
          { $set: { used: true, verifiedAt: new Date(), custNo: String(user.custNo || '') } },
        );

        const custNo = String(user.custNo || '');
        const [services, balance, usage, orders, invoices] = await Promise.all([
          custNo ? this.carrierService.getServices(custNo).catch(() => ({ services: [] })) : { services: [] },
          custNo ? this.carrierService.getBalance(custNo).catch(() => null) : null,
          custNo ? this.carrierService.getUnbilledUsage(custNo).catch(() => null) : null,
          custNo ? this.carrierService.getCustomerOrders(custNo).catch(() => []) : [],
          custNo
            ? this.db.getCollection('invoices').find({ custNo }).sort({ issueDate: -1 }).limit(3).toArray()
            : [],
        ]);

        return JSON.stringify({
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
        });
      }

      if (name === 'update_account_details') {
        const custNo = String(args.custNo || '').trim();
        const isVerified = await this.hasRecentVerifiedChatSession(custNo);
        if (!isVerified) {
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
        if (args.marketingConsent !== undefined) updateSet.marketingConsent = Boolean(args.marketingConsent);

        const usersCol = this.db.getCollection('users');
        await usersCol.updateOne({ custNo }, { $set: updateSet });
        const referenceNumber = `UPD-JM-${Math.floor(100000 + Math.random() * 900000)}`;

        return JSON.stringify({
          success: true,
          referenceNumber,
          effectiveTiming: 'Immediately',
          message: 'Account details updated in database.',
        });
      }

      if (name === 'change_plan') {
        const custNo = String(args.custNo || '').trim();
        const isVerified = await this.hasRecentVerifiedChatSession(custNo);
        if (!isVerified) {
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
        return JSON.stringify({
          success: true,
          referenceNumber,
          planName: target.name,
          monthlyFee: target.price,
          effectiveDate: 'Quota updated immediately; next invoice on the 28th reflects the new monthly rate.',
          backendMessage: res.message,
        });
      }

      if (name === 'suspend_service') {
        const custNo = String(args.custNo || '').trim();
        const isVerified = await this.hasRecentVerifiedChatSession(custNo);
        if (!isVerified) {
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

        const sanitizedTranscript = conversationMessages.slice(-10).map((m) => ({
          role: m.role,
          content: String(m.content || '').replace(/\b(?:\d[ -]*?){13,16}\b/g, '[REDACTED CARD]'),
        }));

        await this.db.getCollection('audit_events').insertOne({
          recordType: args.caseType || 'support_ticket',
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
          const [order, auditRecord] = await Promise.all([
            this.db.getCollection('orders').findOne({ orderId: ref }),
            this.db.getCollection('audit_events').findOne({ $or: [{ referenceNumber: ref }, { queryId: ref }] }),
          ]);
          const found = order || auditRecord;
          if (!found) {
            return JSON.stringify({ found: false, message: `No record found for reference ${ref}.` });
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
          const isVerified = await this.hasRecentVerifiedChatSession(String(args.custNo));
          if (!isVerified) {
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

  async generateResponse(messages: Array<{ role: string; content: string }>) {
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

    const systemContent = containsSensitive
      ? `${BELE_SYSTEM_PROMPT}\n\n[SECURITY ALERT: The user's last message appears to contain sensitive card/PIN/ID details. Immediately warn them NOT to share card numbers, CVVs, PINs, or identity numbers in chat, do NOT repeat those numbers back, and direct them to /account or 1300 492 002.]`
      : BELE_SYSTEM_PROMPT;

    try {
      const apiMessages: ChatMessage[] = [
        { role: 'system', content: systemContent },
        ...messages.slice(-12).map((m) => ({
          role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: this.detectSensitiveInput(m.content)
            ? '[Sensitive payment/identity digits redacted by security filter]'
            : m.content,
        })),
      ];

      const tools = this.getToolsSchema();

      for (let step = 0; step < 4; step++) {
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
            max_tokens: 450,
            temperature: 0.4,
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
