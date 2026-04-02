"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/settings/notifications", label: "Notifications" },
  { href: "/dashboard/settings/apps", label: "Apps" },
] as const;

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground">Settings</h1>
      <p className="mt-2 text-muted">Manage your workspace settings.</p>

      <div className="mt-6 border-b border-border">
        <nav className="-mb-px flex gap-6">
          {TABS.map((tab) => {
            const isActive = pathname === tab.href || pathname === tab.href + "/";
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`pb-3 text-sm font-medium transition-colors ${
                  isActive
                    ? "border-b-2 border-blue-600 text-blue-600"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="mt-6">{children}</div>
    </div>
  );
}
