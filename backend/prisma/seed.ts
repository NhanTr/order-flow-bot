import { PrismaClient } from "@prisma/client";

import { seedInitialOwner, seedSharedUsers } from "./seeds/shared-users.seed";
import { seedBe004IntegrationFixtures } from "./seeds/be004-integration-fixtures.seed";
import { seedThai001CashPayment } from "./seeds/thai001-cash-payment.seed";
import { seedThai002QrPayment } from "./seeds/thai002-qr-payment.seed";
import { seedThai003SepayWebhook } from "./seeds/thai003-sepay-webhook.seed";
import { seedThai004Reconciliation } from "./seeds/thai004-reconciliation.seed";
import { seedThai005Refund } from "./seeds/thai005-refund.seed";
import { seedThai006Revenue } from "./seeds/thai006-revenue.seed";
import { seedReconciliationDemo } from "./seeds/reconciliation-demo.seed";
import { seedAuditDemo } from "./seeds/audit-demo.seed";
import { seedSmallShopMenu } from "./seeds/small-shop-menu.seed";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const target = process.argv[2] ?? "owner";

  if (target === "owner") {
    const owner = await seedInitialOwner(prisma);
    console.info({ owner }, "Initial OWNER seed completed");
    return;
  }

  if (target === "users") {
    const users = await seedSharedUsers(prisma);
    console.info({ users }, "Shared seed accounts completed");
    return;
  }

  if (target === "thai001") {
    await seedThai001CashPayment(prisma);
    return;
  }

  if (target === "thai002") {
    await seedThai002QrPayment(prisma);
    return;
  }

  if (target === "thai003") {
    await seedThai003SepayWebhook(prisma);
    return;
  }

  if (target === "thai004") {
    await seedThai004Reconciliation(prisma);
    return;
  }

  if (target === "thai005") {
    await seedThai005Refund(prisma);
    return;
  }

  if (target === "thai006") {
    await seedThai006Revenue(prisma);
    return;
  }

  if (target === "reconcile") {
    await seedReconciliationDemo(prisma);
    return;
  }

  if (target === "audit") {
    await seedAuditDemo(prisma);
    return;
  }

  if (target === "be004") {
    await seedBe004IntegrationFixtures(prisma);
    return;
  }

  if (target === "menu") {
    await seedSmallShopMenu(prisma);
    return;
  }

  if (target === "thai") {
    await seedThai001CashPayment(prisma);
    await seedThai002QrPayment(prisma);
    await seedThai003SepayWebhook(prisma);
    await seedThai004Reconciliation(prisma);
    await seedThai005Refund(prisma);
    await seedThai006Revenue(prisma);
    return;
  }

  throw new Error(`Unknown seed target: ${target}`);
}

main()
  .catch(() => {
    // Prisma errors can include query arguments: never print the raw error.
    console.error("Seed failed. Check configuration, identity conflicts and database connectivity.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
