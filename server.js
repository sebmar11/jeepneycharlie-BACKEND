const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const db      = require('./db');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Screenshot storage ────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${req.params.orderNumber}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Helpers ───────────────────────────────────────────────────────────────────
function genOrderNumber() {
  const digits = Math.floor(10000 + Math.random() * 90000);
  return `JC-${digits}`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /orders - submit a new order from the menu site
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

// GET /orders - fetch all orders for the dashboard (newest first)
app.get('/orders', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
    // Expose screenshot_path as screenshot_url
    const rows = result.rows.map(o => ({ ...o, screenshot_url: o.screenshot_path || null }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders.' });
  }
});

// GET /orders/:orderNumber - fetch a single order (for the receipt page)
app.get('/orders/:orderNumber', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM orders WHERE order_number=$1',
      [req.params.orderNumber]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });
    const o = result.rows[0];
    res.json({ ...o, screenshot_url: o.screenshot_path || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order.' });
  }
});

// PATCH /orders/:orderNumber/status - staff updates order status from the dashboard
app.patch('/orders/:orderNumber/status', async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'preparing', 'ready', 'done', 'awaiting_verification'];
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

// POST /orders/:orderNumber/screenshot - customer uploads GCash screenshot
app.post('/orders/:orderNumber/screenshot', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const screenshotUrl = `/uploads/${req.file.filename}`;
  try {
    // Delete old screenshot file if one exists
    const existing = await db.query('SELECT screenshot_path FROM orders WHERE order_number=$1', [req.params.orderNumber]);
    if (existing.rows[0]?.screenshot_path) {
      const oldFile = path.join(UPLOADS_DIR, path.basename(existing.rows[0].screenshot_path));
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    }
    const result = await db.query(
      `UPDATE orders SET screenshot_path=$1, payment_status='pending_verification', status='awaiting_verification'
       WHERE order_number=$2 RETURNING *`,
      [screenshotUrl, req.params.orderNumber]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });
    // Return order with screenshot_url field for frontend
    const order = result.rows[0];
    res.json({ ...order, screenshot_url: screenshotUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save screenshot.' });
  }
});

// PATCH /orders/:orderNumber/approve-payment - staff approves GCash payment
app.patch('/orders/:orderNumber/approve-payment', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE orders SET payment_status='approved', status='pending'
       WHERE order_number=$1 RETURNING *`,
      [req.params.orderNumber]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });
    const order = result.rows[0];
    res.json({ ...order, screenshot_url: order.screenshot_path || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve payment.' });
  }
});

// PATCH /orders/:orderNumber/reject-payment - staff rejects GCash screenshot
app.patch('/orders/:orderNumber/reject-payment', async (req, res) => {
  try {
    // Delete the bad screenshot
    const existing = await db.query('SELECT screenshot_path FROM orders WHERE order_number=$1', [req.params.orderNumber]);
    if (existing.rows[0]?.screenshot_path) {
      const oldFile = path.join(UPLOADS_DIR, path.basename(existing.rows[0].screenshot_path));
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    }
    const result = await db.query(
      `UPDATE orders SET payment_status='rejected', screenshot_path=NULL, status='awaiting_verification'
       WHERE order_number=$1 RETURNING *`,
      [req.params.orderNumber]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject payment.' });
  }
});

// GET /orders/:orderNumber/download-screenshot - downloads screenshot then deletes it (called on Mark Done)
app.get('/orders/:orderNumber/download-screenshot', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM orders WHERE order_number=$1', [req.params.orderNumber]);
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });
    const order = result.rows[0];
    if (!order.screenshot_path) return res.status(404).json({ error: 'No screenshot.' });

    const filePath = path.join(UPLOADS_DIR, path.basename(order.screenshot_path));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });

    const name = order.customer_name.replace(/\s+/g, '_');
    const ext  = path.extname(filePath) || '.jpg';
    const downloadName = `${name}_GCash_Payment${ext}`;

    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Type', 'image/jpeg');

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', async () => {
      // Delete file and clear path from DB after download
      try {
        fs.unlinkSync(filePath);
        await db.query('UPDATE orders SET screenshot_path=NULL WHERE order_number=$1', [order.order_number]);
      } catch(e) { console.error('Cleanup error:', e); }
    });
  } catch (err) {
    res.status(500).json({ error: 'Download failed.' });
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
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS screenshot_path TEXT;
    `);
    console.log('✓ Database ready');
    app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
