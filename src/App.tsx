import React, { useEffect, useState } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Holdings from './components/Holdings';
import TradeRecords from './components/TradeRecords';
import PnLAnalysis from './components/PnLAnalysis';
import FundFlows from './components/FundFlows';
import Login from './components/Login';
import { getSession, logout } from './lib/database';
import { User } from './lib/types';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSession()
      .then(setCurrentUser)
      .catch(() => setCurrentUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function handleLogout() {
    await logout();
    setCurrentUser(null);
  }

  if (loading) {
    return (
      <div className="min-h-dvh bg-[#030712] flex items-center justify-center text-[13px] text-[#94a3b8]">
        Loading...
      </div>
    );
  }

  if (!currentUser) {
    return <Login onLogin={setCurrentUser} />;
  }

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Layout currentUser={currentUser} onLogout={handleLogout} />}>
          <Route index element={<Navigate to="/holdings" replace />} />
          <Route path="holdings" element={<Holdings />} />
          <Route path="trades" element={<TradeRecords />} />
          <Route path="pnl" element={<PnLAnalysis />} />
          <Route path="funds" element={<FundFlows />} />
          <Route path="*" element={<Navigate to="/holdings" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
