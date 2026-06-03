/*
  # 股票投资管理系统数据库设计

  1. 新建表
    - `users` - 用户表（含角色权限：operator=交易操作员，viewer=查看者）
      - `id` (text, primary key)
      - `name` (text)
      - `avatar` (text)
      - `department` (text)
      - `role` (text, 默认 viewer)
      - `created_at` (timestamp)
    - `trades` - 交易记录表
      - `id` (uuid, primary key)
      - `stock_code` (text, 股票代码)
      - `stock_name` (text, 股票名称)
      - `trade_type` (text, buy/sell)
      - `quantity` (integer, 数量)
      - `price` (numeric, 成交价格)
      - `trade_time` (timestamp, 交易时间)
      - `note` (text, 备注)
      - `created_by` (text, references users.id)
      - `created_at` (timestamp)
    - `holdings` - 持仓表
      - `id` (uuid, primary key)
      - `stock_code` (text, 股票代码)
      - `stock_name` (text, 股票名称)
      - `quantity` (integer, 持仓数量)
      - `cost_price` (numeric, 成本价)
      - `total_cost` (numeric, 总成本)
      - `current_price` (numeric, 当前价格)
      - `updated_at` (timestamp)
      - `created_at` (timestamp)
    - `fund_flows` - 资金流水表
      - `id` (uuid, primary key)
      - `flow_type` (text, deposit/withdraw)
      - `amount` (numeric, 金额)
      - `balance_after` (numeric, 操作后余额)
      - `note` (text, 备注)
      - `flow_date` (date, 操作日期)
      - `created_by` (text, references users.id)
      - `created_at` (timestamp)
  2. 安全
    - 所有表启用 RLS
    - 所有已认证用户可读取数据
    - 仅操作员(operator)可插入/更新交易和持仓
*/

-- Users table
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  department TEXT,
  role TEXT DEFAULT 'viewer',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = 'users'
          AND c.relkind = 'r'
          AND NOT c.relrowsecurity
    ) THEN
        ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    END IF;
END
$$;

DROP POLICY IF EXISTS "Users can read all users" ON users;
CREATE POLICY "Users can read all users" ON users
    FOR SELECT USING(true);

DROP POLICY IF EXISTS "Users can update own profile" ON users;
CREATE POLICY "Users can update own profile" ON users
    FOR UPDATE USING(auth.uid() = id);

DROP POLICY IF EXISTS "Users can insert own profile" ON users;
CREATE POLICY "Users can insert own profile" ON users
    FOR INSERT WITH CHECK(auth.uid() = id);

DROP POLICY IF EXISTS "Users can delete own profile" ON users;
CREATE POLICY "Users can delete own profile" ON users
    FOR DELETE USING(auth.uid() = id);

CREATE OR REPLACE FUNCTION sync_user_info()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO users(id, name, avatar, department)
  VALUES(
    auth.uid(),
    auth.name(),
    auth.avatar(),
    auth.department()
  )
  ON CONFLICT(id) DO UPDATE
  SET
    name = auth.name(),
    avatar = auth.avatar(),
    department = auth.department();
END;
$$;

-- Trades table
CREATE TABLE IF NOT EXISTS trades(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_code TEXT NOT NULL,
  stock_name TEXT NOT NULL DEFAULT '',
  trade_type TEXT NOT NULL CHECK(trade_type IN ('buy', 'sell')),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  price NUMERIC(12, 4) NOT NULL CHECK(price > 0),
  trade_time TIMESTAMP WITH TIME ZONE NOT NULL,
  note TEXT DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = 'trades'
          AND c.relkind = 'r'
          AND NOT c.relrowsecurity
    ) THEN
        ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
    END IF;
END
$$;

DROP POLICY IF EXISTS "All users can read trades" ON trades;
CREATE POLICY "All users can read trades" ON trades
    FOR SELECT USING(true);

DROP POLICY IF EXISTS "Operators can insert trades" ON trades;
CREATE POLICY "Operators can insert trades" ON trades
    FOR INSERT WITH CHECK(
      EXISTS(SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')
    );

DROP POLICY IF EXISTS "Operators can update trades" ON trades;
CREATE POLICY "Operators can update trades" ON trades
    FOR UPDATE USING(
      EXISTS(SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')
    );

-- Holdings table
CREATE TABLE IF NOT EXISTS holdings(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_code TEXT NOT NULL UNIQUE,
  stock_name TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0,
  cost_price NUMERIC(12, 4) NOT NULL DEFAULT 0,
  total_cost NUMERIC(14, 4) NOT NULL DEFAULT 0,
  current_price NUMERIC(12, 4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = 'holdings'
          AND c.relkind = 'r'
          AND NOT c.relrowsecurity
    ) THEN
        ALTER TABLE holdings ENABLE ROW LEVEL SECURITY;
    END IF;
END
$$;

DROP POLICY IF EXISTS "All users can read holdings" ON holdings;
CREATE POLICY "All users can read holdings" ON holdings
    FOR SELECT USING(true);

DROP POLICY IF EXISTS "Operators can insert holdings" ON holdings;
CREATE POLICY "Operators can insert holdings" ON holdings
    FOR INSERT WITH CHECK(
      EXISTS(SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')
    );

DROP POLICY IF EXISTS "Operators can update holdings" ON holdings;
CREATE POLICY "Operators can update holdings" ON holdings
    FOR UPDATE USING(
      EXISTS(SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')
    );

-- Fund flows table
CREATE TABLE IF NOT EXISTS fund_flows(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_type TEXT NOT NULL CHECK(flow_type IN ('deposit', 'withdraw')),
  amount NUMERIC(14, 2) NOT NULL CHECK(amount > 0),
  balance_after NUMERIC(14, 2) NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  flow_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = 'fund_flows'
          AND c.relkind = 'r'
          AND NOT c.relrowsecurity
    ) THEN
        ALTER TABLE fund_flows ENABLE ROW LEVEL SECURITY;
    END IF;
END
$$;

DROP POLICY IF EXISTS "All users can read fund_flows" ON fund_flows;
CREATE POLICY "All users can read fund_flows" ON fund_flows
    FOR SELECT USING(true);

DROP POLICY IF EXISTS "Operators can insert fund_flows" ON fund_flows;
CREATE POLICY "Operators can insert fund_flows" ON fund_flows
    FOR INSERT WITH CHECK(
      EXISTS(SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')
    );

DROP POLICY IF EXISTS "Operators can update fund_flows" ON fund_flows;
CREATE POLICY "Operators can update fund_flows" ON fund_flows
    FOR UPDATE USING(
      EXISTS(SELECT 1 FROM users WHERE id = auth.uid() AND role = 'operator')
    );
