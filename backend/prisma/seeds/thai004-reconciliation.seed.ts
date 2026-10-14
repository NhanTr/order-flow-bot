import { seedSharedUsers } from "./shared-users.seed";
import {
  FulfillmentStatus,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
} from "@prisma/client";

const ORDERS = [
  {
    key: "UNDER",
    orderCode: "THAI004-UNDER-001",
    paymentCode: "PAY-THAI004-UNDER-001",
    itemName: "THAI004 Underpaid Tea",
    price: BigInt(60000),
    quantity: 2,
    fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT,
    sampleTransactionId: "94004001",
    sampleAmount: "100000",
  },
  {
    key: "OVER",
    orderCode: "THAI004-OVER-001",
    paymentCode: "PAY-THAI004-OVER-001",
    itemName: "THAI004 Overpaid Coffee",
    price: BigInt(60000),
    quantity: 2,
    fulfillmentStatus: FulfillmentStatus.PENDING_PAYMENT,
    sampleTransactionId: "94004002",
    sampleAmount: "150000",
  },
  {
    key: "CANCELLED",
    orderCode: "THAI004-CANCELLED-001",
    paymentCode: "PAY-THAI004-CANCELLED-001",
    itemName: "THAI004 Cancelled Latte",
    price: BigInt(60000),
    quantity: 2,
    fulfillmentStatus: FulfillmentStatus.CANCELLED,
    sampleTransactionId: "94004003",
    sampleAmount: "120000",
  },
];

export async function seedThai004Reconciliation(prisma: PrismaClient) {
  const { owner, serviceStaff } = await seedSharedUsers(prisma);

  const category = await prisma.menuCategory.upsert({
    where: { name: "THAI004 Reconciliation Drinks" },
    update: { displayOrder: 4, isActive: true },
    create: {
      name: "THAI004 Reconciliation Drinks",
      displayOrder: 4,
      isActive: true,
    },
  });

  const output = [];

  for (const spec of ORDERS) {
    const existingItem = await prisma.menuItem.findFirst({
      where: { categoryId: category.id, name: spec.itemName },
    });

    const menuItem = existingItem
      ? await prisma.menuItem.update({
          where: { id: existingItem.id },
          data: {
            description: `Seed item for THAI-004 ${spec.key} reconciliation`,
            price: spec.price,
            isAvailable: true,
            displayOrder: 4,
          },
        })
      : await prisma.menuItem.create({
          data: {
            categoryId: category.id,
            name: spec.itemName,
            description: `Seed item for THAI-004 ${spec.key} reconciliation`,
            price: spec.price,
            isAvailable: true,
            displayOrder: 4,
          },
        });

    const totalAmount = menuItem.price * BigInt(spec.quantity);

    const order = await prisma.order.upsert({
      where: { orderCode: spec.orderCode },
      update: {
        createdByUserId: serviceStaff.id,
        assignedBaristaId: null,
        paymentMethod: PaymentMethod.QR,
        paymentStatus: PaymentStatus.PENDING,
        fulfillmentStatus: spec.fulfillmentStatus,
        totalAmount,
        customerNote: `THAI004 ${spec.key} reconciliation test order`,
        cancellationReason:
          spec.fulfillmentStatus === FulfillmentStatus.CANCELLED
            ? "THAI004 cancelled-order payment review seed"
            : null,
        paidAt: null,
      },
      create: {
        orderCode: spec.orderCode,
        createdByUserId: serviceStaff.id,
        paymentMethod: PaymentMethod.QR,
        paymentStatus: PaymentStatus.PENDING,
        fulfillmentStatus: spec.fulfillmentStatus,
        totalAmount,
        customerNote: `THAI004 ${spec.key} reconciliation test order`,
        cancellationReason:
          spec.fulfillmentStatus === FulfillmentStatus.CANCELLED
            ? "THAI004 cancelled-order payment review seed"
            : null,
      },
    });

    const existingOrderItem = await prisma.orderItem.findFirst({
      where: { orderId: order.id, menuItemId: menuItem.id },
    });

    if (existingOrderItem) {
      await prisma.orderItem.update({
        where: { id: existingOrderItem.id },
        data: {
          itemName: menuItem.name,
          unitPrice: menuItem.price,
          quantity: spec.quantity,
          note: `THAI004 ${spec.key} seed item`,
        },
      });
    } else {
      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          menuItemId: menuItem.id,
          itemName: menuItem.name,
          unitPrice: menuItem.price,
          quantity: spec.quantity,
          note: `THAI004 ${spec.key} seed item`,
        },
      });
    }

    await prisma.payment.upsert({
      where: { orderId: order.id },
      update: {
        paymentCode: spec.paymentCode,
        expectedAmount: totalAmount,
        receivedAmount: BigInt(0),
        cashConfirmedByUserId: null,
        confirmedAt: null,
      },
      create: {
        orderId: order.id,
        paymentCode: spec.paymentCode,
        expectedAmount: totalAmount,
        receivedAmount: BigInt(0),
      },
    });

    output.push({
      case: spec.key,
      orderId: order.id,
      orderCode: order.orderCode,
      paymentCode: spec.paymentCode,
      expectedAmount: totalAmount.toString(),
      sampleSepayTransactionId: spec.sampleTransactionId,
      sampleAmount: spec.sampleAmount,
    });
  }

  console.log("Seeded THAI-004 reconciliation data");
  console.log({
    ownerId: owner.id,
    serviceStaffId: serviceStaff.id,
    cases: output,
    wrongCodeSample: {
      sampleSepayTransactionId: "94004004",
      code: "PAY-THAI004-WRONG-001",
      amountIn: "120000",
    },
  });
}
