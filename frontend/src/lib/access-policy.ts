export type WebRole = "OWNER" | "SERVICE_STAFF" | "BARISTA";

export interface NavigationItem {
  href: string;
  label: string;
  icon: string;
  ownerOnly?: boolean;
}

export const ADMIN_NAVIGATION: NavigationItem[] = [
  { href: "/dashboard", label: "Tổng quan", icon: "dashboard", ownerOnly: true },
  { href: "/orders", label: "Đơn hàng", icon: "orders" },
  { href: "/payments", label: "Thanh toán", icon: "payments", ownerOnly: true },
  { href: "/reconciliations", label: "Đối soát", icon: "reconcile", ownerOnly: true },
  { href: "/users", label: "Nhân viên", icon: "users", ownerOnly: true },
  { href: "/audit", label: "Nhật ký", icon: "audit", ownerOnly: true },
  { href: "/catalog", label: "Thực đơn", icon: "catalog", ownerOnly: true },
  { href: "/categories", label: "Danh mục", icon: "categories", ownerOnly: true },
  { href: "/reports/revenue", label: "Báo cáo doanh thu", icon: "analytics", ownerOnly: true },
];

export function visibleNavigationFor(role: WebRole): NavigationItem[] {
  if (role === "BARISTA") return [];
  return ADMIN_NAVIGATION.filter((item) => role === "OWNER" || !item.ownerOnly);
}

export function canAccessAdminPath(role: WebRole, pathname: string): boolean {
  if (pathname === "/forbidden") return true;
  if (role === "OWNER") return true;
  if (role === "BARISTA") return false;
  return pathname === "/orders" || pathname.startsWith("/orders/");
}
