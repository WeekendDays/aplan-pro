import React, { FormEvent, useState } from 'react';
import { login } from '../lib/database';
import { User } from '../lib/types';

interface LoginProps {
  onLogin: (user: User) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [username, setUsername] = useState('operator');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const user = await login(username.trim(), password);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-label="登录">
        <div>
          <p className="eyebrow">Aplan Portfolio</p>
          <h1>投资组合工作台</h1>
          <p className="muted">登录后查看持仓、交易记录、资金流水和盈亏表现。</p>
        </div>

        <form className="form-stack" onSubmit={handleSubmit}>
          <label>
            <span>账号</span>
            <input
              autoComplete="username"
              value={username}
              onChange={event => setUsername(event.target.value)}
              placeholder="operator"
            />
          </label>

          <label>
            <span>密码</span>
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="开发环境默认 operator123"
            />
          </label>

          {error && <div className="alert error">{error}</div>}

          <button className="primary-button" disabled={submitting} type="submit">
            {submitting ? '登录中...' : '登录'}
          </button>
        </form>
      </section>
    </main>
  );
}
