import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { User } from '../lib/types';

interface LayoutProps {
  currentUser: User;
  onLogout: () => void;
}

const navItems = [
  { to: '/holdings', label: '持仓', icon: '⌁' },
  { to: '/trades', label: '交易', icon: '↻' },
  { to: '/pnl', label: '盈亏', icon: '▦' },
  { to: '/funds', label: '资金', icon: '◌' },
];

export default function Layout({ currentUser, onLogout }: LayoutProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand-block">
            <div className="brand-mark">⌁</div>
            <div>
              <strong>Stock Portfolio</strong>
              <span>Portfolio Console</span>
            </div>
          </div>

          <div className="user-panel">
            <div className="user-avatar">{(currentUser.name || currentUser.id || 'U').slice(0, 1)}</div>
            <div>
              <strong>{currentUser.name || currentUser.id}</strong>
              <span>{currentUser.role === 'operator' ? 'Operator' : 'Viewer'}</span>
            </div>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          {navItems.map(item => (
            <NavLink
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
              key={item.to}
              to={item.to}
            >
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <button className="logout-button" onClick={onLogout} type="button">
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
