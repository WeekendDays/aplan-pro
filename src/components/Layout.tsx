import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { User } from '../lib/types';

interface LayoutProps {
  currentUser: User;
  onLogout: () => void;
}

const navItems: Array<{ to: string; label: string; icon: string }> = [
  { to: '/holdings', label: '持仓', icon: '▣' },
  { to: '/trades', label: '交易', icon: '⇄' },
  { to: '/pnl', label: '分析', icon: '↗' },
  { to: '/funds', label: '资金', icon: '$' },
];

export default function Layout({ currentUser, onLogout }: LayoutProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand-block">
            <div className="brand-logo" aria-hidden="true" />
            <div className="brand-text-lockup">
              <span className="brand-wordmark" role="img" aria-label="Aplan" />
            </div>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          {navItems.map(item => (
            <NavLink
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
              key={item.label}
              to={item.to}
            >
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <button
          className="logout-button"
          onClick={onLogout}
          title={`退出 ${currentUser.name || currentUser.id}`}
          type="button"
        >
          <span>↪</span>
          退出登录
        </button>
      </aside>

      <div className="main-shell">
        <main className="content-area">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
