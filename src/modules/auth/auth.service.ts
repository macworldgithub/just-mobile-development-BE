import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { MailService } from '../mail/mail.service';
import { CarrierService } from '../carrier/carrier.service';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

export interface UserDocument {
  _id?: ObjectId;
  name: string;
  firstName?: string;
  surname?: string;
  email: string;
  passwordHash?: string;
  pin?: string;
  phone?: string;
  dob?: string;
  address?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  custType?: 'R' | 'B';
  company?: string;
  abn?: string;
  custNo?: string;
  role: 'customer' | 'admin';
  isEmailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

export interface VerificationDocument {
  _id?: ObjectId;
  email: string;
  code: string;
  type: 'signup' | 'login' | 'reset';
  expiresAt: Date;
  used: boolean;
  createdAt: Date;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret = process.env.JWT_SECRET || 'justmobile_super_secret_jwt_key_2026';

  constructor(
    private readonly db: DatabaseService,
    private readonly mailService: MailService,
    private readonly carrierService: CarrierService,
  ) {}

  async onModuleInit() {
    await this.seedDefaultAdmin();
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

      // Ensure test customer Alexander Wright (CUST882104) has PIN '1234' for PIN login testing
      const alexander = await usersCol.findOne({ custNo: 'CUST882104' });
      if (alexander && !alexander.pin) {
        const hashedPin = await bcrypt.hash('1234', 10);
        await usersCol.updateOne({ _id: alexander._id }, { $set: { pin: hashedPin } });
        this.logger.log('✓ Configured legacy PIN 1234 for test customer CUST882104');
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

    // Mark code as used
    await verificationsCol.updateOne({ _id: verification._id }, { $set: { used: true } });

    const passwordHash = await bcrypt.hash(password, 10);

    // ------------------------------------------------------------------
    // Telco Carrier Customer Creation (Native CarrierService)
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
      user: {
        id: userId,
        name: newUser.name,
        firstName: newUser.firstName,
        surname: newUser.surname,
        email: newUser.email,
        phone: newUser.phone,
        custNo: newUser.custNo,
        role: newUser.role,
      },
    };
  }

  async login(dto: {
    custNo?: string;
    identifier?: string;
    email?: string;
    password?: string;
    pin?: string;
    code?: string;
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
      // Customer Portal: support login by custNo (e.g. CUST882104 or 512345) or email
      const isEmail = identifier.includes('@');
      if (isEmail) {
        user = await usersCol.findOne({ email: identifier.toLowerCase() });
      } else {
        const cleanCustNo = identifier.toUpperCase().replace(/\s+/g, '');
        const numericPart = cleanCustNo.replace(/^CUST/i, '');
        const withCustPrefix = `CUST${numericPart}`;
        const escaped = cleanCustNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        user = await usersCol.findOne({
          $or: [
            { custNo: cleanCustNo },
            { custNo: numericPart },
            { custNo: withCustPrefix },
            { custNo: { $regex: new RegExp(`^${escaped}$`, 'i') } },
            { email: identifier.toLowerCase() },
          ],
        });
      }

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

    // Update lastLoginAt
    await usersCol.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    const userId = user._id!.toString();
    const token = jwt.sign(
      { sub: userId, email: user.email, role: user.role, name: user.name },
      this.jwtSecret,
      { expiresIn: '7d' },
    );

    return {
      success: true,
      message: `Successfully logged in to ${portal === 'admin' ? 'Admin Portal' : 'Customer Portal'}.`,
      token,
      user: {
        id: userId,
        name: user.name,
        firstName: user.firstName,
        surname: user.surname,
        email: user.email,
        phone: user.phone || '',
        custNo: user.custNo,
        role: user.role,
      },
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

    const usersCol = this.db.getCollection<UserDocument>('users');
    let user: UserDocument | null = null;

    if (identifier.includes('@')) {
      user = await usersCol.findOne({ email: identifier.toLowerCase() });
    } else {
      const cleanCustNo = identifier.toUpperCase().replace(/\s+/g, '');
      const escaped = cleanCustNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      user = await usersCol.findOne({
        $or: [
          { custNo: cleanCustNo },
          { custNo: { $regex: new RegExp(`^${escaped}$`, 'i') } },
          { email: identifier.toLowerCase() },
        ],
      });
    }

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
    let user: UserDocument | null = null;

    if (identifier.includes('@')) {
      user = await usersCol.findOne({ email: identifier.toLowerCase() });
    } else {
      const cleanCustNo = identifier.toUpperCase().replace(/\s+/g, '');
      const numericPart = cleanCustNo.replace(/^CUST/i, '');
      const withCustPrefix = `CUST${numericPart}`;
      const escaped = cleanCustNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      user = await usersCol.findOne({
        $or: [
          { custNo: cleanCustNo },
          { custNo: numericPart },
          { custNo: withCustPrefix },
          { custNo: { $regex: new RegExp(`^${escaped}$`, 'i') } },
          { email: identifier.toLowerCase() },
        ],
      });
    }

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

  async getMe(authHeader?: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization header is required.');
    }

    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as any;
      const usersCol = this.db.getCollection<UserDocument>('users');
      const user = await usersCol.findOne({ _id: new ObjectId(decoded.sub) });

      if (!user) {
        throw new UnauthorizedException('User no longer exists.');
      }

      return {
        success: true,
        user: {
          id: user._id!.toString(),
          name: user.name,
          firstName: user.firstName,
          surname: user.surname,
          email: user.email,
          phone: user.phone || '',
          custNo: user.custNo,
          role: user.role,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
        },
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired session token.');
    }
  }

  async getAdminStats(authHeader?: string) {
    const me = await this.getMe(authHeader);
    if (me.user.role !== 'admin') {
      throw new UnauthorizedException('Admin access required.');
    }

    const usersCol = this.db.getCollection<UserDocument>('users');
    const totalUsers = await usersCol.countDocuments();
    const customers = await usersCol
      .find({ role: 'customer' })
      .project({ passwordHash: 0 })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    return {
      success: true,
      stats: {
        totalUsers,
        totalCustomers: customers.length,
        smtpConfigured: Boolean(process.env.SMTP_USER),
        smtpHost: process.env.SMTP_HOST || 'smtp.hostinger.com',
      },
      customers: customers.map((c) => ({
        id: c._id!.toString(),
        name: c.name,
        email: c.email,
        phone: c.phone,
        role: c.role,
        createdAt: c.createdAt,
        lastLoginAt: c.lastLoginAt,
      })),
    };
  }
}
