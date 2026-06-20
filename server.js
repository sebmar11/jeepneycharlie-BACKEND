const express = require('express');
const cors    = require('cors');
const path    = require('path');
const db      = require('./db');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────
function genOrderNumber() {
  const digits = Math.floor(10000 + Math.random() * 90000);
  return `JC-${digits}`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /orders — submit a new order from the menu site
app.post('/orders', async (req, res) => {
  const { customer_name, customer_phone, items, total, notes, payment_method, payment_status } = req.body;
  if (!customer_name || !items || !total) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  let order_number;
  let attempts = 0;
  while (attempts < 5) {
    order_number = genOrderNumber();
    const exists = await db.query('SELECT 1 FROM orders WHERE order_number=$1', [order_number]);
    if (!exists.rows.length) break;
    attempts++;
  }
  try {
    const result = await db.query(
      `INSERT INTO orders (order_number, customer_name, customer_phone, items, total, notes, payment_method, payment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [order_number, customer_name, customer_phone||null, JSON.stringify(items), total, notes||null,
       payment_method||'cash', payment_status||'pending_pickup']
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save order.' });
  }
});

// GET /orders — fetch all orders for the dashboard (newest first)
app.get('/orders', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders.' });
  }
});

// GET /orders/:orderNumber — fetch a single order (for the receipt page)
app.get('/orders/:orderNumber', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM orders WHERE order_number=$1',
      [req.params.orderNumber]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order.' });
  }
});

// PATCH /orders/:orderNumber/status — staff updates order status from the dashboard
app.patch('/orders/:orderNumber/status', async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'preparing', 'ready', 'done'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    const result = await db.query(
      'UPDATE orders SET status=$1 WHERE order_number=$2 RETURNING *',
      [status, req.params.orderNumber]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

// ── Catch-all: serve dashboard for /dashboard route ───────────────────────────
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/receipt', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'receipt.html'));
});

// ── Init DB and start server ──────────────────────────────────────────────────
async function start() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id            SERIAL PRIMARY KEY,
        order_number  VARCHAR(20) UNIQUE NOT NULL,
        customer_name VARCHAR(100) NOT NULL,
        customer_phone VARCHAR(20),
        items         JSONB NOT NULL,
        total         NUMERIC(10,2) NOT NULL,
        notes         TEXT,
        status        VARCHAR(20) DEFAULT 'pending',
        payment_method VARCHAR(30) DEFAULT 'cash',
        payment_status VARCHAR(30) DEFAULT 'pending_pickup',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30) DEFAULT 'cash';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'pending_pickup';
    `);
    console.log('✓ Database ready');
    app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
