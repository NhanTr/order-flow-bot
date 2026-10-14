import createHttpError from "http-errors";

export interface RevenueQuery {
  from: Date;
  to: Date;
  groupBy?: "hour" | "day" | "week" | "month";
}

export function parseRevenueQuery(query: any): RevenueQuery {
  const from = parseDate(query.from, startOfToday(), "start");
  const to = parseDate(query.to, endOfToday(), "end");

  if (Number.isNaN(from.getTime())) {
    throw createHttpError(400, "from must be a valid ISO date");
  }

  if (Number.isNaN(to.getTime())) {
    throw createHttpError(400, "to must be a valid ISO date");
  }

  if (from > to) {
    throw createHttpError(400, "from must be before or equal to to");
  }

  if (inclusiveCalendarDays(from, to) > 366) {
    throw createHttpError(400, "Revenue range must not exceed 366 days");
  }

  const groupBy = ["hour", "day", "week", "month"].includes(query.groupBy)
    ? query.groupBy
    : "day";

  return { from, to, groupBy };
}

function inclusiveCalendarDays(from: Date, to: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const dayNumber = (value: Date) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(value).map((part) => [part.type, part.value]),
    );
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  };
  return Math.floor((dayNumber(to) - dayNumber(from)) / 86_400_000) + 1;
}

function parseDate(value: unknown, fallback: Date, boundary: "start" | "end"): Date {
  if (!value) return fallback;
  if (typeof value !== "string") return new Date(Number.NaN);

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const time = boundary === "start" ? "00:00:00.000" : "23:59:59.999";
    return new Date(`${value}T${time}+07:00`);
  }

  return new Date(value);
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

function endOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}
