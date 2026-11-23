import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
  Logger,
  OnModuleInit,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { MailService } from '../mail/mail.service';
import { CarrierService } from '../carrier/carrier.service';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { ObjectId } from 'mongodb';

authenticator.options = { window: 1 };

export interface UserDocument {
  _id?: ObjectId;
  name: string;
  firstName?: string;
  surname?: string;
  preferredName?: string;
  email: string;
  passwordHash?: string;
  pin?: string;
  phone?: string;
  dob?: string;
  address?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  postalAddress?: string;
  commPreference?: 'email' | 'sms' | 'both';
  marketingConsent?: boolean;
  custType?: 'R' | 'B';
  company?: string;
  abn?: string;
  custNo?: string;
  role: 'customer' | 'admin';
  isEmailVerified: boolean;
  twoFactorEnabled?: boolean;
  twoFactorSecret?: string;
  twoFactorPendingSecret?: string;
  twoFactorSwitchAuthorizedUntil?: Date | null;
  twoFactorBackupCodeHashes?: string[];
  lastUsedTotpCode?: string;
  lastUsedTotpAt?: number;
  legacyData?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

export interface VerificationDocument {
  _id?: ObjectId;
  email: string;
  code: string;
  type: 'signup' | 'login' | 'reset' | 'action_2fa' | 'chat_otp';
  expiresAt: Date;
  used: boolean;
  attempts?: number;
  createdAt: Date;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret = process.env.JWT_SECRET || 'justmobile_super_secret_jwt_key_2026';

  constructor(
    private readonly db: DatabaseService,
    private readonly mailService: MailService,
    @Inject(forwardRef(() => CarrierService))
    private readonly carrierService: CarrierService,
  ) {}

  async onModuleInit() {
    await this.seedDefaultAdmin();
    this.reconcileLegacyCustomersFromOctane().catch((err) =>
      this.logger.warn(`Legacy customer reconciliation skipped: ${err.message}`),
    );
  }

  // Verified read-only Octane carrier data for legacy accounts
  private readonly LEGACY_OCTANE_MAP: Record<
    string,
    { email?: string; status?: 'Active' | 'Disconnected'; planName?: string; planPrice?: number }
  > = {
    '527558': { status: 'Disconnected' },
    '527559': { status: 'Disconnected' },
    '527693': { status: 'Disconnected' },
    '527694': { status: 'Disconnected' },
    '504026': { email: 'brian@aecreative.com.au', status: 'Disconnected' },
    '504309': { email: 'brian@keayes.com', status: 'Active', planName: 'JM 29GB Auto', planPrice: 28.53 },
    '507548': { email: 'benjamin@keayes.com', status: 'Active' },
    '513838': { email: 'makaellaconias@icloud.com', status: 'Active' },
    '514161': { email: 'lee-atkinson@outlook.com', status: 'Active' },
    '514321': { email: 'getstuartclout@gmail.com', status: 'Active' },
    '515210': { email: 'info@stylerocks.com', status: 'Active', planName: 'JM 29GB Auto', planPrice: 28.53 },
    '527808': { email: 'sam.dicki@hotmail.co.uk', status: 'Active' },
    '533161': { email: 'highway0504@icloud.com', status: 'Active' },
    '533169': { email: '', status: 'Active' },
    '534194': { email: 'roshainwillathgamuwa11@gmail.com', status: 'Active' },
    '534780': { email: 'greg@testdriveaustralia.com.au', status: 'Active' },
    '538231': { status: 'Disconnected' },
    '538232': { status: 'Disconnected' },
    '538233': { status: 'Disconnected' },
    '538234': { status: 'Disconnected' },
    '538406': { status: 'Disconnected' },
    '538407': { status: 'Disconnected' },
    '538408': { status: 'Disconnected' },
    '539273': { status: 'Disconnected' },
    '539421': { status: 'Disconnected' },
    '542009': { status: 'Disconnected' },
    '542037': { status: 'Disconnected' },
    '548930': { status: 'Disconnected' },
  };

  private async reconcileLegacyCustomersFromOctane() {
    const usersCol = this.db.getCollection<UserDocument>('users');
    const ordersCol = this.db.getCollection('orders');

    for (const [custNo, patch] of Object.entries(this.LEGACY_OCTANE_MAP)) {
      const numericVal = parseInt(custNo, 10);
      const user = await usersCol.findOne({ $or: [{ custNo }, { custNo: numericVal as any }] });
      if (!user) continue;

      const userSet: Record<string, any> = {};
      const currentEmail = String(user.email || '').trim().toLowerCase();
      if (
        patch.email !== undefined &&
        (currentEmail.endsWith('@customer.justmobile.com.au') || !currentEmail)
      ) {
        userSet.email = patch.email;
      }

      if (patch.status) {
        userSet['legacyData.status'] = patch.status;
      }
      if (patch.planName) {
        userSet['legacyData.planName'] = patch.planName;
        userSet['legacyData.planPrice'] = patch.planPrice;
      }

      if (Object.keys(userSet).length > 0) {
        userSet.updatedAt = new Date();
        await usersCol.updateOne({ _id: user._id }, { $set: userSet });
      }

      if (patch.status === 'Disconnected') {
        await ordersCol.updateMany(
          { custNo: { $in: [custNo, numericVal] } },
          { $set: { status: 'DISCONNECTED', updatedAt: new Date() } },
        );
      } else if (patch.planName) {
        await ordersCol.updateMany(
          {
            custNo: { $in: [custNo, numericVal] },
            planName: { $in: ['Test Activation', 'Belle Activation', 'Standard Mobile', 'SimplyBig Unlimited'] },
          },
          { $set: { planName: patch.planName, pricePerMonth: patch.planPrice, updatedAt: new Date() } },
        );
      }
    }
    this.logger.log('✓ Reconciled legacy customer emails, plans, and statuses against Octane records.');
  }

  private async seedDefaultAdmin() {
    try {
      const usersCol = this.db.getCollection<UserDocument>('users');
      const adminEmail = process.env.ADMIN_EMAIL || 'devs@neximet.com';
      const existingAdmin = await usersCol.findOne({ email: adminEmail });

      if (!existingAdmin) {
        const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;
        if (!initialPassword) {
          this.logger.log('ADMIN_INITIAL_PASSWORD not defined in environment; skipping admin seeding.');
          return;
        }
        const passwordHash = await bcrypt.hash(initialPassword, 10);
        await usersCol.insertOne({
          name: 'JustMobile Administrator',
          email: adminEmail,
          passwordHash,
          phone: '0488000000',
          role: 'admin',
          isEmailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        this.logger.log(`✓ Seeded default admin user (${adminEmail})`);
      }
    } catch (err: any) {
      this.logger.warn(`Could not seed default admin: ${err.message}`);
    }
  }

  async sendVerificationCode(emailRaw: string, type: 'signup' | 'login' = 'signup') {
    const email = emailRaw.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new BadRequestException('A valid email address is required.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const existingUser = await usersCol.findOne({ email });

    if (type === 'signup' && existingUser && existingUser.isEmailVerified) {
      throw new ConflictException('An account with this email already exists. Please log in.');
    }

    if (type === 'login' && !existingUser) {
      throw new NotFoundException('No account found with this email. Please sign up first.');
    }

    // Generate secure 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const verificationsCol = this.db.getCollection<VerificationDocument>('email_verifications');
    await verificationsCol.insertOne({
      email,
      code,
      type,
      expiresAt,
      used: false,
      createdAt: new Date(),
    });

    // Send code via Hostinger SMTP
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(`[DEV] Verification code for ${email}: ${code}`);
    }
    await this.mailService.sendVerificationCode(email, code, existingUser?.name);

    return {
      success: true,
      message: `A 6-digit verification code has been sent to ${email}.`,
    };
  }

  async signup(dto: {
    firstName?: string;
    surname?: string;
    name?: string;
    email: string;
    password?: string;
    phone?: string;
    dob?: string;
    address?: string;
    suburb?: string;
    state?: string;
    postcode?: string;
    custType?: 'R' | 'B';
    company?: string;
    abn?: string;
    code: string;
  }) {
    const email = dto.email.trim().toLowerCase();
    const { password, code } = dto;

    const firstName = (dto.firstName || (dto.name ? dto.name.trim().split(' ')[0] : '')).trim();
    const surname = (dto.surname || (dto.name ? dto.name.trim().split(' ').slice(1).join(' ') : 'Customer')).trim() || 'Customer';
    const fullName = `${firstName} ${surname}`.trim() || dto.name || 'JustMobile Customer';

    if (!firstName || firstName.length < 2) {
      throw new BadRequestException('Please provide your first name (minimum 2 characters).');
    }
    if (!surname || surname.length < 2) {
      throw new BadRequestException('Please provide your last name / surname (minimum 2 characters).');
    }
    if (!email || !email.includes('@')) {
      throw new BadRequestException('Please provide a valid email address.');
    }
    if (!code || code.trim().length !== 6) {
      throw new BadRequestException('A valid 6-digit verification code is required.');
    }
    if (!password || password.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters long.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const existingUser = await usersCol.findOne({ email });
    if (existingUser && existingUser.isEmailVerified) {
      throw new ConflictException('An account with this email already exists. Please log in.');
    }

    // Verify OTP
    const verificationsCol = this.db.getCollection<VerificationDocument>('email_verifications');
    const verification = await verificationsCol.findOne({
      email,
      code: code.trim(),
      used: false,
      expiresAt: { $gt: new Date() },
    });

    if (!verification) {
      throw new BadRequestException('Invalid or expired verification code. Please request a new one.');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // ------------------------------------------------------------------
    // Atomic Telco Carrier Customer Creation FIRST (fail-closed before DB writes)
    // ------------------------------------------------------------------
    const carrierRes = await this.carrierService.addCustomer({
      firstName,
      surname,
      email,
      phone: dto.phone || '0400000000',
      dob: dto.dob || '1995-01-01',
      address: dto.address || 'Address pending',
      suburb: dto.suburb || 'Sydney',
      state: dto.state || 'NSW',
      postcode: dto.postcode || '2000',
      custType: dto.custType || 'R',
      company: dto.custType === 'B' && dto.company ? dto.company : `${firstName} ${surname}`,
      abn: dto.abn,
    });
    const custNo = carrierRes.custNo;

    // Persist user & mark OTP used ONLY after Octane succeeded
    await verificationsCol.updateOne({ _id: verification._id }, { $set: { used: true } });

    const now = new Date();
    const newUser: UserDocument = {
      name: fullName,
      firstName,
      surname,
      email,
      passwordHash,
      phone: dto.phone?.trim() || '',
      dob: dto.dob?.trim() || '',
      address: dto.address?.trim() || '',
      suburb: dto.suburb?.trim() || '',
      state: dto.state?.trim() || '',
      postcode: dto.postcode?.trim() || '',
      custType: dto.custType || 'R',
      company: dto.company?.trim(),
      abn: dto.abn?.trim(),
      custNo,
      role: 'customer',
      isEmailVerified: true,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    };

    const insertResult = await usersCol.insertOne(newUser);
    const userId = insertResult.insertedId.toString();

    // Send decorated welcome email with Customer Number (custNo)
    try {
      await this.mailService.sendCustomerWelcomeEmail(email, custNo, firstName);
    } catch (err: any) {
      this.logger.warn(`Could not dispatch welcome email to ${email}: ${err.message}`);
    }

    const token = jwt.sign(
      { sub: userId, email: newUser.email, role: newUser.role, name: newUser.name, custNo },
      this.jwtSecret,
      { expiresIn: '7d' },
    );

    return {
      success: true,
      message: 'Account created and verified successfully.',
      token,
      user: this.formatUserResponse({ ...newUser, _id: insertResult.insertedId }),
    };
  }

  private async findUserByIdentifier(identifierRaw: string): Promise<UserDocument | null> {
    const identifier = identifierRaw.trim();
    const usersCol = this.db.getCollection<UserDocument>('users');

    if (identifier.includes('@')) {
      return usersCol.findOne({ email: identifier.toLowerCase() });
    }

    const cleanCustNo = identifier.toUpperCase().replace(/\s+/g, '');
    const numericPart = cleanCustNo.replace(/^CUST/i, '');
    const withCustPrefix = `CUST${numericPart}`;
    const escaped = cleanCustNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const numericVal = /^\d+$/.test(numericPart) ? parseInt(numericPart, 10) : null;

    const orClauses: any[] = [
      { custNo: cleanCustNo },
      { custNo: numericPart },
      { custNo: withCustPrefix },
      { custNo: { $regex: new RegExp(`^${escaped}$`, 'i') } },
      { email: identifier.toLowerCase() },
    ];
    if (numericVal !== null && !isNaN(numericVal)) {
      orClauses.push({ custNo: numericVal });
    }

    return usersCol.findOne({ $or: orClauses });
  }

  private maskEmailAddress(email: string): string {
    const clean = (email || '').trim();
    if (!clean.includes('@')) return 'your registered email';
    const [local, domain] = clean.split('@');
    const maskedLocal =
      local.length > 2
        ? `${local[0]}${'*'.repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}`
        : `${local[0] || '*'}***`;
    return `${maskedLocal}@${domain || 'justmobile.ai'}`;
  }

  private hashCode(val: string): string {
    return crypto.createHash('sha256').update(val).digest('hex');
  }

  private formatUserResponse(user: UserDocument) {
    return {
      id: user._id!.toString(),
      name: user.name,
      firstName: user.firstName,
      surname: user.surname,
      preferredName: user.preferredName || '',
      email: user.email,
      phone: user.phone || '',
      dob: user.dob || '',
      address: user.address || '',
      suburb: user.suburb || '',
      state: user.state || '',
      postcode: user.postcode || '',
      postalAddress: user.postalAddress || '',
      commPreference: user.commPreference || 'email',
      marketingConsent: Boolean(user.marketingConsent),
      custNo: user.custNo,
      role: user.role,
      twoFactorEnabled: Boolean(user.twoFactorEnabled && user.twoFactorSecret),
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  }

  private async createAndDispatchOtp(
    email: string,
    type: VerificationDocument['type'],
    recipientName?: string,
  ): Promise<string> {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const verificationsCol = this.db.getCollection<VerificationDocument>('email_verifications');
    // Invalidate previous active codes of the same type for this email
    await verificationsCol.updateMany(
      { email: email.toLowerCase(), type, used: false },
      { $set: { used: true } },
    );

    await verificationsCol.insertOne({
      email: email.toLowerCase(),
      code,
      type,
      expiresAt,
      used: false,
      attempts: 0,
      createdAt: new Date(),
    });

    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(`[DEV] 2FA ${type} code for ${email}: ${code}`);
    }

    if (email && email.includes('@') && !email.endsWith('@example.com')) {
      try {
        await this.mailService.sendVerificationCode(email, code, recipientName);
      } catch (err: any) {
        this.logger.warn(`Failed to email ${type} code to ${email}: ${err.message}`);
      }
    }

    return code;
  }

  private async verifyStoredOtp(
    email: string,
    type: VerificationDocument['type'],
    rawCode: string,
  ): Promise<boolean> {
    const cleanCode = (rawCode || '').trim();
    if (!cleanCode) return false;

    const verificationsCol = this.db.getCollection<VerificationDocument>('email_verifications');
    const latest = await verificationsCol.findOne(
      { email: email.toLowerCase(), type, used: false },
      { sort: { createdAt: -1 } },
    );

    if (!latest) {
      return false;
    }

    if (latest.expiresAt <= new Date()) {
      await verificationsCol.updateOne({ _id: latest._id }, { $set: { used: true } });
      throw new BadRequestException('Verification code has expired. Please request a new code.');
    }

    const attempts = (latest.attempts || 0) + 1;
    if (latest.code !== cleanCode) {
      if (attempts >= 5) {
        await verificationsCol.updateOne({ _id: latest._id }, { $set: { used: true, attempts } });
        throw new BadRequestException('Too many incorrect verification attempts. Please request a new code.');
      }
      await verificationsCol.updateOne({ _id: latest._id }, { $set: { attempts } });
      return false;
    }

    await verificationsCol.updateOne({ _id: latest._id }, { $set: { used: true } });
    return true;
  }

  private async verifyTotpOrBackup(user: UserDocument, rawCode: string): Promise<boolean> {
    const clean = (rawCode || '').trim().replace(/\s+/g, '');
    if (!clean || !user.twoFactorSecret) return false;

    if (/^\d{6}$/.test(clean)) {
      const isValidTotp = authenticator.check(clean, user.twoFactorSecret);
      if (isValidTotp) {
        // Prevent replay within the same 30s window
        const recentlyUsed =
          user.lastUsedTotpCode === clean &&
          user.lastUsedTotpAt &&
          Date.now() - user.lastUsedTotpAt < 35_000;
        if (recentlyUsed) {
          throw new BadRequestException('This Authenticator code was already used. Wait for the next 6-digit code.');
        }
        const usersCol = this.db.getCollection<UserDocument>('users');
        await usersCol.updateOne(
          { _id: user._id },
          { $set: { lastUsedTotpCode: clean, lastUsedTotpAt: Date.now() } },
        );
        return true;
      }
    }

    // Check single-use backup recovery codes (e.g. JM-XXXX-XXXX)
    const hashes = user.twoFactorBackupCodeHashes || [];
    if (hashes.length > 0) {
      const incomingHash = this.hashCode(clean.toUpperCase());
      const matchIdx = hashes.indexOf(incomingHash);
      if (matchIdx !== -1) {
        const remaining = hashes.filter((_, idx) => idx !== matchIdx);
        const usersCol = this.db.getCollection<UserDocument>('users');
        await usersCol.updateOne(
          { _id: user._id },
          { $set: { twoFactorBackupCodeHashes: remaining } },
        );
        return true;
      }
    }

    return false;
  }

  async login(dto: {
    custNo?: string;
    identifier?: string;
    email?: string;
    password?: string;
    pin?: string;
    code?: string;
    twoFactorCode?: string;
    portal?: 'customer' | 'admin';
  }) {
    const portal = dto.portal || 'customer';
    const identifier = (dto.custNo || dto.identifier || dto.email || '').trim();

    if (!identifier) {
      throw new BadRequestException(
        portal === 'admin'
          ? 'Admin email address is required.'
          : 'Please enter your Customer Number.',
      );
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    let user: UserDocument | null = null;

    if (portal === 'admin') {
      user = await usersCol.findOne({ email: identifier.toLowerCase() });
      if (!user) {
        throw new UnauthorizedException('Invalid credentials.');
      }
      if (user.role !== 'admin') {
        throw new UnauthorizedException(
          'Access denied. Administrator privileges are required to access the JustMobile Admin Portal.',
        );
      }
    } else {
      // Customer Portal: support login by custNo (e.g. CUST990001 or 551059) or email
      user = await this.findUserByIdentifier(identifier);

      if (!user) {
        throw new NotFoundException(
          'Account not found with this Customer Number. Please check your Customer ID or sign up.',
        );
      }
    }

    // Validate credentials: password, PIN or one-time code
    if (dto.code) {
      const verificationsCol = this.db.getCollection<VerificationDocument>('email_verifications');
      const verification = await verificationsCol.findOne({
        email: user.email,
        code: dto.code.trim(),
        used: false,
        expiresAt: { $gt: new Date() },
      });

      if (!verification) {
        throw new BadRequestException('Invalid or expired email verification code.');
      }
      await verificationsCol.updateOne({ _id: verification._id }, { $set: { used: true } });
    } else if (dto.password || dto.pin) {
      const secret = (dto.pin || dto.password)!.trim();
      let isMatch = false;

      // 1. Try standard password hash
      if (user.passwordHash) {
        isMatch = await bcrypt.compare(secret, user.passwordHash);
      }

      // 2. Try legacy PIN hash (from mobile app or bele-app)
      if (!isMatch && user.pin) {
        isMatch = await bcrypt.compare(secret, user.pin);
      }

      if (!isMatch) {
        throw new UnauthorizedException(
          dto.pin
            ? 'Incorrect PIN. Please enter your 4-6 digit PIN or reset your credentials.'
            : 'Incorrect password or PIN. Please verify your credentials.'
        );
      }
    } else {
      throw new BadRequestException(
        dto.pin !== undefined ? 'Please enter your PIN.' : 'Please provide your password or PIN.',
      );
    }

    const userId = user._id!.toString();

    // Enforce Industry-Standard 2FA on Customer Portal Logins
    if (portal === 'customer') {
      const hasTotp = Boolean(user.twoFactorEnabled && user.twoFactorSecret);
      const provided2fa = (dto.twoFactorCode || '').trim();

      if (provided2fa) {
        const verified = hasTotp
          ? (await this.verifyTotpOrBackup(user, provided2fa)) ||
            (await this.verifyStoredOtp(user.email, 'login', provided2fa))
          : await this.verifyStoredOtp(user.email, 'login', provided2fa);

        if (!verified) {
          throw new UnauthorizedException('Invalid 2FA verification code.');
        }
      } else if (!dto.code) {
        const preAuthToken = jwt.sign(
          { sub: userId, email: user.email, custNo: user.custNo, purpose: '2fa_login' },
          this.jwtSecret,
          { expiresIn: '10m' },
        );

        const maskedEmail = this.maskEmailAddress(user.email);

        if (hasTotp) {
          return {
            success: true,
            requiresTwoFactor: true,
            twoFactorMethod: 'totp',
            preAuthToken,
            maskedEmail,
            message: 'Enter the 6-digit code from your Authenticator App to complete sign in.',
          };
        }

        await this.createAndDispatchOtp(user.email, 'login', user.name);
        return {
          success: true,
          requiresTwoFactor: true,
          twoFactorMethod: 'email',
          preAuthToken,
          maskedEmail,
          message: `2FA required: a 6-digit verification code has been sent to ${maskedEmail}.`,
        };
      }
    }

    // Update lastLoginAt
    await usersCol.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    const token = jwt.sign(
      { sub: userId, email: user.email, role: user.role, name: user.name, custNo: user.custNo },
      this.jwtSecret,
      { expiresIn: '7d' },
    );

    return {
      success: true,
      message: `Successfully logged in to ${portal === 'admin' ? 'Admin Portal' : 'Customer Portal'}.`,
      token,
      user: this.formatUserResponse(user),
    };
  }

  async sendLoginEmailOtp(preAuthToken: string) {
    if (!preAuthToken) {
      throw new BadRequestException('Login session token is required.');
    }
    let decoded: any;
    try {
      decoded = jwt.verify(preAuthToken, this.jwtSecret);
    } catch {
      throw new UnauthorizedException('Your sign-in session has expired. Please enter your password/PIN again.');
    }
    if (decoded?.purpose !== '2fa_login') {
      throw new UnauthorizedException('Invalid 2FA login session.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const user = await usersCol.findOne({ _id: new ObjectId(decoded.sub) });
    if (!user) {
      throw new UnauthorizedException('Account not found.');
    }

    await this.createAndDispatchOtp(user.email, 'login', user.name);
    const maskedEmail = this.maskEmailAddress(user.email);

    return {
      success: true,
      twoFactorMethod: 'email',
      maskedEmail,
      message: `A 6-digit verification code has been sent to ${maskedEmail}.`,
    };
  }

  async verifyLoginTwoFactor(dto: { preAuthToken: string; code: string; method?: 'totp' | 'email' }) {
    if (!dto.preAuthToken) {
      throw new BadRequestException('Pre-authentication token is required.');
    }
    if (!dto.code || !dto.code.trim()) {
      throw new BadRequestException('Please enter your 6-digit verification code.');
    }

    let decoded: any;
    try {
      decoded = jwt.verify(dto.preAuthToken, this.jwtSecret);
    } catch {
      throw new UnauthorizedException('Your 2FA session has expired. Please sign in again.');
    }

    if (decoded?.purpose !== '2fa_login') {
      throw new UnauthorizedException('Invalid 2FA session.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const user = await usersCol.findOne({ _id: new ObjectId(decoded.sub) });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists.');
    }

    const hasTotp = Boolean(user.twoFactorEnabled && user.twoFactorSecret);
    let verified = false;

    if (dto.method === 'email' || !hasTotp) {
      verified = await this.verifyStoredOtp(user.email, 'login', dto.code);
      if (!verified && hasTotp) {
        verified = await this.verifyTotpOrBackup(user, dto.code);
      }
    } else {
      verified = await this.verifyTotpOrBackup(user, dto.code);
      if (!verified) {
        verified = await this.verifyStoredOtp(user.email, 'login', dto.code);
      }
    }

    if (!verified) {
      throw new BadRequestException(
        hasTotp && dto.method !== 'email'
          ? 'Invalid 6-digit Authenticator or backup code. Please check your app and try again.'
          : 'Invalid 6-digit verification code. Please check your email and try again.',
      );
    }

    await usersCol.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    const userId = user._id!.toString();
    const token = jwt.sign(
      { sub: userId, email: user.email, role: user.role, name: user.name, custNo: user.custNo },
      this.jwtSecret,
      { expiresIn: '7d' },
    );

    return {
      success: true,
      message: '2FA verified. Welcome to your JustMobile Customer Portal.',
      token,
      user: this.formatUserResponse(user),
    };
  }

  /**
   * Request Password Reset Code via Hostinger SMTP
   */
  async forgotPassword(identifierRaw: string) {
    const identifier = (identifierRaw || '').trim();
    if (!identifier) {
      throw new BadRequestException('Please enter your Customer Number or registered email.');
    }

    const user = await this.findUserByIdentifier(identifier);

    if (!user) {
      throw new NotFoundException('No account found with this Customer Number or email address.');
    }

    // Generate secure 6-digit reset code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const verificationsCol = this.db.getCollection<VerificationDocument>('email_verifications');
    await verificationsCol.insertOne({
      email: user.email,
      code,
      type: 'reset',
      expiresAt,
      used: false,
      createdAt: new Date(),
    });

    // Send reset email via Hostinger SMTP
    await this.mailService.sendPasswordResetEmail(user.email, code, user.firstName || user.name);

    // Mask recipient email for privacy display (e.g., a***r@justmobile.com.au)
    const emailParts = user.email.split('@');
    const local = emailParts[0];
    const domain = emailParts[1] || 'justmobile.com.au';
    const maskedLocal = local.length > 2
      ? `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}`
      : `${local}***`;
    const maskedEmail = `${maskedLocal}@${domain}`;

    return {
      success: true,
      maskedEmail,
      message: `A 6-digit password reset code has been sent to your registered email (${maskedEmail}).`,
    };
  }

  /**
   * Complete Password Reset with 6-digit code
   */
  async resetPassword(dto: { identifier: string; code: string; newPassword: string }) {
    const identifier = (dto.identifier || '').trim();
    const code = (dto.code || '').trim();
    const newPassword = dto.newPassword;

    if (!identifier) {
      throw new BadRequestException('Please provide your Customer Number or email.');
    }
    if (!code || code.length !== 6) {
      throw new BadRequestException('Please enter the valid 6-digit reset code sent to your email.');
    }
    if (!newPassword || newPassword.length < 4) {
      throw new BadRequestException('Password or PIN must be at least 4 characters long.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const user = await this.findUserByIdentifier(identifier);

    if (!user) {
      throw new NotFoundException('Account not found.');
    }

    const verificationsCol = this.db.getCollection<VerificationDocument>('email_verifications');
    const verification = await verificationsCol.findOne({
      email: user.email,
      code,
      type: 'reset',
      used: false,
      expiresAt: { $gt: new Date() },
    });

    if (!verification) {
      throw new BadRequestException('Invalid or expired reset code. Please request a new code.');
    }

    // Mark verification code as used
    await verificationsCol.updateOne({ _id: verification._id }, { $set: { used: true } });

    // Hash new password & PIN
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updatePayload: any = { passwordHash, updatedAt: new Date() };
    if (/^\d{4,6}$/.test(newPassword.trim())) {
      updatePayload.pin = passwordHash;
    }
    await usersCol.updateOne(
      { _id: user._id },
      { $set: updatePayload },
    );

    this.logger.log(`✓ Password successfully reset for customer ${user.custNo || user.email}`);

    return {
      success: true,
      message: 'Your password has been successfully reset. You can now log in with your new password.',
    };
  }

  private async getAuthenticatedUser(authHeader?: string): Promise<UserDocument> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization header is required.');
    }

    const token = authHeader.split(' ')[1];
    let decoded: any;
    try {
      decoded = jwt.verify(token, this.jwtSecret);
    } catch {
      throw new UnauthorizedException('Invalid or expired session token.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const user = await usersCol.findOne({ _id: new ObjectId(decoded.sub) });
    if (!user) {
      throw new UnauthorizedException('User no longer exists.');
    }
    return user;
  }

  private cachedAdminStats: { expiresAt: number; payload: any } | null = null;

  invalidateAdminStatsCache() {
    this.cachedAdminStats = null;
  }

  async getMe(authHeader?: string) {
    const user = await this.getAuthenticatedUser(authHeader);
    const formatted: Record<string, any> = this.formatUserResponse(user);
    const custNo = String(user.custNo || '').trim();

    if (
      user.role === 'customer' &&
      process.env.TELCO_LIVE_CREATE === 'true' &&
      /^\d+$/.test(custNo)
    ) {
      const [custRes, svcRes] = await Promise.allSettled([
        this.carrierService.getCustomer(custNo),
        this.carrierService.getServices(custNo),
      ]);
      const liveCust: any = custRes.status === 'fulfilled' ? custRes.value : null;
      const liveSvcs = svcRes.status === 'fulfilled' ? svcRes.value?.services || [] : [];
      const primarySvc: any = liveSvcs[0] || null;

      if (liveCust) {
        formatted.name = liveCust.name || formatted.name;
        if (liveCust.firstName) formatted.firstName = liveCust.firstName;
        if (liveCust.surname) formatted.surname = liveCust.surname;
        if (liveCust.email) formatted.email = liveCust.email;
        formatted.phone = liveCust.phone || primarySvc?.serviceNumber || formatted.phone;
        if (liveCust.address) formatted.address = liveCust.address;
        if (liveCust.suburb) formatted.suburb = liveCust.suburb;
        if (liveCust.state) formatted.state = liveCust.state;
        if (liveCust.postcode) formatted.postcode = liveCust.postcode;
        if (liveCust.dob) formatted.dob = liveCust.dob;
        formatted.lineStatus = liveCust.status;
      }
      if (primarySvc) {
        formatted.planName = primarySvc.planName;
        formatted.planNo = primarySvc.planNo;
        formatted.phone = primarySvc.serviceNumber || formatted.phone;
      }
    }

    return {
      success: true,
      user: formatted,
    };
  }

  // ==========================================================================
  // 2FA (TOTP via otplib + qrcode, with Email OTP fallback)
  // ==========================================================================

  async getTwoFactorStatus(authHeader?: string) {
    const user = await this.getAuthenticatedUser(authHeader);
    return {
      success: true,
      twoFactorEnabled: Boolean(user.twoFactorEnabled && user.twoFactorSecret),
      method: user.twoFactorEnabled && user.twoFactorSecret ? 'totp' : 'email',
      email: user.email,
      backupCodesRemaining: (user.twoFactorBackupCodeHashes || []).length,
    };
  }

  async setupTwoFactor(authHeader?: string, currentCodeRaw?: string) {
    const user = await this.getAuthenticatedUser(authHeader);
    if (user.twoFactorEnabled && user.twoFactorSecret) {
      await this.verifyActionTwoFactor(user, currentCodeRaw || '');
    }

    const secret = authenticator.generateSecret(20);
    const label = user.custNo ? `${user.email || user.custNo} (${user.custNo})` : user.email;
    const otpauthUrl = authenticator.keyuri(label, 'JustMobile', secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
      width: 240,
      margin: 2,
      color: { dark: '#142420', light: '#FFFFFF' },
    });

    const usersCol = this.db.getCollection<UserDocument>('users');
    await usersCol.updateOne(
      { _id: user._id },
      {
        $set: {
          twoFactorPendingSecret: secret,
          twoFactorSwitchAuthorizedUntil:
            user.twoFactorEnabled && user.twoFactorSecret ? new Date(Date.now() + 10 * 60 * 1000) : null,
          updatedAt: new Date(),
        },
      },
    );

    return {
      success: true,
      secret,
      otpauthUrl,
      qrCodeDataUrl,
      issuer: 'JustMobile',
      accountName: label,
    };
  }

  async enableTwoFactor(authHeader: string | undefined, codeRaw: string, currentCodeRaw?: string) {
    const user = await this.getAuthenticatedUser(authHeader);
    const code = (codeRaw || '').trim().replace(/\s+/g, '');

    if (user.twoFactorEnabled && user.twoFactorSecret) {
      const switchUntil = user.twoFactorSwitchAuthorizedUntil;
      const switchValid = switchUntil instanceof Date
        ? switchUntil.getTime() > Date.now()
        : Boolean(switchUntil && new Date(switchUntil).getTime() > Date.now());
      if (!switchValid) {
        await this.verifyActionTwoFactor(user, currentCodeRaw || '');
      }
    }

    if (!user.twoFactorPendingSecret) {
      throw new BadRequestException('No 2FA setup is in progress. Please generate a QR code first.');
    }
    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException('Please enter the 6-digit code from your Authenticator App.');
    }

    const isValid = authenticator.check(code, user.twoFactorPendingSecret);
    if (!isValid) {
      throw new BadRequestException('Invalid 6-digit Authenticator code. Please ensure your device clock is accurate and try again.');
    }

    const backupCodes = Array.from({ length: 6 }, () => {
      const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      return `JM-${part1}-${part2}`;
    });
    const backupHashes = backupCodes.map((c) => this.hashCode(c));

    const usersCol = this.db.getCollection<UserDocument>('users');
    await usersCol.updateOne(
      { _id: user._id },
      {
        $set: {
          twoFactorEnabled: true,
          twoFactorSecret: user.twoFactorPendingSecret,
          twoFactorPendingSecret: '',
          twoFactorSwitchAuthorizedUntil: null,
          twoFactorBackupCodeHashes: backupHashes,
          updatedAt: new Date(),
        },
      },
    );

    return {
      success: true,
      twoFactorEnabled: true,
      backupCodes,
      message: 'Authenticator App 2FA is now enabled on your account.',
    };
  }

  async disableTwoFactor(authHeader: string | undefined, codeRaw: string) {
    const user = await this.getAuthenticatedUser(authHeader);
    await this.verifyActionTwoFactor(user, codeRaw);

    const usersCol = this.db.getCollection<UserDocument>('users');
    await usersCol.updateOne(
      { _id: user._id },
      {
        $set: {
          twoFactorEnabled: false,
          twoFactorSecret: '',
          twoFactorPendingSecret: '',
          twoFactorSwitchAuthorizedUntil: null,
          twoFactorBackupCodeHashes: [],
          updatedAt: new Date(),
        },
      },
    );

    return {
      success: true,
      twoFactorEnabled: false,
      message: 'Authenticator App 2FA has been disabled. Email OTP 2FA remains active for security.',
    };
  }

  async sendActionTwoFactorCode(authHeader?: string) {
    const user = await this.getAuthenticatedUser(authHeader);
    await this.createAndDispatchOtp(user.email, 'action_2fa', user.name);
    const maskedEmail = this.maskEmailAddress(user.email);

    return {
      success: true,
      maskedEmail,
      message: `A 6-digit security verification code has been sent to ${maskedEmail}.`,
    };
  }

  async verifyActionTwoFactor(user: UserDocument, codeRaw: string): Promise<void> {
    const clean = (codeRaw || '').trim();
    if (!clean) {
      throw new BadRequestException(
        user.twoFactorEnabled && user.twoFactorSecret
          ? 'Please enter the 6-digit 2FA code from your Authenticator App (or request an Email OTP).'
          : 'Please enter the 6-digit Email 2FA code to confirm this account change.',
      );
    }

    const hasTotp = Boolean(user.twoFactorEnabled && user.twoFactorSecret);
    let verified = false;

    if (hasTotp) {
      verified = await this.verifyTotpOrBackup(user, clean);
    }
    if (!verified) {
      verified = await this.verifyStoredOtp(user.email, 'action_2fa', clean);
    }

    if (!verified) {
      throw new BadRequestException('Invalid 2FA verification code. Please check your code and try again.');
    }
  }

  async issueTokenForCustomer(custNo: string): Promise<string> {
    const cleanCustNo = String(custNo || '').trim();
    if (!cleanCustNo) {
      throw new BadRequestException('Customer number is required.');
    }
    const usersCol = this.db.getCollection<UserDocument>('users');
    const digits = cleanCustNo.replace(/\D+/g, '');
    const numericVal = digits ? parseInt(digits, 10) : NaN;
    const orClauses: any[] = [{ custNo: cleanCustNo }];
    if (!isNaN(numericVal)) {
      orClauses.push({ custNo: numericVal });
    }
    const user = await usersCol.findOne({ $or: orClauses });
    if (!user) {
      throw new UnauthorizedException('Account not found.');
    }
    return jwt.sign(
      {
        sub: String(user._id),
        email: user.email,
        role: user.role,
        name: user.name,
        custNo: user.custNo,
      },
      this.jwtSecret,
      { expiresIn: '1h' },
    );
  }

  async verifyCustomerAccess(
    authHeader: string | undefined,
    expectedCustNo?: string,
  ) {
    const user = await this.getAuthenticatedUser(authHeader);
    if (
      expectedCustNo &&
      user.role !== 'admin' &&
      String(user.custNo || '').trim() !== String(expectedCustNo).trim()
    ) {
      throw new ForbiddenException('You are not authorised to perform actions on another customer account.');
    }
    return user;
  }

  async verifyAdminAccess(authHeader: string | undefined) {
    const user = await this.getAuthenticatedUser(authHeader);
    if (user.role !== 'admin') {
      throw new ForbiddenException('Admin access required.');
    }
    return user;
  }

  async verifyActionTwoFactorForHeader(
    authHeader: string | undefined,
    codeRaw: string,
    expectedCustNo?: string,
  ) {
    const user = await this.verifyCustomerAccess(authHeader, expectedCustNo);
    await this.verifyActionTwoFactor(user, codeRaw);
    return user;
  }

  async updateProfile(
    authHeader: string | undefined,
    dto: {
      firstName?: string;
      surname?: string;
      preferredName?: string;
      email?: string;
      phone?: string;
      address?: string;
      suburb?: string;
      state?: string;
      postcode?: string;
      postalAddress?: string;
      commPreference?: 'email' | 'sms' | 'both';
      marketingConsent?: boolean;
      twoFactorCode: string;
    },
  ) {
    const user = await this.getAuthenticatedUser(authHeader);
    await this.verifyActionTwoFactor(user, dto.twoFactorCode);

    const updateSet: Record<string, any> = { updatedAt: new Date() };
    const nextFirst = dto.firstName !== undefined ? dto.firstName.trim() : user.firstName;
    const nextSurname = dto.surname !== undefined ? dto.surname.trim() : user.surname;

    if (dto.firstName !== undefined) updateSet.firstName = nextFirst;
    if (dto.surname !== undefined) updateSet.surname = nextSurname;
    if (dto.firstName !== undefined || dto.surname !== undefined) {
      const combined = `${nextFirst || ''} ${nextSurname || ''}`.trim();
      if (combined) updateSet.name = combined;
    }
    if (dto.preferredName !== undefined) updateSet.preferredName = dto.preferredName.trim();
    if (dto.email !== undefined) {
      const cleanEmail = dto.email.trim().toLowerCase();
      if (!cleanEmail || !cleanEmail.includes('@')) {
        throw new BadRequestException('Please provide a valid email address.');
      }
      updateSet.email = cleanEmail;
    }
    if (dto.phone !== undefined) updateSet.phone = dto.phone.trim();
    if (dto.address !== undefined) updateSet.address = dto.address.trim();
    if (dto.suburb !== undefined) updateSet.suburb = dto.suburb.trim();
    if (dto.state !== undefined) updateSet.state = dto.state.trim().toUpperCase();
    if (dto.postcode !== undefined) {
      const cleanPostcode = dto.postcode.trim();
      if (cleanPostcode && !/^\d{4}$/.test(cleanPostcode)) {
        throw new BadRequestException('Australian postcode must be 4 digits.');
      }
      updateSet.postcode = cleanPostcode;
    }
    if (dto.postalAddress !== undefined) updateSet.postalAddress = dto.postalAddress.trim();
    if (dto.commPreference !== undefined) updateSet.commPreference = dto.commPreference;
    if (dto.marketingConsent !== undefined) updateSet.marketingConsent = Boolean(dto.marketingConsent);

    if (user.custNo) {
      await this.carrierService.updateCustomerDetails(String(user.custNo), {
        ...(updateSet.firstName !== undefined ? { firstName: updateSet.firstName } : {}),
        ...(updateSet.surname !== undefined ? { surname: updateSet.surname } : {}),
        ...(updateSet.email !== undefined ? { email: updateSet.email } : {}),
        ...(updateSet.phone !== undefined ? { phone: updateSet.phone } : {}),
        ...(updateSet.address !== undefined ? { address: updateSet.address } : {}),
        ...(updateSet.suburb !== undefined ? { suburb: updateSet.suburb } : {}),
        ...(updateSet.state !== undefined ? { state: updateSet.state } : {}),
        ...(updateSet.postcode !== undefined ? { postcode: updateSet.postcode } : {}),
        ...(updateSet.postalAddress !== undefined ? { postalAddress: updateSet.postalAddress } : {}),
        ...(updateSet.commPreference !== undefined ? { commPreference: updateSet.commPreference } : {}),
      });
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    await usersCol.updateOne({ _id: user._id }, { $set: updateSet });
    const updatedUser = await usersCol.findOne({ _id: user._id });

    return {
      success: true,
      message: 'Your account details have been updated securely.',
      user: this.formatUserResponse(updatedUser!),
    };
  }

  async getAdminStats(authHeader?: string, forceRefresh = false) {
    const me = await this.getMe(authHeader);
    if (me.user.role !== 'admin') {
      throw new UnauthorizedException('Admin access required.');
    }

    const cached = this.cachedAdminStats;
    if (!forceRefresh && cached && Date.now() < cached.expiresAt) {
      return cached.payload;
    }

    if (forceRefresh) {
      this.carrierService.clearOctaneCustomersCache?.();
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const ordersCol = this.db.getCollection('orders');

    const [totalUsers, totalCustomerCount, rawCustomers, allOrders, octaneCustomersMap] = await Promise.all([
      usersCol.countDocuments(),
      usersCol.countDocuments({ role: 'customer' }),
      usersCol
        .find({ role: 'customer' })
        .project({ passwordHash: 0, pin: 0, twoFactorSecret: 0, twoFactorPendingSecret: 0, twoFactorBackupCodeHashes: 0 })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray(),
      ordersCol.find({}).sort({ updatedAt: -1, createdAt: -1 }).toArray(),
      this.carrierService.getAllCustomersFromOctane(),
    ]);

    const ordersByCust = new Map<string, any>();
    allOrders.forEach((o: any) => {
      if (o.custNo) {
        const key = o.custNo.toString();
        if (!ordersByCust.has(key)) {
          ordersByCust.set(key, o);
        }
      }
    });

    const emailsWithCustNo = new Set<string>(
      rawCustomers
        .filter((c: any) => c.custNo && String(c.custNo).trim() !== '—' && c.email)
        .map((c: any) => String(c.email).trim().toLowerCase()),
    );

    const seenKeys = new Set<string>();
    const customers = rawCustomers.filter((c: any) => {
      const custNoStr = c.custNo ? String(c.custNo).trim() : '';
      const emailStr = c.email ? String(c.email).trim().toLowerCase() : '';
      if ((!custNoStr || custNoStr === '—') && emailStr && emailsWithCustNo.has(emailStr)) {
        return false;
      }
      const dedupeKey = custNoStr && custNoStr !== '—' ? `cust:${custNoStr}` : `email:${emailStr}`;
      if (seenKeys.has(dedupeKey)) {
        return false;
      }
      seenKeys.add(dedupeKey);
      return true;
    });

    const liveServicesByCust = new Map<string, any[]>();
    const liveCustFallbackEmail = new Map<string, string>();
    if (process.env.TELCO_LIVE_CREATE === 'true') {
      const numericActiveCustNos = customers
        .map((c: any) => String(c.custNo || '').trim())
        .filter((custNoStr) => {
          if (!/^\d+$/.test(custNoStr)) return false;
          const octCust = octaneCustomersMap.get(custNoStr);
          if (octCust) {
            return this.carrierService.normalizeOctaneStatus(octCust.category_status_customer) !== 'Disconnected';
          }
          const matchedOrder = ordersByCust.get(custNoStr);
          return String(matchedOrder?.status || '').toUpperCase() !== 'DISCONNECTED';
        });

      const CONCURRENCY = 6;
      for (let i = 0; i < numericActiveCustNos.length; i += CONCURRENCY) {
        const chunk = numericActiveCustNos.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map(async (custNo) => {
            const octCust = octaneCustomersMap.get(custNo);
            const hasListEmail = Boolean(octCust?.email || octCust?.orderNotificationEmail);
            const [svcRes, singleCust] = await Promise.all([
              this.carrierService.getServices(custNo),
              hasListEmail ? Promise.resolve(null) : this.carrierService.getCustomer(custNo),
            ]);
            return {
              custNo,
              services: svcRes?.services || [],
              singleEmail: singleCust?.email || '',
            };
          }),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            const val = (r as PromiseFulfilledResult<{ custNo: string; services: any[]; singleEmail: string }>).value;
            liveServicesByCust.set(val.custNo, val.services);
            if (val.singleEmail) {
              liveCustFallbackEmail.set(val.custNo, val.singleEmail);
            }
          }
        }
      }
    }

    const mappedCustomers = customers.map((c: any) => {
      const custNoStr = c.custNo ? String(c.custNo).trim() : '';
      const octCust = custNoStr ? octaneCustomersMap.get(custNoStr) : undefined;
      const liveServices = custNoStr ? liveServicesByCust.get(custNoStr) : undefined;
      const primarySvc = liveServices && liveServices.length > 0 ? liveServices[0] : null;
      const matchedOrder = custNoStr ? ordersByCust.get(custNoStr) : null;

      let lineStatus = 'Active';
      if (octCust) {
        lineStatus = this.carrierService.normalizeOctaneStatus(octCust.category_status_customer);
      } else {
        const rawStatus = (matchedOrder?.status || c.legacyData?.status || 'Active').trim().toUpperCase();
        if (rawStatus === 'DISCONNECTED') lineStatus = 'Disconnected';
        else if (rawStatus === 'SUSPENDED') lineStatus = 'Suspended';
        else if (rawStatus.includes('PROGRESS') || rawStatus === 'PENDING') lineStatus = 'Pending';
      }

      let planName = 'No Active Plan';
      let planPrice = 0;

      if (lineStatus === 'Disconnected') {
        planName = 'No Active Plan';
        planPrice = 0;
      } else if (primarySvc) {
        const resolved = this.carrierService.resolvePlanDetails(primarySvc.planName, primarySvc.planNo);
        planName = resolved?.name || primarySvc.planName;
        planPrice = resolved?.price ?? primarySvc.planPrice ?? 0;
      } else if (octCust?.planNo) {
        const resolved = this.carrierService.resolvePlanDetails('', octCust.planNo);
        if (resolved) {
          planName = resolved.name;
          planPrice = resolved.price;
        }
      } else if (custNoStr === 'CUST990001') {
        planName = matchedOrder?.planName || 'JM 65GB Auto';
        planPrice = matchedOrder?.pricePerMonth || 40;
      } else if (
        matchedOrder?.planName &&
        ['PENDING', 'PORT_IN_PROGRESS', 'PROCESSING'].includes(String(matchedOrder.status || '').toUpperCase())
      ) {
        planName = matchedOrder.planName;
        planPrice = matchedOrder.pricePerMonth || 0;
      }

      const octName = octCust ? [octCust.firstName, octCust.surname].filter(Boolean).join(' ').trim() : '';
      const octEmail = String(
        octCust?.email ||
          octCust?.orderNotificationEmail ||
          liveCustFallbackEmail.get(custNoStr) ||
          '',
      ).trim();
      const rawMongoEmail = String(c.email || '').trim();
      const displayEmail =
        octEmail ||
        (rawMongoEmail && !rawMongoEmail.endsWith('@customer.justmobile.com.au') ? rawMongoEmail : '') ||
        '—';

      const displayPhone =
        primarySvc?.serviceNumber ||
        octCust?.phone ||
        octCust?.mobile ||
        c.phone ||
        matchedOrder?.msn ||
        '—';

      return {
        id: c._id!.toString(),
        custNo: c.custNo || '—',
        name: octName || c.name,
        email: displayEmail,
        phone: displayPhone,
        role: c.role,
        planName,
        planPrice,
        lineStatus,
        createdAt: c.createdAt,
        lastLoginAt: c.lastLoginAt,
      };
    });

    const payload = {
      success: true,
      source: octaneCustomersMap.size > 0 ? 'octane-live' : 'mongodb-backend',
      stats: {
        totalUsers,
        totalCustomers: mappedCustomers.length,
        octaneTotalGroupCustomers: octaneCustomersMap.size,
        smtpConfigured: Boolean(process.env.SMTP_USER),
        smtpHost: process.env.SMTP_HOST || 'smtp.hostinger.com',
      },
      customers: mappedCustomers,
    };

    this.cachedAdminStats = {
      expiresAt: Date.now() + 60_000,
      payload,
    };
    return payload;
  }

  async getAdminSupportCases(authHeader?: string) {
    await this.verifyAdminAccess(authHeader);

    const [complaints, tickets, billQueries] = await Promise.all([
      this.db.getCollection('complaints').find({}).sort({ createdAt: -1 }).limit(100).toArray(),
      this.db.getCollection('support_tickets').find({}).sort({ createdAt: -1 }).limit(100).toArray(),
      this.db.getCollection('bill_queries').find({}).sort({ createdAt: -1 }).limit(100).toArray(),
    ]);

    const normalizeCase = (doc: any, collection: 'complaints' | 'support_tickets' | 'bill_queries') => ({
      id: doc._id ? String(doc._id) : String(doc.referenceNumber || doc.queryId || ''),
      collection,
      referenceNumber: String(doc.referenceNumber || doc.queryId || ''),
      caseType:
        doc.caseType ||
        (collection === 'complaints'
          ? 'complaint'
          : collection === 'bill_queries'
            ? 'billing_dispute'
            : 'support_ticket'),
      custNo: doc.custNo ? String(doc.custNo) : null,
      contactName: doc.contactName || doc.name || null,
      contactEmail: doc.contactEmail || doc.email || null,
      summary: doc.summary || doc.message || '',
      desiredOutcome: doc.desiredOutcome || null,
      invoiceId: doc.invoiceId || null,
      category: doc.category || null,
      urgent: Boolean(doc.urgent),
      status: String(doc.status || 'OPEN').toUpperCase(),
      adminNote: doc.adminNote || null,
      createdAt: doc.createdAt || new Date(),
      updatedAt: doc.updatedAt || doc.createdAt || new Date(),
    });

    const cases = [
      ...complaints.map((d: any) => normalizeCase(d, 'complaints')),
      ...tickets.map((d: any) => normalizeCase(d, 'support_tickets')),
      ...billQueries.map((d: any) => normalizeCase(d, 'bill_queries')),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const counts = {
      total: cases.length,
      open: cases.filter((c) => c.status === 'OPEN').length,
      inProgress: cases.filter((c) => c.status === 'IN_PROGRESS').length,
      resolved: cases.filter((c) => c.status === 'RESOLVED').length,
      urgentOpen: cases.filter((c) => c.urgent && c.status !== 'RESOLVED').length,
    };

    return {
      success: true,
      counts,
      cases,
    };
  }

  async updateAdminSupportCaseStatus(
    authHeader: string | undefined,
    dto: { collection: string; referenceNumber: string; status: string; adminNote?: string },
  ) {
    await this.verifyAdminAccess(authHeader);

    const allowedCollections = ['complaints', 'support_tickets', 'bill_queries'];
    const allowedStatuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];
    const cleanCollection = String(dto?.collection || '').trim();
    const cleanRef = String(dto?.referenceNumber || '').trim();
    const cleanStatus = String(dto?.status || '').trim().toUpperCase();

    if (!allowedCollections.includes(cleanCollection)) {
      throw new BadRequestException('Invalid support case collection.');
    }
    if (!cleanRef) {
      throw new BadRequestException('Reference number is required.');
    }
    if (!allowedStatuses.includes(cleanStatus)) {
      throw new BadRequestException('Invalid case status.');
    }

    const updateFields: Record<string, any> = {
      status: cleanStatus,
      updatedAt: new Date(),
    };
    if (dto.adminNote !== undefined) {
      updateFields.adminNote = String(dto.adminNote).trim();
    }

    const res = await this.db.getCollection(cleanCollection).updateOne(
      { $or: [{ referenceNumber: cleanRef }, { queryId: cleanRef }] },
      { $set: updateFields },
    );

    if (!res.matchedCount) {
      throw new NotFoundException(`Support case ${cleanRef} not found.`);
    }

    return {
      success: true,
      referenceNumber: cleanRef,
      status: cleanStatus,
    };
  }
}
