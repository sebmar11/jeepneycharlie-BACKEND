CREATE TABLE IF NOT EXISTS orders (
  id            SERIAL PRIMARY KEY,
  order_number  VARCHAR(20) UNIQUE NOT NULL,
  customer_name VARCHAR(100) NOT NULL,
  customer_phone VARCHAR(20),
  items         JSONB NOT NULL,
  total         NUMERIC(10,2) NOT NULL,
  notes         TEXT,
  status        VARCHAR(20) DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
