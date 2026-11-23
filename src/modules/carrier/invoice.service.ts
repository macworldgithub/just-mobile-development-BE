import { Injectable, Logger, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CarrierService } from './carrier.service';
import { MailService } from '../mail/mail.service';
import PDFDocument from 'pdfkit';

export interface InvoiceRecord {
  invoiceId: string;
  custNo: string;
  issueDate: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  planName: string;
  dataAllowance: string;
  amount: number;
  gstAmount: number;
  subtotal: number;
  status: 'PAID' | 'DUE' | 'OVERDUE';
  paymentMethod: string;
  transactionRef: string;
}

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly db: DatabaseService,
    @Inject(forwardRef(() => CarrierService))
    private readonly carrierService: CarrierService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Retrieve list of customer tax invoices
   */
  async getCustomerInvoices(custNo: string): Promise<InvoiceRecord[]> {
    const invoicesCol = this.db.getCollection<InvoiceRecord>('invoices');
    const existing = await invoicesCol.find({ custNo }).sort({ issueDate: -1 }).toArray();
    const isLiveNumeric = process.env.TELCO_LIVE_CREATE === 'true' && /^\d+$/.test((custNo || '').trim());

    const hasOnlyStaleMockInvoices =
      isLiveNumeric &&
      existing.length > 0 &&
      existing.every(
        (inv) =>
          String(inv.transactionRef || '').startsWith('TXN-QS-') &&
          /Starter Mobile|Standard Mobile|SimplyBig/i.test(String(inv.planName || '')),
      );

    if (!isLiveNumeric && existing.length > 0) {
      return existing;
    }

    const isTestCustomer = custNo === 'CUST990001';

    let activePlanName = 'JM 65GB Auto';
    let activeDataGb = 65;
    let amount = 40;
    let hasActivePlan = isTestCustomer;

    if (isLiveNumeric) {
      const groupNo = process.env.groupNo || '922';
      const [custRes, svcRes, txRes] = await Promise.allSettled([
        this.carrierService.getCustomer(custNo),
        this.carrierService.getServices(custNo),
        this.carrierService.restCall<any>(
          `/api/v1/group/${groupNo}/customer/${custNo.trim()}/transaction/`,
          undefined,
          'GET',
        ),
      ]);

      const rawTxList =
        txRes.status === 'fulfilled'
          ? Array.isArray(txRes.value)
            ? txRes.value
            : Array.isArray(txRes.value?.transactions)
              ? txRes.value.transactions
              : Array.isArray(txRes.value?.content)
                ? txRes.value.content
                : []
          : [];

      const services = svcRes.status === 'fulfilled' ? svcRes.value?.services || [] : [];
      const primarySvc: any = services[0];
      const resolved = primarySvc
        ? this.carrierService.resolvePlanDetails(primarySvc.planName, primarySvc.planNo)
        : null;
      const planLabel = resolved?.name || primarySvc?.planName || 'JustMobile Service';
      const dataGb = resolved?.dataGb || 65;
      const networkTier = dataGb >= 65 ? '5G' : '4G';
      const customerStatus = custRes.status === 'fulfilled' ? custRes.value?.status : 'Active';

      // Map real Octane billing/payment transactions (never invent synthetic sample invoices for live customers)
      if (rawTxList.length > 0) {
        return rawTxList.map((tx: any, idx: number) => {
          const amt = Math.abs(Number(tx.amount ?? tx.transactionAmount ?? resolved?.price ?? 0));
          const gst = Number((amt / 11).toFixed(2));
          const sub = Number((amt - gst).toFixed(2));
          const txDate = String(tx.transactionDate || tx.createdDate || new Date().toISOString()).slice(0, 10);
          return {
            invoiceId: String(tx.stmtNo || tx.invoiceId || tx.transactionId || `TXN-${idx + 1}`),
            custNo,
            issueDate: txDate,
            dueDate: txDate,
            periodStart: txDate,
            periodEnd: txDate,
            planName: tx.description || tx.comment || `${planLabel} (Telstra Wholesale ${networkTier})`,
            dataAllowance: `${dataGb} GB Monthly ${networkTier} Data`,
            subtotal: sub,
            gstAmount: gst,
            amount: amt,
            status: 'PAID' as const,
            paymentMethod: String(tx.paymentMethod || tx.paymentProvider || 'Direct Debit / Card'),
            transactionRef: String(tx.transactionId || tx.paymentReference || tx.stmtNo || `TXN-${custNo}-${idx + 1}`),
          };
        });
      }

      if (existing.length > 0 && !hasOnlyStaleMockInvoices) {
        return existing;
      }

      if (customerStatus === 'Disconnected' || services.length === 0) {
        return [];
      }

      return [];
    }

    if (!isTestCustomer) {
      return [];
    }

    if (!hasActivePlan) {
      return [];
    }

    const gstAmount = Number((amount / 11).toFixed(2));
    const subtotal = Number((amount - gstAmount).toFixed(2));
    const networkTier = activeDataGb >= 65 ? '5G' : '4G';
    const planName = `${activePlanName} (Telstra Wholesale ${networkTier})`;
    const dataAllowance = `${activeDataGb} GB Monthly ${networkTier} Data`;
    const paymentMethod = 'Mastercard ending in 9001 (Auto-Pay)';

    // Default invoices matching billing cycle on 28th
    const sampleInvoices: InvoiceRecord[] = [
      {
        invoiceId: `INV-2026-10-${custNo.replace(/\D/g, '') || '990001'}`,
        custNo,
        issueDate: '2026-10-28',
        dueDate: '2026-11-28',
        periodStart: '2026-10-28',
        periodEnd: '2026-11-27',
        planName,
        dataAllowance,
        subtotal,
        gstAmount,
        amount,
        status: 'PAID',
        paymentMethod,
        transactionRef: `TXN-QS-${custNo.replace(/\D/g, '') || '990001'}-OCT`,
      },
      {
        invoiceId: `INV-2026-09-${custNo.replace(/\D/g, '') || '990001'}`,
        custNo,
        issueDate: '2026-09-28',
        dueDate: '2026-10-28',
        periodStart: '2026-09-28',
        periodEnd: '2026-10-27',
        planName,
        dataAllowance,
        subtotal,
        gstAmount,
        amount,
        status: 'PAID',
        paymentMethod,
        transactionRef: `TXN-QS-${custNo.replace(/\D/g, '') || '990001'}-SEP`,
      },
    ];

    // Store in DB for future lookup
    try {
      await invoicesCol.insertMany(sampleInvoices);
    } catch {
      // Ignore if duplicates exist
    }

    return sampleInvoices;
  }

  /**
   * Generate an ATO-compliant Australian Tax Invoice PDF
   */
  async generateTaxInvoicePdf(custNo: string, invoiceId?: string): Promise<Buffer> {
    const invoices = await this.getCustomerInvoices(custNo);
    const targetInvoice = invoiceId
      ? invoices.find((inv) => inv.invoiceId.toLowerCase() === invoiceId.toLowerCase()) || invoices[0]
      : invoices[0];

    if (!targetInvoice) {
      throw new NotFoundException(`No tax invoice found for customer ${custNo}.`);
    }

    // Lookup customer details (support both string and numeric custNo storage, with live Octane fallback)
    const cleanCustNo = String(custNo || '').trim();
    const digitsOnly = cleanCustNo.replace(/\D+/g, '');
    const numericVal = digitsOnly ? parseInt(digitsOnly, 10) : NaN;
    const userFilter: any[] = [{ custNo: cleanCustNo }];
    if (!isNaN(numericVal)) {
      userFilter.push({ custNo: numericVal });
    }
    const usersCol = this.db.getCollection('users');
    const user = await usersCol.findOne({ $or: userFilter });

    const liveCustomer =
      (!user?.name || !user?.email) && /^\d+$/.test(cleanCustNo)
        ? await this.carrierService.getCustomer(cleanCustNo).catch(() => null)
        : null;

    const isSandboxDemo = cleanCustNo === 'CUST990001';
    const customerName =
      user?.name || liveCustomer?.name || (isSandboxDemo ? 'Jordan Miller' : `Customer ${cleanCustNo}`);
    const customerEmail =
      user?.email || liveCustomer?.email || (isSandboxDemo ? 'jordan.miller@example.com' : 'Not provided');
    const customerPhone =
      user?.phone || liveCustomer?.phone || (isSandboxDemo ? '0491 570 006' : 'Not provided');

    const fmtDayMonth = (iso?: string) => {
      const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? `${m[3]}/${m[2]}` : String(iso || '');
    };
    const startDm = fmtDayMonth(targetInvoice.periodStart);
    const endDm = fmtDayMonth(targetInvoice.periodEnd);
    const periodCellText =
      startDm && endDm && startDm !== endDm ? `${startDm}–${endDm}` : startDm || endDm || targetInvoice.issueDate;

    return new Promise<Buffer>((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margin: 40,
          info: {
            Title: `JustMobile Tax Invoice ${targetInvoice.invoiceId}`,
            Author: 'JustMobile Pty Ltd',
            Subject: 'Australian Tax Invoice',
            Keywords: 'Tax Invoice, GST, JustMobile, Telecommunications',
          },
        });

        const buffers: Buffer[] = [];
        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', (err) => reject(err));

        // -------------------------------------------------------------
        // Header Banner (JustMobile Brand Ink: #142420)
        // -------------------------------------------------------------
        doc.rect(0, 0, doc.page.width, 90).fill('#142420');

        // Brand Name
        doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold').text('justmobile', 45, 28, { continued: true });
        doc.fillColor('#D5F879').text('.');

        doc.fillColor('#A8B8A5').fontSize(10).font('Helvetica').text('A little less telco. A lot more you.', 45, 54);

        // Document Title Badge
        doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold').text('TAX INVOICE', doc.page.width - 200, 32, {
          align: 'right',
          width: 155,
        });

        doc.fillColor('#D5F879').fontSize(9).font('Helvetica').text('AUSTRALIAN GST INCLUSIVE', doc.page.width - 200, 54, {
          align: 'right',
          width: 155,
        });

        // -------------------------------------------------------------
        // Business & Invoice Metadata Grid
        // -------------------------------------------------------------
        let y = 115;

        // Seller Info (Left)
        doc.fillColor('#142420').fontSize(11).font('Helvetica-Bold').text('JUSTMOBILE PTY LTD', 45, y);
        doc.fillColor('#58615F').fontSize(9).font('Helvetica');
        doc.text('ABN: 48 672 819 204', 45, y + 16);
        doc.text('Level 14, 182 George Street', 45, y + 28);
        doc.text('Sydney NSW 2000, Australia', 45, y + 40);
        doc.text('Web: www.justmobile.com.au', 45, y + 52);
        doc.text('Support: info@justmobile.ai · 1300 492 002', 45, y + 64);

        // Invoice Metadata Box (Right)
        const metaBoxX = doc.page.width - 240;
        doc.rect(metaBoxX - 10, y - 5, 205, 84).fillAndStroke('#FAFBF8', '#DFE4DD');

        doc.fillColor('#697866').fontSize(8).font('Helvetica-Bold');
        doc.text('INVOICE NUMBER:', metaBoxX, y + 2);
        doc.fillColor('#142420').fontSize(9).font('Helvetica-Bold');
        doc.text(targetInvoice.invoiceId, metaBoxX + 90, y + 2);

        doc.fillColor('#697866').fontSize(8).font('Helvetica-Bold');
        doc.text('ISSUE DATE:', metaBoxX, y + 18);
        doc.fillColor('#142420').fontSize(9).font('Helvetica');
        doc.text(targetInvoice.issueDate, metaBoxX + 90, y + 18);

        doc.fillColor('#697866').fontSize(8).font('Helvetica-Bold');
        doc.text('DUE DATE:', metaBoxX, y + 34);
        doc.fillColor('#142420').fontSize(9).font('Helvetica');
        doc.text(targetInvoice.dueDate, metaBoxX + 90, y + 34);

        doc.fillColor('#697866').fontSize(8).font('Helvetica-Bold');
        doc.text('BILLING PERIOD:', metaBoxX, y + 50);
        doc.fillColor('#142420').fontSize(8).font('Helvetica');
        doc.text(`${targetInvoice.periodStart} – ${targetInvoice.periodEnd}`, metaBoxX + 90, y + 50);

        doc.fillColor('#697866').fontSize(8).font('Helvetica-Bold');
        doc.text('ACCOUNT STATUS:', metaBoxX, y + 66);
        doc.fillColor('#2E7D32').fontSize(9).font('Helvetica-Bold');
        doc.text('PAID (AUTO-PAY)', metaBoxX + 90, y + 66);

        // -------------------------------------------------------------
        // Bill To Customer Section
        // -------------------------------------------------------------
        y = 220;
        doc.rect(45, y, doc.page.width - 90, 56).fillAndStroke('#F7FAF3', '#D8E5D3');

        doc.fillColor('#697866').fontSize(8).font('Helvetica-Bold').text('BILLED TO (CUSTOMER DETAILS)', 58, y + 10);
        doc.fillColor('#142420').fontSize(11).font('Helvetica-Bold').text(customerName, 58, y + 22);
        doc.fillColor('#58615F').fontSize(9).font('Helvetica');
        doc.text(`Customer ID: ${targetInvoice.custNo}  |  Mobile: ${customerPhone}  |  Email: ${customerEmail}`, 58, y + 36);

        // -------------------------------------------------------------
        // Line Items Table Header
        // -------------------------------------------------------------
        y = 295;
        const tableWidth = doc.page.width - 90;

        doc.rect(45, y, tableWidth, 24).fill('#142420');
        doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
        doc.text('DESCRIPTION & SERVICE INCLUSIONS', 55, y + 8);
        doc.text('PERIOD', 310, y + 8);
        doc.text('QTY', 390, y + 8);
        doc.text('EX-GST', 430, y + 8);
        doc.text('GST (10%)', 480, y + 8);
        doc.text('TOTAL (AUD)', 510, y + 8, { width: 40, align: 'right' });

        // Table Row
        y += 24;
        doc.rect(45, y, tableWidth, 52).fillAndStroke('#FFFFFF', '#E2EBD8');

        doc.fillColor('#142420').fontSize(9).font('Helvetica-Bold');
        doc.text(targetInvoice.planName, 55, y + 10);

        doc.fillColor('#58615F').fontSize(8).font('Helvetica');
        doc.text('• Unlimited standard AU calls, SMS & MMS (Telstra Wholesale 5G)', 55, y + 23);
        doc.text(`• ${targetInvoice.dataAllowance || 'Monthly 5G Data'} on Telstra Wholesale Network`, 55, y + 35);

        doc.fillColor('#142420').fontSize(8).font('Helvetica');
        doc.text(periodCellText, 310, y + 10);
        doc.text('1', 395, y + 10);
        doc.text(`$${targetInvoice.subtotal.toFixed(2)}`, 430, y + 10);
        doc.text(`$${targetInvoice.gstAmount.toFixed(2)}`, 485, y + 10);

        doc.fillColor('#142420').fontSize(10).font('Helvetica-Bold');
        doc.text(`$${targetInvoice.amount.toFixed(2)}`, 505, y + 10, { width: 45, align: 'right' });

        // -------------------------------------------------------------
        // Summary & Payment Receipt Box
        // -------------------------------------------------------------
        y += 68;

        // Payment Details Note (Left)
        const receiptBoxX = 45;
        doc.rect(receiptBoxX, y, 260, 96).fillAndStroke('#FAFBF8', '#DFE4DD');

        doc.fillColor('#142420').fontSize(9).font('Helvetica-Bold').text('PAYMENT RECEIPT & SETTLEMENT', receiptBoxX + 12, y + 10);
        doc.fillColor('#58615F').fontSize(8.5).font('Helvetica');
        doc.text(`Payment Status: `, receiptBoxX + 12, y + 26, { continued: true });
        doc.fillColor('#2E7D32').font('Helvetica-Bold').text('Paid in Full');

        doc.fillColor('#58615F').font('Helvetica');
        doc.text(`Payment Method: ${targetInvoice.paymentMethod}`, receiptBoxX + 12, y + 40);
        doc.text(`Transaction Reference: ${targetInvoice.transactionRef}`, receiptBoxX + 12, y + 54);
        doc.text(`Settlement Date: ${targetInvoice.issueDate} 08:00 AEST`, receiptBoxX + 12, y + 68);
        doc.text(`Next Scheduled Renewal: ${targetInvoice.dueDate}`, receiptBoxX + 12, y + 82);

        // Totals Calculation (Right)
        const totalBoxX = doc.page.width - 240;
        doc.rect(totalBoxX - 10, y, 205, 96).fillAndStroke('#F7FAF3', '#D8E5D3');

        doc.fillColor('#58615F').fontSize(9).font('Helvetica').text('Subtotal (Excl. GST):', totalBoxX, y + 12);
        doc.fillColor('#142420').fontSize(9).font('Helvetica').text(`$${targetInvoice.subtotal.toFixed(2)} AUD`, totalBoxX + 110, y + 12, { align: 'right', width: 75 });

        doc.fillColor('#58615F').fontSize(9).font('Helvetica').text('Total GST (10.0%):', totalBoxX, y + 32);
        doc.fillColor('#142420').fontSize(9).font('Helvetica').text(`$${targetInvoice.gstAmount.toFixed(2)} AUD`, totalBoxX + 110, y + 32, { align: 'right', width: 75 });

        doc.rect(totalBoxX, y + 52, 185, 1).fill('#D8E5D3');

        doc.fillColor('#142420').fontSize(11).font('Helvetica-Bold').text('TOTAL PAID:', totalBoxX, y + 64);
        doc.fillColor('#142420').fontSize(13).font('Helvetica-Bold').text(`$${targetInvoice.amount.toFixed(2)} AUD`, totalBoxX + 80, y + 63, { align: 'right', width: 105 });

        // -------------------------------------------------------------
        // Statutory Consumer Disclosures & Footer Notes
        // -------------------------------------------------------------
        y = 520;

        doc.rect(45, y, tableWidth, 120).fillAndStroke('#FAFBF8', '#E2EBD8');

        doc.fillColor('#142420').fontSize(8.5).font('Helvetica-Bold').text('AUSTRALIAN STATUTORY TAX INVOICE DISCLOSURES', 58, y + 12);
        doc.fillColor('#58615F').fontSize(8).font('Helvetica');

        const legalNotice =
          '1. This document is a formal Australian Tax Invoice issued in accordance with A New Tax System (Goods and Services Tax) Act 1999.\n' +
          '2. Telecommunications Consumer Protections Code (TCP C628): Inquiries, plan changes, or billing disputes may be raised via the Customer Portal, by emailing info@justmobile.ai, or calling 1300 492 002.\n' +
          '3. If you are experiencing financial hardship, free assistance and flexible payment arrangements are available under our Financial Hardship Policy at justmobile.com.au/hardship.\n' +
          '4. Telecommunications Industry Ombudsman (TIO): If a complaint remains unresolved, you have the right to contact the independent TIO on 1800 062 058 or visit www.tio.com.au.';

        doc.text(legalNotice, 58, y + 28, { width: tableWidth - 26, lineGap: 3 });

        // Footer Brand Line
        doc.fillColor('#7B8E78').fontSize(8).font('Helvetica').text(
          `© 2026 JustMobile Pty Ltd | ABN 48 672 819 204 | Level 14, 182 George St, Sydney NSW 2000 | Generated ${new Date().toISOString()}`,
          45,
          doc.page.height - 35,
          { align: 'center', width: doc.page.width - 90 },
        );

        doc.end();
      } catch (err: any) {
        this.logger.error('Failed to generate Tax Invoice PDF:', err.message);
        reject(err);
      }
    });
  }

  /**
   * Process a one-off "Pay Now" invoice or balance payment
   */
  async payNow(
    custNo: string,
    dto: {
      amount: number;
      invoiceId?: string;
      cardName?: string;
      cardLast4?: string;
      paymentMethod?: string;
    },
  ) {
    const amount = Number(dto.amount);
    if (!amount || isNaN(amount) || amount <= 0) {
      throw new BadRequestException('A valid positive payment amount is required.');
    }

    const transactionRef = `PAY-JM-${Date.now().toString().slice(-6)}`;
    const paidAt = new Date();
    const maskedLast4 = (dto.cardLast4 || '4242').replace(/\D/g, '').slice(-4) || '4242';
    const paymentMethod = dto.paymentMethod || `Visa/Mastercard ending in ${maskedLast4}`;

    const paymentsCol = this.db.getCollection('payments');
    await paymentsCol.insertOne({
      transactionRef,
      custNo,
      invoiceId: dto.invoiceId || null,
      amount: Number(amount.toFixed(2)),
      paymentMethod,
      cardName: dto.cardName || 'Account Holder',
      status: 'PAID',
      paidAt,
      createdAt: paidAt,
    });

    const invoicesCol = this.db.getCollection<InvoiceRecord>('invoices');
    if (dto.invoiceId) {
      await invoicesCol.updateOne(
        { custNo, invoiceId: dto.invoiceId },
        { $set: { status: 'PAID', transactionRef, paymentMethod } },
      );
    }

    this.logger.log(`✓ One-off payment ${transactionRef} ($${amount.toFixed(2)}) recorded for custNo ${custNo}`);

    return {
      success: true,
      transactionRef,
      amount: Number(amount.toFixed(2)),
      paymentMethod,
      paidAt: paidAt.toISOString(),
      message: `Payment of $${amount.toFixed(2)} AUD processed successfully (Ref: ${transactionRef}).`,
    };
  }

  /**
   * Lodge a billing enquiry or dispute for a specific invoice
   */
  async submitBillQuery(
    custNo: string,
    dto: {
      invoiceId: string;
      category?: string;
      message: string;
      email?: string;
      name?: string;
    },
  ) {
    const cleanMessage = (dto.message || '').trim();
    if (!cleanMessage || cleanMessage.length < 5) {
      throw new BadRequestException('Please describe your billing question or dispute (minimum 5 characters).');
    }

    const queryId = `BQ-JM-${Math.floor(100000 + Math.random() * 900000)}`;
    const createdAt = new Date();

    const doc = {
      queryId,
      custNo,
      invoiceId: dto.invoiceId || 'GENERAL',
      category: dto.category || 'Unfamiliar Charge / Bill Question',
      message: cleanMessage,
      email: dto.email || '',
      name: dto.name || '',
      status: 'OPEN',
      createdAt,
      updatedAt: createdAt,
    };

    const queriesCol = this.db.getCollection('bill_queries');
    await queriesCol.insertOne(doc);

    await this.mailService
      .sendSupportAlertEmail({
        referenceNumber: queryId,
        caseType: 'billing_dispute',
        custNo,
        contactName: doc.name || null,
        contactEmail: doc.email || null,
        summary: doc.message,
        invoiceId: doc.invoiceId,
        category: doc.category,
        urgent: false,
      })
      .catch(() => false);

    this.logger.log(`✓ Bill query ${queryId} logged for custNo ${custNo} (Invoice: ${doc.invoiceId})`);

    return {
      success: true,
      queryId,
      status: 'OPEN',
      query: doc,
      message: `Billing query ${queryId} submitted. Our team (info@justmobile.ai / 1300 492 002) will respond within 2 business days.`,
    };
  }

  /**
   * Retrieve customer bill queries
   */
  async getBillQueries(custNo: string) {
    const queriesCol = this.db.getCollection('bill_queries');
    const queries = await queriesCol
      .find({ custNo })
      .sort({ createdAt: -1 })
      .toArray();
    return {
      success: true,
      queries,
    };
  }
}

