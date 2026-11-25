
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
  console.error(
    "JWT_SECRET is missing. Create a .env file and set JWT_SECRET=your-secret-text"
  );
  process.exit(1);
}

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true }));
app.use(express.json({ limit: "1mb" }));

const asyncRoute = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (error) {
    next(error);
  }
};

const clean = (value) => String(value ?? "").trim();

const positiveInt = (value) =>
  Number.isInteger(Number(value)) && Number(value) > 0;

const httpError = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });


// ======================================================
// PUBLIC ROUTES
// ======================================================

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "CEVA WMS Simulator API"
  });
});


// ---------- Authentication: Login ----------

app.post("/api/auth/login", asyncRoute((req, res) => {
  const email = clean(req.body.email).toLowerCase();

  const user = db.prepare(
    "SELECT * FROM users WHERE email=? AND active=1"
  ).get(email);

  if (
    !user ||
    !bcrypt.compareSync(
      String(req.body.password || ""),
      user.password_hash
    )
  ) {
    return res.status(401).json({
      message: "Invalid email or password"
    });
  }

  const token = jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "8h"
    }
  );

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    }
  });
}));


// ======================================================
// PROTECTED ROUTES
// Everything below requires a valid login token
// ======================================================

app.use("/api", requireAuth);


// ---------- Current User ----------

app.get("/api/auth/me", (req, res) => {
  const user = db.prepare(
    "SELECT id,name,email,role FROM users WHERE id=? AND active=1"
  ).get(req.user.id);

  if (!user) {
    return res.status(401).json({
      message: "User not found"
    });
  }

  res.json(user);
});


// ======================================================
// PHASE 1: DASHBOARD
// ======================================================

app.get("/api/dashboard", (_req, res) => {
  const one = (sql) => db.prepare(sql).get().n;

  res.json({
    warehouses: one(
      "SELECT COUNT(*) n FROM warehouses WHERE status='ACTIVE'"
    ),

    skus: one(
      "SELECT COUNT(*) n FROM skus WHERE status='ACTIVE'"
    ),

    inventoryUnits: one(
      "SELECT COALESCE(SUM(quantity),0) n FROM inventory"
    ),

    availableUnits: one(
      "SELECT COALESCE(SUM(quantity-allocated_qty),0) n FROM inventory WHERE status='AVAILABLE'"
    ),

    totalOrders: one(
      "SELECT COUNT(*) n FROM orders"
    ),

    pendingOrders: one(
      "SELECT COUNT(*) n FROM orders WHERE status IN ('CREATED','RELEASED','ON_HOLD')"
    ),

    onHoldOrders: one(
      "SELECT COUNT(*) n FROM orders WHERE status='ON_HOLD'"
    )
  });
});


// ======================================================
// PHASE 1: MASTER DATA CRUD
// Warehouses, SKUs and Locations
// ======================================================

function crudRoutes(table, fields, required, listSql, validate = () => null) {
  const base = `/api/${table}`;

  // List records
  app.get(base, (_req, res) => {
    res.json(db.prepare(listSql).all());
  });

  // Create record
  app.post(base, (req, res) => {
    for (const field of required) {
      if (!clean(req.body[field])) {
        return res.status(400).json({
          message: `${field} is required`
        });
      }
    }

    const error = validate(req.body);

    if (error) {
      return res.status(400).json({
        message: error
      });
    }

    const cols = fields.join(",");
    const marks = fields.map(() => "?").join(",");

    const values = fields.map((field) =>
      field === "capacity"
        ? Number(req.body[field] || 0)
        : clean(req.body[field])
    );

    const result = db.prepare(
      `INSERT INTO ${table} (${cols}) VALUES (${marks})`
    ).run(...values);

    res.status(201).json(
      db.prepare(`SELECT * FROM ${table} WHERE id=?`)
        .get(result.lastInsertRowid)
    );
  });

  // Update record
  app.put(`${base}/:id`, (req, res) => {
    const existing = db.prepare(
      `SELECT * FROM ${table} WHERE id=?`
    ).get(req.params.id);

    if (!existing) {
      return res.status(404).json({
        message: "Record not found"
      });
    }

    for (const field of required) {
      if (!clean(req.body[field])) {
        return res.status(400).json({
          message: `${field} is required`
        });
      }
    }

    const error = validate(req.body);

    if (error) {
      return res.status(400).json({
        message: error
      });
    }

    const set = fields.map((field) => `${field}=?`).join(",");

    const values = fields.map((field) =>
      field === "capacity"
        ? Number(req.body[field] || 0)
        : clean(req.body[field])
    );

    db.prepare(
      `UPDATE ${table} SET ${set} WHERE id=?`
    ).run(...values, req.params.id);

    res.json(
      db.prepare(`SELECT * FROM ${table} WHERE id=?`)
        .get(req.params.id)
    );
  });

  // Delete record
  app.delete(`${base}/:id`, (req, res) => {
    try {
      const result = db.prepare(
        `DELETE FROM ${table} WHERE id=?`
      ).run(req.params.id);

      if (!result.changes) {
        return res.status(404).json({
          message: "Record not found"
        });
      }

      res.json({
        message: "Deleted"
      });

    } catch {
      res.status(409).json({
        message: "Cannot delete: this record is referenced by other records"
      });
    }
  });
}


// Warehouse routes

crudRoutes(
  "warehouses",
  ["code", "name", "address", "status"],
  ["code", "name"],
  "SELECT * FROM warehouses ORDER BY id DESC"
);


// SKU routes

crudRoutes(
  "skus",
  ["code", "description", "barcode", "uom", "category", "status"],
  ["code", "description", "uom"],
  "SELECT * FROM skus ORDER BY id DESC"
);


// Location routes

crudRoutes(
  "locations",
  ["warehouse_id", "code", "type", "capacity", "status"],
  ["warehouse_id", "code", "type"],
  `SELECT l.*,w.code AS warehouse_code
   FROM locations l
   JOIN warehouses w ON w.id=l.warehouse_id
   ORDER BY l.id DESC`,
  (body) =>
    !positiveInt(body.warehouse_id)
      ? "Valid warehouse is required"
      : null
);


// ======================================================
// PHASE 1: INVENTORY
// ======================================================

// Get inventory

app.get("/api/inventory", (_req, res) => {
  const inventory = db.prepare(`
    SELECT
      i.*,
      w.code warehouse_code,
      l.code location_code,
      s.code sku_code,
      s.description sku_description,
      (i.quantity - i.allocated_qty) available_qty
    FROM inventory i
    JOIN warehouses w ON w.id = i.warehouse_id
    JOIN locations l ON l.id = i.location_id
    JOIN skus s ON s.id = i.sku_id
    ORDER BY i.id DESC
  `).all();

  res.json(inventory);
});


// Adjust inventory quantity

app.post("/api/inventory/adjust", (req, res) => {
  const {
    inventory_id,
    quantity_change,
    reason
  } = req.body;

  const change = Number(quantity_change);

  if (
    !positiveInt(inventory_id) ||
    !Number.isInteger(change) ||
    change === 0
  ) {
    return res.status(400).json({
      message: "Select inventory and enter a non-zero whole-number adjustment"
    });
  }

  const item = db.prepare(
    "SELECT * FROM inventory WHERE id=?"
  ).get(inventory_id);

  if (!item) {
    return res.status(404).json({
      message: "Inventory record not found"
    });
  }

  if (item.quantity + change < item.allocated_qty) {
    return res.status(400).json({
      message: "Adjustment cannot reduce stock below allocated quantity"
    });
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE inventory
      SET quantity=?,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(item.quantity + change, item.id);

    db.prepare(`
      INSERT INTO inventory_transactions
        (inventory_id,transaction_type,quantity_change,reference,performed_by)
      VALUES (?,?,?,?,?)
    `).run(
      item.id,
      "ADJUSTMENT",
      change,
      clean(reason),
      req.user.id
    );
  });

  tx();

  res.json({
    message: "Inventory adjusted",
    quantity: item.quantity + change
  });
});


// ======================================================
// PHASE 1: ORDERS
// ======================================================


// Get all orders

app.get("/api/orders", (_req, res) => {
  const orders = db.prepare(`
    SELECT
      o.*,
      w.code warehouse_code,
      (
        SELECT COUNT(*)
        FROM order_lines ol
        WHERE ol.order_id = o.id
      ) line_count
    FROM orders o
    JOIN warehouses w ON w.id = o.warehouse_id
    ORDER BY o.id DESC
  `).all();

  res.json(orders);
});


// Get one order with order lines

app.get("/api/orders/:id", (req, res) => {
  const order = db.prepare(`
    SELECT
      o.*,
      w.code warehouse_code
    FROM orders o
    JOIN warehouses w ON w.id=o.warehouse_id
    WHERE o.id=?
  `).get(req.params.id);

  if (!order) {
    return res.status(404).json({
      message: "Order not found"
    });
  }

  order.lines = db.prepare(`
    SELECT
      ol.*,
      s.code sku_code,
      s.description sku_description
    FROM order_lines ol
    JOIN skus s ON s.id=ol.sku_id
    WHERE ol.order_id=?
  `).all(order.id);

  res.json(order);
});


// Create order

app.post("/api/orders", (req, res) => {
  const {
    order_number,
    customer_name,
    warehouse_id,
    notes,
    lines = []
  } = req.body;

  if (
    !clean(order_number) ||
    !clean(customer_name) ||
    !positiveInt(warehouse_id)
  ) {
    return res.status(400).json({
      message: "Order number, customer and warehouse are required"
    });
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({
      message: "Add at least one order line"
    });
  }

  for (const line of lines) {
    if (
      !positiveInt(line.sku_id) ||
      !positiveInt(line.ordered_qty)
    ) {
      return res.status(400).json({
        message: "Each line needs a valid SKU and positive quantity"
      });
    }
  }

  try {
    const create = db.transaction(() => {
      const id = db.prepare(`
        INSERT INTO orders
          (order_number,customer_name,warehouse_id,notes)
        VALUES (?,?,?,?)
      `).run(
        clean(order_number),
        clean(customer_name),
        Number(warehouse_id),
        clean(notes)
      ).lastInsertRowid;

      const insertLine = db.prepare(`
        INSERT INTO order_lines
          (order_id,sku_id,ordered_qty)
        VALUES (?,?,?)
      `);

      lines.forEach((line) => {
        insertLine.run(
          id,
          Number(line.sku_id),
          Number(line.ordered_qty)
        );
      });

      return id;
    });

    const id = create();

    res.status(201).json(
      db.prepare("SELECT * FROM orders WHERE id=?").get(id)
    );

  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({
        message: "Order number already exists"
      });
    }

    throw error;
  }
});


// Update order status
// RELEASED is handled only through the allocation endpoint.

app.put("/api/orders/:id/status", (req, res) => {
  const allowed = [
    "CREATED",
    "ON_HOLD",
    "CANCELLED"
  ];

  const status = clean(req.body.status).toUpperCase();

  if (!allowed.includes(status)) {
    return res.status(400).json({
      message: "Invalid status. Use CREATED, ON_HOLD or CANCELLED. Use the release endpoint to release an order."
    });
  }

  const result = db.prepare(
    "UPDATE orders SET status=? WHERE id=?"
  ).run(status, req.params.id);

  if (!result.changes) {
    return res.status(404).json({
      message: "Order not found"
    });
  }

  res.json(
    db.prepare("SELECT * FROM orders WHERE id=?")
      .get(req.params.id)
  );
});


// ======================================================
// PHASE 2: FIFO INVENTORY ALLOCATION
// ======================================================


// Release order and allocate inventory using FIFO

app.post("/api/orders/:id/release", (req, res) => {
  try {
    const releaseOrder = db.transaction(() => {

      // 1. Find order

      const order = db.prepare(`
        SELECT *
        FROM orders
        WHERE id=?
      `).get(req.params.id);

      if (!order) {
        throw httpError("Order not found", 404);
      }

      if (order.status !== "CREATED") {
        throw httpError(
          `Only CREATED orders can be released. Current status: ${order.status}`,
          400
        );
      }


      // 2. Get order lines

      const lines = db.prepare(`
        SELECT *
        FROM order_lines
        WHERE order_id=?
        ORDER BY id ASC
      `).all(order.id);

      if (lines.length === 0) {
        throw httpError("Order has no order lines", 400);
      }


      // 3. Prepare inventory and allocation statements

      const findInventory = db.prepare(`
        SELECT *
        FROM inventory
        WHERE warehouse_id=?
          AND sku_id=?
          AND status='AVAILABLE'
          AND quantity > allocated_qty
        ORDER BY id ASC
      `);

      const updateInventory = db.prepare(`
        UPDATE inventory
        SET allocated_qty = allocated_qty + ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id=?
      `);

      const insertAllocation = db.prepare(`
        INSERT INTO allocations
          (order_line_id, inventory_id, allocated_qty, status)
        VALUES (?, ?, ?, 'ALLOCATED')
      `);

      const insertTransaction = db.prepare(`
        INSERT INTO inventory_transactions
          (inventory_id, transaction_type, quantity_change, reference, performed_by)
        VALUES (?, 'ALLOCATE', 0, ?, ?)
      `);


      // 4. Process each order line

      const allocationSummary = [];

      for (const line of lines) {

        let remainingQty = line.ordered_qty;

        // FIFO: oldest inventory record first

        const inventoryRows = findInventory.all(
          order.warehouse_id,
          line.sku_id
        );

        for (const stock of inventoryRows) {

          if (remainingQty <= 0) {
            break;
          }

          const availableQty =
            stock.quantity - stock.allocated_qty;

          if (availableQty <= 0) {
            continue;
          }

          const allocateQty = Math.min(
            availableQty,
            remainingQty
          );

          // Update allocated quantity

          updateInventory.run(
            allocateQty,
            stock.id
          );

          // Insert allocation record

          const allocationResult = insertAllocation.run(
            line.id,
            stock.id,
            allocateQty
          );

          // Log allocation transaction.
          // Quantity change is 0 because stock is reserved,
          // not physically removed from inventory.

          insertTransaction.run(
            stock.id,
            order.order_number,
            req.user.id
          );

          allocationSummary.push({
            allocation_id: allocationResult.lastInsertRowid,
            order_line_id: line.id,
            inventory_id: stock.id,
            sku_id: line.sku_id,
            allocated_qty: allocateQty
          });

          remainingQty -= allocateQty;
        }


        // 5. Roll back entire order if stock is insufficient

        if (remainingQty > 0) {
          throw httpError(
            `Insufficient available inventory for SKU ID ${line.sku_id}. Short by ${remainingQty} unit(s).`,
            409
          );
        }
      }


      // 6. Update order status after all lines are allocated

      db.prepare(`
        UPDATE orders
        SET status='RELEASED'
        WHERE id=?
      `).run(order.id);


      // 7. Record activity log

      db.prepare(`
        INSERT INTO activity_logs
          (user_id, module, action, reference, details)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        req.user.id,
        "ALLOCATION",
        "ORDER_RELEASED",
        order.order_number,
        `Order released successfully. ${allocationSummary.length} allocation record(s) created.`
      );


      return allocationSummary;
    });


    // Execute transaction

    const allocations = releaseOrder();

    res.json({
      message: "Order released and inventory allocated successfully",
      order_id: Number(req.params.id),
      status: "RELEASED",
      allocations
    });

  } catch (error) {

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        message: error.message
      });
    }

    throw error;
  }
});


// ======================================================
// PHASE 2: ALLOCATION LIST
// ======================================================


// Get all allocations

app.get("/api/allocations", (_req, res) => {
  const allocations = db.prepare(`
    SELECT
      a.*,
      o.order_number,
      ol.sku_id,
      s.code AS sku_code,
      s.description AS sku_description,
      i.warehouse_id,
      w.code AS warehouse_code,
      l.code AS location_code
    FROM allocations a
    JOIN order_lines ol ON ol.id = a.order_line_id
    JOIN orders o ON o.id = ol.order_id
    JOIN skus s ON s.id = ol.sku_id
    JOIN inventory i ON i.id = a.inventory_id
    JOIN warehouses w ON w.id = i.warehouse_id
    JOIN locations l ON l.id = i.location_id
    ORDER BY a.id DESC
  `).all();

  res.json(allocations);
});


// Get allocations for a specific order

app.get("/api/orders/:id/allocations", (req, res) => {

  const order = db.prepare(`
    SELECT id, order_number
    FROM orders
    WHERE id=?
  `).get(req.params.id);

  if (!order) {
    return res.status(404).json({
      message: "Order not found"
    });
  }

  const allocations = db.prepare(`
    SELECT
      a.*,
      ol.sku_id,
      s.code AS sku_code,
      s.description AS sku_description,
      i.location_id,
      l.code AS location_code
    FROM allocations a
    JOIN order_lines ol ON ol.id = a.order_line_id
    JOIN skus s ON s.id = ol.sku_id
    JOIN inventory i ON i.id = a.inventory_id
    JOIN locations l ON l.id = i.location_id
    WHERE ol.order_id=?
    ORDER BY a.id ASC
  `).all(order.id);

  res.json({
    order_number: order.order_number,
    allocations
  });
});


// ======================================================
// PHASE 1: USERS
// ======================================================

app.get("/api/users", (_req, res) => {
  const users = db.prepare(`
    SELECT id,name,email,role,active,created_at
    FROM users
    ORDER BY id
  `).all();

  res.json(users);
});


// ======================================================
// ERROR HANDLER
// ======================================================

app.use((err, _req, res, _next) => {
  console.error(err);

  if (err.statusCode) {
    return res.status(err.statusCode).json({
      message: err.message
    });
  }

  if (String(err.code || "").startsWith("SQLITE_CONSTRAINT")) {
    return res.status(409).json({
      message: "A unique value or relationship constraint was violated"
    });
  }

  res.status(500).json({
    message: "Internal server error"
  });
});


// ======================================================
// START SERVER
// ======================================================

const port = Number(process.env.PORT || 5000);

app.listen(port, "0.0.0.0", () => {
  console.log(`WMS API running on port ${port}`);
});
