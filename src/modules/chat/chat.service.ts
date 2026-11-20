import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { MailService } from '../mail/mail.service';
import { CarrierService } from '../carrier/carrier.service';
import { InvoiceService } from '../carrier/invoice.service';
import { AuthService } from '../auth/auth.service';
import { BELE_SYSTEM_PROMPT } from './chat-prompt';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: any[];
}

const PLAN_CATALOGUE = [
  { id: 'plan-10gb', planNo: '11144153', name: 'JM 10GB Auto', price: 20.54, dataGb: 10 },
  { id: 'plan-15gb', planNo: '11144154', name: 'JM 15GB Auto', price: 24.6, dataGb: 15 },
  { id: 'plan-29gb', planNo: '11144155', name: 'JM 29GB Auto', price: 28.53, dataGb: 29 },
  { id: 'plan-65gb', planNo: '11144157', name: 'JM 65GB Auto', price: 37.55, dataGb: 65 },
  { id: 'plan-100gb', planNo: '11144168', name: 'JM 100GB Auto', price: 46.4, dataGb: 100 },
  { id: 'plan-120gb', planNo: '11144169', name: 'JM 120GB Auto', price: 54.86, dataGb: 120 },
  { id: 'plan-150gb', planNo: '11144170', name: 'JM 150GB Auto', price: 59.89, dataGb: 150 },
  { id: 'plan-180gb', planNo: '11156014', name: 'JM 180GB Auto', price: 67.0, dataGb: 180 },
];

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly mailService: MailService,
    private readonly carrierService: CarrierService,
    private readonly invoiceService: InvoiceService,
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
  ) {}

  private normalizeChatMsn(raw?: string): string {
    const digits = String(raw || '').replace(/\D+/g, '');
    if (digits.startsWith('614') && digits.length >= 11) {
      return `0${digits.slice(2, 11)}`;
    }
    if (digits.startsWith('4') && digits.length === 9) {
      return `0${digits}`;
    }
    return digits;
  }

  private normalizeChatDob(raw?: string): string {
    const clean = String(raw || '').trim();
    if (!clean) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
    const dmy = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
      const [, dd, mm, yyyy] = dmy;
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
    return clean;
  }

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
    const [services, balance, usage, orders, invoices, liveCustomer] = await Promise.all([
      custNo ? this.carrierService.getServices(custNo).catch(() => ({ services: [] })) : { services: [] },
      custNo ? this.carrierService.getBalance(custNo).catch(() => null) : null,
      custNo ? this.carrierService.getUnbilledUsage(custNo).catch(() => null) : null,
      custNo ? this.carrierService.getCustomerOrders(custNo).catch(() => []) : [],
      custNo ? this.invoiceService.getCustomerInvoices(custNo).catch(() => []) : [],
      custNo && typeof this.carrierService?.getCustomer === 'function'
        ? this.carrierService.getCustomer(custNo).catch(() => null)
        : null,
    ]);

    const rawPhone = user.phone || liveCustomer?.phone || '';
    const registeredPhone = this.normalizeChatMsn(rawPhone);
    const dobOnFile = this.normalizeChatDob(user.dob || liveCustomer?.dob || '');
    const streetAddress = user.address || liveCustomer?.address || '';
    const suburb = user.suburb || liveCustomer?.suburb || '';
    const state = user.state || liveCustomer?.state || '';
    const postcode = user.postcode || liveCustomer?.postcode || '';
    const fullAddress = streetAddress
      ? `${streetAddress}${suburb ? `, ${suburb}` : ''}${state ? ` ${state}` : ''}${postcode ? ` ${postcode}` : ''}`.trim()
      : 'Not set';

    return {
      verified: true,
      custNo,
      name: user.name || liveCustomer?.name,
      preferredName: user.preferredName || user.firstName || user.name || liveCustomer?.firstName,
      maskedEmail: this.maskEmail(user.email || liveCustomer?.email || ''),
      maskedPhone: this.maskPhone(rawPhone),
      registeredPhone: /^04\d{8}$/.test(registeredPhone) ? registeredPhone : null,
      dobOnFile: dobOnFile || null,
      address: fullAddress,
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
          name: 'cancel_pending_port_transfer',
          description:
            'Cancel an in-progress or pending mobile number transfer (port-in) order via Octane orderCancel (requires OTP verification and explicit customer confirmation).',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              orderId: { type: 'string', description: 'Optional specific port order ID' },
              confirmed: { type: 'boolean', description: 'True only after customer explicitly confirms' },
              reason: { type: 'string' },
            },
            required: ['custNo', 'confirmed'],
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
          name: 'resend_esim_qr',
          description:
            'Resend an eSIM activation QR code email OR issue a brand-new replacement eSIM QR code (set replaceProfile: true when the customer accidentally deleted/removed their eSIM or switched phones) after OTP verification.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              orderId: { type: 'string', description: 'Optional specific orderId' },
              msn: { type: 'string', description: 'Optional 10-digit mobile number' },
              replaceProfile: {
                type: 'boolean',
                description: 'Set true ONLY after explicit customer confirmation to issue a brand-new replacement eSIM profile/QR (invalidates prior active QR)',
              },
              reason: { type: 'string', description: 'Optional reason for replacement' },
              confirmed: {
                type: 'boolean',
                description: 'Required (true) when replaceProfile is true after the customer explicitly confirms replacement',
              },
            },
            required: ['custNo'],
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
      {
        type: 'function',
        function: {
          name: 'send_signup_verification_code',
          description:
            'Send a 6-digit email verification code to register a brand new JustMobile customer inside chat.',
          parameters: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'New customer email address' },
            },
            required: ['email'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'register_new_customer',
          description:
            'Complete customer registration with Octane and MongoDB after verifying the 6-digit signup email OTP. Automatically verifies the current chat session for the new customer.',
          parameters: {
            type: 'object',
            properties: {
              firstName: { type: 'string' },
              surname: { type: 'string' },
              email: { type: 'string' },
              phone: { type: 'string', description: 'Optional existing Australian mobile number or empty if getting a new number' },
              dob: { type: 'string', description: 'Date of birth in YYYY-MM-DD or DD/MM/YYYY format' },
              address: { type: 'string', description: 'Australian street address' },
              suburb: { type: 'string' },
              state: { type: 'string', description: 'Australian state code e.g. NSW, VIC, QLD, SA, WA, TAS, ACT, NT' },
              postcode: { type: 'string', description: '4-digit Australian postcode' },
              password: { type: 'string', description: 'Account password (minimum 6 characters) for signing into My Account' },
              code: { type: 'string', description: '6-digit email verification code' },
            },
            required: ['firstName', 'surname', 'email', 'dob', 'address', 'suburb', 'state', 'postcode', 'password', 'code'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_available_numbers',
          description:
            'Fetch live available 04XX mobile numbers from Telstra Wholesale reserve pool so a verified customer can pick a new number in chat.',
          parameters: {
            type: 'object',
            properties: {
              qty: { type: 'number', description: 'Number of options to return (default 5)' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'check_port_eligibility',
          description: 'Validate whether an existing Australian 04XX mobile number is eligible for number transfer (port-in).',
          parameters: {
            type: 'object',
            properties: {
              number: { type: 'string', description: 'Australian 04XX mobile number' },
            },
            required: ['number'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'send_port_sms_otp',
          description:
            'Send ACMA mandatory pre-port SMS 2FA OTP to the customer existing 04XX mobile number before transferring it (requires verified chat session). Omit destination only if using the unmasked registeredPhone already saved on the verified customer profile.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              destination: {
                type: 'string',
                description:
                  'Unmasked 10-digit Australian 04XX mobile number being transferred (optional if using saved registeredPhone on file)',
              },
            },
            required: ['custNo'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'verify_port_sms_otp',
          description:
            'Verify the 6-digit ACMA pre-port SMS OTP entered by the customer before opening QuickStream payment checkout.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              code: { type: 'string' },
              transactionId: { type: 'string' },
            },
            required: ['custNo', 'code'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'open_quickstream_card_form',
          description:
            'Open the secure Westpac QuickStream card iframe right inside the chat widget so the customer can register their Direct Debit card in Octane (never collect card details as chat text). For new_order or port_order, activation proceeds immediately after the card is saved.',
          parameters: {
            type: 'object',
            properties: {
              custNo: { type: 'string' },
              purpose: { type: 'string', enum: ['new_order', 'port_order', 'update_card'] },
              planName: { type: 'string', description: 'Required for new_order or port_order e.g. JM 65GB Auto' },
              msn: { type: 'string', description: 'Selected 04XX number or porting number (required for new_order / port_order)' },
              numType: { type: 'string', enum: ['prepaid', 'postpaid'], description: 'Required for port_order' },
              donorCarrier: { type: 'string', description: 'Current carrier e.g. Telstra, Optus, Vodafone' },
              arn: { type: 'string', description: 'Postpaid account number (required for postpaid port_order)' },
              dob: { type: 'string', description: 'Date of birth YYYY-MM-DD (required for prepaid port_order)' },
            },
            required: ['custNo', 'purpose'],
          },
        },
      },
    ];
  }

  async executeToolCall(
    name: string,
    rawArgs: string,
    conversationMessages: Array<{ role: string; content: string }>,
    sessionId?: string,
    onUiAction?: (action: any) => void,
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
        const updateSet: Record<string, any> = { updatedAt: new Date() };
        if (args.newEmail || rec.newEmail) updateSet.email = String(args.newEmail || rec.newEmail).trim().toLowerCase();
        if (args.newPhone || rec.newPhone) updateSet.phone = String(args.newPhone || rec.newPhone).trim();

        await this.carrierService.updateCustomerDetails(custNo, {
          ...(updateSet.email !== undefined ? { email: updateSet.email } : {}),
          ...(updateSet.phone !== undefined ? { phone: updateSet.phone } : {}),
        });
        await this.db.getCollection('email_verifications').updateOne({ _id: rec._id }, { $set: { used: true } });
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

        await this.carrierService.updateCustomerDetails(custNo, {
          ...(updateSet.address !== undefined ? { address: updateSet.address } : {}),
          ...(updateSet.suburb !== undefined ? { suburb: updateSet.suburb } : {}),
          ...(updateSet.state !== undefined ? { state: updateSet.state } : {}),
          ...(updateSet.postcode !== undefined ? { postcode: updateSet.postcode } : {}),
          ...(updateSet.postalAddress !== undefined ? { postalAddress: updateSet.postalAddress } : {}),
          ...(updateSet.commPreference !== undefined ? { commPreference: updateSet.commPreference } : {}),
        });

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
          carrierOrderId: res.carrierOrderId || null,
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
        await this.carrierService.cancelOrder(
          custNo,
          pending.carrierOrderId,
          `Customer cancelled pending plan change ${pending.referenceNumber}`,
        );
        await this.db.getCollection('plan_changes').updateOne(
          { _id: pending._id },
          { $set: { status: 'CANCELLED', cancelledAt: new Date() } },
        );
        return JSON.stringify({
          cancelled: true,
          referenceNumber: pending.referenceNumber,
          message: `Pending plan change (${pending.planName}) cancelled with the carrier. Your original plan remains active.`,
        });
      }

      if (name === 'cancel_pending_port_transfer') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required first.' });
        }
        const ordersCol = this.db.getCollection('orders');
        const targetOrder = args.orderId
          ? await ordersCol.findOne({ custNo, orderId: String(args.orderId).trim(), orderType: 'PORT_IN' })
          : await ordersCol.findOne(
              { custNo, orderType: 'PORT_IN', status: { $in: ['PENDING', 'PORT_IN_PROGRESS'] } },
              { sort: { createdAt: -1 } },
            );

        if (!targetOrder) {
          return JSON.stringify({
            cancelled: false,
            message: 'No pending or in-progress mobile number transfer found on your account.',
          });
        }
        if (args.confirmed !== true) {
          return JSON.stringify({
            requiresConfirmation: true,
            orderId: targetOrder.orderId,
            msn: targetOrder.msn,
            status: targetOrder.status,
            message: `Please confirm you want to cancel your pending number transfer for ${targetOrder.msn} (Order #${targetOrder.orderId}).`,
          });
        }

        const res = await this.carrierService.cancelPortOrder(custNo, targetOrder.orderId, args.reason);
        const user = await this.findCustomerByIdentifier(custNo);
        const emailSent = user?.email
          ? await this.mailService.sendCustomerNotificationEmail(
              user.email,
              `JustMobile Number Transfer Cancelled (${res.orderId})`,
              `Your pending mobile number transfer for ${res.msn} (Order #${res.orderId}) has been cancelled as requested.`,
            )
          : false;

        return JSON.stringify({
          cancelled: true,
          orderId: res.orderId,
          msn: res.msn,
          writtenConfirmationSent: emailSent,
          message: res.message,
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
              `Here is a summary of your ATO Tax Invoice ${target.invoiceId} (${target.periodStart} to ${target.periodEnd}):\nPlan: ${target.planName}\nTotal (incl. GST): $${Number(target.amount).toFixed(2)}\nStatus: ${target.status}\n\nYou can download the full PDF anytime in My Account -> Billing & Payment Method at justmobile.com.au.`,
            )
          : false;

        return JSON.stringify({
          found: true,
          invoiceId: target.invoiceId,
          amount: target.amount,
          status: target.status,
          downloadInstructions:
            'Sign into [My Account](/account) -> Billing & Payment Method to download the full ATO PDF tax invoice.',
          portalPath: '/account',
          emailed,
        });
      }

      if (name === 'resend_esim_qr') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ success: false, error: 'OTP verification required first.' });
        }
        if (args.replaceProfile) {
          if (!args.confirmed) {
            return JSON.stringify({
              success: false,
              error: 'Issuing a replacement eSIM replaces/invalidates the previous eSIM QR. Confirm with the customer first before calling resend_esim_qr with replaceProfile: true and confirmed: true.',
            });
          }
          const user = await this.findCustomerByIdentifier(custNo);
          const rep = await this.carrierService.replaceEsimProfile(custNo, {
            msn: args.msn,
            reason: args.reason || 'Requested replacement eSIM via verified Bele chat',
            email: user?.email,
          });
          return JSON.stringify({
            sent: true,
            replaced: true,
            referenceNumber: rep.referenceNumber,
            orderId: rep.orderId,
            lpa: rep.lpa,
            smdpAddress: rep.smdpAddress,
            activationCode: rep.activationCode,
            emailDispatched: rep.emailSent,
            carrierDispatchedEmail: rep.carrierDispatchedEmail,
            maskedEmail: this.maskEmail(user?.email || rep.email || ''),
            message: rep.message,
          });
        }
        const orders = await this.carrierService.getCustomerOrders(custNo);
        const order =
          (args.orderId && orders.find((o) => o.orderId === args.orderId)) || orders[0];
        if (!order && custNo !== 'CUST990001') {
          return JSON.stringify({
            sent: false,
            error: 'No existing eSIM order found on this account yet. Complete an order in chat or [My Account](/account) first.',
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
        if (!qr && !emailRes?.success) {
          return JSON.stringify({
            sent: false,
            error:
              'Your eSIM QR code is not ready from the carrier yet. Please try again shortly or confirm if you want to issue a replacement eSIM.',
          });
        }
        return JSON.stringify({
          sent: true,
          orderId: qr?.orderId || targetId,
          lpa: qr?.lpa,
          smdpAddress: qr?.smdpAddress,
          emailDispatched: Boolean(emailRes?.success),
          maskedEmail: this.maskEmail(user?.email || ''),
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

      if (name === 'send_signup_verification_code') {
        const cleanEmail = String(args.email || '').trim().toLowerCase();
        const res = await this.authService.sendVerificationCode(cleanEmail, 'signup');
        return JSON.stringify({
          sent: true,
          email: cleanEmail,
          message: `${res.message} Ask the customer for the 6-digit verification code from their inbox to complete registration.`,
        });
      }

      if (name === 'register_new_customer') {
        const signupRes = await this.authService.signup({
          custType: 'R',
          firstName: String(args.firstName || '').trim(),
          surname: String(args.surname || '').trim(),
          name: `${String(args.firstName || '').trim()} ${String(args.surname || '').trim()}`.trim(),
          email: String(args.email || '').trim(),
          phone: args.phone ? this.normalizeChatMsn(args.phone) : '',
          password: String(args.password || ''),
          dob: this.normalizeChatDob(args.dob),
          address: String(args.address || '').trim(),
          suburb: String(args.suburb || '').trim(),
          state: String(args.state || '').trim().toUpperCase(),
          postcode: String(args.postcode || '').trim(),
          code: String(args.code || '').trim(),
        });

        const assignedCustNo = String(signupRes?.user?.custNo || '');
        if (assignedCustNo) {
          await this.db.getCollection('chat_sessions').updateOne(
            { sessionId: cleanSessionId },
            {
              $set: {
                sessionId: cleanSessionId,
                custNo: assignedCustNo,
                active: true,
                verifiedAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
                updatedAt: new Date(),
              },
            },
            { upsert: true },
          );
        }

        return JSON.stringify({
          registered: true,
          custNo: assignedCustNo,
          name: signupRes?.user?.name,
          email: signupRes?.user?.email,
          portalHint: 'Customer can also sign in via [Sign In](/login) and manage their service in [My Account](/account) anytime.',
          message: signupRes?.message || `Customer account #${assignedCustNo} created and verified.`,
        });
      }

      if (name === 'get_available_numbers') {
        const res = await this.carrierService.reserveNumbers(Number(args.qty) || 5);
        return JSON.stringify({
          numbers: res?.numbers || [],
        });
      }

      if (name === 'check_port_eligibility') {
        const msn = this.normalizeChatMsn(args.number);
        const res = await this.carrierService.checkNumber(msn);
        return JSON.stringify(res);
      }

      if (name === 'send_port_sms_otp') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ sent: false, error: 'Identity verification required first.' });
        }

        let rawDest = String(args.destination || '').trim();
        let destination =
          rawDest && !rawDest.includes('*') ? this.normalizeChatMsn(rawDest) : '';

        if (!/^04\d{8}$/.test(destination)) {
          const customer = await this.findCustomerByIdentifier(custNo);
          destination = this.normalizeChatMsn(customer?.phone || '');
          if (!/^04\d{8}$/.test(destination) && typeof this.carrierService?.getCustomer === 'function') {
            const liveCust = await this.carrierService.getCustomer(custNo).catch(() => null);
            destination = this.normalizeChatMsn(liveCust?.phone || '');
          }
        }

        if (!/^04\d{8}$/.test(destination)) {
          return JSON.stringify({
            sent: false,
            missingNumber: true,
            error:
              'No valid 10-digit 04XX Australian mobile number was provided or stored on the account. Ask the customer for the exact 04XX mobile number they want to transfer.',
          });
        }

        const res = await this.carrierService.sendPrePortOtp(custNo, destination);
        await this.db.getCollection('chat_sessions').updateOne(
          { sessionId: cleanSessionId, active: true },
          {
            $set: {
              portOtpTransactionId: res.transactionId,
              portOtpDestination: destination,
              portOtpVerified: false,
              updatedAt: new Date(),
            },
          },
        );
        return JSON.stringify({
          sent: true,
          transactionId: res.transactionId,
          destination,
          message: res.message,
        });
      }

      if (name === 'verify_port_sms_otp') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ verified: false, error: 'Identity verification required first.' });
        }
        const sessionDoc: any = await this.db
          .getCollection('chat_sessions')
          .findOne({ sessionId: cleanSessionId, active: true, expiresAt: { $gt: new Date() } });
        const txId = String(args.transactionId || sessionDoc?.portOtpTransactionId || '').trim();
        if (!txId) {
          return JSON.stringify({ verified: false, error: 'No SMS OTP session found. Please call send_port_sms_otp first.' });
        }
        const res = await this.carrierService.verifyPrePortOtp(txId, String(args.code || ''));
        await this.db.getCollection('chat_sessions').updateOne(
          { sessionId: cleanSessionId, active: true },
          {
            $set: {
              portOtpVerified: true,
              portOtpVerifiedNumber: sessionDoc?.portOtpDestination || '',
              updatedAt: new Date(),
            },
          },
        );
        return JSON.stringify({
          verified: Boolean(res?.verified),
          transactionId: txId,
          destination: sessionDoc?.portOtpDestination || '',
          message: res.message,
        });
      }

      if (name === 'open_quickstream_card_form') {
        const custNo = String(args.custNo || '').trim();
        if (!(await this.hasRecentVerifiedChatSession(custNo, cleanSessionId))) {
          return JSON.stringify({ opened: false, error: 'Please verify your account or register first.' });
        }

        const purpose = String(args.purpose || 'new_order') as 'new_order' | 'port_order' | 'update_card';
        if (!['new_order', 'port_order', 'update_card'].includes(purpose)) {
          return JSON.stringify({ opened: false, error: 'Invalid payment form purpose.' });
        }

        if (purpose === 'update_card') {
          const authToken = await this.authService.issueTokenForCustomer(custNo);
          onUiAction?.({
            type: 'QUICKSTREAM_PAYMENT',
            custNo,
            authToken,
            purpose: 'update_card',
            planName: 'JustMobile Direct Debit (Billing Cycle 28th)',
          });
          return JSON.stringify({
            opened: true,
            purpose: 'update_card',
            message: 'Secure Westpac QuickStream payment card form opened below in chat. Customer can also manage cards anytime in [My Account](/account).',
          });
        }

        const rawPlan = String(args.planName || '').toLowerCase();
        const plan =
          PLAN_CATALOGUE.find((p) => p.name.toLowerCase() === rawPlan || p.id.toLowerCase() === rawPlan) ||
          PLAN_CATALOGUE.find((p) => rawPlan.includes(`${p.dataGb}gb`) || rawPlan.includes(String(p.dataGb)));
        if (!plan) {
          return JSON.stringify({
            opened: false,
            error: 'Please select a valid JustMobile plan (10GB, 15GB, 29GB, 65GB, 100GB, 120GB, 150GB, or 180GB) first.',
          });
        }

        const customer = await this.findCustomerByIdentifier(custNo);
        const liveCustomer =
          (!customer?.dob || !customer?.phone || !customer?.address) &&
          typeof this.carrierService?.getCustomer === 'function'
            ? await this.carrierService.getCustomer(custNo).catch(() => null)
            : null;
        const sessionDoc: any = await this.db
          .getCollection('chat_sessions')
          .findOne({ sessionId: cleanSessionId, active: true, expiresAt: { $gt: new Date() } });

        const rawMsn = String(args.msn || '').trim();
        let msn =
          rawMsn && !rawMsn.includes('*') ? this.normalizeChatMsn(rawMsn) : '';
        if (!/^04\d{8}$/.test(msn)) {
          if (purpose === 'port_order' && sessionDoc?.portOtpVerifiedNumber) {
            msn = this.normalizeChatMsn(sessionDoc.portOtpVerifiedNumber);
          } else {
            msn = this.normalizeChatMsn(customer?.phone || liveCustomer?.phone || '');
          }
        }
        if (!msn || !/^04\d{8}$/.test(msn)) {
          return JSON.stringify({
            opened: false,
            error: 'Please select an available 04XX mobile number or provide your 10-digit Australian mobile number first.',
          });
        }

        let numType: 'prepaid' | 'postpaid' | undefined;
        let cleanDob: string | undefined;
        let cleanArn: string | undefined;

        if (purpose === 'port_order') {
          numType = args.numType === 'prepaid' ? 'prepaid' : args.numType === 'postpaid' ? 'postpaid' : undefined;
          if (!numType) {
            return JSON.stringify({ opened: false, error: 'Please specify whether your existing number is prepaid or postpaid.' });
          }
          cleanDob = this.normalizeChatDob(args.dob || customer?.dob || liveCustomer?.dob || '');
          cleanArn = String(args.arn || '').trim();
          if (numType === 'prepaid' && !cleanDob) {
            return JSON.stringify({ opened: false, error: 'Date of Birth is required for prepaid number transfers.' });
          }
          if (numType === 'postpaid' && !cleanArn) {
            return JSON.stringify({ opened: false, error: 'Current provider Account Number is required for postpaid number transfers.' });
          }

          if (!sessionDoc?.portOtpVerified || (sessionDoc?.portOtpVerifiedNumber && sessionDoc.portOtpVerifiedNumber !== msn)) {
            return JSON.stringify({
              opened: false,
              requiresPortOtp: true,
              error: `ACMA SMS OTP verification is required on ${msn} before opening payment checkout. Call send_port_sms_otp and verify_port_sms_otp first.`,
            });
          }

          const existingPendingPort = await this.db.getCollection('orders').findOne({
            msn,
            orderType: 'PORT_IN',
            status: { $in: ['PENDING', 'PORT_IN_PROGRESS'] },
          });
          if (existingPendingPort) {
            return JSON.stringify({
              opened: false,
              duplicatePort: true,
              error: `A mobile number transfer for ${msn} is already in progress (Order #${existingPendingPort.orderId}). Please wait for completion or cancel it first.`,
            });
          }
        }

        const authToken = await this.authService.issueTokenForCustomer(custNo);
        const orderDraft = {
          custNo,
          msn,
          planNo: plan.planNo,
          planName: plan.name,
          pricePerMonth: plan.price,
          email: customer?.email || liveCustomer?.email || '',
          firstName:
            customer?.firstName ||
            liveCustomer?.firstName ||
            String(customer?.name || liveCustomer?.name || '').split(' ')[0] ||
            '',
          lastName:
            customer?.surname ||
            liveCustomer?.surname ||
            String(customer?.name || liveCustomer?.name || '')
              .split(' ')
              .slice(1)
              .join(' ') ||
            '',
          address: customer?.address || liveCustomer?.address || '',
          suburb: customer?.suburb || liveCustomer?.suburb || '',
          state: customer?.state || liveCustomer?.state || 'NSW',
          postcode: customer?.postcode || liveCustomer?.postcode || '',
          ...(purpose === 'port_order'
            ? {
                numType,
                donorCarrier: args.donorCarrier || 'Optus',
                ...(numType === 'prepaid' ? { dob: cleanDob } : { arn: cleanArn }),
              }
            : {}),
        };

        onUiAction?.({
          type: 'QUICKSTREAM_PAYMENT',
          custNo,
          authToken,
          purpose,
          planName: plan.name,
          planNo: plan.planNo,
          planPrice: plan.price,
          orderDraft,
        });

        return JSON.stringify({
          opened: true,
          purpose,
          planName: plan.name,
          planPrice: plan.price,
          msn,
          message:
            'The secure Westpac QuickStream payment card form is now open inline below inside this chat window. Ask the customer to complete card setup inside the secure frame to activate their eSIM (they can also visit [My Account](/account) anytime).',
        });
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
      ? `${BELE_SYSTEM_PROMPT}\n\n[SECURITY ALERT: The user's last message appears to contain sensitive card/PIN/ID details. Immediately warn them NOT to share card numbers, CVVs, PINs, or identity numbers in chat, do NOT repeat those numbers back, and direct them to [My Account](/account) or 1300 492 002.]`
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
      let pendingUiAction: any = null;

      for (let step = 0; step < 6; step++) {
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
            max_tokens: 750,
            temperature: 0.35,
          }),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          this.logger.error(`OpenAI error status ${res.status}:`, errBody);
          return {
            reply:
              "I'm having a brief connection hiccup right now. You can view plans at justmobile.com.au, manage your service in [My Account](/account), or reach our team on 1300 492 002 or info@justmobile.ai.",
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
              (action) => {
                pendingUiAction = action;
              },
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
        return {
          reply,
          ...(pendingUiAction ? { uiAction: pendingUiAction } : {}),
        };
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
