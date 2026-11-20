import { Injectable, Logger, BadRequestException, HttpException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { MailService } from '../mail/mail.service';
import * as soap from 'soap';
import * as QRCode from 'qrcode';

export interface CarrierCustomerInput {
  firstName: string;
  surname: string;
  email: string;
  phone: string;
  dob: string;
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  custType?: string;
  company?: string;
  abn?: string;
  preferredContactMethod?: string;
  orderNotificationEmail?: string;
  internetAccess?: string;
  agent_id?: string;
}

export interface ActivateOrderInput {
  custNo: string;
  msn: string;
  planNo?: string;
  planName?: string;
  pricePerMonth?: number;
  email?: string;
  firstName?: string;
  lastName?: string;
  address?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
}

export interface ActivatePortOrderInput extends ActivateOrderInput {
  numType: 'prepaid' | 'postpaid';
  dob?: string;
  arn?: string;
}

export interface OrderRecord {
  orderId: string;
  carrierOrderId?: string;
  previousOrderIds?: string[];
  custNo: string;
  msn: string;
  planNo: string;
  planName: string;
  pricePerMonth: number;
  status: 'PENDING' | 'ACTIVE' | 'PORT_IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'REJECTED' | 'CANCELLED';
  orderType: 'NEW_ACTIVATION' | 'PORT_IN' | 'PLAN_CHANGE' | 'ESIM_REPLACEMENT';
  orderAction: 'ADD_WME_NEW' | 'ADD_WME_PORT' | 'CHANGE_WME_PLAN' | 'CHANGE_WME_SIM';
  isEsim: boolean;
  isQRcode: boolean;
  lpaString?: string;
  activationCode?: string;
  numType?: 'prepaid' | 'postpaid';
  dob?: string;
  arn?: string;
  donorCarrier?: string;
  rejectionReason?: string | null;
  rejectionCode?: string | null;
  portRetries?: number;
  address?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  email?: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CarrierService {
  private readonly logger = new Logger(CarrierService.name);
  private readonly baseUrl: string;
  private readonly userName: string;
  private readonly password: string;
  private readonly benzineBaseUrl: string;
  private readonly benzineUserName: string;
  private readonly benzinePassword: string;
  private readonly groupNo: string;
  private readonly quickstreamApiKey: string;
  private cachedGroupPlans: { expiresAt: number; data: any[] } | null = null;
  private cachedOctaneCustomers: { expiresAt: number; map: Map<string, any> } | null = null;
  private readonly soapClientCache = new Map<string, Promise<any>>();

  private readonly OCTANE_RETAIL_PLANS = [
    { id: 'plan-15gb', planNo: '11144154', name: 'JM 15GB Auto', dataGb: 15, price: 31, network: '4G' },
    { id: 'plan-45gb', planNo: '11144156', name: 'JM 45GB Auto', dataGb: 45, price: 36, network: '5G' },
    { id: 'plan-65gb', planNo: '11144157', name: 'JM 65GB Auto', dataGb: 65, price: 40, network: '5G' },
    { id: 'plan-100gb', planNo: '11144168', name: 'JM 100GB Auto', dataGb: 100, price: 48, network: '5G' },
    { id: 'plan-120gb', planNo: '11144169', name: 'JM 120GB Auto', dataGb: 120, price: 57, network: '5G' },
    { id: 'plan-150gb', planNo: '11144170', name: 'JM 150GB Auto', dataGb: 150, price: 62, network: '5G' },
    { id: 'plan-180gb', planNo: '11156014', name: 'JM 180GB Auto', dataGb: 180, price: 67, network: '5G' },
  ];

  constructor(
    private readonly db: DatabaseService,
    private readonly mailService: MailService,
  ) {
    this.baseUrl = process.env.apiBaseUrl || 'https://api-octane.telcoinabox.com.au/tiabwsv2';
    this.userName = process.env.octaneUserName || '';
    this.password = process.env.octanePassword || '';
    this.benzineBaseUrl = process.env.benzineBaseUrl || 'https://benzine.telcoinabox.com:443/tiab';
    this.benzineUserName = process.env.benzineUserName || '';
    this.benzinePassword = process.env.benzinePassword || '';
    this.groupNo = process.env.groupNo || '';
    this.quickstreamApiKey = process.env.quickstreamApiKey || '';
  }

  private getLogin(endpoint?: string) {
    const isBenzine = endpoint && endpoint.includes('benzine');
    if (isBenzine) {
      return {
        userName: this.benzineUserName,
        password: this.benzinePassword,
      };
    }
    return {
      userName: this.userName,
      password: this.password,
    };
  }

  private getSoapClient(wsdlUrl: string): Promise<any> {
    if (!this.soapClientCache.has(wsdlUrl)) {
      const clientPromise = soap.createClientAsync(wsdlUrl).catch((err) => {
        this.soapClientCache.delete(wsdlUrl);
        throw err;
      });
      this.soapClientCache.set(wsdlUrl, clientPromise);
    }
    return this.soapClientCache.get(wsdlUrl)!;
  }

  private static readonly CARRIER_TIMEOUT_MS = 25000;

  /**
   * Generic SOAP call to Telcoinabox / Octane or Benzine WSDL
   */
  async soapCall<T = any>(endpoint: string, methodName: string, args: Record<string, any>): Promise<T> {
    const isBenzine = endpoint.includes('benzine');
    const base = isBenzine ? this.benzineBaseUrl : this.baseUrl;
    const wsdlUrl = `${base}${endpoint}?wsdl`;
    const login = this.getLogin(endpoint);
    const fullArgs = { ...args, login };

    this.logger.log(`Invoking Carrier SOAP: ${methodName} @ ${wsdlUrl}`);

    try {
      const client: any = await this.getSoapClient(wsdlUrl);
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.logger.error(`SOAP timeout executing ${methodName} after ${CarrierService.CARRIER_TIMEOUT_MS}ms`);
          reject(
            new InternalServerErrorException(
              'We are temporarily unable to reach our network provider. Please try again shortly.',
            ),
          );
        }, CarrierService.CARRIER_TIMEOUT_MS);

        client[methodName](fullArgs, (err: any, result: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) {
            this.logger.error(`SOAP error executing ${methodName}:`, err.message || err);
            return reject(
              new InternalServerErrorException(
                'We are temporarily unable to reach our network provider. Please try again shortly.',
              ),
            );
          }
          this.logger.log(`SOAP ${methodName} executed successfully`);
          resolve(result as T);
        });
      });
    } catch (err: any) {
      if (err instanceof HttpException) {
        throw err;
      }
      this.logger.error(`Failed to initialize SOAP client for ${wsdlUrl}:`, err.message);
      throw new InternalServerErrorException(
        'We are temporarily unable to reach our network provider. Please try again shortly.',
      );
    }
  }

  /**
   * Map raw Octane carrier error text to a clear, customer-friendly message while logging raw details server-side.
   */
  private formatFriendlyCarrierError(operation: string, rawDetail: string): string {
    const lower = (rawDetail || '').toLowerCase();
    if (/dob|birth|arn|account|transfer|port|mismatch/.test(lower)) {
      return 'We could not validate your transfer details with the carrier. Please check your details and try again, or contact 1300 492 002.';
    }
    if (/sim|iccid|esim/.test(operation.toLowerCase()) || /change_wme_sim|esim/i.test(operation)) {
      return 'We could not issue your replacement eSIM QR right now, and your existing service was not changed. Please try again shortly or contact 1300 492 002.';
    }
    if (/chg_plan|plan/i.test(operation)) {
      return 'We could not complete your plan change with our network provider right now, so your current plan stays active. Please try again shortly.';
    }
    if (/otp/i.test(operation)) {
      return 'We could not send or verify the SMS security code right now. Please try again in a moment.';
    }
    if (/addcustomer/i.test(operation)) {
      return 'We could not set up your account with our network provider right now, so nothing was saved. Please check your details and try again.';
    }
    if (/payment-method|payment/i.test(operation)) {
      return 'We could not register your payment method with our billing provider right now. Please check your card details and try again.';
    }
    return 'We could not complete this request with our network provider right now, and no changes were saved. Please try again shortly or contact 1300 492 002.';
  }

  private isBenignOctaneMessage(msg: any): boolean {
    const clean = String(msg || '').trim();
    return clean === '' || /^(web method processed successfully|success|ok)$/i.test(clean);
  }

  private hasOctaneFailure(payload: any): { failed: boolean; detail: string } {
    if (!payload || typeof payload !== 'object') {
      return { failed: true, detail: 'Empty or invalid response from Octane' };
    }
    const errorCode = payload?.errorCode;
    const hasNonZeroCode =
      errorCode !== undefined &&
      errorCode !== null &&
      String(errorCode).trim() !== '' &&
      String(errorCode).trim() !== '0';
    const isSuccessTrue =
      payload?.success === true ||
      String(payload?.success || '').trim().toLowerCase() === 'true';
    const isSuccessFalse =
      payload?.success === false ||
      String(payload?.success || '').trim().toLowerCase() === 'false';
    const rawStatus = String(payload?.status || payload?.resultStatus || '').trim().toUpperCase();
    const isFailedStatus = ['FAILED', 'FAILURE', 'ERROR', 'REJECTED'].includes(rawStatus);
    const errText =
      payload?.error?.message ||
      (typeof payload?.error === 'string' ? payload.error : '') ||
      payload?.errorMessage ||
      '';
    const hasErrorText =
      String(errText).trim() !== '' &&
      !(isSuccessTrue && !hasNonZeroCode && !isFailedStatus) &&
      !( !hasNonZeroCode && !isFailedStatus && this.isBenignOctaneMessage(errText) );

    if (hasNonZeroCode || isSuccessFalse || isFailedStatus || hasErrorText) {
      const detail =
        (String(errText).trim() || undefined) ||
        (isSuccessFalse || isFailedStatus ? payload?.message || rawStatus : undefined) ||
        (hasNonZeroCode ? `errorCode=${errorCode}` : 'Empty or invalid response from Octane');
      return { failed: true, detail: String(detail) };
    }
    return { failed: false, detail: '' };
  }

  private isSyntheticLpa(lpa?: string | null): boolean {
    return Boolean(lpa && /\$JM-(AU|REP)-/i.test(String(lpa)));
  }

  private parseActivationCodeString(
    rawCode: string,
    defaultSmdp = 'smdp.telcoinabox.com.au',
  ): { smdpAddress: string; activationCode: string; lpaString: string } | null {
    const clean = String(rawCode || '').trim();
    if (!clean) return null;
    const normalizedLpa = clean.startsWith('LPA:')
      ? clean
      : clean.startsWith('1$')
        ? `LPA:${clean}`
        : `LPA:1$${defaultSmdp}$${clean}`;
    const parts = normalizedLpa.split('$');
    const smdpAddress = parts[1] || defaultSmdp;
    const activationCode = parts[2] || clean;
    return { smdpAddress, activationCode, lpaString: normalizedLpa };
  }

  /**
   * Validate an Octane SOAP response payload and reject any non-zero errorCode, errorMessage,
   * string/boolean false success flag, or failed/rejected status string.
   */
  private assertOctaneSoapSuccess(operation: string, result: any): any {
    const ret = result?.return ?? result;
    const check = this.hasOctaneFailure(ret);
    if (check.failed) {
      this.logger.error(`Octane rejected ${operation}: ${check.detail}`);
      throw new BadRequestException(this.formatFriendlyCarrierError(operation, check.detail));
    }
    return ret;
  }

  /**
   * Generic REST call to Telcoinabox / Octane API
   */
  async restCall<T = any>(path: string, body?: any, method: string = 'POST'): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    this.logger.log(`Carrier REST call → ${method} ${url}`);

    const authHeader = `Basic ${Buffer.from(`${this.userName}:${this.password}`).toString('base64')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CarrierService.CARRIER_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Carrier REST error status ${response.status}: ${errorText}`);
        throw new BadRequestException(
          'We could not complete that request with our network provider right now. Please try again shortly.',
        );
      }

      if (response.status === 204) {
        return null as T;
      }

      const rawText = await response.text();
      if (!rawText || !rawText.trim()) {
        return null as T;
      }

      const data: any = JSON.parse(rawText);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const check = this.hasOctaneFailure(data);
        if (check.failed) {
          this.logger.error(`Carrier REST rejected request: ${check.detail}`);
          throw new BadRequestException(this.formatFriendlyCarrierError(path, check.detail));
        }
      }

      return data as T;
    } catch (err: any) {
      if (err instanceof HttpException) {
        throw err;
      }
      this.logger.error(`REST request failed for ${url}:`, err?.name === 'AbortError' ? 'Timeout exceeded' : err.message);
      throw new InternalServerErrorException(
        'We are temporarily unable to reach our network provider. Please try again shortly.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ==========================================================================
  // 1. CUSTOMER LIFECYCLE
  // ==========================================================================

  /**
   * Add / Register Customer with Carrier
   * Note: Governed strictly by TELCO_LIVE_CREATE safety guard.
   */
  async addCustomer(data: CarrierCustomerInput): Promise<{ custNo: string; isMock: boolean }> {
    const isLive = process.env.TELCO_LIVE_CREATE === 'true';

    if (!isLive) {
      const randomDigits = Math.floor(100000 + Math.random() * 900000);
      const mockCustNo = `CUST${randomDigits}`;
      this.logger.log(`[SAFETY GUARD] TELCO_LIVE_CREATE !== 'true'. Generated safe customer number: ${mockCustNo}`);
      return { custNo: mockCustNo, isMock: true };
    }

    this.logger.warn(`[LIVE CARRIER CALL] TELCO_LIVE_CREATE is enabled. Submitting live customer to Octane.`);

    const customerPayload = {
      firstName: data.firstName,
      surname: data.surname,
      email: data.email,
      phone: data.phone || '0400000000',
      dob: data.dob || '1995-01-01',
      address: data.address,
      suburb: data.suburb,
      state: data.state,
      postcode: data.postcode,
      custType: data.custType || 'R',
      preferredContactMethod: data.preferredContactMethod || 'Email',
      orderNotificationEmail: data.orderNotificationEmail || data.email,
      internetAccess: data.internetAccess || 'Y',
      agent_id: data.agent_id || '923',
      company: data.company || `${data.firstName} ${data.surname}`,
      ...(data.abn ? { abn: data.abn } : {}),
    };

    try {
      const result: any = await this.soapCall(
        '/UtbCustomer',
        'addCustomer',
        { customer: customerPayload },
      );

      const ret = this.assertOctaneSoapSuccess('addCustomer', result);
      const custNo = ret?.custNo;
      if (!custNo) {
        throw new BadRequestException(this.formatFriendlyCarrierError('addCustomer', 'Missing custNo'));
      }

      this.logger.log(`✓ Live Octane Customer created with CustNo: ${custNo}`);
      return { custNo, isMock: false };
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Failed to create carrier customer: ${err.message}`);
      throw new BadRequestException(this.formatFriendlyCarrierError('addCustomer', err.message));
    }
  }

  /**
   * Update Customer Details / Address in Octane (/UtbCustomer updateCustomer) atomically
   */
  async updateCustomerDetails(
    custNo: string,
    fields: {
      firstName?: string;
      surname?: string;
      email?: string;
      phone?: string;
      address?: string;
      suburb?: string;
      state?: string;
      postcode?: string;
      postalAddress?: string;
      commPreference?: string;
      dob?: string;
    },
  ): Promise<{ syncedWithOctane: boolean }> {
    const cleanCustNo = String(custNo || '').trim();
    const isLiveNumeric = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test(cleanCustNo);
    if (!isLiveNumeric) {
      return { syncedWithOctane: false };
    }

    const [liveCustRes, userDoc] = await Promise.allSettled([
      this.getCustomer(cleanCustNo),
      this.findUserDoc(cleanCustNo),
    ]);
    const liveCust: any = liveCustRes.status === 'fulfilled' ? liveCustRes.value : null;
    const localUser: any = userDoc.status === 'fulfilled' ? userDoc.value : null;

    const effectiveDob = fields.dob || liveCust?.dob || localUser?.dob || '';
    const payload: Record<string, any> = {
      custNo: cleanCustNo,
      ...(effectiveDob ? { dob: effectiveDob } : {}),
    };

    if (fields.firstName !== undefined) payload.firstName = fields.firstName;
    if (fields.surname !== undefined) payload.surname = fields.surname;
    if (fields.firstName !== undefined || fields.surname !== undefined) {
      const fn = fields.firstName ?? liveCust?.firstName ?? localUser?.firstName ?? '';
      const sn = fields.surname ?? liveCust?.surname ?? localUser?.surname ?? '';
      const combined = `${fn} ${sn}`.trim();
      if (combined) payload.company = combined;
    }
    if (fields.email !== undefined) {
      payload.email = fields.email;
      payload.orderNotificationEmail = fields.email;
      payload.authEmail = fields.email;
    }
    if (fields.phone !== undefined) {
      payload.phone = fields.phone;
      payload.mobile = fields.phone;
    }
    if (fields.address !== undefined) payload.address = fields.address;
    if (fields.suburb !== undefined) payload.suburb = fields.suburb;
    if (fields.state !== undefined) payload.state = fields.state;
    if (fields.postcode !== undefined) payload.postcode = fields.postcode;
    if (fields.postalAddress !== undefined) payload.address2 = fields.postalAddress;
    if (fields.commPreference !== undefined) {
      payload.preferredContactMethod = fields.commPreference === 'sms' ? 'SMS' : 'Email';
    }

    // Skip remote call if nothing mapped for Octane changed
    if (Object.keys(payload).filter((k) => k !== 'custNo' && k !== 'dob').length === 0) {
      return { syncedWithOctane: false };
    }

    try {
      const res: any = await this.soapCall('/UtbCustomer', 'updateCustomer', { customer: payload });
      this.assertOctaneSoapSuccess('updateCustomer', res);
      this.cachedOctaneCustomers = null;
      return { syncedWithOctane: true };
    } catch (err: any) {
      this.logger.error(`Live updateCustomer failed for ${cleanCustNo}: ${err.message}`);
      if (err instanceof HttpException) throw err;
      throw new BadRequestException(this.formatFriendlyCarrierError('updateCustomer', err.message));
    }
  }

  private async findUserDoc(custNo: string): Promise<any> {
    const usersCol = this.db.getCollection('users');
    const clean = (custNo || '').trim();
    const digits = clean.replace(/\D+/g, '');
    const numericVal = digits ? parseInt(digits, 10) : NaN;
    const orClauses: any[] = [{ custNo: clean }];
    if (!isNaN(numericVal)) {
      orClauses.push({ custNo: numericVal });
    }
    return usersCol.findOne({ $or: orClauses });
  }

  /**
   * Compute dynamic billing cycle dates anchored on the 28th of each month
   */
  private getCurrentBillingCycleDates() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const day = now.getUTCDate();

    const startDate = day >= 28 ? new Date(Date.UTC(year, month, 28)) : new Date(Date.UTC(year, month - 1, 28));
    const nextRenewal = day >= 28 ? new Date(Date.UTC(year, month + 1, 28)) : new Date(Date.UTC(year, month, 28));
    const endDate = new Date(nextRenewal.getTime() - 24 * 60 * 60 * 1000);

    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const daysRemaining = Math.max(1, Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

    return {
      periodStart: fmt(startDate),
      periodEnd: fmt(endDate),
      nextInvoiceDate: fmt(nextRenewal),
      lastInvoiceDate: fmt(startDate),
      daysRemaining,
    };
  }

  /**
   * Normalize Octane status strings (supports 'DIS', 'Disconnected', 'SUS', 'Suspended', etc.)
   */
  normalizeOctaneStatus(rawStatus?: string): 'Active' | 'Disconnected' | 'Suspended' {
    const clean = String(rawStatus || '').trim();
    if (/^(dis|disconnect)/i.test(clean)) return 'Disconnected';
    if (/suspend/i.test(clean)) return 'Suspended';
    return 'Active';
  }

  /**
   * Resolve retail plan metadata from an Octane planNo or planName
   */
  resolvePlanDetails(planName?: string, planNo?: string | number) {
    const noStr = planNo !== undefined && planNo !== null ? String(planNo).trim() : '';
    const nameStr = String(planName || '').trim().toLowerCase();

    if (noStr === '11144171') {
      return this.OCTANE_RETAIL_PLANS.find((p) => p.id === 'plan-180gb')!;
    }
    if (noStr) {
      const byNo = this.OCTANE_RETAIL_PLANS.find(
        (p) => p.planNo === noStr || p.id.toLowerCase() === noStr.toLowerCase(),
      );
      if (byNo) return byNo;
    }
    if (nameStr) {
      const byExactName = this.OCTANE_RETAIL_PLANS.find((p) => p.name.toLowerCase() === nameStr);
      if (byExactName) return byExactName;
      const byGbMatch = this.OCTANE_RETAIL_PLANS.find((p) =>
        new RegExp(`\\b${p.dataGb}\\s*gb\\b`, 'i').test(nameStr),
      );
      if (byGbMatch) return byGbMatch;
    }
    return null;
  }

  /**
   * Read-only: Retrieve group plans directly from Octane (/UtbPlan getGroupPlans)
   */
  async getGroupPlans(): Promise<Array<{ planNo: number; planName: string; usageType: string }>> {
    if (this.cachedGroupPlans && Date.now() < this.cachedGroupPlans.expiresAt) {
      return this.cachedGroupPlans.data;
    }
    if (process.env.TELCO_LIVE_CREATE !== 'true') {
      return [];
    }
    const res: any = await this.soapCall('/UtbPlan', 'getGroupPlans', {
      group: { groupNo: this.groupNo || '922' },
    });
    const raw = res?.return?.groupPlan ?? [];
    const list = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
    this.cachedGroupPlans = {
      expiresAt: Date.now() + 60_000,
      data: list,
    };
    return list;
  }

  /**
   * Read-only: Retrieve all customers in the reseller group from Octane (/UtbCustomer getCustomers)
   */
  async getAllCustomersFromOctane(): Promise<Map<string, any>> {
    if (this.cachedOctaneCustomers && Date.now() < this.cachedOctaneCustomers.expiresAt) {
      return this.cachedOctaneCustomers.map;
    }
    const map = new Map<string, any>();
    if (process.env.TELCO_LIVE_CREATE !== 'true') {
      return map;
    }
    try {
      const res: any = await this.soapCall('/UtbCustomer', 'getCustomers', {
        groupNo: parseInt(this.groupNo || '922', 10),
      });
      const raw = res?.return?.customer ?? [];
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const c of list) {
        if (c?.custNo) {
          map.set(String(c.custNo).trim(), c);
        }
      }
      this.cachedOctaneCustomers = {
        expiresAt: Date.now() + 60_000,
        map,
      };
    } catch (err: any) {
      this.logger.warn(`Live getCustomers fallback triggered: ${err.message}`);
    }
    return map;
  }

  /**
   * Retrieve Customer Details from Carrier
   */
  async getCustomer(custNo: string) {
    const cleanCustNo = (custNo || '').trim();
    const isLiveNumeric = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test(cleanCustNo);

    if (isLiveNumeric) {
      try {
        const liveRes: any = await this.soapCall('/UtbCustomer', 'getCustomer', {
          customer: { custNo: cleanCustNo },
        });
        const liveCustomer = liveRes?.return?.customer || liveRes?.return || liveRes;
        if (liveCustomer && typeof liveCustomer === 'object' && !liveCustomer.isError) {
          const normalizedStatus = this.normalizeOctaneStatus(
            liveCustomer.category_status_customer || liveCustomer.status,
          );
          const fullName = [liveCustomer.firstName, liveCustomer.surname].filter(Boolean).join(' ').trim();
          return {
            custNo: cleanCustNo,
            name: fullName || liveCustomer.company || `Customer ${cleanCustNo}`,
            firstName: liveCustomer.firstName || '',
            surname: liveCustomer.surname || '',
            email: liveCustomer.email || liveCustomer.orderNotificationEmail || liveCustomer.authEmail || '',
            phone: liveCustomer.phone || liveCustomer.mobile || '',
            address: liveCustomer.address || '',
            suburb: liveCustomer.suburb || '',
            state: liveCustomer.state || '',
            postcode: liveCustomer.postcode || '',
            dob: liveCustomer.dob || '',
            planNo: liveCustomer.planNo || '',
            paymentMethod: liveCustomer.direct_debit_method || liveCustomer.payment_method || '',
            status: normalizedStatus,
            raw: liveCustomer,
          };
        }
      } catch (err: any) {
        this.logger.warn(`Live getCustomer fallback for ${cleanCustNo}: ${err.message}`);
      }
    }

    const user = await this.findUserDoc(cleanCustNo);
    return {
      custNo: cleanCustNo,
      name: user?.name || 'Jordan Miller',
      email: user?.email || 'jordan.miller@example.com',
      phone: user?.phone || '0491 570 006',
      status: this.normalizeOctaneStatus(user?.legacyData?.status),
    };
  }

  /**
   * Retrieve Services associated with Customer
   */
  async getServices(custNo: string) {
    const cleanCustNo = (custNo || '').trim();
    const isLiveNumeric = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test(cleanCustNo);

    if (isLiveNumeric) {
      let octaneResponded = false;
      try {
        const liveRes: any = await this.soapCall('/UtbServices', 'getServices', { custNo: cleanCustNo });
        octaneResponded = true;
        const detailsNode =
          liveRes?.services?.serviceDetails ??
          liveRes?.return?.services?.serviceDetails ??
          liveRes?.return?.services ??
          (liveRes?.services && !('serviceDetails' in liveRes.services) ? liveRes.services : null);

        const serviceList = Array.isArray(detailsNode)
          ? detailsNode
          : detailsNode && typeof detailsNode === 'object'
          ? [detailsNode]
          : [];

        if (serviceList.length > 0) {
          return {
            source: 'octane-live',
            services: serviceList.map((svc: any, idx: number) => {
              const resolved = this.resolvePlanDetails(svc.planName, svc.planNo);
              return {
                serviceId: svc.serviceId || svc.id || `SVC-${cleanCustNo}-${svc.lineSeqNo || idx + 1}`,
                serviceNumber: svc.csn || svc.serviceNumber || svc.msn || svc.number || '',
                serviceType:
                  svc.productType === 'MO'
                    ? 'Mobile 5G/4G'
                    : svc.serviceType || 'Mobile Service',
                planName: resolved?.name || svc.planName || 'Active Service',
                planNo: String(svc.planNo || resolved?.planNo || ''),
                planPrice: resolved?.price ?? null,
                status: svc.status || 'Active',
                lineSeqNo: String(svc.lineSeqNo || idx + 1),
              };
            }),
          };
        }
      } catch (err: any) {
        this.logger.warn(`Live getServices fallback for ${cleanCustNo}: ${err.message}`);
      }

      if (octaneResponded) {
        // Octane confirmed zero active services — surface only in-flight local port/pending orders if any
        const ordersCol = this.db.getCollection<OrderRecord>('orders');
        const pendingOrders = await ordersCol
          .find({ custNo: cleanCustNo, status: { $in: ['PENDING', 'PORT_IN_PROGRESS', 'PROCESSING'] as any } })
          .sort({ updatedAt: -1 })
          .toArray();
        return {
          source: 'octane-live',
          services: pendingOrders.map((ord, idx) => ({
            serviceId: `SVC-${ord.orderId}`,
            serviceNumber: ord.msn || '',
            serviceType: ord.isEsim ? 'Mobile eSIM 5G' : 'Mobile 5G',
            planName: ord.planName,
            planNo: ord.planNo,
            planPrice: ord.pricePerMonth,
            status: ord.status,
            lineSeqNo: String(idx + 1),
          })),
        };
      }
    }

    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const userOrders = await ordersCol.find({ custNo: cleanCustNo }).sort({ updatedAt: -1 }).toArray();
    const userDoc: any = await this.findUserDoc(cleanCustNo);

    if (userOrders.length > 0) {
      return {
        services: userOrders.map((ord, idx) => ({
          serviceId: `SVC-${ord.orderId}`,
          serviceNumber: ord.msn || userDoc?.phone || '0491 570 006',
          serviceType: ord.isEsim ? 'Mobile eSIM 5G' : 'Mobile 5G',
          planName: ord.planName || 'JM 65GB Auto',
          status: ord.status,
          lineSeqNo: String(idx + 1),
        })),
      };
    }

    if (cleanCustNo === 'CUST990001') {
      return {
        services: [
          {
            serviceId: 'SVC-JM-990001',
            serviceNumber: userDoc?.phone || '0491 570 006',
            serviceType: 'Mobile eSIM 5G',
            planName: 'JM 65GB Auto',
            status: 'Active',
            lineSeqNo: '1',
          },
        ],
      };
    }

    return {
      services: [],
    };
  }

  private async fetchOctaneEsimActivation(params: {
    custNo?: string | number;
    msn?: string;
    orderId?: string;
    lineSeqNo?: number;
  }): Promise<{ smdpAddress: string; activationCode: string; lpaString: string } | null> {
    const cleanCust = params.custNo ? String(params.custNo).replace(/\D+/g, '') : '';
    const cleanMsn = params.msn ? String(params.msn).replace(/\s+/g, '') : '';
    const payload: Record<string, any> = {
      requestType: 'QR Code',
      lineseqno: params.lineSeqNo || 1,
      ...(cleanCust ? { custno: Number(cleanCust) } : {}),
      ...(cleanMsn ? { msn: cleanMsn } : {}),
      ...(params.orderId && !/^(ORD|PORT|REP)-/i.test(String(params.orderId))
        ? { orderId: String(params.orderId) }
        : {}),
    };
    const qrRes = await this.restCall<any>('/api/v1/mobile/resource/getEsimDetails', payload);
    const rawCode =
      qrRes?.simDetails?.activationCode ||
      qrRes?.esimDetails?.activationCode ||
      qrRes?.activationCode ||
      '';
    return this.parseActivationCodeString(rawCode);
  }

  private async resolveLiveServiceLine(cleanCustNo: string, preferredMsn?: string): Promise<{
    lineSeqNo: number;
    msn: string;
    status: string;
    planNo?: string;
  }> {
    const svcRes = await this.getServices(cleanCustNo);
    const services = Array.isArray(svcRes?.services) ? svcRes.services : [];
    const targetMsn = (preferredMsn || '').replace(/\s+/g, '');
    const matched: any =
      (targetMsn
        ? services.find((s: any) => String(s.serviceNumber || '').replace(/\s+/g, '') === targetMsn)
        : null) || services[0];

    if (!matched) {
      throw new BadRequestException(
        'No active mobile service was found on your network account yet. Please contact 1300 492 002 if your service was recently activated.',
      );
    }

    const rawStatus = String(matched.status || '').trim().toUpperCase();
    if (/BAR|DISC|SUSP|CANCEL/.test(rawStatus)) {
      throw new BadRequestException(
        `Your mobile service is currently ${matched.status} and cannot be modified right now. Please contact 1300 492 002 for assistance.`,
      );
    }

    const lineSeqNo = parseInt(String(matched.lineSeqNo || '1'), 10);
    return {
      lineSeqNo: Number.isFinite(lineSeqNo) && lineSeqNo > 0 ? lineSeqNo : 1,
      msn: String(matched.serviceNumber || targetMsn || '').replace(/\s+/g, ''),
      status: String(matched.status || 'Active'),
      planNo: matched.planNo ? String(matched.planNo) : undefined,
    };
  }

  // ==========================================================================
  // 2. NUMBER RESERVATION & SELECTION (/UtbPooledResource)
  // ==========================================================================

  /**
   * Reserve Pooled Mobile Numbers (WME_MSN)
   */
  async reserveNumbers(qty: number = 5): Promise<{ numbers: { id: string; number: string; formatted: string }[] }> {
    const isLive = process.env.TELCO_LIVE_CREATE === 'true';

    if (isLive) {
      try {
        const result: any = await this.soapCall(
          '/UtbPooledResource',
          'reserveResources',
          {
            reservePooledResourcesRequest: {
              resourceType: 'WME_MSN',
              numResources: String(qty),
            },
          },
        );

        const ret = this.assertOctaneSoapSuccess('reserveResources', result);
        const rawReserved = ret?.reservedPooledResources ?? [];
        const reservedList = Array.isArray(rawReserved) ? rawReserved : rawReserved ? [rawReserved] : [];
        const numbers = reservedList
          .map((item: any) => {
            const raw = String(item?.resourceValue || item?.resource || '').replace(/\s+/g, '');
            if (!raw) return null;
            const formatted = raw.length === 10 ? `${raw.slice(0, 4)} ${raw.slice(4, 7)} ${raw.slice(7)}` : raw;
            return {
              id: String(item.reservationId || `RES-${raw}`),
              number: raw,
              formatted,
            };
          })
          .filter(Boolean) as { id: string; number: string; formatted: string }[];

        if (numbers.length === 0) {
          throw new BadRequestException(
            'No new mobile numbers are currently available from the carrier pool. Please try again in a moment.',
          );
        }

        return { numbers };
      } catch (err: any) {
        this.logger.error(`Live number reservation failed: ${err.message}`);
        if (err instanceof HttpException) throw err;
        throw new BadRequestException(this.formatFriendlyCarrierError('reserveResources', err.message));
      }
    }

    // Sandbox-only numbers when TELCO_LIVE_CREATE !== 'true'
    const baseSuffix = Math.floor(100 + Math.random() * 800);
    const mockList = [
      `0488 912 ${baseSuffix}`,
      `0488 912 ${baseSuffix + 1}`,
      `0488 912 ${baseSuffix + 2}`,
      `0488 912 ${baseSuffix + 3}`,
      `0488 912 ${baseSuffix + 4}`,
    ].slice(0, qty);

    const numbers = mockList.map((numStr, index) => {
      const raw = numStr.replace(/\s+/g, '');
      return {
        id: `RES-MOCK-${Date.now()}-${index}`,
        number: raw,
        formatted: numStr,
      };
    });

    return { numbers };
  }

  /**
   * Check / Validate Australian Mobile Number availability
   */
  async checkNumber(numberRaw: string): Promise<{ available: boolean; formatted: string; message: string }> {
    const clean = numberRaw.replace(/\s+/g, '');
    const isAuMobile = /^04\d{8}$/.test(clean);

    if (!isAuMobile) {
      throw new BadRequestException('Please enter a valid 10-digit Australian mobile number (e.g. 0491 570 006).');
    }

    const formatted = `${clean.slice(0, 4)} ${clean.slice(4, 7)} ${clean.slice(7)}`;

    if (process.env.TELCO_LIVE_CREATE === 'true') {
      try {
        const result: any = await this.soapCall(
          '/UtbPooledResource',
          'queryResources',
          { queryPooledResourcesRequest: { queryValue: clean } },
        );
        const ret = this.assertOctaneSoapSuccess('queryResources', result);
        return {
          available: Boolean(ret?.available),
          formatted,
          message: 'Carrier pool verification complete.',
        };
      } catch (err: any) {
        this.logger.error(`Live queryResources failed: ${err.message}`);
        if (err instanceof HttpException) throw err;
        throw new BadRequestException(this.formatFriendlyCarrierError('queryResources', err.message));
      }
    }

    return {
      available: true,
      formatted,
      message: 'Number is valid and ready for activation or port-in.',
    };
  }

  // ==========================================================================
  // 3. ORDER ACTIVATION (NEW ESIM & PORT-IN ESIM)
  // ==========================================================================

  private normalizeMsn(raw?: string): string {
    const digits = String(raw || '').replace(/\D+/g, '');
    if (digits.startsWith('614') && digits.length >= 11) {
      return `0${digits.slice(2, 11)}`;
    }
    if (digits.startsWith('4') && digits.length === 9) {
      return `0${digits}`;
    }
    return digits || String(raw || '').replace(/\s+/g, '');
  }

  private normalizeDobIso(raw?: string): string | undefined {
    const clean = String(raw || '').trim();
    if (!clean) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
    const dmy = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
      const [, dd, mm, yyyy] = dmy;
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
    return clean;
  }

  private getOctaneBillingCycleDate(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return `27-${month}-${year}`;
  }

  private async hydrateOrderCustomerProfile(
    custNo: string,
    dto: {
      email?: string;
      firstName?: string;
      lastName?: string;
      address?: string;
      suburb?: string;
      state?: string;
      postcode?: string;
    },
    isLive: boolean,
  ) {
    let email = dto.email?.trim() || '';
    let firstName = dto.firstName?.trim() || '';
    let lastName = dto.lastName?.trim() || '';
    let address = dto.address?.trim() || '';
    let suburb = dto.suburb?.trim() || '';
    let state = dto.state?.trim() || '';
    let postcode = dto.postcode?.trim() || '';

    const userDoc: any = await this.findUserDoc(custNo).catch(() => null);
    if (userDoc) {
      email = email || userDoc.email || '';
      firstName = firstName || userDoc.firstName || String(userDoc.name || '').split(' ')[0] || '';
      lastName = lastName || userDoc.surname || String(userDoc.name || '').split(' ').slice(1).join(' ') || '';
      address = address || userDoc.address || '';
      suburb = suburb || userDoc.suburb || '';
      state = state || userDoc.state || '';
      postcode = postcode || userDoc.postcode || '';
    }

    if (isLive && (!address || !suburb || !postcode || !email)) {
      const liveCust: any = await this.getCustomer(custNo).catch(() => null);
      if (liveCust) {
        email = email || liveCust.email || '';
        firstName = firstName || liveCust.firstName || '';
        lastName = lastName || liveCust.surname || '';
        address = address || liveCust.address || '';
        suburb = suburb || liveCust.suburb || '';
        state = state || liveCust.state || '';
        postcode = postcode || liveCust.postcode || '';
      }
    }

    return {
      email: email || 'info@justmobile.ai',
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      address: address || 'George St',
      suburb: suburb || 'Sydney',
      state: state || 'NSW',
      postcode: postcode || '2000',
    };
  }

  /**
   * Activate New eSIM Service (ADD_WME_NEW)
   */
  async activateNewOrder(dto: ActivateOrderInput): Promise<{
    success: boolean;
    orderId: string;
    msn: string;
    status: string;
    isEsim: boolean;
    lpaString: string | null;
    carrierDispatchedEmail?: boolean;
    emailSent?: boolean;
    emailRecipient?: string;
  }> {
    const msn = this.normalizeMsn(dto.msn);
    const resolvedPlan = this.resolvePlanDetails(dto.planName, dto.planNo);
    const planNo = String(resolvedPlan?.planNo || dto.planNo || '11144157');
    const planName = resolvedPlan?.name || dto.planName || 'JM 65GB Auto';
    const pricePerMonth = resolvedPlan?.price ?? dto.pricePerMonth ?? 40;
    const isLive = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test((dto.custNo || '').trim());
    const customerProfile = await this.hydrateOrderCustomerProfile(dto.custNo, dto, isLive);

    let orderId = `ORD-${Math.floor(100000 + Math.random() * 900000)}`;

    if (isLive) {
      this.logger.warn(`[LIVE CARRIER CALL] Submitting ADD_WME_NEW order to Octane.`);
      const requestBody = {
        createRequest: {
          custNo: dto.custNo,
          orderType: 'SRVC_ORD',
          orderAction: 'ADD_WME_NEW',
          orderItems: {
            wmeNewReqItem: {
              lineType: 'R',
              lineName: 'SimplyBig Unlimited',
              planNo: Number(planNo),
              agentId: '923',
              msn,
              isEsim: true,
              isQRCode: true,
              cycleNo: '28',
              spendCode: '80610',
              notificationEmail: customerProfile.email,
              orderItemAddress: {
                locality: customerProfile.suburb,
                postcode: customerProfile.postcode,
                streetName: customerProfile.address.split(',')[0].trim(),
                additionalAddress: customerProfile.address.slice(0, 10),
              },
            },
          },
        },
      };

      try {
        const result: any = await this.soapCall('/UtbOrder', 'orderCreate', requestBody);
        const ret = this.assertOctaneSoapSuccess('ADD_WME_NEW', result);
        if (!ret?.orderId) {
          throw new BadRequestException(this.formatFriendlyCarrierError('ADD_WME_NEW', 'Missing orderId'));
        }
        orderId = String(ret.orderId);
      } catch (err: any) {
        this.logger.error(`Live order creation failed: ${err.message}`);
        if (err instanceof HttpException) throw err;
        throw new BadRequestException(this.formatFriendlyCarrierError('ADD_WME_NEW', err.message));
      }
    }

    const esimDetails = await this.resolveActivatedOrderEsim(isLive, dto.custNo, msn, orderId);
    const now = new Date();

    // Persist in orders collection (never invent synthetic LPA strings on live accounts)
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    await ordersCol.updateOne(
      { orderId },
      {
        $set: {
          orderId,
          custNo: dto.custNo,
          msn,
          planNo,
          planName,
          pricePerMonth,
          status: 'ACTIVE',
          orderType: 'NEW_ACTIVATION',
          orderAction: 'ADD_WME_NEW',
          isEsim: true,
          isQRcode: true,
          ...(esimDetails.lpaString ? { lpaString: esimDetails.lpaString } : {}),
          ...(esimDetails.activationCode ? { activationCode: esimDetails.activationCode } : {}),
          address: customerProfile.address,
          suburb: customerProfile.suburb,
          state: customerProfile.state,
          postcode: customerProfile.postcode,
          email: customerProfile.email,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );

    const { recipientEmail, sent: emailSent } = await this.dispatchOrderWelcomeEmail({
      custNo: dto.custNo,
      orderId,
      msn,
      planName,
      pricePerMonth,
      email: customerProfile.email,
      firstName: customerProfile.firstName,
      lastName: customerProfile.lastName,
      lpaString: esimDetails.lpaString,
      smdpAddress: esimDetails.smdpAddress,
      activationCode: esimDetails.activationCode,
    });

    return {
      success: true,
      orderId,
      msn,
      status: 'ACTIVE',
      isEsim: true,
      lpaString: esimDetails.lpaString,
      carrierDispatchedEmail: isLive && !esimDetails.lpaString,
      emailSent: Boolean(emailSent || (isLive && recipientEmail)),
      emailRecipient: recipientEmail,
    };
  }

  private async resolveActivatedOrderEsim(
    isLive: boolean,
    custNo: string,
    msn: string,
    orderId: string,
  ): Promise<{ lpaString: string | null; smdpAddress: string | null; activationCode: string | null }> {
    if (isLive) {
      const liveQr = await this.fetchOctaneEsimActivation({ custNo, msn, orderId }).catch(() => null);
      if (liveQr) {
        return liveQr;
      }
      return { lpaString: null, smdpAddress: null, activationCode: null };
    }
    const smdpAddress = 'smdp.telcoinabox.com.au';
    const activationCode = `JM-AU-${orderId}`;
    return {
      lpaString: `LPA:1$${smdpAddress}$${activationCode}`,
      smdpAddress,
      activationCode,
    };
  }

  private async dispatchOrderWelcomeEmail(params: {
    custNo: string;
    orderId: string;
    msn: string;
    planName: string;
    pricePerMonth: number;
    email?: string;
    firstName?: string;
    lastName?: string;
    lpaString: string | null;
    smdpAddress: string | null;
    activationCode: string | null;
  }): Promise<{ recipientEmail?: string; sent: boolean }> {
    let recipientEmail = params.email;
    try {
      let recipientName: string | undefined =
        params.firstName && params.lastName ? `${params.firstName} ${params.lastName}` : params.firstName;

      if (!recipientEmail || !recipientEmail.includes('@') || !recipientName) {
        const usersCol = this.db.getCollection('users');
        const user = await usersCol.findOne({
          $or: [{ custNo: params.custNo }, { custNo: parseInt(params.custNo.replace(/\D+/g, ''), 10) }],
        });
        if (user?.email && !recipientEmail) recipientEmail = user.email;
        if (user?.name && !recipientName) recipientName = user.name;
      }

      if (
        recipientEmail &&
        recipientEmail.includes('@') &&
        params.lpaString &&
        params.smdpAddress &&
        params.activationCode
      ) {
        this.mailService
          .sendEsimWelcomeEmail({
            to: recipientEmail,
            recipientName,
            custNo: params.custNo,
            orderId: params.orderId,
            msn: params.msn,
            planName: params.planName,
            pricePerMonth: params.pricePerMonth,
            lpaString: params.lpaString,
            smdpAddress: params.smdpAddress,
            activationCode: params.activationCode,
            isEsim: true,
          })
          .catch((err) => this.logger.warn(`Background eSIM email send error: ${err.message}`));
        return { recipientEmail, sent: true };
      }
    } catch (e: any) {
      this.logger.warn(`Could not dispatch automated eSIM welcome email: ${e.message}`);
    }
    return { recipientEmail, sent: false };
  }

  /**
   * Activate Port-in Service (ADD_WME_PORT)
   */
  async activatePortOrder(dto: ActivatePortOrderInput): Promise<{
    success: boolean;
    orderId: string;
    msn: string;
    status: string;
    isEsim: boolean;
    lpaString: string | null;
    carrierDispatchedEmail?: boolean;
    emailSent?: boolean;
    emailRecipient?: string;
  }> {
    const msn = this.normalizeMsn(dto.msn);
    const resolvedPlan = this.resolvePlanDetails(dto.planName, dto.planNo);
    const planNo = String(resolvedPlan?.planNo || dto.planNo || '11144157');
    const planName = resolvedPlan?.name || dto.planName || 'JM 65GB Auto';
    const pricePerMonth = resolvedPlan?.price ?? dto.pricePerMonth ?? 40;
    const normalizedDob = this.normalizeDobIso(dto.dob);
    const cleanArn = dto.arn?.trim();
    const isLive = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test((dto.custNo || '').trim());

    if (dto.numType === 'prepaid' && (!normalizedDob || normalizedDob.length < 6)) {
      throw new BadRequestException('Valid Date of Birth is required to transfer a prepaid mobile number.');
    }
    if (dto.numType === 'postpaid' && (!cleanArn || cleanArn.length < 3)) {
      throw new BadRequestException('Valid Account Number is required to transfer a postpaid mobile number.');
    }

    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const existingPendingPort = await ordersCol.findOne({
      msn,
      orderType: 'PORT_IN',
      status: { $in: ['PENDING', 'PORT_IN_PROGRESS'] },
    });
    if (existingPendingPort) {
      throw new BadRequestException(
        `A mobile number transfer for ${msn} is already in progress (Order #${existingPendingPort.orderId}). Please wait for the transfer to complete or cancel it before submitting a new request.`,
      );
    }

    const customerProfile = await this.hydrateOrderCustomerProfile(dto.custNo, dto, isLive);
    let orderId = `PORT-${Math.floor(100000 + Math.random() * 900000)}`;

    if (isLive) {
      this.logger.warn(`[LIVE CARRIER CALL] Submitting ADD_WME_PORT order to Octane.`);
      const requestBody = {
        createRequest: {
          custNo: dto.custNo,
          orderType: 'SRVC_ORD',
          orderAction: 'ADD_WME_PORT',
          orderItems: {
            wmePortInReqItem: {
              lineType: 'R',
              planNo: Number(planNo),
              agentId: '923',
              msn,
              isEsim: true,
              isQRCode: true,
              cycleNo: '28',
              spendCode: '80610',
              notificationEmail: customerProfile.email,
              ...(dto.numType === 'prepaid' ? { dob: normalizedDob } : { arn: cleanArn }),
              orderItemAddress: {
                locality: customerProfile.suburb,
                postcode: customerProfile.postcode,
                streetName: customerProfile.address.split(',')[0].trim(),
                additionalAddress: customerProfile.address.slice(0, 10),
              },
            },
          },
        },
      };

      try {
        const result: any = await this.soapCall('/UtbOrder', 'orderCreate', requestBody);
        const ret = this.assertOctaneSoapSuccess('ADD_WME_PORT', result);
        if (!ret?.orderId) {
          throw new BadRequestException(this.formatFriendlyCarrierError('ADD_WME_PORT', 'Missing orderId'));
        }
        orderId = String(ret.orderId);
      } catch (err: any) {
        this.logger.error(`Live port order creation failed: ${err.message}`);
        if (err instanceof HttpException) throw err;
        throw new BadRequestException(this.formatFriendlyCarrierError('ADD_WME_PORT', err.message));
      }
    }

    const esimDetails = await this.resolveActivatedOrderEsim(isLive, dto.custNo, msn, orderId);
    const now = new Date();

    await ordersCol.updateOne(
      { orderId },
      {
        $set: {
          orderId,
          custNo: dto.custNo,
          msn,
          planNo,
          planName,
          pricePerMonth,
          status: 'PORT_IN_PROGRESS',
          orderType: 'PORT_IN',
          orderAction: 'ADD_WME_PORT',
          isEsim: true,
          isQRcode: true,
          ...(esimDetails.lpaString ? { lpaString: esimDetails.lpaString } : {}),
          ...(esimDetails.activationCode ? { activationCode: esimDetails.activationCode } : {}),
          numType: dto.numType,
          dob: normalizedDob,
          arn: cleanArn,
          address: customerProfile.address,
          suburb: customerProfile.suburb,
          state: customerProfile.state,
          postcode: customerProfile.postcode,
          email: customerProfile.email,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );

    const { recipientEmail, sent: emailSent } = await this.dispatchOrderWelcomeEmail({
      custNo: dto.custNo,
      orderId,
      msn,
      planName,
      pricePerMonth,
      email: customerProfile.email,
      firstName: customerProfile.firstName,
      lastName: customerProfile.lastName,
      lpaString: esimDetails.lpaString,
      smdpAddress: esimDetails.smdpAddress,
      activationCode: esimDetails.activationCode,
    });

    return {
      success: true,
      orderId,
      msn,
      status: 'PORT_IN_PROGRESS',
      isEsim: true,
      lpaString: esimDetails.lpaString,
      carrierDispatchedEmail: isLive && !esimDetails.lpaString,
      emailSent: Boolean(emailSent || (isLive && recipientEmail)),
      emailRecipient: recipientEmail,
    };
  }

  /**
   * Resubmit a rejected or failed port-in order with updated donor credentials (INT-10 UX)
   */
  async resubmitPortOrder(
    orderId: string,
    dto: {
      numType?: 'prepaid' | 'postpaid';
      dob?: string;
      arn?: string;
      donorCarrier?: string;
    },
  ): Promise<{ success: boolean; message: string; order: any }> {
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const order = await ordersCol.findOne({ orderId });

    if (!order) {
      throw new NotFoundException(`Order #${orderId} not found.`);
    }

    if (order.status === 'ACTIVE' || order.status === 'COMPLETED') {
      throw new BadRequestException(`Order #${orderId} has already completed and is active on the network.`);
    }

    const effectiveNumType = dto.numType || order.numType || 'prepaid';
    const effectiveDob = this.normalizeDobIso(dto.dob !== undefined ? dto.dob : order.dob);
    const effectiveArn = (dto.arn !== undefined ? dto.arn : order.arn)?.trim();
    const effectiveDonor = dto.donorCarrier || order.donorCarrier || 'Optus';

    if (effectiveNumType === 'prepaid' && (!effectiveDob || effectiveDob.trim().length < 4)) {
      throw new BadRequestException('Valid Date of Birth is required to transfer a prepaid service.');
    }
    if (effectiveNumType === 'postpaid' && (!effectiveArn || effectiveArn.trim().length < 3)) {
      throw new BadRequestException('Valid Account Number is required to transfer a postpaid contract service.');
    }

    const isLive = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test((order.custNo || '').trim());
    let nextCarrierOrderId: string | undefined;

    if (isLive) {
      const customerProfile = await this.hydrateOrderCustomerProfile(order.custNo, order, true);
      this.logger.warn(`[LIVE CARRIER CALL] Resubmitting ADD_WME_PORT to Octane for order ${orderId} with updated credentials.`);
      try {
        const msn = this.normalizeMsn(order.msn);
        const result: any = await this.soapCall('/UtbOrder', 'orderCreate', {
          createRequest: {
            custNo: order.custNo,
            orderType: 'SRVC_ORD',
            orderAction: 'ADD_WME_PORT',
            orderItems: {
              wmePortInReqItem: {
                lineType: 'R',
                planNo: Number(order.planNo || '11144157'),
                agentId: '923',
                msn,
                isEsim: true,
                isQRCode: true,
                cycleNo: '28',
                spendCode: '80610',
                notificationEmail: customerProfile.email,
                ...(effectiveNumType === 'prepaid' ? { dob: effectiveDob } : { arn: effectiveArn }),
                orderItemAddress: {
                  locality: customerProfile.suburb,
                  postcode: customerProfile.postcode,
                  streetName: customerProfile.address.split(',')[0].trim(),
                  additionalAddress: customerProfile.address.slice(0, 10),
                },
              },
            },
          },
        });
        const ret = this.assertOctaneSoapSuccess('ADD_WME_PORT resubmission', result);
        if (ret?.orderId) {
          nextCarrierOrderId = String(ret.orderId);
        }
      } catch (err: any) {
        this.logger.error(`Live port order resubmission failed: ${err.message}`);
        if (err instanceof HttpException) throw err;
        throw new BadRequestException(this.formatFriendlyCarrierError('ADD_WME_PORT resubmission', err.message));
      }
    }

    const now = new Date();
    const targetOrderId = nextCarrierOrderId || orderId;
    await ordersCol.updateOne(
      { orderId },
      {
        $set: {
          ...(nextCarrierOrderId && nextCarrierOrderId !== orderId
            ? { orderId: nextCarrierOrderId, carrierOrderId: nextCarrierOrderId }
            : {}),
          status: 'PORT_IN_PROGRESS',
          numType: effectiveNumType,
          dob: effectiveDob,
          arn: effectiveArn,
          donorCarrier: effectiveDonor,
          rejectionReason: null,
          rejectionCode: null,
          portRetries: (order.portRetries || 0) + 1,
          updatedAt: now,
        },
        ...(nextCarrierOrderId && nextCarrierOrderId !== orderId
          ? { $push: { previousOrderIds: orderId } as any }
          : {}),
      },
    );

    const updated = await ordersCol.findOne({ orderId: targetOrderId });
    this.logger.log(`✓ Port order #${orderId} resubmitted to ${effectiveDonor}. Status changed to PORT_IN_PROGRESS.`);

    return {
      success: true,
      message: `Updated transfer details submitted to ${effectiveDonor}. Number porting is now in progress.`,
      order: updated,
    };
  }

  /**
   * Look up the owning customer number for an orderId (used for JWT ownership checks)
   */
  async resolveOrderOwnerCustNo(orderId: string): Promise<string | null> {
    const cleanOrderId = String(orderId || '').trim();
    if (!cleanOrderId) return null;
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const order = await ordersCol.findOne({ orderId: cleanOrderId });
    return order?.custNo ? String(order.custNo).trim() : null;
  }

  /**
   * Look up the owning customer number for a QR identifier (orderId, custNo, or MSN)
   */
  async resolveQrOwnerCustNo(identifier: string): Promise<string | null> {
    const cleanId = String(identifier || '').trim();
    if (!cleanId) return null;

    const normalizedPhone = cleanId.replace(/\s+/g, '');
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const order = await ordersCol.findOne(
      {
        $or: [{ orderId: cleanId }, { custNo: cleanId }, { msn: normalizedPhone }],
      },
      { sort: { updatedAt: -1 } },
    );
    if (order?.custNo) {
      return String(order.custNo).trim();
    }

    const usersCol = this.db.getCollection('users');
    const userOrClauses: any[] = [{ custNo: cleanId }];
    if (/^\d+$/.test(cleanId) && !normalizedPhone.startsWith('04')) {
      userOrClauses.push({ custNo: Number(cleanId) });
    }
    if (normalizedPhone.startsWith('04') || normalizedPhone.startsWith('+614')) {
      userOrClauses.push({ phone: cleanId }, { phone: normalizedPhone });
    }
    const userDoc = await usersCol.findOne({ $or: userOrClauses });
    if (userDoc?.custNo) {
      return String(userDoc.custNo).trim();
    }

    if (/^(CUST\d+|\d+)$/i.test(cleanId) && !normalizedPhone.startsWith('04')) {
      return cleanId;
    }

    return null;
  }

  /**
   * Query Order Status (uses live Octane orderQuery for real carrier orders)
   */
  async queryOrder(orderId: string) {
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const order = await ordersCol.findOne({ orderId });

    if (!order) {
      throw new NotFoundException(`Order with reference ${orderId} not found.`);
    }

    const isLiveOrder =
      process.env.TELCO_LIVE_CREATE === 'true' &&
      /^\d+$/.test((order.custNo || '').trim()) &&
      !/^(ORD|PORT|REP)-/i.test(String(order.orderId || ''));

    let effectiveStatus = order.status;
    let rejectionReason = order.rejectionReason;
    let rejectionCode = order.rejectionCode;

    if (isLiveOrder) {
      const queryRes: any = await this.soapCall('/UtbOrder', 'orderQuery', {
        request: { orderId: order.orderId },
      });
      const ret = queryRes?.return?.orderQueryResponse || queryRes?.return;
      if (ret) {
        const liveStatus = String(ret?.internalStatus || ret?.status || '').toUpperCase();
        if (['COMPLETED', 'ACTIVE', 'PROVISIONED', 'SUCCESS'].includes(liveStatus)) {
          effectiveStatus = 'ACTIVE';
          rejectionReason = null;
          rejectionCode = null;
        } else if (['REJECTED', 'FAILED', 'CANCELLED'].includes(liveStatus)) {
          effectiveStatus = 'REJECTED';
          rejectionReason = ret?.errorMessage || ret?.message || 'Transfer rejected by donor carrier.';
          rejectionCode = ret?.errorCode ? String(ret.errorCode) : 'DONOR_REJECTED';
        }
        if (effectiveStatus !== order.status) {
          await ordersCol.updateOne(
            { orderId: order.orderId },
            {
              $set: {
                status: effectiveStatus,
                rejectionReason: rejectionReason ?? null,
                rejectionCode: rejectionCode ?? null,
                updatedAt: new Date(),
              },
            },
          );
        }
      }
    }

    return {
      orderId: order.orderId,
      custNo: order.custNo,
      msn: order.msn,
      status: effectiveStatus,
      planName: order.planName,
      orderType: order.orderType,
      isEsim: order.isEsim,
      numType: order.numType,
      dob: order.dob,
      arn: order.arn,
      donorCarrier: order.donorCarrier,
      rejectionReason,
      rejectionCode,
      portRetries: order.portRetries,
      createdAt: order.createdAt,
    };
  }

  /**
   * Get all orders for a customer (including in-flight mobile ports)
   */
  async getCustomerOrders(custNo: string): Promise<any[]> {
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const orders = await ordersCol
      .find({ custNo })
      .sort({ createdAt: -1 })
      .toArray();

    return orders.map((o) => ({
      orderId: o.orderId,
      custNo: o.custNo,
      msn: o.msn,
      status: o.status,
      planName: o.planName,
      orderType: o.orderType,
      isEsim: o.isEsim,
      createdAt: o.createdAt,
      completedAt: (o as any).completedAt,
      donorNetworkNote: (o as any).donorNetworkNote,
      rejectionReason: o.rejectionReason,
      rejectionCode: o.rejectionCode,
      donorCarrier: o.donorCarrier,
      numType: o.numType,
      dob: o.dob,
      arn: o.arn,
      portRetries: o.portRetries,
    }));
  }

  // ==========================================================================
  // 4. ESIM QR CODE GENERATION & DIGITAL ACTIVATION
  // ==========================================================================

  /**
   * Get Scannable eSIM QR Code & GSMA LPA Details (queries live Octane getEsimDetails first)
   */
  async getEsimQRCode(identifier: string): Promise<{
    orderId: string;
    lpa: string;
    smdpAddress: string;
    activationCode: string;
    qrCodeDataUrl: string;
    instructions: string[];
  }> {
    const cleanId = String(identifier || '').trim();
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const order = await ordersCol.findOne(
      {
        $or: [{ orderId: cleanId }, { custNo: cleanId }, { msn: cleanId.replace(/\s+/g, '') }],
      },
      { sort: { updatedAt: -1 } },
    );

    const activeOrderId = order?.orderId || cleanId || 'ORD-990001';
    const isLiveOrder =
      process.env.TELCO_LIVE_CREATE === 'true' &&
      (Boolean(order?.custNo && /^\d+$/.test(order.custNo.trim())) ||
        (/^\d+$/.test(cleanId) && cleanId !== 'CUST990001'));

    let smdpAddress = 'smdp.telcoinabox.com.au';
    let activationCode = '';
    let lpa = '';

    if (isLiveOrder) {
      const liveQr = await this.fetchOctaneEsimActivation({
        custNo: order?.custNo || (/^\d+$/.test(cleanId) && !cleanId.startsWith('04') ? cleanId : undefined),
        msn: order?.msn || (/^04\d{8}$/.test(cleanId.replace(/\s+/g, '')) ? cleanId : undefined),
        orderId: order?.orderId || (/^\d+$/.test(cleanId) && !cleanId.startsWith('04') ? cleanId : undefined),
      }).catch(() => null);

      if (liveQr) {
        smdpAddress = liveQr.smdpAddress;
        activationCode = liveQr.activationCode;
        lpa = liveQr.lpaString;
      } else if (order?.lpaString && !this.isSyntheticLpa(order.lpaString)) {
        const parsed = this.parseActivationCodeString(order.lpaString);
        if (parsed) {
          smdpAddress = parsed.smdpAddress;
          activationCode = parsed.activationCode;
          lpa = parsed.lpaString;
        }
      }

      if (!lpa || !activationCode) {
        throw new BadRequestException(
          'Your eSIM QR code is not available from the network provider yet. Please check your email or try again shortly.',
        );
      }
    } else {
      const parsedLpaCode = order?.lpaString?.startsWith('LPA:') ? order.lpaString.split('$')[2] : undefined;
      activationCode =
        order?.activationCode || parsedLpaCode || `JM-AU-${activeOrderId.replace(/[^a-zA-Z0-9]/g, '')}`;
      lpa = order?.lpaString || `LPA:1$${smdpAddress}$${activationCode}`;
    }

    // Generate high-resolution scannable QR Code PNG Data URL
    const qrCodeDataUrl = await QRCode.toDataURL(lpa, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: {
        dark: '#142420', // JustMobile Dark Ink
        light: '#FFFFFF',
      },
    });

    return {
      orderId: activeOrderId,
      lpa,
      smdpAddress,
      activationCode,
      qrCodeDataUrl,
      instructions: [
        'Open Settings on your Apple iOS or Android device.',
        'Tap Mobile / Cellular > Add eSIM (or Set Up Mobile Service).',
        'Scan this QR code using your device camera, or tap Enter Details Manually.',
        `If entering manually, input SM-DP+ Address: ${smdpAddress} and Activation Code: ${activationCode}`,
        'Follow device on-screen prompts to label your JustMobile line and start surfing.',
      ],
    };
  }

  /**
   * Resend / Send Order eSIM Welcome Email (INT-07)
   */
  async sendOrderEsimEmail(custNo: string, orderId: string, targetEmail?: string) {
    const cleanCustNo = String(custNo || '').trim();
    const cleanOrderId = String(orderId || '').trim();
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    let order = await ordersCol.findOne(
      {
        custNo: cleanCustNo,
        $or: [{ orderId: cleanOrderId }, { msn: cleanOrderId.replace(/\s+/g, '') }],
      },
      { sort: { updatedAt: -1 } },
    );
    if (!order) {
      order = await ordersCol.findOne({ custNo: cleanCustNo }, { sort: { updatedAt: -1 } });
    }

    if (!order) {
      throw new NotFoundException(`Order with reference ${orderId} not found.`);
    }

    let email = targetEmail || order.email;
    let recipientName: string | undefined;

    if (!email || !email.includes('@')) {
      const usersCol = this.db.getCollection('users');
      const user = await usersCol.findOne({
        $or: [{ custNo: order.custNo }, { custNo: parseInt(order.custNo.replace(/\D+/g, ''), 10) }],
      });
      if (user?.email) {
        email = user.email;
        recipientName = user.name;
      }
    }

    if (!email || !email.includes('@')) {
      throw new BadRequestException('No valid email address found for this order.');
    }

    const qrDetails = await this.getEsimQRCode(order.orderId);

    const sent = await this.mailService.sendEsimWelcomeEmail({
      to: email,
      recipientName,
      custNo: order.custNo,
      orderId: order.orderId,
      msn: order.msn,
      planName: order.planName,
      pricePerMonth: order.pricePerMonth,
      lpaString: qrDetails.lpa,
      smdpAddress: qrDetails.smdpAddress,
      activationCode: qrDetails.activationCode,
      isEsim: order.isEsim ?? true,
    });

    return {
      success: sent,
      email,
      orderId: order.orderId,
      msn: order.msn,
      isEsim: order.isEsim ?? true,
      message: sent
        ? `eSIM activation QR code and LPA string sent to ${email} via Hostinger SMTP.`
        : 'Could not deliver email.',
    };
  }

  /**
   * Issue a Replacement eSIM Profile & QR Code (Reset eSIM or CHANGE_WME_SIM swap)
   * Protected by 2FA in Customer Portal or OTP session in Chatbot.
   */
  async replaceEsimProfile(
    custNo: string,
    options?: { msn?: string; reason?: string; email?: string },
  ) {
    const cleanCustNo = String(custNo || '').trim();
    if (!cleanCustNo) {
      throw new BadRequestException('Customer number is required.');
    }

    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const replacementsCol = this.db.getCollection('esim_replacements');
    const [existingOrder, userDoc] = await Promise.all([
      ordersCol.findOne({ custNo: cleanCustNo }, { sort: { updatedAt: -1 } }),
      this.findUserDoc(cleanCustNo),
    ]);

    const cleanMsn = (
      options?.msn ||
      existingOrder?.msn ||
      userDoc?.phone ||
      '0491570006'
    ).replace(/\s+/g, '');

    // Enforce 24-hour rate limit per service on non-sandbox accounts to prevent repeated SIM swap abuse
    if (cleanCustNo !== 'CUST990001') {
      const cooldownSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentReplacement = await replacementsCol.findOne({
        custNo: cleanCustNo,
        msn: cleanMsn,
        createdAt: { $gte: cooldownSince },
      });
      if (recentReplacement) {
        throw new BadRequestException(
          'An eSIM replacement was already issued for this mobile number in the last 24 hours. Please contact 1300 492 002 or info@justmobile.ai for urgent help.',
        );
      }
    }

    const recipientEmail =
      options?.email || existingOrder?.email || userDoc?.email || '';
    const recipientName = userDoc?.name || undefined;

    const isLive =
      process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test(cleanCustNo);

    const replacementRef = `REP-ESIM-${Math.floor(100000 + Math.random() * 900000)}`;
    let smdpAddress = 'smdp.telcoinabox.com.au';
    let activationCode: string | null = isLive
      ? null
      : `JM-REP-${replacementRef.replace(/[^a-zA-Z0-9]/g, '')}-${Date.now().toString().slice(-4)}`;
    let lpaString: string | null = isLive ? null : `LPA:1$${smdpAddress}$${activationCode}`;
    let carrierActionTaken = isLive ? 'PENDING_CARRIER' : 'SANDBOX_PROFILE_REISSUED';
    let carrierOrderId: string | undefined;

    if (isLive) {
      const liveSvc = await this.resolveLiveServiceLine(cleanCustNo, cleanMsn);
      const effectiveLineSeqNo = liveSvc.lineSeqNo;
      const effectiveMsn = liveSvc.msn || cleanMsn;

      // Step 1: Check live eSIM profile state via Octane REST getEsimDetails & reset if resettable
      // (Never auto-submit CHANGE_WME_SIM blindly without confirmed reseller eSIM swap rules)
      try {
        const details = await this.restCall<any>(
          '/api/v1/mobile/resource/getEsimDetails',
          {
            requestType: 'SIM Details',
            custno: Number(cleanCustNo),
            lineseqno: effectiveLineSeqNo,
            msn: effectiveMsn,
          },
        );
        const simNode = details?.simDetails || details?.esimDetails || details;
        const profileState = String(simNode?.profileState || details?.profileState || '').toUpperCase();
        const esimId =
          simNode?.esimIdentifier ||
          simNode?.eSIMIdentifier ||
          simNode?.extra1 ||
          details?.eSIMIdentifier ||
          details?.esimIdentifier;
        if (
          esimId &&
          ['RELEASED', 'LINKED', 'AVAILABLE', 'ERROR'].includes(profileState)
        ) {
          await this.restCall('/api/v1/mobile/resource/manageEsim', {
            custNo: Number(cleanCustNo),
            eSIMIdentifier: String(esimId),
            lineSeqNo: effectiveLineSeqNo,
            orderType: 'Reset Esim',
            resetEsim: { targetState: 'RELEASED' },
          });
          carrierActionTaken = 'OCTANE_MANAGE_ESIM_RESET';
        }
      } catch (err: any) {
        this.logger.warn(
          `Octane REST getEsimDetails/manageEsim reset unavailable for ${cleanCustNo}: ${err.message}`,
        );
      }

      // Step 2: Retrieve genuine activationCode/LPA from Octane REST getEsimDetails (never synthesize a fake QR)
      const qrDetails = await this.fetchOctaneEsimActivation({
        custNo: cleanCustNo,
        msn: effectiveMsn,
        lineSeqNo: effectiveLineSeqNo,
      }).catch((err: any) => {
        this.logger.warn(
          `Octane REST getEsimDetails QR lookup unavailable after ${carrierActionTaken} for ${cleanCustNo}: ${err.message}`,
        );
        return null;
      });
      if (qrDetails) {
        smdpAddress = qrDetails.smdpAddress;
        activationCode = qrDetails.activationCode;
        lpaString = qrDetails.lpaString;
      }

      // Atomic fail-closed guard: if Octane neither reset the eSIM profile nor returned a valid QR code, do not save anything
      if (carrierActionTaken !== 'OCTANE_MANAGE_ESIM_RESET' && !lpaString) {
        throw new BadRequestException(
          'We could not reset your existing eSIM profile automatically. Please try again or contact our support team on 1300 492 002 or info@justmobile.ai so we can issue a fresh replacement eSIM for you.',
        );
      }
    }

    const qrCodeDataUrl = lpaString
      ? await QRCode.toDataURL(lpaString, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 320,
          color: { dark: '#142420', light: '#FFFFFF' },
        })
      : null;

    const now = new Date();
    if (existingOrder) {
      await ordersCol.updateOne(
        { _id: (existingOrder as any)._id },
        {
          $set: {
            ...(lpaString ? { lpaString, activationCode } : {}),
            ...(carrierOrderId ? { lastCarrierOrderId: carrierOrderId } : {}),
            isEsim: true,
            isQRcode: true,
            updatedAt: now,
          } as any,
        },
      );
    } else if (cleanCustNo !== 'CUST990001') {
      await ordersCol.insertOne({
        orderId: carrierOrderId || replacementRef,
        custNo: cleanCustNo,
        msn: cleanMsn,
        planNo: '11144157',
        planName: userDoc?.planName || 'JM 65GB Auto',
        pricePerMonth: userDoc?.planPrice || 40,
        status: 'ACTIVE',
        orderType: 'ESIM_REPLACEMENT',
        orderAction: 'CHANGE_WME_SIM',
        isEsim: true,
        isQRcode: true,
        ...(lpaString ? { lpaString } : {}),
        ...(activationCode ? { activationCode } : {}),
        email: recipientEmail,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (cleanCustNo !== 'CUST990001') {
      await replacementsCol.insertOne({
        referenceNumber: replacementRef,
        carrierOrderId: carrierOrderId || null,
        custNo: cleanCustNo,
        msn: cleanMsn,
        email: recipientEmail,
        reason: options?.reason || 'Customer requested replacement eSIM QR code',
        carrierActionTaken,
        lpaString: lpaString || null,
        createdAt: now,
      });
    }

    let emailSent = false;
    if (
      lpaString &&
      activationCode &&
      recipientEmail &&
      recipientEmail.includes('@') &&
      !recipientEmail.endsWith('@example.com') &&
      !recipientEmail.endsWith('.invalid')
    ) {
      emailSent = await this.mailService
        .sendEsimWelcomeEmail({
          to: recipientEmail,
          recipientName,
          custNo: cleanCustNo,
          orderId: carrierOrderId || existingOrder?.orderId || replacementRef,
          msn: cleanMsn,
          planName: existingOrder?.planName || userDoc?.planName || 'JustMobile eSIM Plan',
          pricePerMonth: existingOrder?.pricePerMonth || userDoc?.planPrice || 40,
          lpaString,
          smdpAddress,
          activationCode,
          isEsim: true,
        })
        .catch(() => false);
    }

    const carrierDispatchedEmail = false;

    return {
      success: true,
      referenceNumber: replacementRef,
      orderId: carrierOrderId || existingOrder?.orderId || replacementRef,
      msn: cleanMsn,
      lpa: lpaString,
      smdpAddress: lpaString ? smdpAddress : null,
      activationCode,
      qrCodeDataUrl,
      emailSent,
      carrierDispatchedEmail,
      email: recipientEmail,
      carrierActionTaken,
      instructions: [
        'Connect your phone to a stable Wi-Fi network.',
        'Open Settings > Mobile / Cellular > Add eSIM.',
        lpaString
          ? 'Scan the replacement QR code below or enter the SM-DP+ Address and Activation Code manually.'
          : 'Your existing eSIM profile has been reset. If you do not see the QR yet, please try again shortly or contact 1300 492 002.',
        'Select your JustMobile eSIM line for Voice, SMS, and Mobile Data.',
      ],
      message: lpaString
        ? `Replacement eSIM QR code (${replacementRef}) has been issued${
            emailSent ? ` and emailed to ${recipientEmail}` : ''
          }.`
        : `Your eSIM profile (${replacementRef}) has been reset with the carrier. Please try fetching your QR code again in a moment.`,
    };
  }

  // ==========================================================================
  // 5. ACMA PRE-PORT 2FA SMS VERIFICATION (/UtbOTP)
  // ==========================================================================

  /**
   * Send ACMA Mandated Pre-Port SMS 2FA Code
   */
  async sendPrePortOtp(custNo: string, destination: string): Promise<{
    success: boolean;
    transactionId: string;
    destination: string;
    message: string;
  }> {
    const cleanDestination = this.normalizeMsn(destination);
    if (!/^04\d{8}$/.test(cleanDestination)) {
      throw new BadRequestException(
        'Please provide a valid 10-digit Australian mobile number (e.g. 0412 345 678).',
      );
    }

    const transactionId = `TX-PORT-${Date.now()}`;
    const mockCode = '829104';

    const cleanCustNo = (custNo || '').trim();
    const isLive = process.env.TELCO_LIVE_CREATE === 'true' && (!cleanCustNo || /^\d+$/.test(cleanCustNo));

    if (isLive) {
      try {
        const result: any = await this.soapCall('/UtbOTP', 'manageOtp', {
          manageOtpRequest: {
            requestType: 'getOtp',
            getOtp: {
              ...(cleanCustNo ? { custNo: Number(cleanCustNo) } : {}),
              destination: cleanDestination,
              destinationCategory: 'Phone (Bh)',
              destinationType: 'Primary Account Holder',
              method: 'SMS',
              operationType: 'Port',
              reason: 'R8',
            },
          },
        });

        const ret = this.assertOctaneSoapSuccess('UtbOTP getOtp', result);
        const getOtpNode = ret?.getOtp || ret;
        const nodeCheck = this.hasOctaneFailure(getOtpNode);
        if (nodeCheck.failed) {
          this.logger.error(`Octane rejected UtbOTP getOtp: ${nodeCheck.detail}`);
          throw new BadRequestException(this.formatFriendlyCarrierError('UtbOTP getOtp', nodeCheck.detail));
        }

        const txId = getOtpNode?.transactionId || ret?.transactionId;
        if (!txId) {
          this.logger.error(`UtbOTP getOtp missing transactionId: ${JSON.stringify(ret)}`);
          throw new BadRequestException(this.formatFriendlyCarrierError('UtbOTP getOtp', 'Missing transactionId'));
        }
        return {
          success: true,
          transactionId: String(txId),
          destination: cleanDestination,
          message: `ACMA security code dispatched via SMS to ${cleanDestination}.`,
        };
      } catch (err: any) {
        this.logger.error(`Live OTP dispatch failed: ${err.message}`);
        if (err instanceof HttpException) throw err;
        throw new BadRequestException(this.formatFriendlyCarrierError('UtbOTP getOtp', err.message));
      }
    }

    // Persist OTP record in MongoDB for validation
    const otpCol = this.db.getCollection('otp_verifications');
    await otpCol.insertOne({
      custNo,
      destination: cleanDestination,
      transactionId,
      code: mockCode,
      used: false,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    });

    return {
      success: true,
      transactionId,
      destination: cleanDestination,
      message:
        process.env.NODE_ENV !== 'production'
          ? `ACMA security code sent to ${cleanDestination}. (Development Code: ${mockCode})`
          : `ACMA security code sent to ${cleanDestination}.`,
    };
  }

  /**
   * Verify Pre-Port SMS 2FA Code
   */
  async verifyPrePortOtp(transactionId: string, code: string): Promise<{
    success: boolean;
    verified: boolean;
    transactionId: string;
    message: string;
  }> {
    const cleanCode = code.trim();
    const isLiveTx =
      process.env.TELCO_LIVE_CREATE === 'true' &&
      !transactionId.startsWith('TX-PORT-') &&
      transactionId !== 'TX-DEV';

    if (isLiveTx) {
      try {
        const result: any = await this.soapCall('/UtbOTP', 'manageOtp', {
          manageOtpRequest: {
            requestType: 'verifyOtp',
            verifyOtp: {
              code: cleanCode,
              transactionId,
            },
          },
        });

        const ret = this.assertOctaneSoapSuccess('UtbOTP verifyOtp', result);
        const verifyNode = ret?.verifyOtp || ret;
        const nodeCheck = this.hasOctaneFailure(verifyNode);
        if (nodeCheck.failed) {
          this.logger.error(`Octane rejected UtbOTP verifyOtp: ${nodeCheck.detail}`);
          throw new BadRequestException(this.formatFriendlyCarrierError('UtbOTP verifyOtp', nodeCheck.detail));
        }

        const rawValid = verifyNode?.valid ?? ret?.valid ?? ret?.success;
        const verified = rawValid === true || String(rawValid || '').trim().toLowerCase() === 'true';
        if (!verified) {
          throw new BadRequestException(
            verifyNode?.message || 'The verification code was incorrect or expired. Please check your SMS and try again.',
          );
        }
        return {
          success: true,
          verified: true,
          transactionId,
          message: 'Mobile number verified.',
        };
      } catch (err: any) {
        this.logger.error(`Live OTP verify failed: ${err.message}`);
        if (err instanceof HttpException) throw err;
        throw new BadRequestException(this.formatFriendlyCarrierError('UtbOTP verifyOtp', err.message));
      }
    }

    // Development fallback only when live carrier integration is disabled
    if (process.env.TELCO_LIVE_CREATE !== 'true' && cleanCode === '829104') {
      return {
        success: true,
        verified: true,
        transactionId,
        message: 'Pre-port identity successfully verified under ACMA standards.',
      };
    }

    const otpCol = this.db.getCollection('otp_verifications');
    const record = await otpCol.findOne({
      transactionId,
      code: cleanCode,
      used: false,
      expiresAt: { $gt: new Date() },
    });

    if (!record) {
      throw new BadRequestException('Invalid or expired ACMA 2FA verification code.');
    }

    await otpCol.updateOne({ _id: record._id }, { $set: { used: true } });

    return {
      success: true,
      verified: true,
      transactionId,
      message: 'Pre-port identity successfully verified under ACMA standards.',
    };
  }

  // ==========================================================================
  // 6. LIVE USAGE & BALANCE SYNC (/UtbCall & /UtbCustomer)
  // ==========================================================================

  /**
   * Upgrade or Change Customer Plan (INT-11)
   */
  async changePlan(custNo: string, dto: {
    planId?: string;
    planName: string;
    monthlyFee: number;
    dataGb: number;
    dataBankMaxGb?: number;
    msn?: string;
  }): Promise<{
    success: boolean;
    carrierOrderId?: string;
    custNo: string;
    planName: string;
    monthlyFee: number;
    dataGb: number;
    effectiveDate: string;
    message: string;
  }> {
    if (!dto.planName || !dto.monthlyFee) {
      throw new BadRequestException('Plan name and monthly fee are required.');
    }

    const cleanCustNo = custNo.trim();
    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const [existingOrder, userDoc] = await Promise.all([
      ordersCol.findOne({ custNo: cleanCustNo }, { sort: { updatedAt: -1 } }),
      this.findUserDoc(cleanCustNo),
    ]);

    const cleanMsn = (dto.msn || existingOrder?.msn || userDoc?.phone || '0491570006').replace(/\s+/g, '');
    const isLive = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test(cleanCustNo);

    const resolvedPlan = this.resolvePlanDetails(dto.planName, dto.planId);
    const targetPlanNo = resolvedPlan?.planNo || '';
    if (isLive && !targetPlanNo) {
      throw new BadRequestException('Selected plan could not be matched to a valid carrier plan.');
    }

    let carrierOrderId: string | undefined;
    let effectiveMsn = cleanMsn;

    if (isLive) {
      const liveSvc = await this.resolveLiveServiceLine(cleanCustNo, dto.msn);
      effectiveMsn = liveSvc.msn || cleanMsn;
      const custReqDate = this.getOctaneBillingCycleDate();

      this.logger.warn(
        `[LIVE CARRIER CALL] Submitting CHANGE_WME_PLAN to Octane for ${cleanCustNo} (lineSeqNo=${liveSvc.lineSeqNo}, planno=${targetPlanNo})`,
      );
      try {
        const result: any = await this.soapCall('/UtbOrder', 'orderCreate', {
          createRequest: {
            custNo: cleanCustNo,
            orderType: 'SRVC_ORD',
            orderAction: 'CHANGE_WME_PLAN',
            orderItems: {
              wmeModifyPlanReqItem: {
                lineSeqNo: liveSvc.lineSeqNo,
                planno: Number(targetPlanNo),
                custReqDate,
              },
            },
          },
        });
        const ret = this.assertOctaneSoapSuccess('CHANGE_WME_PLAN', result);
        if (ret?.orderId) {
          carrierOrderId = String(ret.orderId);
        }
      } catch (err: any) {
        this.logger.error(`Live plan change failed for ${cleanCustNo}: ${err.message}`);
        if (err instanceof HttpException) throw err;
        throw new BadRequestException(this.formatFriendlyCarrierError('CHANGE_WME_PLAN', err.message));
      }
    }

    const now = new Date();
    const effectivePlanNo = targetPlanNo || '11144157';

    if (existingOrder) {
      await ordersCol.updateMany(
        { custNo: cleanCustNo },
        {
          $set: {
            planNo: effectivePlanNo,
            planName: dto.planName,
            pricePerMonth: dto.monthlyFee,
            updatedAt: now,
          },
        },
      );
    } else {
      const orderId = carrierOrderId || `ORD-${Math.floor(100000 + Math.random() * 900000)}`;
      await ordersCol.insertOne({
        orderId,
        custNo: cleanCustNo,
        msn: effectiveMsn,
        planNo: effectivePlanNo,
        planName: dto.planName,
        pricePerMonth: dto.monthlyFee,
        status: 'ACTIVE',
        orderType: 'PLAN_CHANGE',
        orderAction: 'CHANGE_WME_PLAN',
        isEsim: true,
        isQRcode: true,
        ...(isLive ? {} : { lpaString: `LPA:1$smdp.telcoinabox.com.au$JM-AU-${orderId}` }),
        email: userDoc?.email,
        createdAt: now,
        updatedAt: now,
      } as any);
    }

    // Persist in plan_changes collection for audit and reporting
    const planChangesCol = this.db.getCollection('plan_changes');
    await planChangesCol.insertOne({
      custNo: cleanCustNo,
      msn: effectiveMsn,
      carrierOrderId: carrierOrderId || null,
      newPlanName: dto.planName,
      planNo: effectivePlanNo,
      monthlyFee: dto.monthlyFee,
      dataGb: dto.dataGb,
      previousPlanName: existingOrder?.planName || 'Active Mobile Plan',
      changedAt: now,
    });

    return {
      success: true,
      ...(carrierOrderId ? { carrierOrderId } : {}),
      custNo: cleanCustNo,
      planName: dto.planName,
      monthlyFee: dto.monthlyFee,
      dataGb: dto.dataGb,
      effectiveDate: 'Next billing cycle (28th) with immediate quota allocation',
      message: `Plan successfully switched to ${dto.planName}. Your quota has been updated immediately.`,
    };
  }

  /**
   * Cancel a pending Octane order (/UtbOrder orderCancel)
   */
  async cancelOrder(custNo: string, orderId?: string | null, detail?: string): Promise<{ cancelledWithOctane: boolean }> {
    const cleanCustNo = String(custNo || '').trim();
    const cleanOrderId = String(orderId || '').trim();
    const isLiveNumeric = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test(cleanCustNo);

    if (!isLiveNumeric) {
      return { cancelledWithOctane: false };
    }

    if (!/^\d+$/.test(cleanOrderId)) {
      throw new BadRequestException(
        'This order has no cancellable carrier reference or is already being processed. Please contact 1300 492 002 or info@justmobile.ai for help.',
      );
    }

    try {
      const res: any = await this.soapCall('/UtbOrder', 'orderCancel', {
        request: {
          orderId: Number(cleanOrderId),
          detail: detail || 'Customer requested order cancellation',
        },
      });
      this.assertOctaneSoapSuccess('orderCancel', res);
      return { cancelledWithOctane: true };
    } catch (err: any) {
      this.logger.error(`Live orderCancel failed for order ${cleanOrderId} (custNo=${cleanCustNo}): ${err.message}`);
      if (err instanceof HttpException) throw err;
      throw new BadRequestException(this.formatFriendlyCarrierError('orderCancel', err.message));
    }
  }

  /**
   * Cancel a pending/in-progress mobile number transfer order (NNA-084)
   */
  async cancelPortOrder(
    custNo: string,
    orderId: string,
    reason?: string,
  ): Promise<{
    success: boolean;
    orderId: string;
    msn: string;
    status: string;
    cancelledWithOctane: boolean;
    message: string;
  }> {
    const cleanCustNo = String(custNo || '').trim();
    const cleanOrderId = String(orderId || '').trim();
    if (!cleanCustNo || !cleanOrderId) {
      throw new BadRequestException('Customer number and order ID are required.');
    }

    const ordersCol = this.db.getCollection<OrderRecord>('orders');
    const order = await ordersCol.findOne({ orderId: cleanOrderId, custNo: cleanCustNo });
    if (!order) {
      throw new NotFoundException(`Order #${cleanOrderId} not found.`);
    }

    if (order.status === 'ACTIVE' || order.status === 'COMPLETED' || order.status === 'CANCELLED') {
      throw new BadRequestException(
        `Order #${cleanOrderId} cannot be cancelled because its status is ${order.status}.`,
      );
    }

    const detail = reason?.trim() || 'Customer requested mobile number transfer cancellation';
    const octaneRes = await this.cancelOrder(cleanCustNo, cleanOrderId, detail);

    const now = new Date();
    await ordersCol.updateOne(
      { orderId: cleanOrderId, custNo: cleanCustNo },
      {
        $set: {
          status: 'CANCELLED',
          cancellationReason: reason?.trim() || 'Cancelled by customer',
          cancelledAt: now,
          updatedAt: now,
        } as any,
      },
    );

    return {
      success: true,
      orderId: cleanOrderId,
      msn: order.msn,
      status: 'CANCELLED',
      cancelledWithOctane: octaneRes.cancelledWithOctane,
      message: `Mobile number transfer for ${order.msn} (Order #${cleanOrderId}) has been cancelled.`,
    };
  }

  /**
   * Get Real-time Monthly Usage & Billing Cycle Meter
   */
  async getUnbilledUsage(custNo: string) {
    const cleanCustNo = (custNo || '').trim();
    const isLiveNumeric = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test(cleanCustNo);

    if (isLiveNumeric) {
      const numericCustNo = parseInt(cleanCustNo, 10);
      const [svcRes, catRes, remDataRes, remVoiceRes] = await Promise.allSettled([
        this.getServices(cleanCustNo),
        this.soapCall('/UtbCall', 'getUnbilledCallsSummaryCategorize', { custNo: numericCustNo }),
        this.soapCall('/UtbCall', 'getMobileCallRemainingData', { custNo: numericCustNo }),
        this.soapCall('/UtbCall', 'getMobileCallRemaining', { custNo: numericCustNo }),
      ]);

      const services = svcRes.status === 'fulfilled' ? svcRes.value.services || [] : [];
      if (services.length === 0) {
        return {
          custNo: cleanCustNo,
          source: 'octane-live',
          hasActivePlan: false,
          billingCycle: 'No active plan',
          cycleDetails: null,
          dataMeter: null,
          voiceAndSms: null,
        };
      }

      const primarySvc: any = services[0];
      const catCall =
        catRes.status === 'fulfilled'
          ? (Array.isArray(catRes.value?.unbilledCallsSummaryCategorize?.calls)
              ? catRes.value.unbilledCallsSummaryCategorize.calls[0]
              : catRes.value?.unbilledCallsSummaryCategorize?.calls) || null
          : null;
      const remData =
        remDataRes.status === 'fulfilled'
          ? (Array.isArray(remDataRes.value?.mobileCallRemainingData?.calls)
              ? remDataRes.value.mobileCallRemainingData.calls[0]
              : remDataRes.value?.mobileCallRemainingData?.calls) || null
          : null;
      const remVoice =
        remVoiceRes.status === 'fulfilled'
          ? (Array.isArray(remVoiceRes.value?.mobileCallRemaining?.calls)
              ? remVoiceRes.value.mobileCallRemaining.calls[0]
              : remVoiceRes.value?.mobileCallRemaining?.calls) || null
          : null;

      const resolvedPlan = this.resolvePlanDetails(
        catCall?.planName || remData?.planName || primarySvc.planName,
        remData?.planNo || primarySvc.planNo,
      );
      const planMatch = (catCall?.planName || primarySvc.planName || '').match(/(\d+)\s*GB/i);
      const planTotalGb = resolvedPlan?.dataGb || (planMatch ? parseInt(planMatch[1], 10) : 0);

      // Parse live data used from Octane ('0', '1.4 GB', '512 MB', etc.)
      let dataUsedGb = 0;
      const rawDataStr = String(
        catCall?.download && catCall.download !== '0 GB'
          ? catCall.download
          : catCall?.dataUsed ?? remData?.dataUsed ?? '0',
      ).trim();
      const mbMatch = rawDataStr.match(/([\d.]+)\s*MB/i);
      const gbMatch = rawDataStr.match(/([\d.]+)/);
      if (mbMatch) {
        dataUsedGb = Number((parseFloat(mbMatch[1]) / 1024).toFixed(2));
      } else if (gbMatch) {
        dataUsedGb = Number(parseFloat(gbMatch[1]).toFixed(2));
      }

      const cycle = this.getCurrentBillingCycleDates();
      let periodEnd = cycle.periodEnd;
      let daysRemaining = cycle.daysRemaining;
      if (catCall?.dataCountResetDate) {
        const resetDate = new Date(catCall.dataCountResetDate);
        if (!isNaN(resetDate.getTime())) {
          periodEnd = resetDate.toISOString().split('T')[0];
          daysRemaining = Math.max(0, Math.ceil((resetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
        }
      }

      const dataRemainingGb = Number(Math.max(0, planTotalGb - dataUsedGb).toFixed(2));
      const percentRemaining =
        planTotalGb > 0 ? Number(((dataRemainingGb / planTotalGb) * 100).toFixed(1)) : 0;

      return {
        custNo: cleanCustNo,
        source: 'octane-live',
        hasActivePlan: true,
        planName: resolvedPlan?.name || primarySvc.planName,
        billingCycle: '28th of every month',
        cycleDetails: {
          periodStart: cycle.periodStart,
          periodEnd,
          daysRemaining,
        },
        dataMeter: {
          planTotalGb,
          dataUsedGb,
          dataRemainingGb,
          percentRemaining,
          bankedDataGb: 0,
          bankedMaxGb: 0,
          autoRollover: false,
        },
        voiceAndSms: {
          unlimitedStandardAuCalls: true,
          unlimitedStandardAuSms: true,
          minutesUsed: parseInt(catCall?.totalCalls || '0', 10) || 0,
          smsSent: parseInt(remVoice?.smsCount || '0', 10) || 0,
          unbilledChargeAud: parseFloat(catCall?.totalCharge || '0') || 0,
        },
      };
    }

    // Demo fallback for non-numeric sandbox account (CUST990001)
    const cycle = this.getCurrentBillingCycleDates();
    const isTestCustomer = cleanCustNo === 'CUST990001';
    if (!isTestCustomer) {
      return {
        custNo: cleanCustNo,
        hasActivePlan: false,
        billingCycle: 'No active plan',
        cycleDetails: null,
        dataMeter: null,
        voiceAndSms: null,
      };
    }

    const planTotalGb = 65;
    const dataUsedGb = 7.6;
    const dataRemainingGb = Number((planTotalGb - dataUsedGb).toFixed(1));
    return {
      custNo: cleanCustNo,
      hasActivePlan: true,
      billingCycle: '28th of every month',
      cycleDetails: {
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        daysRemaining: cycle.daysRemaining,
      },
      dataMeter: {
        planTotalGb,
        dataUsedGb,
        dataRemainingGb,
        percentRemaining: Number(((dataRemainingGb / planTotalGb) * 100).toFixed(1)),
        bankedDataGb: 0,
        bankedMaxGb: 0,
        autoRollover: false,
      },
      voiceAndSms: {
        unlimitedStandardAuCalls: true,
        unlimitedStandardAuSms: true,
        minutesUsed: 342,
        smsSent: 89,
        internationalSmsSent: 4,
      },
    };
  }

  // ==========================================================================
  // 7. PAYMENT METHODS (QUICKSTREAM -> OCTANE DIRECT DEBIT)
  // ==========================================================================

  /**
   * Build MongoDB filter matching custNo regardless of string/number storage
   */
  private buildCustNoFilter(custNo: string): Record<string, any> {
    const clean = (custNo || '').trim();
    const digits = clean.replace(/\D+/g, '');
    const numericVal = digits ? parseInt(digits, 10) : NaN;
    const orClauses: any[] = [{ custNo: clean }];
    if (!isNaN(numericVal)) {
      orClauses.push({ custNo: numericVal });
    }
    return { $or: orClauses };
  }

  /**
   * Register a Westpac QuickStream single-use card token on the customer's Octane account.
   * Octane handles all recurring billing and direct debit charges natively.
   */
  async addPaymentMethod(custNo: string, paymentTokenId: string) {
    const cleanCustNo = String(custNo || '').trim();
    const cleanToken = String(paymentTokenId || '').trim();

    if (!cleanCustNo || !cleanToken) {
      throw new BadRequestException('Customer number and payment token are required.');
    }

    const isLiveNumeric = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test(cleanCustNo);
    const groupNo = this.groupNo || process.env.groupNo || '922';
    let result: any = null;

    if (isLiveNumeric) {
      const endpoint = `/api/v1/group/${groupNo}/customer/${cleanCustNo}/payment-method`;
      const payload = {
        paymentProvider: 'QS',
        paymentTokenId: cleanToken,
      };
      this.logger.log(`Registering QuickStream payment method with Octane for custNo=${cleanCustNo}`);
      result = await this.restCall(endpoint, payload, 'POST');
    } else {
      result = {
        paymentProvider: 'QS',
        paymentTokenId: cleanToken,
        simulated: true,
      };
    }

    const usersCol = this.db.getCollection('users');
    await usersCol.updateOne(this.buildCustNoFilter(cleanCustNo), {
      $set: {
        hasPaymentMethod: true,
        paymentProvider: 'QS',
        paymentMethodLabel: 'Direct Debit (QuickStream Card)',
        paymentUpdatedAt: new Date(),
      },
    });

    return {
      success: true,
      custNo: cleanCustNo,
      paymentProvider: 'QS',
      data: result,
      message: 'Payment method added successfully.',
    };
  }

  /**
   * Retrieve registered payment methods for a customer from Octane (or local state in sandbox mode).
   */
  async getPaymentMethods(custNo: string) {
    const cleanCustNo = String(custNo || '').trim();
    if (!cleanCustNo) {
      throw new BadRequestException('Customer number is required.');
    }

    const isLiveNumeric = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test(cleanCustNo);
    const groupNo = this.groupNo || process.env.groupNo || '922';

    if (isLiveNumeric) {
      const endpoint = `/api/v1/group/${groupNo}/customer/${cleanCustNo}/payment-method`;
      const result = await this.restCall<any>(endpoint, undefined, 'GET');
      return {
        success: true,
        custNo: cleanCustNo,
        data: result ?? [],
      };
    }

    const userDoc = await this.findUserDoc(cleanCustNo);
    return {
      success: true,
      custNo: cleanCustNo,
      data: userDoc?.hasPaymentMethod ? [{ paymentProvider: 'QS', status: 'ACTIVE' }] : [],
    };
  }

  /**
   * Retrieve Current Balance and Invoicing Info
   */
  async getBalance(custNo: string) {
    const cleanCustNo = (custNo || '').trim();
    const isLiveNumeric = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test(cleanCustNo);

    if (isLiveNumeric) {
      const [balRes, svcRes, custRes, userRes] = await Promise.allSettled([
        this.soapCall('/UtbCustomer', 'getCurrBalance', { customer: { custNo: cleanCustNo } }),
        this.getServices(cleanCustNo),
        this.getCustomer(cleanCustNo),
        this.findUserDoc(cleanCustNo),
      ]);

      let liveCurrBalance = 0.0;
      if (balRes.status === 'fulfilled') {
        const parsed = parseFloat(balRes.value?.return?.currBalance ?? balRes.value?.currBalance ?? '0');
        if (!isNaN(parsed)) liveCurrBalance = parsed;
      }

      const services = svcRes.status === 'fulfilled' ? svcRes.value.services || [] : [];
      const customerInfo: any = custRes.status === 'fulfilled' ? custRes.value : null;
      const userDoc: any = userRes.status === 'fulfilled' ? userRes.value : null;
      const hasActivePlan = services.length > 0 && customerInfo?.status !== 'Disconnected';
      const hasSavedPayment = Boolean(
        userDoc?.hasPaymentMethod ||
          customerInfo?.paymentMethod === 'CC' ||
          customerInfo?.raw?.direct_debit_method === 'CC' ||
          customerInfo?.raw?.payment_method === 'DD' ||
          customerInfo?.raw?.direct_debit_method,
      );
      const ddLabel =
        userDoc?.hasPaymentMethod
          ? userDoc.paymentMethodLabel || 'Direct Debit (QuickStream Card)'
          : customerInfo?.paymentMethod === 'CC' || customerInfo?.raw?.direct_debit_method === 'CC'
            ? 'Direct Debit (Credit/Debit Card)'
            : customerInfo?.paymentMethod || (hasActivePlan ? 'Direct Debit' : 'No payment method registered');

      if (!hasActivePlan) {
        return {
          custNo: cleanCustNo,
          source: 'octane-live',
          hasActivePlan: false,
          currentBalance: liveCurrBalance,
          formattedBalance: `$${liveCurrBalance.toFixed(2)}`,
          lastInvoiceAmount: 0.0,
          lastInvoiceDate: null,
          nextInvoiceDate: null,
          nextInvoiceAmount: 0.0,
          autoPayStatus: hasSavedPayment ? 'Active (Card Saved)' : 'Inactive',
          paymentMethod: ddLabel,
        };
      }

      const primarySvc: any = services[0];
      const resolved = this.resolvePlanDetails(primarySvc.planName, primarySvc.planNo);
      const monthlyFee = resolved?.price ?? primarySvc.planPrice ?? 0;
      const cycle = this.getCurrentBillingCycleDates();

      return {
        custNo: cleanCustNo,
        source: 'octane-live',
        hasActivePlan: true,
        planName: resolved?.name || primarySvc.planName,
        currentBalance: liveCurrBalance,
        formattedBalance: `$${liveCurrBalance.toFixed(2)}`,
        lastInvoiceAmount: monthlyFee,
        lastInvoiceDate: cycle.lastInvoiceDate,
        nextInvoiceDate: cycle.nextInvoiceDate,
        nextInvoiceAmount: monthlyFee,
        autoPayStatus: hasSavedPayment ? 'Active' : 'Standard',
        paymentMethod: ddLabel,
      };
    }

    const isTestCustomer = cleanCustNo === 'CUST990001';
    if (!isTestCustomer) {
      const userDoc = await this.findUserDoc(cleanCustNo);
      return {
        custNo: cleanCustNo,
        hasActivePlan: false,
        currentBalance: 0.0,
        formattedBalance: '$0.00',
        lastInvoiceAmount: 0.0,
        lastInvoiceDate: null,
        nextInvoiceDate: null,
        nextInvoiceAmount: 0.0,
        autoPayStatus: userDoc?.hasPaymentMethod ? 'Active (Card Saved)' : 'Inactive',
        paymentMethod: userDoc?.hasPaymentMethod
          ? userDoc.paymentMethodLabel || 'Direct Debit (QuickStream Card)'
          : 'No payment method registered',
      };
    }

    const cycle = this.getCurrentBillingCycleDates();
    return {
      custNo: cleanCustNo,
      hasActivePlan: true,
      currentBalance: 0.0,
      formattedBalance: '$0.00',
      lastInvoiceAmount: 40,
      lastInvoiceDate: cycle.lastInvoiceDate,
      nextInvoiceDate: cycle.nextInvoiceDate,
      nextInvoiceAmount: 40,
      autoPayStatus: 'Active',
      paymentMethod: 'Mastercard ending in 9001',
    };
  }
}
