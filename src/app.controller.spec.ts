import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CarrierService } from './modules/carrier/carrier.service';
import { CarrierController } from './modules/carrier/carrier.controller';
import { ChatService } from './modules/chat/chat.service';

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
        planPrice: 37.55,
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
