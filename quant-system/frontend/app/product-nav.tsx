"use client";

import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { BarChart3, Bot, BrainCircuit, BriefcaseBusiness, ClipboardList, Database, LayoutDashboard, LineChart, Settings, ShieldCheck, Sparkles, WalletCards } from "lucide-react";

const nav = [
  { href: "/", label: "工作台", icon: LayoutDashboard },
  { href: "/recommendations", label: "推荐股票", icon: Sparkles },
  { href: "/research", label: "研究中心", icon: BrainCircuit },
  { href: "/strategies", label: "策略中心", icon: ClipboardList },
  { href: "/backtests", label: "回测中心", icon: BarChart3 },
  { href: "/paper", label: "Paper Trading", icon: WalletCards },
  { href: "/reviews", label: "复盘中心", icon: LineChart },
  { href: "/knowledge", label: "知识库", icon: Database },
  { href: "/agent-gateway", label: "Agent Gateway", icon: Bot },
  { href: "/settings", label: "系统设置", icon: Settings },
];

export function ProductNav({ userName }: { userName: string }) {
  const pathname = usePathname();

  return (
    <aside className="productNav">
      <div className="productBrand">
        <BriefcaseBusiness size={20} />
        <div>
          <strong>QuantOS</strong>
          <span>Research + Execution</span>
        </div>
      </div>
      <nav>
        {nav.map((item) => {
          const Icon = item.icon;
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link aria-current={active ? "page" : undefined} className={`productNavItem ${active ? "active" : ""}`} href={item.href} key={item.href}>
              <Icon size={16} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="productUserBox">
        <div>
          <ShieldCheck size={15} />
          <span>{userName}</span>
        </div>
        <UserButton />
      </div>
    </aside>
  );
}
