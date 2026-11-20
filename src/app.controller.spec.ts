import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CarrierService } from './modules/carrier/carrier.service';
import { CarrierController } from './modules/carrier/carrier.controller';

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
