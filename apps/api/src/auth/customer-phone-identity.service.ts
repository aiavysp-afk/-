import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../database/prisma.service.js";
import { AuthCryptoService } from "./auth-crypto.service.js";

type Tx = Prisma.TransactionClient;

@Injectable()
export class CustomerPhoneIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: AuthCryptoService,
  ) {}

  hash(phone: string) {
    return this.crypto.hashPhoneVerification("phone", phone);
  }

  async lock(tx: Tx, phone: string) {
    const phoneHash = this.hash(phone);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer-phone:${phoneHash}`}, 0))`;
    return phoneHash;
  }

  // Caller holds the phone advisory lock. Legacy ciphertext is randomized, so it
  // cannot be compared or backfilled in SQL. Resolve the original user lazily.
  async findOwner(tx: Tx, phone: string): Promise<string | null> {
    const binding = await tx.customerPhoneIdentity.findUnique({
      where: { phoneHash: this.hash(phone) },
    });
    if (binding) {
      const owner = await tx.user.findUnique({
        where: { id: binding.userId },
        select: { status: true, phoneEncrypted: true, phoneVerifiedAt: true },
      });
      if (
        !owner ||
        owner.status !== "ACTIVE" ||
        !owner.phoneEncrypted ||
        !owner.phoneVerifiedAt
      )
        throw new UnauthorizedException("手机号绑定账户不可用，请联系平台处理");
      if (this.decryptPhone(owner.phoneEncrypted) !== phone)
        throw accountLinkConflict();
      return binding.userId;
    }

    let cursor: string | undefined;
    let ownerId: string | null = null;
    for (;;) {
      const batch = await tx.user.findMany({
        where: {
          phoneVerifiedAt: { not: null },
          phoneEncrypted: { not: null },
          customerPhoneIdentity: null,
        },
        select: { id: true, phoneEncrypted: true, status: true },
        orderBy: { id: "asc" },
        take: 200,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const user of batch) {
        if (this.decryptPhone(user.phoneEncrypted!) !== phone) continue;
        // Never silently choose one of two legacy accounts or revive a disabled account.
        if (ownerId && ownerId !== user.id) throw accountLinkConflict();
        if (user.status !== "ACTIVE")
          throw new UnauthorizedException(
            "手机号绑定账户不可用，请联系平台处理",
          );
        ownerId = user.id;
      }
      if (batch.length < 200) break;
      cursor = batch[batch.length - 1]!.id;
    }
    if (ownerId) await this.register(tx, ownerId, phone);
    return ownerId;
  }

  async register(tx: Tx, userId: string, phone: string) {
    const existing = await tx.customerPhoneIdentity.findUnique({
      where: { userId },
    });
    const phoneHash = this.hash(phone);
    if (existing && existing.phoneHash !== phoneHash)
      throw accountLinkConflict();
    if (!existing)
      await tx.customerPhoneIdentity.create({ data: { phoneHash, userId } });
  }

  // Old two-step APIs keep their response shape, but may not create a duplicate
  // verified phone. They cannot change userId mid-session; single-step login can.
  async bindVerifiedPhone(
    tx: Tx,
    userId: string,
    phone: string,
    verifiedAt: Date,
  ) {
    await this.lock(tx, phone);
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true, phoneEncrypted: true, phoneVerifiedAt: true },
    });
    if (!user || user.status !== "ACTIVE")
      throw new UnauthorizedException("账号不可用");
    if (
      user.phoneEncrypted &&
      user.phoneVerifiedAt &&
      this.decryptPhone(user.phoneEncrypted) !== phone
    )
      throw new ConflictException("手机号已经完成验证，如需更换请联系人工客服");
    const ownerId = await this.findOwner(tx, phone);
    if (ownerId && ownerId !== userId) throw accountLinkConflict();
    await this.register(tx, userId, phone);
    await tx.user.update({
      where: { id: userId },
      data: {
        phoneEncrypted: this.crypto.encrypt(phone),
        phoneVerifiedAt: verifiedAt,
      },
    });
  }

  async hasStaffAuthority(tx: Tx, userId: string) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        memberships: {
          where: { role: { not: UserRole.CUSTOMER } },
          select: { id: true },
          take: 1,
        },
        mfaCredential: { select: { userId: true } },
        staffPasswordCredential: { select: { userId: true } },
        technicianProfile: { select: { id: true } },
      },
    });
    return (
      !user ||
      user.role !== UserRole.CUSTOMER ||
      user.memberships.length > 0 ||
      !!user.mfaCredential ||
      !!user.staffPasswordCredential ||
      !!user.technicianProfile
    );
  }

  private decryptPhone(encrypted: string) {
    try {
      return this.crypto.decrypt(encrypted);
    } catch {
      throw new ServiceUnavailableException(
        "历史手机号资料需要安全核对，请联系平台处理",
      );
    }
  }
}

export const accountLinkConflict = () =>
  new ConflictException({
    statusCode: 409,
    code: "ACCOUNT_LINK_CONFLICT",
    message:
      "手机号与现有账户资料存在冲突，请联系平台核对；订单、余额和优惠券未作任何变更",
  });
