import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CarrierService } from './modules/carrier/carrier.service';
import { CarrierController } from './modules/carrier/carrier.controller';
import { CarrierPortingWorker } from './modules/carrier/carrier-porting.worker';
import { ChatService } from './modules/chat/chat.service';
import { AuthService } from './modules/auth/auth.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });
});

describe('CarrierService Payment Methods (QuickStream -> Octane)', () => {
  const originalTelcoLive = process.env.TELCO_LIVE_CREATE;
  const originalGroupNo = process.env.groupNo;

  afterEach(() => {
    process.env.TELCO_LIVE_CREATE = originalTelcoLive;
    process.env.groupNo = originalGroupNo;
    jest.restoreAllMocks();
  });

  function makeService(updateOneMock = jest.fn().mockResolvedValue({ matchedCount: 1 })) {
    const findOneMock = jest.fn().mockResolvedValue(null);
    const mockDb: any = {
      getCollection: jest.fn(() => ({
        updateOne: updateOneMock,
        findOne: findOneMock,
      })),
    };
    const mockMail: any = { sendMail: jest.fn() };
    const service = new CarrierService(mockDb, mockMail);
    return { service, updateOneMock, findOneMock };
  }

  it('registers QuickStream token with Octane POST /api/v1/group/922/customer/:custNo/payment-method and updates DB on success', async () => {
    process.env.TELCO_LIVE_CREATE = 'true';
    process.env.groupNo = '922';

    const { service, updateOneMock } = makeService();
    const restSpy = jest
      .spyOn(service, 'restCall')
      .mockResolvedValue({ status: 'OK', paymentMethodId: 'PM-99' });

    const res = await service.addPaymentMethod('123456', 'qs-single-use-token-abc');

    expect(restSpy).toHaveBeenCalledWith(
      '/api/v1/group/922/customer/123456/payment-method',
      { paymentProvider: 'QS', paymentTokenId: 'qs-single-use-token-abc' },
      'POST',
    );
    expect(updateOneMock).toHaveBeenCalledWith(
      { $or: [{ custNo: '123456' }, { custNo: 123456 }] },
      expect.objectContaining({
        $set: expect.objectContaining({
          hasPaymentMethod: true,
          paymentProvider: 'QS',
        }),
      }),
    );
    expect(res).toEqual(
      expect.objectContaining({
        success: true,
        custNo: '123456',
        paymentProvider: 'QS',
      }),
    );
  });

  it('fails closed without touching MongoDB if Octane rejects the payment token', async () => {
    process.env.TELCO_LIVE_CREATE = 'true';
    process.env.groupNo = '922';

    const { service, updateOneMock } = makeService();
    jest
      .spyOn(service, 'restCall')
      .mockRejectedValue(new BadRequestException('Invalid QuickStream token'));

    await expect(service.addPaymentMethod('123456', 'bad-token')).rejects.toThrow(
      BadRequestException,
    );
    expect(updateOneMock).not.toHaveBeenCalled();
  });

  it('rejects empty custNo or paymentTokenId', async () => {
    const { service } = makeService();
    await expect(service.addPaymentMethod('', 'tok')).rejects.toThrow(BadRequestException);
    await expect(service.addPaymentMethod('123456', '  ')).rejects.toThrow(BadRequestException);
  });

  it('retrieves payment methods via Octane GET /api/v1/group/922/customer/:custNo/payment-method for live customers', async () => {
    process.env.TELCO_LIVE_CREATE = 'true';
    process.env.groupNo = '922';

    const { service } = makeService();
    const octaneMethods = [{ paymentProvider: 'QS', cardType: 'VISA', maskedNumber: '****1111' }];
    const restSpy = jest.spyOn(service, 'restCall').mockResolvedValue(octaneMethods);

    const res = await service.getPaymentMethods('123456');

    expect(restSpy).toHaveBeenCalledWith(
      '/api/v1/group/922/customer/123456/payment-method',
      undefined,
      'GET',
    );
    expect(res).toEqual({
      success: true,
      custNo: '123456',
      data: octaneMethods,
    });
  });
});

describe('CarrierController Payment Endpoints Auth & Validation', () => {
  function makeController(
    verifyCustomerAccess = jest.fn().mockResolvedValue({ custNo: '123456', role: 'customer' }),
    addPaymentMethod = jest.fn().mockResolvedValue({ success: true }),
  ) {
    const carrierService: any = { addPaymentMethod };
    const invoiceService: any = { payNow: jest.fn() };
    const portingWorker: any = {};
    const authService: any = { verifyCustomerAccess };
    const controller = new CarrierController(
      carrierService,
      invoiceService,
      portingWorker,
      authService,
    );
    return { controller, verifyCustomerAccess, addPaymentMethod, invoiceService };
  }

  it('enforces authService.verifyCustomerAccess before calling carrierService.addPaymentMethod on addCustomerPaymentMethod', async () => {
    const verifyCustomerAccess = jest.fn().mockRejectedValue(new ForbiddenException('Not authorised'));
    const addPaymentMethod = jest.fn();
    const { controller } = makeController(verifyCustomerAccess, addPaymentMethod);

    await expect(
      controller.addCustomerPaymentMethod('123456', 'Bearer other-token', {
        paymentTokenId: 'tok_123',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(verifyCustomerAccess).toHaveBeenCalledWith('Bearer other-token', '123456');
    expect(addPaymentMethod).not.toHaveBeenCalled();

    const validAuth = jest.fn().mockResolvedValue({ custNo: '123456', role: 'customer' });
    const validAdd = jest.fn().mockResolvedValue({ success: true, custNo: '123456' });
    const { controller: okCtrl } = makeController(validAuth, validAdd);

    await okCtrl.addCustomerPaymentMethod('123456', 'Bearer valid-token', {
      paymentTokenId: 'tok_456',
    });

    expect(validAuth).toHaveBeenCalledWith('Bearer valid-token', '123456');
    expect(validAdd).toHaveBeenCalledWith('123456', 'tok_456');
  });

  it('rejects payNow without paymentTokenId instead of falling back to legacy dummy payment', async () => {
    const { controller, verifyCustomerAccess, invoiceService } = makeController();

    await expect(
      controller.payNow('123456', 'Bearer valid-token', {}),
    ).rejects.toThrow(BadRequestException);

    expect(verifyCustomerAccess).toHaveBeenCalledWith('Bearer valid-token', '123456');
    expect(invoiceService.payNow).not.toHaveBeenCalled();
  });
});

describe('CarrierService Port Transfer Safeguards (NNA-088 & NNA-084)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makePortService(findOneResult: any = null) {
    const findOneMock = jest.fn().mockResolvedValue(findOneResult);
    const updateOneMock = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const mockDb: any = {
      getCollection: jest.fn(() => ({
        findOne: findOneMock,
        updateOne: updateOneMock,
      })),
    };
    const mockMail: any = { sendOrderWelcomeEmail: jest.fn(), sendCustomerNotificationEmail: jest.fn() };
    const service = new CarrierService(mockDb, mockMail);
    return { service, findOneMock, updateOneMock };
  }

  it('rejects duplicate PORT_IN_PROGRESS submission for the same MSN without calling Octane (NNA-088)', async () => {
    const { service } = makePortService({
      orderId: '987654',
      msn: '0412345678',
      status: 'PORT_IN_PROGRESS',
    });
    const soapSpy = jest.spyOn(service, 'soapCall');

    await expect(
      service.activatePortOrder({
        custNo: '123456',
        msn: '0412 345 678',
        numType: 'postpaid',
        arn: 'ACC-1',
      }),
    ).rejects.toThrow(/already in progress/i);

    expect(soapSpy).not.toHaveBeenCalled();
  });

  it('cancels a pending port order via Octane orderCancel and marks DB CANCELLED (NNA-084)', async () => {
    const { service, updateOneMock } = makePortService({
      orderId: '987654',
      custNo: '123456',
      msn: '0412345678',
      status: 'PORT_IN_PROGRESS',
    });
    const cancelSpy = jest
      .spyOn(service, 'cancelOrder')
      .mockResolvedValue({ cancelledWithOctane: true });

    const res = await service.cancelPortOrder('123456', '987654', 'Customer changed mind');

    expect(cancelSpy).toHaveBeenCalledWith('123456', '987654', 'Customer changed mind');
    expect(updateOneMock).toHaveBeenCalledWith(
      { orderId: '987654', custNo: '123456' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'CANCELLED',
        }),
      }),
    );
    expect(res).toEqual(
      expect.objectContaining({
        success: true,
        orderId: '987654',
        status: 'CANCELLED',
        cancelledWithOctane: true,
      }),
    );
  });

  it('fails closed without mutating DB if Octane orderCancel rejects (NNA-084)', async () => {
    const { service, updateOneMock } = makePortService({
      orderId: '987654',
      custNo: '123456',
      msn: '0412345678',
      status: 'PORT_IN_PROGRESS',
    });
    jest
      .spyOn(service, 'cancelOrder')
      .mockRejectedValue(new BadRequestException('Order already dispatched'));

    await expect(service.cancelPortOrder('123456', '987654')).rejects.toThrow(
      BadRequestException,
    );
    expect(updateOneMock).not.toHaveBeenCalled();
  });
});

describe('CarrierService & Controller Order Hardening (+614 MSN, Integer planNo, Auth)', () => {
  const originalTelcoLive = process.env.TELCO_LIVE_CREATE;

  afterEach(() => {
    process.env.TELCO_LIVE_CREATE = originalTelcoLive;
    jest.restoreAllMocks();
  });

  it('normalizes +614 MSN, resolves planNo as number, and hydrates user address/email in activateNewOrder', async () => {
    process.env.TELCO_LIVE_CREATE = 'true';
    const findOneMock = jest.fn().mockImplementation(() =>
      Promise.resolve({
        custNo: '551196',
        name: 'Alex Morgan',
        firstName: 'Alex',
        surname: 'Morgan',
        email: 'alex@justmobile.ai',
        address: '10 Collins St',
        suburb: 'Melbourne',
        state: 'VIC',
        postcode: '3000',
      }),
    );
    const updateOneMock = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const mockDb: any = {
      getCollection: jest.fn(() => ({ findOne: findOneMock, updateOne: updateOneMock })),
    };
    const mockMail: any = { sendOrderWelcomeEmail: jest.fn(), sendEsimWelcomeEmail: jest.fn().mockResolvedValue(true) };
    const service = new CarrierService(mockDb, mockMail);
    const soapSpy = jest
      .spyOn(service, 'soapCall')
      .mockResolvedValue({ return: { errorCode: 0, orderId: '778899' } });
    jest.spyOn(service, 'restCall').mockResolvedValue(null);

    const res = await service.activateNewOrder({
      custNo: '551196',
      msn: '+61 412 345 678',
      planName: 'JM 65GB Auto',
    });

    expect(soapSpy).toHaveBeenCalledWith(
      '/UtbOrder',
      'orderCreate',
      expect.objectContaining({
        createRequest: expect.objectContaining({
          custNo: '551196',
          orderAction: 'ADD_WME_NEW',
          orderItems: {
            wmeNewReqItem: expect.objectContaining({
              msn: '0412345678',
              planNo: 11144157,
              notificationEmail: 'alex@justmobile.ai',
              orderItemAddress: expect.objectContaining({
                locality: 'Melbourne',
                postcode: '3000',
                streetName: '10 Collins St',
              }),
            }),
          },
        }),
      }),
    );
    expect(res.orderId).toBe('778899');
    expect(res.msn).toBe('0412345678');
  });

  it('normalizes prepaid DOB (DD/MM/YYYY -> YYYY-MM-DD) and MSN in activatePortOrder', async () => {
    process.env.TELCO_LIVE_CREATE = 'true';
    const findOneMock = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        custNo: '551196',
        email: 'alex@justmobile.ai',
        address: '10 Collins St',
        suburb: 'Melbourne',
        state: 'VIC',
        postcode: '3000',
      });
    const updateOneMock = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const mockDb: any = {
      getCollection: jest.fn(() => ({ findOne: findOneMock, updateOne: updateOneMock })),
    };
    const mockMail: any = { sendOrderWelcomeEmail: jest.fn(), sendEsimWelcomeEmail: jest.fn().mockResolvedValue(true) };
    const service = new CarrierService(mockDb, mockMail);
    const soapSpy = jest
      .spyOn(service, 'soapCall')
      .mockResolvedValue({ return: { errorCode: 0, orderId: '889900' } });
    jest.spyOn(service, 'restCall').mockResolvedValue(null);

    await service.activatePortOrder({
      custNo: '551196',
      msn: '+61 499 111 222',
      planName: 'JM 65GB Auto',
      numType: 'prepaid',
      dob: '14/06/1992',
    });

    expect(soapSpy).toHaveBeenCalledWith(
      '/UtbOrder',
      'orderCreate',
      expect.objectContaining({
        createRequest: expect.objectContaining({
          orderAction: 'ADD_WME_PORT',
          orderItems: {
            wmePortInReqItem: expect.objectContaining({
              msn: '0499111222',
              planNo: 11144157,
              dob: '1992-06-14',
            }),
          },
        }),
      }),
    );
  });

  it('enforces authService.verifyCustomerAccess on CarrierController.activateNewOrder & activatePortOrder', async () => {
    const verifyCustomerAccess = jest.fn().mockRejectedValue(new ForbiddenException('Not allowed'));
    const activateNewOrder = jest.fn();
    const activatePortOrder = jest.fn();
    const controller = new CarrierController(
      { activateNewOrder, activatePortOrder } as any,
      {} as any,
      {} as any,
      { verifyCustomerAccess } as any,
    );

    await expect(
      controller.activateNewOrder('Bearer bad', { custNo: '551196', msn: '0412345678' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.activatePortOrder('Bearer bad', { custNo: '551196', msn: '0412345678' }),
    ).rejects.toThrow(ForbiddenException);

    expect(activateNewOrder).not.toHaveBeenCalled();
    expect(activatePortOrder).not.toHaveBeenCalled();
  });
});

describe('ChatService Registration & Inline QuickStream Flow', () => {
  it('registers new customer with normalized DOB and auto-verifies chat session', async () => {
    const updateOneMock = jest.fn().mockResolvedValue({ upsertedCount: 1 });
    const mockDb: any = {
      getCollection: jest.fn(() => ({ updateOne: updateOneMock, findOne: jest.fn() })),
    };
    const signupMock = jest.fn().mockResolvedValue({
      success: true,
      user: { custNo: '551999', email: 'new@justmobile.ai', name: 'Sam Lee' },
      message: 'Account created',
    });
    const chatService = new ChatService(
      mockDb,
      {} as any,
      {} as any,
      {} as any,
      { signup: signupMock } as any,
    );

    const out = JSON.parse(
      await chatService.executeToolCall(
        'register_new_customer',
        JSON.stringify({
          firstName: 'Sam',
          surname: 'Lee',
          email: 'new@justmobile.ai',
          dob: '14/06/1992',
          address: '10 Collins St',
          suburb: 'Melbourne',
          state: 'VIC',
          postcode: '3000',
          password: 'password123',
          code: '123456',
        }),
        [],
        'sess-reg-1',
      ),
    );

    expect(signupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        custType: 'R',
        dob: '1992-06-14',
        code: '123456',
      }),
    );
    expect(updateOneMock).toHaveBeenCalledWith(
      { sessionId: 'sess-reg-1' },
      expect.objectContaining({
        $set: expect.objectContaining({ custNo: '551999', active: true }),
      }),
      { upsert: true },
    );
    expect(out.registered).toBe(true);
    expect(out.custNo).toBe('551999');
  });

  it('rejects open_quickstream_card_form for port_order when ACMA SMS OTP is not verified, and emits uiAction when verified', async () => {
    let portVerified = false;
    const findOneMock = jest.fn().mockImplementation((query: any) => {
      if (query?.orderType === 'PORT_IN') return Promise.resolve(null);
      if (query?.sessionId) {
        return Promise.resolve({
          sessionId: 'sess-buy-1',
          custNo: '551999',
          active: true,
          expiresAt: new Date(Date.now() + 600000),
          portOtpVerified: portVerified,
          portOtpVerifiedNumber: portVerified ? '0412345678' : '',
        });
      }
      return Promise.resolve({
        custNo: '551999',
        email: 'new@justmobile.ai',
        firstName: 'Sam',
        surname: 'Lee',
        address: '10 Collins St',
        suburb: 'Melbourne',
        state: 'VIC',
        postcode: '3000',
      });
    });
    const mockDb: any = {
      getCollection: jest.fn(() => ({ findOne: findOneMock })),
    };
    const issueTokenMock = jest.fn().mockResolvedValue('jwt-chat-tok-1');
    const chatService = new ChatService(
      mockDb,
      {} as any,
      {} as any,
      {} as any,
      { issueTokenForCustomer: issueTokenMock } as any,
    );

    const emitted: any[] = [];
    const blocked = JSON.parse(
      await chatService.executeToolCall(
        'open_quickstream_card_form',
        JSON.stringify({
          custNo: '551999',
          purpose: 'port_order',
          planName: 'JM 65GB Auto',
          msn: '0412345678',
          numType: 'postpaid',
          arn: 'ACC-999',
        }),
        [],
        'sess-buy-1',
        (act) => emitted.push(act),
      ),
    );
    expect(blocked.opened).toBe(false);
    expect(blocked.requiresPortOtp).toBe(true);
    expect(emitted).toHaveLength(0);

    portVerified = true;
    const allowed = JSON.parse(
      await chatService.executeToolCall(
        'open_quickstream_card_form',
        JSON.stringify({
          custNo: '551999',
          purpose: 'port_order',
          planName: 'JM 65GB Auto',
          msn: '0412345678',
          numType: 'postpaid',
          arn: 'ACC-999',
        }),
        [],
        'sess-buy-1',
        (act) => emitted.push(act),
      ),
    );
    expect(allowed.opened).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(
      expect.objectContaining({
        type: 'QUICKSTREAM_PAYMENT',
        custNo: '551999',
        authToken: 'jwt-chat-tok-1',
        purpose: 'port_order',
        planNo: '11144157',
        planPrice: 40,
      }),
    );
  });
});

describe('CarrierController Auth, Ownership & Simulate-Rejection Removal', () => {
  it('enforces verifyCustomerAccess across all customer PII, billing, invoice PDF, and eSIM email endpoints', async () => {
    const verifyCustomerAccess = jest.fn().mockRejectedValue(new ForbiddenException('Not authorised'));
    const carrierService: any = {
      getCustomer: jest.fn(),
      getServices: jest.fn(),
      getBalance: jest.fn(),
      getUnbilledUsage: jest.fn(),
      getCustomerOrders: jest.fn(),
      sendOrderEsimEmail: jest.fn(),
    };
    const invoiceService: any = {
      getCustomerInvoices: jest.fn(),
      generateTaxInvoicePdf: jest.fn(),
      submitBillQuery: jest.fn(),
      getBillQueries: jest.fn(),
    };
    const controller = new CarrierController(
      carrierService,
      invoiceService,
      {} as any,
      { verifyCustomerAccess } as any,
    );
    const mockRes: any = { setHeader: jest.fn(), end: jest.fn() };

    await expect(controller.getCustomer('551059', 'Bearer bad')).rejects.toThrow(ForbiddenException);
    await expect(controller.getServices('551059', 'Bearer bad')).rejects.toThrow(ForbiddenException);
    await expect(controller.getBalance('551059', 'Bearer bad')).rejects.toThrow(ForbiddenException);
    await expect(controller.getUsage('551059', 'Bearer bad')).rejects.toThrow(ForbiddenException);
    await expect(controller.getCustomerOrders('551059', 'Bearer bad')).rejects.toThrow(ForbiddenException);
    await expect(controller.getCustomerInvoices('551059', 'Bearer bad')).rejects.toThrow(ForbiddenException);
    await expect(
      controller.downloadInvoicePdf('551059', 'INV-1', mockRes, 'Bearer bad'),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.submitBillQuery('551059', 'Bearer bad', { invoiceId: 'INV-1', message: 'Check charge' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(controller.getBillQueries('551059', 'Bearer bad')).rejects.toThrow(ForbiddenException);
    await expect(
      controller.sendOrderEsimEmail('551059', 'ORD-1', 'Bearer bad', { email: 'a@b.com' }),
    ).rejects.toThrow(ForbiddenException);

    expect(carrierService.getCustomer).not.toHaveBeenCalled();
    expect(carrierService.getServices).not.toHaveBeenCalled();
    expect(carrierService.getBalance).not.toHaveBeenCalled();
    expect(carrierService.getUnbilledUsage).not.toHaveBeenCalled();
    expect(carrierService.getCustomerOrders).not.toHaveBeenCalled();
    expect(carrierService.sendOrderEsimEmail).not.toHaveBeenCalled();
    expect(invoiceService.getCustomerInvoices).not.toHaveBeenCalled();
    expect(invoiceService.generateTaxInvoicePdf).not.toHaveBeenCalled();
    expect(mockRes.end).not.toHaveBeenCalled();
    expect(invoiceService.submitBillQuery).not.toHaveBeenCalled();
    expect(invoiceService.getBillQueries).not.toHaveBeenCalled();
  });

  it('enforces verifyAdminAccess on POST /api/carrier/customers', async () => {
    const verifyAdminAccess = jest.fn().mockRejectedValue(new ForbiddenException('Admin access required.'));
    const addCustomer = jest.fn();
    const controller = new CarrierController(
      { addCustomer } as any,
      {} as any,
      {} as any,
      { verifyAdminAccess } as any,
    );

    await expect(
      controller.addCustomer('Bearer customer-tok', { firstName: 'Sam', email: 'sam@example.com' }),
    ).rejects.toThrow(ForbiddenException);
    expect(verifyAdminAccess).toHaveBeenCalledWith('Bearer customer-tok');
    expect(addCustomer).not.toHaveBeenCalled();

    verifyAdminAccess.mockResolvedValueOnce({ role: 'admin' });
    addCustomer.mockResolvedValueOnce({ custNo: '551999', isMock: true });
    const created = await controller.addCustomer('Bearer admin-tok', { firstName: 'Sam' });
    expect(created).toEqual({ custNo: '551999', isMock: true });
  });

  it('enforces order and QR ownership across queryOrder, syncPortOrder, resubmitPortOrder, and getEsimQRCode', async () => {
    const verifyCustomerAccess = jest.fn().mockResolvedValue({ custNo: '551059', role: 'customer' });
    const carrierService: any = {
      resolveOrderOwnerCustNo: jest.fn().mockResolvedValue('999888'),
      resolveQrOwnerCustNo: jest.fn().mockResolvedValue('999888'),
      queryOrder: jest.fn().mockResolvedValue({ orderId: 'ORD-OTHER', status: 'ACTIVE' }),
      resubmitPortOrder: jest.fn().mockResolvedValue({ success: true }),
      getEsimQRCode: jest.fn().mockResolvedValue({ orderId: 'ORD-OTHER', lpa: 'LPA:1$smdp$code' }),
    };
    const portingWorker: any = {
      forceSyncOrder: jest.fn().mockResolvedValue({ orderId: 'ORD-OTHER', status: 'ACTIVE', message: 'ok' }),
    };
    const controller = new CarrierController(
      carrierService,
      {} as any,
      portingWorker,
      { verifyCustomerAccess } as any,
    );

    // Other customer's order & QR -> Forbidden
    await expect(controller.queryOrder('ORD-OTHER', 'Bearer cust-551059')).rejects.toThrow(ForbiddenException);
    await expect(controller.syncPortOrder('ORD-OTHER', 'Bearer cust-551059')).rejects.toThrow(ForbiddenException);
    await expect(
      controller.resubmitPortOrder('ORD-OTHER', 'Bearer cust-551059', { numType: 'prepaid', dob: '1990-01-01' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(controller.getEsimQRCode('ORD-OTHER', 'Bearer cust-551059')).rejects.toThrow(ForbiddenException);
    expect(carrierService.queryOrder).not.toHaveBeenCalled();
    expect(portingWorker.forceSyncOrder).not.toHaveBeenCalled();
    expect(carrierService.resubmitPortOrder).not.toHaveBeenCalled();
    expect(carrierService.getEsimQRCode).not.toHaveBeenCalled();

    // Owner -> Allowed
    carrierService.resolveOrderOwnerCustNo.mockResolvedValue('551059');
    carrierService.resolveQrOwnerCustNo.mockResolvedValue('551059');
    await expect(controller.queryOrder('ORD-OWN', 'Bearer cust-551059')).resolves.toEqual({
      orderId: 'ORD-OTHER',
      status: 'ACTIVE',
    });
    await expect(controller.getEsimQRCode('551059', 'Bearer cust-551059')).resolves.toEqual({
      orderId: 'ORD-OTHER',
      lpa: 'LPA:1$smdp$code',
    });

    // Admin -> Allowed even when custNo differs
    verifyCustomerAccess.mockResolvedValue({ custNo: 'ADMIN', role: 'admin' });
    carrierService.resolveOrderOwnerCustNo.mockResolvedValue('999888');
    await expect(controller.syncPortOrder('ORD-OTHER', 'Bearer admin')).resolves.toEqual(
      expect.objectContaining({ status: 'ACTIVE' }),
    );
  });

  it('does not expose simulateRejection test helper on CarrierController or simulatePortRejection on CarrierService', () => {
    expect((CarrierController.prototype as any).simulateRejection).toBeUndefined();
    expect((CarrierService.prototype as any).simulatePortRejection).toBeUndefined();
  });
});

describe('Octane UtbOTP Nested Parsing & Chat Verified Profile Auto-Fetch', () => {
  const originalTelcoLive = process.env.TELCO_LIVE_CREATE;

  afterEach(() => {
    process.env.TELCO_LIVE_CREATE = originalTelcoLive;
    jest.restoreAllMocks();
  });

  function makeOtpCarrierService(recentCount = 0) {
    const mockDb: any = {
      getCollection: jest.fn(() => ({
        insertOne: jest.fn(),
        findOne: jest.fn(),
        updateOne: jest.fn(),
        countDocuments: jest.fn().mockResolvedValue(recentCount),
      })),
    };
    const mockMail: any = { sendMail: jest.fn() };
    return new CarrierService(mockDb, mockMail);
  }

  it('sendPrePortOtp sends numeric custNo, normalizes destination, reads nested getOtp.transactionId, and rejects non-04XX/masked input', async () => {
    process.env.TELCO_LIVE_CREATE = 'true';
    const service = makeOtpCarrierService();
    const soapSpy = jest.spyOn(service, 'soapCall').mockResolvedValue({
      return: {
        message: 'Success',
        getOtp: {
          errorCode: '0',
          transactionId: 'OCTANE-TX-9988',
          destination: '0412345678',
        },
      },
    });

    await expect(service.sendPrePortOtp('551059', '0412 *** 678')).rejects.toThrow(
      BadRequestException,
    );
    expect(soapSpy).not.toHaveBeenCalled();

    const res = await service.sendPrePortOtp('551059', '+61 412 345 678');
    expect(soapSpy).toHaveBeenCalledWith(
      '/UtbOTP',
      'manageOtp',
      expect.objectContaining({
        manageOtpRequest: {
          requestType: 'getOtp',
          getOtp: expect.objectContaining({
            custNo: 551059,
            destination: '0412345678',
            method: 'SMS',
            operationType: 'Port',
            reason: 'R8',
          }),
        },
      }),
    );
    expect(res).toEqual(
      expect.objectContaining({
        success: true,
        transactionId: 'OCTANE-TX-9988',
        destination: '0412345678',
      }),
    );
  });

  it('verifyPrePortOtp reads nested verifyOtp.valid === true and throws BadRequestException when valid === false', async () => {
    process.env.TELCO_LIVE_CREATE = 'true';
    const service = makeOtpCarrierService();
    const soapSpy = jest.spyOn(service, 'soapCall').mockResolvedValueOnce({
      return: {
        verifyOtp: {
          errorCode: '0',
          valid: true,
          transactionId: 'OCTANE-TX-9988',
        },
      },
    });

    const ok = await service.verifyPrePortOtp('OCTANE-TX-9988', '123456');
    expect(ok).toEqual(
      expect.objectContaining({
        success: true,
        verified: true,
        transactionId: 'OCTANE-TX-9988',
      }),
    );

    soapSpy.mockResolvedValueOnce({
      return: {
        verifyOtp: {
          errorCode: '0',
          valid: false,
          message: 'Code mismatch',
        },
      },
    });
    await expect(service.verifyPrePortOtp('OCTANE-TX-9988', '000000')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('ChatService send_port_sms_otp resolves saved registered phone when destination is masked/omitted, and open_quickstream_card_form auto-hydrates dob & msn', async () => {
    const reservedBySession = new Map<string, string[]>();
    const updateOneMock = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const mockDb: any = {
      getCollection: jest.fn((name: string) => {
        if (name === 'chat_reserved_numbers') {
          return {
            updateOne: jest.fn(async (filter: any, update: any) => {
              const sid = filter?.sessionId || 'default-session';
              const incoming: string[] = update?.$addToSet?.numbers?.$each || [];
              const prev = reservedBySession.get(sid) || [];
              reservedBySession.set(sid, Array.from(new Set([...prev, ...incoming])));
              return { modifiedCount: 1 };
            }),
            findOne: jest.fn(async (filter: any) => {
              const sid = filter?.sessionId || 'default-session';
              const nums = reservedBySession.get(sid) || [];
              return nums.length > 0 ? { sessionId: sid, numbers: nums } : null;
            }),
          };
        }
        return {
          updateOne: updateOneMock,
          findOne: jest.fn().mockImplementation((query: any) => {
            if (query?.orderType === 'PORT_IN') return Promise.resolve(null);
            if (query?.sessionId) {
              return Promise.resolve({
                sessionId: 'sess-existing-1',
                custNo: '551059',
                active: true,
                expiresAt: new Date(Date.now() + 600000),
                portOtpVerified: true,
                portOtpVerifiedNumber: '0412345678',
              });
            }
            return Promise.resolve({
              custNo: '551059',
              email: 'yaseen@neximet.com',
              firstName: 'Yaseen',
              surname: 'Jamal',
              phone: '0412 345 678',
              dob: '23/11/2002',
              address: '100 George St',
              suburb: 'Sydney',
              state: 'NSW',
              postcode: '2000',
            });
          }),
        };
      }),
    };
    const sendPrePortOtpMock = jest.fn().mockResolvedValue({
      success: true,
      transactionId: 'OCTANE-TX-123',
      destination: '0412345678',
      message: 'ACMA security code dispatched via SMS to 0412345678.',
    });
    const reserveNumbersMock = jest.fn().mockResolvedValue({
      numbers: [{ id: 'RES-1', number: '0488912101', formatted: '0488 912 101' }],
    });
    const issueTokenMock = jest.fn().mockResolvedValue('jwt-551059');
    const chatService = new ChatService(
      mockDb,
      {} as any,
      { sendPrePortOtp: sendPrePortOtpMock, reserveNumbers: reserveNumbersMock } as any,
      {} as any,
      { issueTokenForCustomer: issueTokenMock } as any,
    );

    const otpRes = JSON.parse(
      await chatService.executeToolCall(
        'send_port_sms_otp',
        JSON.stringify({ custNo: '551059', destination: '0412 *** 678' }),
        [],
        'sess-existing-1',
      ),
    );
    expect(sendPrePortOtpMock).toHaveBeenCalledWith('551059', '0412345678');
    expect(otpRes).toEqual(
      expect.objectContaining({
        sent: true,
        transactionId: 'OCTANE-TX-123',
        destination: '0412345678',
      }),
    );

    const emitted: any[] = [];
    const qsRes = JSON.parse(
      await chatService.executeToolCall(
        'open_quickstream_card_form',
        JSON.stringify({
          custNo: '551059',
          purpose: 'port_order',
          planName: 'JM 45GB Auto',
          numType: 'prepaid',
          donorCarrier: 'Vodafone',
        }),
        [],
        'sess-existing-1',
        (act) => emitted.push(act),
      ),
    );
    expect(qsRes.opened).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(
      expect.objectContaining({
        planName: 'JM 45GB Auto',
        planNo: '11144156',
        planPrice: 36,
      }),
    );
    expect(emitted[0].orderDraft).toEqual(
      expect.objectContaining({
        custNo: '551059',
        msn: '0412345678',
        dob: '2002-11-23',
        donorCarrier: 'Vodafone',
        numType: 'prepaid',
        planNo: '11144156',
        pricePerMonth: 36,
      }),
    );

    // Removed plans (10GB, 29GB) should be rejected cleanly
    const removed10 = JSON.parse(
      await chatService.executeToolCall(
        'open_quickstream_card_form',
        JSON.stringify({
          custNo: '551059',
          purpose: 'new_order',
          planName: 'JM 10GB Auto',
          msn: '0412345678',
        }),
        [],
        'sess-existing-1',
      ),
    );
    expect(removed10.opened).toBe(false);
    expect(removed10.error).toMatch(/15GB, 45GB/);

    // update_card must reject calls that pass a planName
    const badUpdateCard = JSON.parse(
      await chatService.executeToolCall(
        'open_quickstream_card_form',
        JSON.stringify({
          custNo: '551059',
          purpose: 'update_card',
          planName: 'JM 15GB Auto',
        }),
        [],
        'sess-existing-1',
      ),
    );
    expect(badUpdateCard.opened).toBe(false);

    // new_order must reject an unreserved MSN (such as the customer's existing contact phone)
    const unreservedNew = JSON.parse(
      await chatService.executeToolCall(
        'open_quickstream_card_form',
        JSON.stringify({
          custNo: '551059',
          purpose: 'new_order',
          planName: '150GB',
          msn: '0412345678',
        }),
        [],
        'sess-existing-1',
      ),
    );
    expect(unreservedNew.opened).toBe(false);
    expect(unreservedNew.requiresNumberSelection).toBe(true);

    // Reserve a fresh number first, then 150GB must resolve to 11144170 ($62) without 15GB collision
    await chatService.executeToolCall(
      'get_available_numbers',
      JSON.stringify({ qty: 5 }),
      [],
      'sess-existing-1',
    );
    const emitted150: any[] = [];
    const res150 = JSON.parse(
      await chatService.executeToolCall(
        'open_quickstream_card_form',
        JSON.stringify({
          custNo: '551059',
          purpose: 'new_order',
          planName: '150GB',
          msn: '0488912101',
        }),
        [],
        'sess-existing-1',
        (act) => emitted150.push(act),
      ),
    );
    expect(res150.opened).toBe(true);
    expect(emitted150[0]).toEqual(
      expect.objectContaining({
        planNo: '11144170',
        planPrice: 62,
      }),
    );
  });

  it('CarrierController.sendOtp & verifyOtp enforce verifyCustomerAccess and sendPrePortOtp enforces 5/15m rate limit', async () => {
    const verifyCustomerAccess = jest.fn().mockRejectedValue(new ForbiddenException('Auth required'));
    const controller = new CarrierController(
      { sendPrePortOtp: jest.fn(), verifyPrePortOtp: jest.fn() } as any,
      {} as any,
      {} as any,
      { verifyCustomerAccess } as any,
    );

    await expect(
      controller.sendOtp(undefined, { custNo: '551059', destination: '0412345678' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.verifyOtp(undefined, { transactionId: 'TX-1', code: '123456' }),
    ).rejects.toThrow(ForbiddenException);

    const rateLimitedService = makeOtpCarrierService(5);
    await expect(rateLimitedService.sendPrePortOtp('551059', '0412345678')).rejects.toThrow(
      HttpException,
    );
  });

  it('CarrierPortingWorker enforces 30-minute live Octane polling budget per order', async () => {
    process.env.TELCO_LIVE_CREATE = 'true';
    const recentOrder = {
      orderId: '991122',
      custNo: '551059',
      msn: '0412345678',
      orderType: 'PORT_IN',
      status: 'PORT_IN_PROGRESS',
      lastQueriedAt: new Date(Date.now() - 5 * 60 * 1000),
    };
    const staleOrder = {
      orderId: '991123',
      custNo: '551059',
      msn: '0412345679',
      orderType: 'PORT_IN',
      status: 'PORT_IN_PROGRESS',
      lastQueriedAt: new Date(Date.now() - 35 * 60 * 1000),
    };
    const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const mockDb: any = {
      getCollection: jest.fn(() => ({
        find: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([recentOrder, staleOrder]) })),
        updateOne,
      })),
    };
    const queryOrder = jest.fn().mockResolvedValue({ status: 'PORT_IN_PROGRESS' });
    const worker = new CarrierPortingWorker(mockDb, { queryOrder } as any);

    const summary = await worker.checkPendingPortingOrders({ respectPollBudget: true });
    expect(queryOrder).toHaveBeenCalledTimes(1);
    expect(queryOrder).toHaveBeenCalledWith('991123');
    expect(summary).toEqual(
      expect.objectContaining({
        checked: 1,
        skippedDueToBudget: 1,
      }),
    );
  });

  it('CarrierService.resolvePlanDetails maps all 7 active plans to their Octane planNo without 15GB/150GB collision', () => {
    const service = new CarrierService({ getCollection: jest.fn() } as any, {} as any);
    const expected = [
      ['15GB', '11144154', 31],
      ['45GB', '11144156', 36],
      ['65GB', '11144157', 40],
      ['100GB', '11144168', 48],
      ['120GB', '11144169', 57],
      ['150GB', '11144170', 62],
      ['180GB', '11156014', 67],
    ] as const;

    for (const [label, expectedPlanNo, expectedPrice] of expected) {
      const resolved = service.resolvePlanDetails(label);
      expect(resolved).toEqual(
        expect.objectContaining({
          planNo: expectedPlanNo,
          price: expectedPrice,
        }),
      );
    }
    expect(service.resolvePlanDetails('JM 10GB Auto')).toBeNull();
    expect(service.resolvePlanDetails('JM 29GB Auto')).toBeNull();
  });

  it('ChatService.generateResponse auto-opens QuickStream iframe for logged-in customers asking to save payment method and gates unverified guests', async () => {
    const prevKey = process.env.OPENAI_KEY;
    process.env.OPENAI_KEY = 'test-openai-key';
    const originalFetch = global.fetch;

    try {
      const mockDb: any = {
        getCollection: jest.fn(() => ({
          findOne: jest.fn().mockResolvedValue(null),
          updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        })),
      };
      const verifyCustomerAccess = jest.fn().mockResolvedValue({ custNo: '551059', role: 'customer' });
      const issueTokenForCustomer = jest.fn().mockResolvedValue('jwt-551059');
      const chatService = new ChatService(
        mockDb,
        {} as any,
        {} as any,
        {} as any,
        { verifyCustomerAccess, issueTokenForCustomer } as any,
      );

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Please provide your card number, expiry date, and CVV.',
              },
            },
          ],
        }),
      }) as any;

      const loggedInRes: any = await chatService.generateResponse(
        [{ role: 'user', content: 'well i like to save my payment method' }],
        'sess-jwt-1',
        'Bearer valid-jwt',
      );
      expect(verifyCustomerAccess).toHaveBeenCalledWith('Bearer valid-jwt');
      expect(loggedInRes.uiAction).toEqual(
        expect.objectContaining({
          type: 'QUICKSTREAM_PAYMENT',
          custNo: '551059',
          purpose: 'update_card',
          authToken: 'jwt-551059',
        }),
      );
      expect(loggedInRes.reply).not.toMatch(/provide your card number/i);

      const guestRes: any = await chatService.generateResponse(
        [{ role: 'user', content: 'well i like to save my payment method' }],
        'sess-guest-1',
      );
      expect(guestRes.uiAction).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
      if (prevKey === undefined) {
        delete process.env.OPENAI_KEY;
      } else {
        process.env.OPENAI_KEY = prevKey;
      }
    }
  });

  it('CarrierService.deleteCustomer disconnects live customer in Octane and removes local user; CarrierController.deleteCustomer enforces verifyCustomerAccess', async () => {
    const prevLive = process.env.TELCO_LIVE_CREATE;
    process.env.TELCO_LIVE_CREATE = 'true';

    try {
      const deleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });
      const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 1 });
      const findOne = jest.fn().mockResolvedValue({ custNo: '551233', dob: '1995-05-10' });
      const mockDb: any = {
        getCollection: jest.fn(() => ({ deleteOne, updateMany, findOne })),
      };
      const service = new CarrierService(mockDb, {} as any);
      jest.spyOn(service, 'getCustomer').mockResolvedValue({ custNo: '551233', dob: '1995-05-10' } as any);
      const soapSpy = jest.spyOn(service, 'soapCall').mockResolvedValue({ return: { errorCode: '0' } });

      const result = await service.deleteCustomer('551233');
      expect(soapSpy).toHaveBeenCalledWith(
        '/UtbCustomer',
        'updateCustomer',
        expect.objectContaining({
          customer: expect.objectContaining({
            custNo: '551233',
            category_status_customer: 'Disconnected',
          }),
        }),
      );
      expect(deleteOne).toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          custNo: '551233',
          disconnectedInCarrier: true,
          deletedLocally: true,
        }),
      );

      const verifyCustomerAccess = jest.fn().mockRejectedValue(new ForbiddenException('Auth required'));
      const controller = new CarrierController(
        { deleteCustomer: jest.fn(), getServices: jest.fn() } as any,
        {} as any,
        {} as any,
        { verifyCustomerAccess } as any,
      );
      await expect(controller.deleteCustomer('551233', undefined)).rejects.toThrow(ForbiddenException);

      const adminDeleteCustomer = jest.fn().mockResolvedValue({ success: true, custNo: '551196' });
      const invalidateAdminStatsCache = jest.fn();
      const adminController = new CarrierController(
        { deleteCustomer: adminDeleteCustomer, getServices: jest.fn() } as any,
        {} as any,
        {} as any,
        {
          verifyCustomerAccess: jest.fn().mockResolvedValue({ role: 'admin' }),
          invalidateAdminStatsCache,
        } as any,
      );
      await expect(adminController.deleteCustomer('551196', 'Bearer admin-jwt')).resolves.toEqual({
        success: true,
        custNo: '551196',
      });
      expect(adminDeleteCustomer).toHaveBeenCalledWith('551196');
      expect(invalidateAdminStatsCache).toHaveBeenCalledTimes(1);
    } finally {
      if (prevLive === undefined) {
        delete process.env.TELCO_LIVE_CREATE;
      } else {
        process.env.TELCO_LIVE_CREATE = prevLive;
      }
    }
  });

  it('AuthService.getAdminStats supports forceRefresh and invalidateAdminStatsCache', async () => {
    const countDocuments = jest.fn().mockResolvedValue(1);
    const toArray = jest.fn().mockResolvedValue([]);
    const usersCol = {
      countDocuments,
      find: jest.fn(() => ({
        project: jest.fn(() => ({
          sort: jest.fn(() => ({
            limit: jest.fn(() => ({ toArray })),
          })),
        })),
      })),
    };
    const ordersCol = {
      find: jest.fn(() => ({
        sort: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) })),
      })),
    };
    const mockDb: any = {
      getCollection: jest.fn((name: string) => (name === 'users' ? usersCol : ordersCol)),
    };
    const clearOctaneCustomersCache = jest.fn();
    const getAllCustomersFromOctane = jest.fn().mockResolvedValue(new Map());
    const authService = new AuthService(
      mockDb,
      {} as any,
      { clearOctaneCustomersCache, getAllCustomersFromOctane } as any,
    );
    jest.spyOn(authService, 'getMe').mockResolvedValue({ user: { role: 'admin' } } as any);

    await authService.getAdminStats('Bearer admin-jwt');
    await authService.getAdminStats('Bearer admin-jwt');
    expect(getAllCustomersFromOctane).toHaveBeenCalledTimes(1);

    await authService.getAdminStats('Bearer admin-jwt', true);
    expect(clearOctaneCustomersCache).toHaveBeenCalledTimes(1);
    expect(getAllCustomersFromOctane).toHaveBeenCalledTimes(2);

    authService.invalidateAdminStatsCache();
    await authService.getAdminStats('Bearer admin-jwt');
    expect(getAllCustomersFromOctane).toHaveBeenCalledTimes(3);
  });

  it('ChatService request_contact_update_otp sends phone-update OTP to registered email, fails closed on SMTP error, and confirm_contact_update enforces retries and numeric custNo', async () => {
    const insertedOtps: any[] = [];
    const verificationUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const usersUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const mockDb: any = {
      getCollection: jest.fn((name: string) => {
        if (name === 'chat_sessions') {
          return {
            findOne: jest.fn().mockResolvedValue({
              sessionId: 'sess-contact-1',
              custNo: '551059',
              active: true,
              expiresAt: new Date(Date.now() + 600_000),
            }),
          };
        }
        if (name === 'users') {
          return {
            findOne: jest.fn().mockResolvedValue({
              custNo: 551059,
              name: 'Yaseen Jamal',
              email: 'yaseen@neximet.com',
              phone: '0411111111',
            }),
            updateOne: usersUpdateOne,
          };
        }
        if (name === 'email_verifications') {
          return {
            updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
            insertOne: jest.fn(async (doc: any) => {
              const id = `otp-${insertedOtps.length + 1}`;
              const stored = { _id: id, ...doc };
              insertedOtps.push(stored);
              return { insertedId: id };
            }),
            findOne: jest.fn(async () => insertedOtps.find((o) => !o.used) || null),
            updateOne: jest.fn(async (filter: any, update: any) => {
              verificationUpdateOne(filter, update);
              const target = insertedOtps.find((o) => o._id === filter?._id);
              if (target && update?.$set) Object.assign(target, update.$set);
              return { modifiedCount: 1 };
            }),
          };
        }
        return { findOne: jest.fn().mockResolvedValue(null) };
      }),
    };

    const sendVerificationCode = jest
      .fn()
      .mockRejectedValueOnce(new Error('SMTP timeout'))
      .mockResolvedValue(true);
    const updateCustomerDetails = jest.fn().mockResolvedValue({ syncedWithOctane: true });

    const chatService = new ChatService(
      mockDb,
      { sendVerificationCode } as any,
      { updateCustomerDetails } as any,
      {} as any,
      {} as any,
    );

    // Fail closed when SMTP fails
    const failRes = JSON.parse(
      await chatService.executeToolCall(
        'request_contact_update_otp',
        JSON.stringify({ custNo: '551059', newPhone: '0412 345 678' }),
        [],
        'sess-contact-1',
      ),
    );
    expect(failRes.otpSent).toBe(false);
    expect(insertedOtps[0].used).toBe(true);

    // Succeeds and sends confirmation code to registered email
    const okRes = JSON.parse(
      await chatService.executeToolCall(
        'request_contact_update_otp',
        JSON.stringify({ custNo: '551059', newPhone: '+61 412 345 678' }),
        [],
        'sess-contact-1',
      ),
    );
    expect(okRes).toEqual(
      expect.objectContaining({
        otpSent: true,
        deliveryChannel: 'email',
      }),
    );
    expect(sendVerificationCode).toHaveBeenLastCalledWith(
      'yaseen@neximet.com',
      insertedOtps[1].code,
      'Yaseen Jamal',
    );

    // Wrong OTP decrements attemptsRemaining, then valid OTP updates numeric+string custNo filter
    const wrongRes = JSON.parse(
      await chatService.executeToolCall(
        'confirm_contact_update',
        JSON.stringify({ custNo: '551059', code: '000000' }),
        [],
        'sess-contact-1',
      ),
    );
    expect(wrongRes.success).toBe(false);
    expect(wrongRes.attemptsRemaining).toBe(2);

    const confirmRes = JSON.parse(
      await chatService.executeToolCall(
        'confirm_contact_update',
        JSON.stringify({ custNo: '551059', code: insertedOtps[1].code }),
        [],
        'sess-contact-1',
      ),
    );
    expect(confirmRes.success).toBe(true);
    expect(updateCustomerDetails).toHaveBeenCalledWith('551059', { phone: '0412345678' });
    expect(usersUpdateOne).toHaveBeenCalledWith(
      { $or: [{ custNo: '551059' }, { custNo: 551059 }] },
      expect.objectContaining({
        $set: expect.objectContaining({ phone: '0412345678' }),
      }),
    );
  });

  it('CarrierService.getOctaneBillingCycleDate rolls over to next month on days 28-31 in Australia/Sydney', () => {
    const service = new CarrierService({ getCollection: jest.fn() } as any, {} as any) as any;
    expect(service.getOctaneBillingCycleDate(new Date('2026-11-24T05:00:00Z'))).toBe('27-11-2026');
    expect(service.getOctaneBillingCycleDate(new Date('2026-11-27T05:00:00Z'))).toBe('27-11-2026');
    expect(service.getOctaneBillingCycleDate(new Date('2026-11-28T05:00:00Z'))).toBe('27-12-2026');
    expect(service.getOctaneBillingCycleDate(new Date('2026-12-29T05:00:00Z'))).toBe('27-01-2027');
  });

  it('ChatService.resetChatSession deactivates chat_sessions and clears reserved numbers for the sessionId', async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const deleteMany = jest.fn().mockResolvedValue({ deletedCount: 1 });
    const mockDb: any = {
      getCollection: jest.fn((name: string) => {
        if (name === 'chat_sessions') return { updateMany };
        if (name === 'chat_reserved_numbers') return { deleteMany };
        return {};
      }),
    };
    const chatService = new ChatService(mockDb, {} as any, {} as any, {} as any, {} as any);

    const res = await chatService.resetChatSession('widget-abc-123');
    expect(res).toEqual({ success: true, reset: true });
    expect(updateMany).toHaveBeenCalledWith(
      { sessionId: 'widget-abc-123', active: true },
      expect.objectContaining({
        $set: expect.objectContaining({ active: false }),
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({ sessionId: 'widget-abc-123' });
  });

  it('ChatService.generateResponse deterministically opens QuickStream iframe for "set payment" and "update my payment card for my plan" and rewrites deflecting replies', async () => {
    const prevKey = process.env.OPENAI_KEY;
    process.env.OPENAI_KEY = 'test-openai-key';
    const originalFetch = global.fetch;

    try {
      const mockDb: any = {
        getCollection: jest.fn(() => ({
          findOne: jest.fn().mockResolvedValue({
            sessionId: 'sess-qs-1',
            custNo: '551059',
            active: true,
            expiresAt: new Date(Date.now() + 600_000),
          }),
          updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        })),
      };
      const issueTokenForCustomer = jest.fn().mockResolvedValue('jwt-551059');
      const chatService = new ChatService(
        mockDb,
        {} as any,
        {} as any,
        {} as any,
        { issueTokenForCustomer } as any,
      );

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Please go to My Account to update your card.',
              },
            },
          ],
        }),
      }) as any;

      for (const prompt of ['set payment', 'update my payment card for my plan']) {
        const res: any = await chatService.generateResponse(
          [{ role: 'user', content: prompt }],
          'sess-qs-1',
        );
        expect(res.uiAction).toEqual(
          expect.objectContaining({
            type: 'QUICKSTREAM_PAYMENT',
            custNo: '551059',
            purpose: 'update_card',
            authToken: 'jwt-551059',
          }),
        );
        expect(res.reply).toMatch(/opened the secure Westpac QuickStream card form right below/i);
      }
    } finally {
      global.fetch = originalFetch;
      if (prevKey === undefined) {
        delete process.env.OPENAI_KEY;
      } else {
        process.env.OPENAI_KEY = prevKey;
      }
    }
  });
});
