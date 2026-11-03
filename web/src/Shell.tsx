import { useEffect, useState } from "react";
import {
  Activity,
  LayoutDashboard,
  LogOut,
  Menu,
  ReceiptText,
  RefreshCw,
  ServerCog,
  Users,
  X,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "./api";
import { useBodyLock, useClock } from "./hooks";
import type { Admin } from "./types";
import { Avatar, LiveBadge, Mark, useToast } from "./ui";

const NAV = [
  {
    to: "/",
    label: "Overview",
    icon: LayoutDashboard,
    end: true,
    hint: "Money at a glance",
  },
  {
    to: "/donations",
    label: "Donations",
    icon: ReceiptText,
    hint: "Every checkout",
  },
  {
    to: "/donors",
    label: "Supporters",
    icon: Users,
    hint: "Lifetime value",
  },
  {
    to: "/system",
    label: "System",
    icon: ServerCog,
    hint: "Health & access",
  },
];

export function Shell({ admin }: { admin: Admin }) {
  const location = useLocation();
  const clock = useClock();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  useBodyLock(open);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const current =
    NAV.find((item) =>
      item.end ? location.pathname === "/" : location.pathname.startsWith(item.to),
    ) ?? NAV[0];

  const reconcile = async () => {
    setReconciling(true);
    try {
      await api("/admin/api/reconcile", { method: "POST" });
      toast(
        "info",
        "Reconciliation started",
        "Pending checkouts are being verified in the background.",
      );
      window.setTimeout(() => setReconciling(false), 1200);
    } catch (error) {
      toast(
        "error",
        "Could not start reconciliation",
        error instanceof Error ? error.message : undefined,
      );
      setReconciling(false);
    }
  };

  const logout = async () => {
    try {
      await api("/admin/auth/logout", { method: "POST" });
    } catch {
      /* clear the cookie server-side even if the request is flaky */
    }
    window.location.assign("/admin");
  };

  return (
    <div className={`shell ${open ? "nav-open" : ""}`}>
      <button
        type="button"
        className="nav-scrim"
        aria-label="Close navigation"
        onClick={() => setOpen(false)}
      />

      <aside className="sidebar">
        <div className="sidebar-top">
          <NavLink to="/" className="brand" aria-label="Dashboard home">
            <Mark size={34} />
            <span className="brand-text">
              <strong>donate to me</strong>
              <small>control room</small>
            </span>
          </NavLink>
          <button
            type="button"
            className="icon-btn sidebar-close"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
          >
            <X size={17} />
          </button>
        </div>

        <nav className="nav" aria-label="Dashboard">
          <p className="nav-label">Workspace</p>
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `nav-item ${isActive ? "is-active" : ""}`
                }
                title={item.hint}
              >
                <Icon size={18} strokeWidth={1.7} />
                <span className="nav-text">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-pulse">
            <Activity size={14} />
            <span>
              Auto-refreshing
              <small>as you browse</small>
            </span>
          </div>
          <div className="admin-card">
            <Avatar
              name={admin.name}
              picture={admin.picture}
              size={34}
            />
            <div className="admin-identity">
              <strong>{admin.name}</strong>
              <span>
                {admin.username ? `@${admin.username}` : `id ${admin.id}`}
              </span>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="icon-btn menu-btn"
              onClick={() => setOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={18} />
            </button>
            <div className="breadcrumb">
              <span>Control room</span>
              <i>/</i>
              <strong>{current.label}</strong>
            </div>
          </div>

          <div className="topbar-right">
            <LiveBadge />
            <span className="clock">
              {clock}
              <small>EAT</small>
            </span>
            <button
              type="button"
              className="btn btn-reconcile"
              onClick={reconcile}
              disabled={reconciling}
            >
              <RefreshCw
                size={15}
                className={reconciling ? "spin" : ""}
              />
              <span className="reconcile-text">Reconcile</span>
            </button>
          </div>
        </header>

        <main className="main">
          <div className="page-wrap">
            <div className="route-fade" key={location.pathname}>
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
