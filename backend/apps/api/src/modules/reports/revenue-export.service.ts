import type { PrismaClient } from "@prisma/client";
import createHttpError from "http-errors";
import ExcelJS from "exceljs";
import { prisma } from "../../db";
import { createAccountingWorkbook as createControlWorkbook, loadAccountingExportData } from "./accounting-workbook";
import { RevenueReportService, type RevenueReportInput } from "./revenue.service";
import type { RevenueExportInput } from "./revenue-export.validation";

export interface RevenueExportResult {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

interface AccountingEntry {
  date: Date;
  reference: string;
  description: string;
  paymentMethod: "CASH" | "QR";
  debitAccount: string;
  creditAccount: string;
  amount: bigint;
  netRevenue: bigint;
}

interface RevenueReportPort {
  getRevenueReport(input: RevenueReportInput): Promise<Awaited<ReturnType<RevenueReportService["getRevenueReport"]>>>;
}

export class RevenueExportService {
  constructor(
    private readonly db: PrismaClient = prisma,
    private readonly revenueReportService: RevenueReportPort = new RevenueReportService(db),
  ) {}

  public async export(input: RevenueExportInput): Promise<RevenueExportResult> {
    const range = { from: input.from, to: input.to };
    const orderCount = await this.db.order.count({
      where: {
        OR: [
          { createdAt: { gte: input.from, lte: input.to } },
          { paidAt: { gte: input.from, lte: input.to } },
        ],
      },
    });
    if (orderCount > 10_000) {
      throw createHttpError(413, "Revenue export exceeds the 10000-order limit");
    }
    const report = await this.revenueReportService.getRevenueReport(range);
    const period = `${localDateKey(input.from)}_${localDateKey(input.to)}`;

    const data = await loadAccountingExportData(this.db, range);
    return {
      buffer: await createControlWorkbook(report, data),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: `so-doanh-thu-${period}.xlsx`,
    };
  }

}

/** @deprecated Kept temporarily for backwards-compatible internal imports. */
export async function createLegacyAccountingWorkbook(
  report: Awaited<ReturnType<RevenueReportService["getRevenueReport"]>>,
  entries: AccountingEntry[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Order Flow";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  const summary = workbook.addWorksheet("Tổng hợp", { views: [{ state: "frozen", ySplit: 5 }] });
  summary.properties.defaultRowHeight = 20;
  summary.mergeCells("A1:F1");
  summary.getCell("A1").value = "BÁO CÁO DOANH THU VÀ ĐỐI CHIẾU KẾ TOÁN";
  summary.getCell("A2").value = "Kỳ báo cáo";
  summary.getCell("B2").value = `${formatDate(report.range.from)} - ${formatDate(report.range.to)}`;
  summary.getCell("A3").value = "Đơn vị tiền";
  summary.getCell("B3").value = "VND";
  summary.addRow([]);
  summary.addRow(["Chỉ tiêu", "Tiền mặt", "QR/Ngân hàng", "Hoàn tiền", "Doanh thu gộp", "Doanh thu thuần"]);
  summary.addRow([
    "Số tiền",
    Number(report.byMethod.CASH.amount),
    Number(report.byMethod.QR.amount),
    Number(report.summary.refundedAmount),
    Number(report.summary.grossRevenue),
    Number(report.summary.netRevenue),
  ]);
  summary.addRow([
    "Số chứng từ",
    report.byMethod.CASH.count,
    report.byMethod.QR.count,
    report.summary.refundCount,
    report.summary.paidOrderCount,
    report.summary.paidOrderCount - report.summary.refundCount,
  ]);
  summary.addRow([]);
  summary.mergeCells("A9:F9");
  summary.getCell("A9").value =
    "Phạm vi: số liệu bán hàng và hoàn tiền trong Order Flow; chưa bao gồm VAT, hóa đơn đầu vào và chi phí vì hệ thống chưa lưu các dữ liệu này.";

  const journal = workbook.addWorksheet("Nhật ký doanh thu", { views: [{ state: "frozen", ySplit: 4 }] });
  journal.mergeCells("A1:J1");
  journal.getCell("A1").value = "NHẬT KÝ DOANH THU";
  journal.mergeCells("A2:J2");
  journal.getCell("A2").value = `Từ ${formatDate(report.range.from)} đến ${formatDate(report.range.to)} - Đơn vị: VND`;
  journal.addRow([
    "STT",
    "Ngày hạch toán",
    "Số chứng từ",
    "Diễn giải",
    "Phương thức",
    "TK Nợ",
    "TK Có",
    "Số tiền",
    "Điều chỉnh giảm",
    "Doanh thu thuần",
  ]);
  entries.forEach((entry, index) => {
    const isRefund = entry.netRevenue < 0n;
    journal.addRow([
      index + 1,
      entry.date,
      entry.reference,
      entry.description,
      entry.paymentMethod,
      entry.debitAccount,
      entry.creditAccount,
      Number(isRefund ? 0n : entry.amount),
      Number(isRefund ? entry.amount : 0n),
      Number(entry.netRevenue),
    ]);
  });
  const journalTotalRow = Math.max(5, journal.rowCount + 1);
  journal.getCell(`G${journalTotalRow}`).value = "CỘNG";
  for (const column of ["H", "I", "J"] as const) {
    const values = entries.reduce((sum, entry) => {
      if (column === "H") return sum + (entry.netRevenue >= 0n ? entry.amount : 0n);
      if (column === "I") return sum + (entry.netRevenue < 0n ? entry.amount : 0n);
      return sum + entry.netRevenue;
    }, 0n);
    journal.getCell(`${column}${journalTotalRow}`).value = {
      formula: `SUM(${column}4:${column}${journalTotalRow - 1})`,
      result: Number(values),
    };
  }

  const daily = workbook.addWorksheet("Tổng hợp ngày", { views: [{ state: "frozen", ySplit: 4 }] });
  daily.mergeCells("A1:H1");
  daily.getCell("A1").value = "BẢNG TỔNG HỢP DOANH THU THEO NGÀY";
  daily.mergeCells("A2:H2");
  daily.getCell("A2").value = `Từ ${formatDate(report.range.from)} đến ${formatDate(report.range.to)} - Đơn vị: VND`;
  daily.addRow(["STT", "Ngày", "Tiền mặt", "QR/Ngân hàng", "Doanh thu gộp", "Hoàn tiền", "Doanh thu thuần", "Số đơn"]);
  report.byTime.forEach((item, index) => {
    daily.addRow([
      index + 1,
      new Date(`${item.time}T00:00:00+07:00`),
      Number(item.cashAmount),
      Number(item.qrAmount),
      Number(item.grossRevenue),
      Number(item.refundedAmount),
      Number(item.netRevenue),
      item.orderCount,
    ]);
  });
  const dailyTotalRow = daily.rowCount + 1;
  daily.getCell(`B${dailyTotalRow}`).value = "CỘNG";
  for (const column of ["C", "D", "E", "F", "G", "H"] as const) {
    daily.getCell(`${column}${dailyTotalRow}`).value = {
      formula: `SUM(${column}4:${column}${dailyTotalRow - 1})`,
      result:
        column === "C" ? Number(report.byMethod.CASH.amount) :
        column === "D" ? Number(report.byMethod.QR.amount) :
        column === "E" ? Number(report.summary.grossRevenue) :
        column === "F" ? Number(report.summary.refundedAmount) :
        column === "G" ? Number(report.summary.netRevenue) :
        report.summary.paidOrderCount,
    };
  }

  styleWorkbook(summary, 5, [2, 3, 4, 5, 6]);
  styleWorkbook(journal, 3, [8, 9, 10]);
  styleWorkbook(daily, 3, [3, 4, 5, 6, 7]);
  journal.getColumn(2).numFmt = "dd/mm/yyyy";
  daily.getColumn(2).numFmt = "dd/mm/yyyy";
  summary.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  journal.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  daily.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function styleWorkbook(
  sheet: ExcelJS.Worksheet,
  headerRow: number,
  moneyColumns: number[],
): void {
  sheet.getCell("A1").font = { name: "Arial", size: 15, bold: true, color: { argb: "FF173F35" } };
  sheet.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(1).height = 28;
  sheet.getRow(headerRow).eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF173F35" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FF173F35" } } };
  });
  sheet.getRow(headerRow).height = 34;
  sheet.eachRow((row, rowNumber) => {
    row.font = rowNumber === headerRow ? row.font : { name: "Arial", size: 10 };
    row.alignment = { vertical: "middle", wrapText: true };
  });
  moneyColumns.forEach((column) => {
    sheet.getColumn(column).numFmt = "#,##0;[Red](#,##0);-";
    sheet.getColumn(column).alignment = { horizontal: "right", vertical: "middle" };
  });
  sheet.columns.forEach((column, index) => {
    const widths = [7, 14, 18, 46, 16, 10, 10, 18, 18, 18];
    column.width = widths[index] ?? 16;
  });
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
}

function formatDate(value: string | Date): string {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));
}

function localDateKey(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(value);
}
