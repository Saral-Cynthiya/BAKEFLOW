const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const app = express();

/* ---------- Database ---------- */
const db = new DatabaseSync(path.join(__dirname, "bakeflow.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer TEXT NOT NULL,
    item TEXT NOT NULL,
    qty INTEGER NOT NULL,
    due TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'New',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    qty INTEGER NOT NULL,
    unit TEXT NOT NULL,
    min INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const FLOW = ["New", "Baking", "Ready", "Out for delivery", "Delivered"];

const dayOffset = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

function tx(fn) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function seed() {
  const insertOrder = db.prepare("INSERT INTO orders (customer, item, qty, due, status) VALUES (?, ?, ?, ?, ?)");
  const insertStock = db.prepare("INSERT INTO stock (name, qty, unit, min) VALUES (?, ?, ?, ?)");
  insertOrder.run("Priya", "Red velvet cupcakes", 12, dayOffset(1), "Baking");
  insertOrder.run("Arun", "Black forest cake", 1, dayOffset(0), "Ready");
  insertOrder.run("Meena", "Butter cookies", 30, dayOffset(2), "New");
  insertOrder.run("Priya", "Chocolate brownies", 8, dayOffset(-1), "Delivered");
  insertStock.run("Flour", 18, "kg", 8);
  insertStock.run("Butter", 3, "kg", 5);
  insertStock.run("Sugar", 9, "kg", 4);
  insertStock.run("Cocoa powder", 2, "kg", 2);
}

const countOf = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
if (countOf("orders") === 0 && countOf("stock") === 0) tx(seed);

/* ---------- Helpers ---------- */
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const bad = (res, msg) => res.status(400).json({ error: msg });

/* ---------- Middleware ---------- */
app.use(express.json({ limit: "10kb" }));

// Serve the logo from the project root even though it sits outside /public
app.get("/logo.jpeg", (req, res, next) => {
  const candidates = [
    path.join(PUBLIC_DIR, "logo.jpeg"),
    path.join(__dirname, "bakeflow logo.jpeg"),
    path.join(__dirname, "logo.jpeg")
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  return file ? res.sendFile(file) : next();
});

app.use(express.static(PUBLIC_DIR));

/* ---------- Orders ---------- */
app.get("/api/orders", (req, res) => {
  res.json(db.prepare("SELECT * FROM orders ORDER BY due ASC, id ASC").all());
});

app.post("/api/orders", (req, res) => {
  const customer = clean(req.body.customer, 40);
  const item = clean(req.body.item, 40);
  const qty = Number(req.body.qty);
  const due = clean(req.body.due, 10);

  if (!customer) return bad(res, "Enter the customer's name.");
  if (!item) return bad(res, "Enter what was ordered.");
  if (!isInt(qty, 1, 500)) return bad(res, "Quantity must be a whole number from 1 to 500.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return bad(res, "Choose a valid date.");

  const info = db.prepare("INSERT INTO orders (customer, item, qty, due) VALUES (?, ?, ?, ?)")
    .run(customer, item, qty, due);
  res.status(201).json(db.prepare("SELECT * FROM orders WHERE id = ?").get(info.lastInsertRowid));
});

app.patch("/api/orders/:id/advance", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const next = FLOW[FLOW.indexOf(order.status) + 1];
  if (!next) return bad(res, "This order is already delivered.");
  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(next, order.id);
  res.json({ ...order, status: next });
});

app.delete("/api/orders/:id", (req, res) => {
  const info = db.prepare("DELETE FROM orders WHERE id = ?").run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: "Order not found." });
  res.json({ ok: true });
});

/* ---------- Inventory ---------- */
app.get("/api/stock", (req, res) => {
  res.json(db.prepare("SELECT * FROM stock ORDER BY name COLLATE NOCASE").all());
});

app.post("/api/stock", (req, res) => {
  const name = clean(req.body.name, 30);
  const unit = clean(req.body.unit, 10);
  const qty = Number(req.body.qty);
  const min = Number(req.body.min);

  if (!name) return bad(res, "Enter the ingredient name.");
  if (!unit) return bad(res, "Enter a unit, for example kg.");
  if (!isInt(qty, 0, 100000)) return bad(res, "Amount must be a whole number, 0 or more.");
  if (!isInt(min, 0, 100000)) return bad(res, "Reorder level must be a whole number, 0 or more.");

  const info = db.prepare("INSERT INTO stock (name, qty, unit, min) VALUES (?, ?, ?, ?)")
    .run(name, qty, unit, min);
  res.status(201).json(db.prepare("SELECT * FROM stock WHERE id = ?").get(info.lastInsertRowid));
});

app.patch("/api/stock/:id", (req, res) => {
  const item = db.prepare("SELECT * FROM stock WHERE id = ?").get(req.params.id);
  if (!item) return res.status(404).json({ error: "Ingredient not found." });
  const delta = Number(req.body.delta);
  if (!isInt(delta, -1000, 1000)) return bad(res, "Invalid change.");
  const qty = Math.max(0, item.qty + delta);
  db.prepare("UPDATE stock SET qty = ? WHERE id = ?").run(qty, item.id);
  res.json({ ...item, qty });
});

app.delete("/api/stock/:id", (req, res) => {
  const info = db.prepare("DELETE FROM stock WHERE id = ?").run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: "Ingredient not found." });
  res.json({ ok: true });
});

/* ---------- Customers (built from orders) ---------- */
app.get("/api/customers", (req, res) => {
  const rows = db.prepare(`
    SELECT
      MIN(customer) AS name,
      COUNT(*) AS count,
      (SELECT o2.item FROM orders o2
        WHERE LOWER(o2.customer) = LOWER(o.customer)
        ORDER BY o2.due DESC, o2.id DESC LIMIT 1) AS last_item
    FROM orders o
    GROUP BY LOWER(customer)
    ORDER BY count DESC, name COLLATE NOCASE
  `).all();
  res.json(rows);
});

/* ---------- Contact form ---------- */
app.post("/api/contact", (req, res) => {
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120);
  const message = clean(req.body.message, 1000);

  if (!name) return bad(res, "Enter your name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, "Enter a valid email address.");
  if (message.length < 5) return bad(res, "Write a message of at least 5 characters.");

  db.prepare("INSERT INTO messages (name, email, message) VALUES (?, ?, ?)").run(name, email, message);
  console.log(`New message from ${name} <${email}>`);
  res.status(201).json({ ok: true });
});

/* ---------- Demo reset ---------- */
app.post("/api/reset", (req, res) => {
  tx(() => {
    db.exec("DELETE FROM orders; DELETE FROM stock; DELETE FROM sqlite_sequence WHERE name IN ('orders','stock');");
    seed();
  });
  res.json({ ok: true });
});

/* ---------- Errors ---------- */
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

app.listen(PORT, () => {
  console.log(`BakeFlow is running at http://localhost:${PORT}`);
});