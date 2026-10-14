import {
  FulfillmentStatus,
  OrderStatusDomain,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
} from "@prisma/client";
import { seedSharedUsers } from "./shared-users.seed";

const paidAt = new Date("2026-08-04T00:00:00.000Z");

const fixtures = {
  menu: {
    activeCategory: {
      id: "00000000-0000-4000-8000-000000004101",
      name: "BE004 Drinks",
      displayOrder: 400,
      isActive: true,
    },
    inactiveCategory: {
      id: "00000000-0000-4000-8000-000000004102",
      name: "BE004 Hidden Drinks",
      displayOrder: 401,
      isActive: false,
    },
    activeItem: {
      id: "00000000-0000-4000-8000-000000004201",
      name: "BE004 Iced Latte",
      description: "Stable active item for integration tests",
      price: BigInt(45000),
      isAvailable: true,
      displayOrder: 400,
    },
    inactiveItem: {
      id: "00000000-0000-4000-8000-000000004202",
      name: "BE004 Inactive Mocha",
      description: "Stable inactive item for visibility tests",
      price: BigInt(50000),
      isAvailable: false,
      displayOrder: 401,
    },
  },
  orders: {
    queued: {
      id: "00000000-0000-4000-8000-000000004301",
      itemId: "00000000-0000-4000-8000-000000004401",
      paymentId: "00000000-0000-4000-8000-000000004501",
      orderCode: "BE004-QUEUED-001",
      paymentCode: "PAY-BE004-QUEUED-001",
      quantity: 1,
      note: "BE004 queued order for barista smoke tests",
    },
  },
} as const;

export async function seedBe004IntegrationFixtures(prisma: PrismaClient): Promise<void> {
  const { owner, serviceStaff, barista } = await seedSharedUsers(prisma);

  const activeCategory = await prisma.menuCategory.upsert({
    where: { id: fixtures.menu.activeCategory.id },
    create: fixtures.menu.activeCategory,
    update: {
      name: fixtures.menu.activeCategory.name,
      displayOrder: fixtures.menu.activeCategory.displayOrder,
      isActive: fixtures.menu.activeCategory.isActive,
    },
  });

  await prisma.menuCategory.upsert({
    where: { id: fixtures.menu.inactiveCategory.id },
    create: fixtures.menu.inactiveCategory,
    update: {
      name: fixtures.menu.inactiveCategory.name,
      displayOrder: fixtures.menu.inactiveCategory.displayOrder,
      isActive: fixtures.menu.inactiveCategory.isActive,
    },
  });

  const activeItem = await prisma.menuItem.upsert({
    where: { id: fixtures.menu.activeItem.id },
    create: {
      ...fixtures.menu.activeItem,
      categoryId: activeCategory.id,
    },
    update: {
      categoryId: activeCategory.id,
      name: fixtures.menu.activeItem.name,
      description: fixtures.menu.activeItem.description,
      price: fixtures.menu.activeItem.price,
      isAvailable: fixtures.menu.activeItem.isAvailable,
      displayOrder: fixtures.menu.activeItem.displayOrder,
    },
  });

  await prisma.menuItem.upsert({
    where: { id: fixtures.menu.inactiveItem.id },
    create: {
      ...fixtures.menu.inactiveItem,
      categoryId: activeCategory.id,
    },
    update: {
      categoryId: activeCategory.id,
      name: fixtures.menu.inactiveItem.name,
      description: fixtures.menu.inactiveItem.description,
      price: fixtures.menu.inactiveItem.price,
      isAvailable: fixtures.menu.inactiveItem.isAvailable,
      displayOrder: fixtures.menu.inactiveItem.displayOrder,
    },
  });

  const queuedTotal = activeItem.price * BigInt(fixtures.orders.queued.quantity);
  const queuedOrder = await prisma.order.upsert({
    where: { id: fixtures.orders.queued.id },
    create: {
      id: fixtures.orders.queued.id,
      orderCode: fixtures.orders.queued.orderCode,
      createdByUserId: serviceStaff.id,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PAID,
      fulfillmentStatus: FulfillmentStatus.QUEUED,
      totalAmount: queuedTotal,
      paidAt,
      customerNote: fixtures.orders.queued.note,
    },
    update: {
      orderCode: fixtures.orders.queued.orderCode,
      createdByUserId: serviceStaff.id,
      assignedBaristaId: null,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PAID,
      fulfillmentStatus: FulfillmentStatus.QUEUED,
      totalAmount: queuedTotal,
      paidAt,
      customerNote: fixtures.orders.queued.note,
      cancellationReason: null,
    },
  });

  await prisma.orderItem.upsert({
    where: { id: fixtures.orders.queued.itemId },
    create: {
      id: fixtures.orders.queued.itemId,
      orderId: queuedOrder.id,
      menuItemId: activeItem.id,
      itemName: activeItem.name,
      unitPrice: activeItem.price,
      quantity: fixtures.orders.queued.quantity,
      note: null,
    },
    update: {
      orderId: queuedOrder.id,
      menuItemId: activeItem.id,
      itemName: activeItem.name,
      unitPrice: activeItem.price,
      quantity: fixtures.orders.queued.quantity,
      note: null,
    },
  });

  await prisma.payment.upsert({
    where: { id: fixtures.orders.queued.paymentId },
    create: {
      id: fixtures.orders.queued.paymentId,
      orderId: queuedOrder.id,
      paymentCode: fixtures.orders.queued.paymentCode,
      expectedAmount: queuedTotal,
      receivedAmount: queuedTotal,
      cashConfirmedByUserId: owner.id,
      confirmedAt: paidAt,
    },
    update: {
      orderId: queuedOrder.id,
      paymentCode: fixtures.orders.queued.paymentCode,
      expectedAmount: queuedTotal,
      receivedAmount: queuedTotal,
      cashConfirmedByUserId: owner.id,
      confirmedAt: paidAt,
    },
  });

  const paymentHistory = await prisma.orderStatusHistory.findFirst({
    where: {
      orderId: queuedOrder.id,
      statusDomain: OrderStatusDomain.PAYMENT,
      newStatus: PaymentStatus.PAID,
      reason: "BE004 fixture payment status",
    },
    select: { id: true },
  });

  if (!paymentHistory) {
    await prisma.orderStatusHistory.create({
      data: {
        orderId: queuedOrder.id,
        statusDomain: OrderStatusDomain.PAYMENT,
        oldStatus: PaymentStatus.UNPAID,
        newStatus: PaymentStatus.PAID,
        changedByUserId: owner.id,
        reason: "BE004 fixture payment status",
        createdAt: paidAt,
      },
    });
  }

  const fulfillmentHistory = await prisma.orderStatusHistory.findFirst({
    where: {
      orderId: queuedOrder.id,
      statusDomain: OrderStatusDomain.FULFILLMENT,
      newStatus: FulfillmentStatus.QUEUED,
      reason: "BE004 fixture fulfillment status",
    },
    select: { id: true },
  });

  if (!fulfillmentHistory) {
    await prisma.orderStatusHistory.create({
      data: {
        orderId: queuedOrder.id,
        statusDomain: OrderStatusDomain.FULFILLMENT,
        oldStatus: FulfillmentStatus.PENDING_PAYMENT,
        newStatus: FulfillmentStatus.QUEUED,
        changedByUserId: owner.id,
        reason: "BE004 fixture fulfillment status",
        createdAt: paidAt,
      },
    });
  }

  console.info(
    {
      users: {
        ownerUsername: owner.username,
        ownerTelegramUserId: owner.telegramUserId?.toString(),
        serviceStaffTelegramUserId: serviceStaff.telegramUserId?.toString(),
        baristaTelegramUserId: barista.telegramUserId?.toString(),
      },
      menu: {
        activeCategory: fixtures.menu.activeCategory.name,
        activeItem: fixtures.menu.activeItem.name,
        inactiveCategory: fixtures.menu.inactiveCategory.name,
        inactiveItem: fixtures.menu.inactiveItem.name,
      },
      orders: {
        queuedOrderCode: fixtures.orders.queued.orderCode,
      },
    },
    "BE004 integration fixtures seed completed",
  );
}
