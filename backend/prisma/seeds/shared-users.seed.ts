import { Prisma, PrismaClient, UserRole, UserStatus } from "@prisma/client";
import { hash } from "bcryptjs";
import { getSeedConfig } from "../../apps/api/src/config/seed.config.js";

// Seed callers and logs only receive public identity fields, never passwordHash.
const identitySelect = {
  id: true, fullName: true, username: true, role: true, status: true, telegramUserId: true,
} satisfies Prisma.UserSelect;

function telegramId(name: string, fallback: string): bigint {
  const value = process.env[name] ?? fallback;
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return BigInt(value);
}

async function upsertOwner(tx: Prisma.TransactionClient, telegramUserId?: bigint) {
  const config = getSeedConfig();
  const existing = await tx.user.findUnique({ where: { username: config.username }, select: identitySelect });
  if (existing && existing.role !== UserRole.OWNER) {
    throw new Error("Refusing to change an existing user's role to OWNER");
  }
  const passwordHash = await hash(config.password, config.passwordRounds);
  const identity = { fullName: config.fullName, status: UserStatus.ACTIVE,
    ...(telegramUserId === undefined ? {} : { telegramUserId }) };
  return tx.user.upsert({
    where: { username: config.username },
    create: { ...identity, username: config.username, passwordHash, role: UserRole.OWNER },
    update: { ...identity, passwordHash },
    select: identitySelect,
  });
}

export async function seedInitialOwner(prisma: PrismaClient) {
  const ownerTelegramId = process.env.SEED_OWNER_TELEGRAM_USER_ID === undefined ? undefined
    : telegramId("SEED_OWNER_TELEGRAM_USER_ID", "94004001");
  return prisma.$transaction(tx => upsertOwner(tx, ownerTelegramId));
}

export async function seedSharedUsers(prisma: PrismaClient) {
  // Validate all configuration before writing anything. No hard-coded password fallback.
  getSeedConfig();
  const ownerTelegramId = telegramId("SEED_OWNER_TELEGRAM_USER_ID", "94004001");
  const staffTelegramId = telegramId("SEED_SERVICE_STAFF_TELEGRAM_USER_ID", "94004002");
  const baristaTelegramId = telegramId("SEED_BARISTA_TELEGRAM_USER_ID", "94004003");
  if (new Set([ownerTelegramId, staffTelegramId, baristaTelegramId]).size !== 3) {
    throw new Error("Seed Telegram user IDs must be distinct for each role");
  }

  return prisma.$transaction(async tx => {
    const owner = await upsertOwner(tx, ownerTelegramId);
    async function employee(username: string, fullName: string, role: UserRole, telegramUserId: bigint) {
      const byUsername = await tx.user.findUnique({ where: { username }, select: identitySelect });
      const byTelegram = await tx.user.findUnique({ where: { telegramUserId }, select: identitySelect });
      if (byUsername && byTelegram && byUsername.id !== byTelegram.id) {
        throw new Error("Seed username and Telegram identity belong to different users");
      }
      const existing = byUsername ?? byTelegram;
      if (existing && existing.role !== role) {
        throw new Error(`Refusing to change an existing user's role to ${role}`);
      }
      const data = { username, fullName, telegramUserId, telegramChatId: telegramUserId,
        status: UserStatus.ACTIVE, passwordHash: null };
      return existing
        ? tx.user.update({ where: { id: existing.id }, data, select: identitySelect })
        : tx.user.create({ data: { ...data, role }, select: identitySelect });
    }
    const serviceStaff = await employee("service_staff", "Service Staff", UserRole.SERVICE_STAFF, staffTelegramId);
    const barista = await employee("barista", "Barista", UserRole.BARISTA, baristaTelegramId);
    return { owner, serviceStaff, barista };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 });
}
