import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "./database.js";
import "./seed.js";
import { requireAuth } from "./auth.js";

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing. Create a .env file and set JWT_SECRET=your-secret-text");
  process.exit(1);
}

const app = express();
app.use(helmet());
// FRONTEND_ORIGIN is optional. Without it, any origin is allowed (fine for local/Codespaces training use).
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true }));
app.use(express.json({ limit: "1mb" }));

const asyncRoute = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
const clean = (v) => String(v ?? "").trim();
const positiveInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

// ---------- Public routes ----------
app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "CEVA WMS Simulator API" }));

app.post("/api/auth/login", asyncRoute((req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email=? AND active=1").get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ""), user.password_hash))
    return res.status(401).json({ message: "Invalid email or password" });
  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
  );
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

// ---------- Everything below needs a valid login token ----------
app.use("/api", requireAuth);

app.get("/api/auth/me", (req, res) => {
  const user = db.prepare("SELECT id,name,email,role FROM users WHERE id=? AND active=1").get(req.user.id);
  if (!user) return res.status(401).json({ message: "User not found" });
  res.json(user);
});

app.get("/api/dashboard", (_req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  res.json({
    warehouses: one("SELECT COUNT(*) n FROM warehouses WHERE status='ACTIVE'"),
    skus: one("SELECT COUNT(*) n FROM skus WHERE status='ACTIVE'"),
    inventoryUnits: one("SELECT COALESCE(SUM(quantity),0) n FROM inventory"),
    availableUnits: one("SELECT COALESCE(SUM(quantity-allocated_qty),0) n FROM inventory WHERE status='AVAILABLE'"),
    totalOrders: one("SELECT COUNT(*) n FROM orders"),
    pendingOrders: one("SELECT COUNT(*) n FROM orders WHERE status IN ('CREATED','RELEASED','ON_HOLD')"),
    onHoldOrders: one("SELECT COUNT(*) n FROM orders WHERE status='ON_HOLD'")
  });
});

// Generic list / create / update / delete for master data tables
function crudRoutes(table, fields, required, listSql, validate = () => null) {
  const base = `/api/${table}`;
  app.get(base, (_req, res) => res.json(db.prepare(listSql).all()));
  app.post(base, (req, res) => {
    for (const f of required) if (!clean(req.body[f])) return res.status(400).json({ message: `${f} is required` });
    const error = validate(req.body);
    if (error) return res.status(400).json({ message: error });
    const cols = fields.join(",");
    const marks = fields.map(() => "?").join(",");
    const values = fields.map((f) => (f === "capacity" ? Number(req.body[f] || 0) : clean(req.body[f])));
    const result = db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${marks})`).run(...values);
    res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(result.lastInsertRowid));
  });
  app.put(`${base}/:id`, (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id);
    if (!existing) return res.status(404).json({ message: "Record not found" });
    for (const f of required) if (!clean(req.body[f])) return res.status(400).json({ message: `${f} is required` });
    const error = validate(req.body);
    if (error) return res.status(400).json({ message: error });
    const set = fields.map((f) => `${f}=?`).join(",");
    const values = fields.map((f) => (f === "capacity" ? Number(req.body[f] || 0) : clean(req.body[f])));
    db.prepare(`UPDATE ${table} SET ${set} WHERE id=?`).run(...values, req.params.id);
    res.json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id));
  });
  app.delete(`${base}/:id`, (req, res) => {
    try {
      const result = db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
      if (!result.changes) return res.status(404).json({ message: "Record not found" });
      res.json({ message: "Deleted" });
    } catch {
      res.status(409).json({ message: "Cannot delete: this record is referenced by other records" });
    }
  });
}

crudRoutes("warehouses", ["code", "name", "address", "status"], ["code", "name"],
  "SELECT * FROM warehouses ORDER BY id DESC");
crudRoutes("skus", ["code", "description", "barcode", "uom", "category", "status"], ["code", "description", "uom"],
  "SELECT * FROM skus ORDER BY id DESC");
crudRoutes("locations", ["warehouse_id", "code", "type", "capacity", "status"], ["warehouse_id", "code", "type"],
  "SELECT l.*,w.code AS warehouse_code FROM locations l JOIN warehouses w ON w.id=l.warehouse_id ORDER BY l.id DESC",
  (b) => (!positiveInt(b.warehouse_id) ? "Valid warehouse is required" : null));

// ---------- Inventory ----------
app.get("/api/inventory", (_req, res) => res.json(db.prepare(`
  SELECT i.*, w.code warehouse_code, l.code location_code, s.code sku_code, s.description sku_description,
         (i.quantity - i.allocated_qty) available_qty
  FROM inventory i
  JOIN warehouses w ON w.id = i.warehouse_id
  JOIN locations l ON l.id = i.location_id
  JOIN skus s ON s.id = i.sku_id
  ORDER BY i.id DESC`).all()));

app.post("/api/inventory/adjust", (req, res) => {
  const { inventory_id, quantity_change, reason } = req.body;
  const change = Number(quantity_change);
  if (!positiveInt(inventory_id) || !Number.isInteger(change) || change === 0)
    return res.status(400).json({ message: "Select inventory and enter a non-zero whole-number adjustment" });
  const item = db.prepare("SELECT * FROM inventory WHERE id=?").get(inventory_id);
  if (!item) return res.status(404).json({ message: "Inventory record not found" });
  if (item.quantity + change < item.allocated_qty)
    return res.status(400).json({ message: "Adjustment cannot reduce stock below allocated quantity" });
  const tx = db.transaction(() => {
    db.prepare("UPDATE inventory SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(item.quantity + change, item.id);
    db.prepare(
      "INSERT INTO inventory_transactions (inventory_id,transaction_type,quantity_change,reference,performed_by) VALUES (?,?,?,?,?)"
    ).run(item.id, "ADJUSTMENT", change, clean(reason), req.user.id);
  });
  tx();
  res.json({ message: "Inventory adjusted", quantity: item.quantity + change });
});

// ---------- Orders ----------
app.get("/api/orders", (_req, res) => res.json(db.prepare(`
  SELECT o.*, w.code warehouse_code,
         (SELECT COUNT(*) FROM order_lines ol WHERE ol.order_id = o.id) line_count
  FROM orders o JOIN warehouses w ON w.id = o.warehouse_id
  ORDER BY o.id DESC`).all()));

app.get("/api/orders/:id", (req, res) => {
  const order = db.prepare(
    "SELECT o.*, w.code warehouse_code FROM orders o JOIN warehouses w ON w.id=o.warehouse_id WHERE o.id=?"
  ).get(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  order.lines = db.prepare(
    "SELECT ol.*, s.code sku_code, s.description sku_description FROM order_lines ol JOIN skus s ON s.id=ol.sku_id WHERE ol.order_id=?"
  ).all(order.id);
  res.json(order);
});

app.post("/api/orders", (req, res) => {
  const { order_number, customer_name, warehouse_id, notes, lines = [] } = req.body;
  if (!clean(order_number) || !clean(customer_name) || !positiveInt(warehouse_id))
    return res.status(400).json({ message: "Order number, customer and warehouse are required" });
  if (!Array.isArray(lines) || lines.length === 0)
    return res.status(400).json({ message: "Add at least one order line" });
  for (const line of lines)
    if (!positiveInt(line.sku_id) || !positiveInt(line.ordered_qty))
      return res.status(400).json({ message: "Each line needs a valid SKU and positive quantity" });
  try {
    const create = db.transaction(() => {
      const id = db.prepare("INSERT INTO orders (order_number,customer_name,warehouse_id,notes) VALUES (?,?,?,?)")
        .run(clean(order_number), clean(customer_name), Number(warehouse_id), clean(notes)).lastInsertRowid;
      const insertLine = db.prepare("INSERT INTO order_lines (order_id,sku_id,ordered_qty) VALUES (?,?,?)");
      lines.forEach((line) => insertLine.run(id, Number(line.sku_id), Number(line.ordered_qty)));
      return id;
    });
    const id = create();
    res.status(201).json(db.prepare("SELECT * FROM orders WHERE id=?").get(id));
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ message: "Order number already exists" });
    throw e;
  }
});

app.put("/api/orders/:id/status", (req, res) => {
  const allowed = ["CREATED", "RELEASED", "ON_HOLD", "CANCELLED"];
  const status = clean(req.body.status).toUpperCase();
  if (!allowed.includes(status)) return res.status(400).json({ message: "Invalid Phase 1 order status" });
  const result = db.prepare("UPDATE orders SET status=? WHERE id=?").run(status, req.params.id);
  if (!result.changes) return res.status(404).json({ message: "Order not found" });
  res.json(db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id));
});

app.get("/api/users", (_req, res) =>
  res.json(db.prepare("SELECT id,name,email,role,active,created_at FROM users ORDER BY id").all()));

// ---------- Error handler ----------
app.use((err, _req, res, _next) => {
  console.error(err);
  if (String(err.code || "").startsWith("SQLITE_CONSTRAINT"))
    return res.status(409).json({ message: "A unique value or relationship constraint was violated" });
  res.status(500).json({ message: "Internal server error" });
});

/*const port = Number(process.env.PORT || 5000);
app.listen(port, () => console.log(`WMS API running at http://localhost:${port}`));*/


const port = Number(process.env.PORT || 5000);

app.listen(port, "0.0.0.0", () => {
  console.log(`WMS API running on port ${port}`);
});



