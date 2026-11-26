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
    lines
  } = req.body;

  if (
    !clean(order_number) ||
    !clean(customer_name) ||
    !positiveInt(warehouse_id) ||
    !Array.isArray(lines) ||
    lines.length === 0
  ) {
    return res.status(400).json({
      message: "Order number, customer, warehouse and at least one line are required"
    });
  }

  const warehouse = db.prepare(
    "SELECT id FROM warehouses WHERE id=? AND status='ACTIVE'"
  ).get(warehouse_id);

  if (!warehouse) {
    return res.status(400).json({
      message: "Active warehouse not found"
    });
  }

  for (const line of lines) {
    if (
      !positiveInt(line.sku_id) ||
      !positiveInt(line.quantity)
    ) {
      return res.status(400).json({
        message: "Each order line requires a valid SKU and positive quantity"
      });
    }

    const sku = db.prepare(
      "SELECT id FROM skus WHERE id=? AND status='ACTIVE'"
    ).get(line.sku_id);

    if (!sku) {
      return res.status(400).json({
        message: `Active SKU ${line.sku_id} not found`
      });
    }
  }

  const createOrder = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO orders
        (order_number,customer_name,warehouse_id,status)
      VALUES (?,?,?,'CREATED')
    `).run(
      clean(order_number),
      clean(customer_name),
      warehouse_id
    );

    const orderId = result.lastInsertRowid;

    const insertLine = db.prepare(`
      INSERT INTO order_lines (order_id,sku_id,ordered_qty)
VALUES (?,?,?)
    `);

    for (const line of lines) {
      insertLine.run(orderId, line.sku_id, line.quantity);
    }

    return orderId;
  });

  const orderId = createOrder();

  res.status(201).json({
    message: "Order created successfully",
    order_id: orderId
  });
});


// Update order status (manual status changes only)

app.put("/api/orders/:id/status", (req, res) => {
  const status = clean(req.body.status).toUpperCase();

  const allowedStatuses = [
    "CREATED",
    "ON_HOLD",
    "CANCELLED"
  ];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      message: "Invalid manual status. RELEASED is controlled by the release workflow."
    });
  }

  const order = db.prepare(
    "SELECT * FROM orders WHERE id=?"
  ).get(req.params.id);

  if (!order) {
    return res.status(404).json({
      message: "Order not found"
    });
  }

  db.prepare(
    "UPDATE orders SET status=? WHERE id=?"
  ).run(status, order.id);

  res.json({
    message: "Order status updated",
    order_id: order.id,
    status
  });
});


// ======================================================
// PHASE 1: ORDER RELEASE AND INVENTORY ALLOCATION
// ======================================================

app.post("/api/orders/:id/release", asyncRoute((req, res) => {
  const orderId = Number(req.params.id);

  if (!positiveInt(orderId)) {
    throw httpError("Invalid order ID");
  }

  const order = db.prepare(
    "SELECT * FROM orders WHERE id=?"
  ).get(orderId);

  if (!order) {
    throw httpError("Order not found", 404);
  }

  if (order.status !== "CREATED") {
    throw httpError(
      `Only CREATED orders can be released. Current status: ${order.status}`,
      409
    );
  }

  const orderLines = db.prepare(`
    SELECT
      ol.id AS order_line_id,
      ol.sku_id,
      ol.ordered_qty AS quantity,
      s.code AS sku_code
    FROM order_lines ol
    JOIN skus s ON s.id = ol.sku_id
    WHERE ol.order_id = ?
    ORDER BY ol.id
  `).all(orderId);

  if (orderLines.length === 0) {
    throw httpError("Order has no order lines", 409);
  }

  const releaseOrder = db.transaction(() => {
    const allocations = [];

    for (const line of orderLines) {
      let remainingQty = Number(line.quantity);

      const inventoryRows = db.prepare(`
        SELECT
          id,
          warehouse_id,
          sku_id,
          location_id,
          quantity,
          allocated_qty,
          (quantity - allocated_qty) AS available_qty
        FROM inventory
        WHERE warehouse_id = ?
          AND sku_id = ?
          AND status = 'AVAILABLE'
          AND (quantity - allocated_qty) > 0
        ORDER BY id
      `).all(order.warehouse_id, line.sku_id);

      for (const inventory of inventoryRows) {
        if (remainingQty <= 0) break;

        const allocateQty = Math.min(
          remainingQty,
          Number(inventory.available_qty)
        );

        if (allocateQty <= 0) continue;

        db.prepare(`
          UPDATE inventory
          SET allocated_qty = allocated_qty + ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(allocateQty, inventory.id);

   
const allocationResult = db.prepare(`
  INSERT INTO allocations
    (order_line_id, inventory_id, allocated_qty, picked_qty, status)
  VALUES (?, ?, ?, 0, 'ALLOCATED')
`).run(
  line.order_line_id,
  inventory.id,
  allocateQty
);


        db.prepare(`
          INSERT INTO inventory_transactions
            (inventory_id, transaction_type, quantity_change, reference, performed_by)
          VALUES (?, 'ALLOCATE', 0, ?, ?)
        `).run(
          inventory.id,
          order.order_number,
          req.user.id
        );

        allocations.push({
          allocation_id: allocationResult.lastInsertRowid,
          order_line_id: line.order_line_id,
          inventory_id: inventory.id,
          sku_id: line.sku_id,
          allocated_qty: allocateQty
        });

        remainingQty -= allocateQty;
      }

      if (remainingQty > 0) {
        throw httpError(
          `Insufficient available inventory for SKU ${line.sku_code}. Short by ${remainingQty} unit(s).`,
          409
        );
      }
    }

    db.prepare(`
      UPDATE orders
      SET status = 'RELEASED'
      WHERE id = ?
    `).run(orderId);

    db.prepare(`
      INSERT INTO activity_logs
        (user_id, module, action, reference, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      "ORDER",
      "ORDER_RELEASED",
      order.order_number,
      `${allocations.length} allocation(s) created`
    );

    return allocations;
  });

  const allocations = releaseOrder();

  res.json({
    message: "Order released and inventory allocated successfully",
    order_id: orderId,
    status: "RELEASED",
    allocations
  });
}));


// ======================================================
// PHASE 1: ALLOCATIONS
// ======================================================

app.get("/api/allocations", (req, res) => {
  const allocations = db.prepare(`
    SELECT
      a.*,
      ol.order_id,
      o.order_number,
      s.code AS sku_code,
      s.description AS sku_description,
      i.location_id,
      l.code AS location_code
    FROM allocations a
    JOIN order_lines ol ON ol.id = a.order_line_id
    JOIN orders o ON o.id = ol.order_id
    JOIN skus s ON s.id = ol.sku_id
    JOIN inventory i ON i.id = a.inventory_id
    JOIN locations l ON l.id = i.location_id
    ORDER BY a.id DESC
  `).all();

  res.json(allocations);
});


app.get("/api/orders/:id/allocations", (req, res) => {
  const allocations = db.prepare(`
    SELECT
      a.*,
      ol.order_id,
      s.code AS sku_code,
      s.description AS sku_description,
      i.location_id,
      l.code AS location_code
    FROM allocations a
    JOIN order_lines ol ON ol.id = a.order_line_id
    JOIN skus s ON s.id = ol.sku_id
    JOIN inventory i ON i.id = a.inventory_id
    JOIN locations l ON l.id = i.location_id
    WHERE ol.order_id = ?
    ORDER BY a.id
  `).all(req.params.id);

  res.json(allocations);
});


// ======================================================
// PHASE 2: WAVE MANAGEMENT
// ======================================================

// Create a picking wave
app.post("/api/waves", asyncRoute((req, res) => {
  const warehouseId = Number(req.body.warehouse_id);

  if (!positiveInt(warehouseId)) {
    throw httpError("Valid warehouse_id is required");
  }

  const warehouse = db.prepare(`
    SELECT id, code, name
    FROM warehouses
    WHERE id = ? AND status = 'ACTIVE'
  `).get(warehouseId);

  if (!warehouse) {
    throw httpError("Active warehouse not found", 404);
  }

  const waveNumber = `WAVE-${Date.now()}`;

  const wave = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO waves (wave_number, warehouse_id, status)
      VALUES (?, ?, 'OPEN')
    `).run(waveNumber, warehouseId);

    db.prepare(`
      INSERT INTO activity_logs
        (user_id, module, action, reference, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      "WAVE",
      "WAVE_CREATED",
      waveNumber,
      `Picking wave created for warehouse ${warehouse.code}`
    );

    return db.prepare(`
      SELECT *
      FROM waves
      WHERE id = ?
    `).get(result.lastInsertRowid);
  })();

  res.status(201).json({
    message: "Picking wave created successfully",
    wave
  });
}));


// Get all picking waves
app.get("/api/waves", asyncRoute((req, res) => {
  const waves = db.prepare(`
    SELECT
      w.id,
      w.wave_number,
      w.warehouse_id,
      wh.code AS warehouse_code,
      wh.name AS warehouse_name,
      w.status,
      w.created_at,
      (
        SELECT COUNT(*)
        FROM wave_orders wo
        WHERE wo.wave_id = w.id
      ) AS order_count,
      (
        SELECT COUNT(*)
        FROM pick_tasks pt
        WHERE pt.wave_id = w.id
      ) AS pick_task_count
    FROM waves w
    JOIN warehouses wh ON wh.id = w.warehouse_id
    ORDER BY w.id DESC
  `).all();

  res.json(waves);
}));


// Get one wave with its orders and picking tasks
app.get("/api/waves/:id", asyncRoute((req, res) => {
  const waveId = Number(req.params.id);

  if (!positiveInt(waveId)) {
    throw httpError("Invalid wave ID");
  }

  const wave = db.prepare(`
    SELECT
      w.*,
      wh.code AS warehouse_code,
      wh.name AS warehouse_name
    FROM waves w
    JOIN warehouses wh ON wh.id = w.warehouse_id
    WHERE w.id = ?
  `).get(waveId);

  if (!wave) {
    throw httpError("Wave not found", 404);
  }

  const orders = db.prepare(`
    SELECT
      o.id,
      o.order_number,
      o.customer_name,
      o.status,
      o.created_at
    FROM wave_orders wo
    JOIN orders o ON o.id = wo.order_id
    WHERE wo.wave_id = ?
    ORDER BY o.id
  `).all(waveId);

  const pickTasks = db.prepare(`
    SELECT
      pt.id AS pick_task_id,
      pt.status AS task_status,
      pt.picked_qty,
      pt.assigned_to,
      a.id AS allocation_id,
      a.allocated_qty,
      a.picked_qty AS allocation_picked_qty,
      a.status AS allocation_status,
      o.order_number,
      s.code AS sku_code,
      s.description AS sku_description,
      l.code AS location_code
    FROM pick_tasks pt
    JOIN allocations a ON a.id = pt.allocation_id
    JOIN order_lines ol ON ol.id = a.order_line_id
    JOIN orders o ON o.id = ol.order_id
    JOIN inventory i ON i.id = a.inventory_id
    JOIN skus s ON s.id = ol.sku_id
    JOIN locations l ON l.id = i.location_id
    WHERE pt.wave_id = ?
    ORDER BY pt.id
  `).all(waveId);

  res.json({
    wave,
    orders,
    pick_tasks: pickTasks
  });
}));


// Add a released order to a wave
app.post("/api/waves/:id/orders", asyncRoute((req, res) => {
  const waveId = Number(req.params.id);
  const orderId = Number(req.body.order_id);

  if (!positiveInt(waveId) || !positiveInt(orderId)) {
    throw httpError("Valid wave ID and order_id are required");
  }

  const result = db.transaction(() => {
    const wave = db.prepare(`
      SELECT *
      FROM waves
      WHERE id = ?
    `).get(waveId);

    if (!wave) {
      throw httpError("Wave not found", 404);
    }

    if (wave.status !== "OPEN") {
      throw httpError("Orders can only be added to OPEN waves", 409);
    }

    const order = db.prepare(`
      SELECT *
      FROM orders
      WHERE id = ?
    `).get(orderId);

    if (!order) {
      throw httpError("Order not found", 404);
    }

    if (order.status !== "RELEASED") {
      throw httpError("Only RELEASED orders can be added to a wave", 409);
    }

    if (Number(order.warehouse_id) !== Number(wave.warehouse_id)) {
      throw httpError(
        "Order and wave must belong to the same warehouse",
        409
      );
    }

    const allocationSummary = db.prepare(`
      SELECT
        COUNT(*) AS allocation_count,
        COALESCE(SUM(a.allocated_qty), 0) AS allocated_units
      FROM allocations a
      JOIN order_lines ol ON ol.id = a.order_line_id
      WHERE ol.order_id = ?
        AND a.status = 'ALLOCATED'
    `).get(orderId);

    if (allocationSummary.allocation_count === 0) {
      throw httpError(
        "No active inventory allocations found for this order",
        409
      );
    }

    const existingWaveOrder = db.prepare(`
      SELECT wave_id
      FROM wave_orders
      WHERE order_id = ?
    `).get(orderId);

    if (existingWaveOrder) {
      throw httpError(
        "This order is already assigned to a wave",
        409
      );
    }

    db.prepare(`
      INSERT INTO wave_orders (wave_id, order_id)
      VALUES (?, ?)
    `).run(waveId, orderId);

    db.prepare(`
      INSERT INTO activity_logs
        (user_id, module, action, reference, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      "WAVE",
      "ORDER_ADDED",
      order.order_number,
      `Order added to wave ${wave.wave_number}`
    );

    return {
      wave_number: wave.wave_number,
      order_number: order.order_number,
      allocation_count: allocationSummary.allocation_count,
      allocated_units: allocationSummary.allocated_units
    };
  })();

  res.status(201).json({
    message: "Order added to wave successfully",
    ...result
  });
}));


// Generate one picking task for each active allocation in the wave
app.post("/api/waves/:id/generate-picks", asyncRoute((req, res) => {
  const waveId = Number(req.params.id);

  if (!positiveInt(waveId)) {
    throw httpError("Invalid wave ID");
  }

  const tasks = db.transaction(() => {
    const wave = db.prepare(`
      SELECT *
      FROM waves
      WHERE id = ?
    `).get(waveId);

    if (!wave) {
      throw httpError("Wave not found", 404);
    }

    if (wave.status !== "OPEN") {
      throw httpError(
        "Picking tasks can only be generated for OPEN waves",
        409
      );
    }

    const orderCount = db.prepare(`
      SELECT COUNT(*) AS total
      FROM wave_orders
      WHERE wave_id = ?
    `).get(waveId).total;

    if (orderCount === 0) {
      throw httpError(
        "Add at least one released order before generating picks",
        409
      );
    }

    const existingTaskCount = db.prepare(`
      SELECT COUNT(*) AS total
      FROM pick_tasks
      WHERE wave_id = ?
    `).get(waveId).total;

    if (existingTaskCount > 0) {
      throw httpError(
        "Picking tasks have already been generated for this wave",
        409
      );
    }

    const allocations = db.prepare(`
      SELECT
        a.id AS allocation_id,
        a.allocated_qty,
        a.picked_qty,
        a.status AS allocation_status,
        ol.order_id,
        o.order_number
      FROM wave_orders wo
      JOIN orders o ON o.id = wo.order_id
      JOIN order_lines ol ON ol.order_id = o.id
      JOIN allocations a ON a.order_line_id = ol.id
      WHERE wo.wave_id = ?
        AND a.status = 'ALLOCATED'
      ORDER BY a.id
    `).all(waveId);

    if (allocations.length === 0) {
      throw httpError(
        "No eligible allocations found for this wave",
        409
      );
    }

    const insertTask = db.prepare(`
      INSERT INTO pick_tasks
        (wave_id, allocation_id, status, picked_qty)
      VALUES (?, ?, 'PENDING', 0)
    `);

    for (const allocation of allocations) {
      const existingTask = db.prepare(`
        SELECT id
        FROM pick_tasks
        WHERE allocation_id = ?
      `).get(allocation.allocation_id);

      if (existingTask) {
        throw httpError(
          `Allocation ${allocation.allocation_id} already has a picking task`,
          409
        );
      }

      insertTask.run(waveId, allocation.allocation_id);
    }

    db.prepare(`
      UPDATE waves
      SET status = 'PICKING'
      WHERE id = ?
    `).run(waveId);

    db.prepare(`
      INSERT INTO activity_logs
        (user_id, module, action, reference, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      "PICKING",
      "PICK_TASKS_GENERATED",
      wave.wave_number,
      `${allocations.length} picking task(s) generated`
    );

    return db.prepare(`
      SELECT
        pt.id AS pick_task_id,
        pt.wave_id,
        pt.allocation_id,
        pt.status,
        pt.picked_qty,
        a.allocated_qty,
        o.order_number,
        s.code AS sku_code,
        s.description AS sku_description,
        l.code AS location_code
      FROM pick_tasks pt
      JOIN allocations a ON a.id = pt.allocation_id
      JOIN order_lines ol ON ol.id = a.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN inventory i ON i.id = a.inventory_id
      JOIN skus s ON s.id = ol.sku_id
      JOIN locations l ON l.id = i.location_id
      WHERE pt.wave_id = ?
      ORDER BY pt.id
    `).all(waveId);
  })();

  res.status(201).json({
    message: "Picking tasks generated successfully",
    wave_id: waveId,
    status: "PICKING",
    task_count: tasks.length,
    pick_tasks: tasks
  });
}));


// ======================================================
// PHASE 3: PICKING EXECUTION
// ======================================================

// ---------- Shared picking task query ----------

const getPickingTask = (taskId) => db.prepare(`
  SELECT
    pt.id AS pick_task_id,
    pt.wave_id,
    pt.allocation_id,
    pt.status,
    pt.picked_qty,
    pt.assigned_to,
    a.allocated_qty,
    a.picked_qty AS allocation_picked_qty,
    a.status AS allocation_status,
    ol.id AS order_line_id,
    ol.ordered_qty,
    o.id AS order_id,
    o.order_number,
    s.id AS sku_id,
    s.code AS sku_code,
    s.description AS sku_description,
    i.id AS inventory_id,
    i.quantity AS inventory_quantity,
    i.allocated_qty AS inventory_allocated_qty,
    l.id AS location_id,
    l.code AS location_code,
    u.name AS assigned_operator
  FROM pick_tasks pt
  JOIN allocations a ON a.id = pt.allocation_id
  JOIN order_lines ol ON ol.id = a.order_line_id
  JOIN orders o ON o.id = ol.order_id
  JOIN skus s ON s.id = ol.sku_id
  JOIN inventory i ON i.id = a.inventory_id
  JOIN locations l ON l.id = i.location_id
  LEFT JOIN users u ON u.id = pt.assigned_to
  WHERE pt.id = ?
`).get(taskId);


// ---------- GET: List Picking Tasks ----------

app.get("/api/picking/tasks", (req, res) => {
  const conditions = [];
  const params = [];

  if (req.query.status) {
    conditions.push("pt.status = ?");
    params.push(clean(req.query.status).toUpperCase());
  }

  if (req.query.wave_id) {
    if (!positiveInt(req.query.wave_id)) {
      return res.status(400).json({
        message: "Invalid wave_id"
      });
    }

    conditions.push("pt.wave_id = ?");
    params.push(Number(req.query.wave_id));
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const tasks = db.prepare(`
    SELECT
      pt.id AS pick_task_id,
      pt.wave_id,
      pt.allocation_id,
      pt.status,
      pt.picked_qty,
      pt.assigned_to,
      a.allocated_qty,
      o.order_number,
      s.code AS sku_code,
      s.description AS sku_description,
      l.code AS location_code,
      u.name AS assigned_operator,
      pt.created_at
    FROM pick_tasks pt
    JOIN allocations a ON a.id = pt.allocation_id
    JOIN order_lines ol ON ol.id = a.order_line_id
    JOIN orders o ON o.id = ol.order_id
    JOIN skus s ON s.id = ol.sku_id
    JOIN inventory i ON i.id = a.inventory_id
    JOIN locations l ON l.id = i.location_id
    LEFT JOIN users u ON u.id = pt.assigned_to
    ${whereClause}
    ORDER BY pt.id
  `).all(...params);

  res.json({
    count: tasks.length,
    tasks
  });
});


// ---------- GET: Single Picking Task ----------

app.get("/api/picking/tasks/:id", (req, res) => {
  if (!positiveInt(req.params.id)) {
    return res.status(400).json({
      message: "Invalid picking task ID"
    });
  }

  const task = getPickingTask(Number(req.params.id));

  if (!task) {
    return res.status(404).json({
      message: "Picking task not found"
    });
  }

  res.json(task);
});


// ---------- PUT: Assign Picking Task ----------

app.put(
  "/api/picking/tasks/:id/assign",
  asyncRoute((req, res) => {
    const taskId = Number(req.params.id);
    const assignedTo = Number(req.body.assigned_to);

    if (!positiveInt(taskId)) {
      throw httpError("Invalid picking task ID");
    }

    if (!positiveInt(assignedTo)) {
      throw httpError("A valid assigned_to user ID is required");
    }

    const task = getPickingTask(taskId);

    if (!task) {
      throw httpError("Picking task not found", 404);
    }

    if (task.status === "COMPLETED") {
      throw httpError("Completed tasks cannot be reassigned", 409);
    }

    const operator = db.prepare(`
      SELECT id, name, email, role, active
      FROM users
      WHERE id = ? AND active = 1
    `).get(assignedTo);

    if (!operator) {
      throw httpError("Active operator not found", 404);
    }

    if (!["OPERATOR", "SUPERVISOR", "ADMIN"].includes(operator.role)) {
      throw httpError(
        "Selected user does not have an eligible warehouse role"
      );
    }

    const assignTransaction = db.transaction(() => {
      db.prepare(`
        UPDATE pick_tasks
        SET assigned_to = ?, status = 'ASSIGNED'
        WHERE id = ?
      `).run(assignedTo, taskId);

      db.prepare(`
        INSERT INTO activity_logs
          (user_id, module, action, reference, details)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        req.user.id,
        "PICKING",
        "TASK_ASSIGNED",
        `PICK-TASK-${taskId}`,
        `Assigned to ${operator.name} (user ID ${assignedTo})`
      );
    });

    assignTransaction();

    res.json({
      message: "Picking task assigned successfully",
      pick_task_id: taskId,
      assigned_to: operator.id,
      assigned_operator: operator.name,
      status: "ASSIGNED"
    });
  })
);


// ---------- POST: Complete Picking Task ----------

app.post(
  "/api/picking/tasks/:id/complete",
  asyncRoute((req, res) => {
    const taskId = Number(req.params.id);
    const pickedQty = Number(req.body.picked_qty);
    const locationCode = clean(req.body.location_code).toUpperCase();

    if (!positiveInt(taskId)) {
      throw httpError("Invalid picking task ID");
    }

    if (!Number.isInteger(pickedQty) || pickedQty <= 0) {
      throw httpError("picked_qty must be a positive integer");
    }

    if (!locationCode) {
      throw httpError("location_code is required");
    }

    const task = getPickingTask(taskId);

    if (!task) {
      throw httpError("Picking task not found", 404);
    }

    if (task.status === "COMPLETED") {
      throw httpError("Picking task is already completed", 409);
    }

    if (task.status !== "ASSIGNED") {
      throw httpError("Assign the picking task before completing it", 409);
    }

    if (
      Number(task.assigned_to) !== Number(req.user.id) &&
      !["ADMIN", "SUPERVISOR"].includes(req.user.role)
    ) {
      throw httpError(
        "This picking task is assigned to another operator",
        403
      );
    }

    if (locationCode !== task.location_code.toUpperCase()) {
      throw httpError(
        `Incorrect picking location. Expected ${task.location_code}`,
        400
      );
    }

    if (pickedQty !== task.allocated_qty) {
      throw httpError(
        `Picked quantity must equal allocated quantity (${task.allocated_qty})`
      );
    }

    if (
      task.allocation_status !== "ALLOCATED" ||
      task.allocation_picked_qty !== 0
    ) {
      throw httpError(
        "Allocation is not available for picking",
        409
      );
    }

    if (
      task.inventory_quantity < pickedQty ||
      task.inventory_allocated_qty < pickedQty
    ) {
      throw httpError(
        "Insufficient physical or allocated inventory",
        409
      );
    }

    
const completeTransaction = db.transaction(() => {
  // Decrease physical stock and reserved stock together.
  const inventoryResult = db.prepare(`
    UPDATE inventory
    SET
      quantity = quantity - ?,
      allocated_qty = allocated_qty - ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND quantity >= ?
      AND allocated_qty >= ?
  `).run(
    pickedQty,
    pickedQty,
    task.inventory_id,
    pickedQty,
    pickedQty
  );

  if (inventoryResult.changes !== 1) {
    throw httpError(
      "Inventory changed during picking. Refresh and retry",
      409
    );
  }

  // Record the completed allocation.
  const allocationResult = db.prepare(`
    UPDATE allocations
    SET picked_qty = ?, status = 'PICKED'
    WHERE id = ?
      AND status = 'ALLOCATED'
      AND picked_qty = 0
  `).run(pickedQty, task.allocation_id);

  if (allocationResult.changes !== 1) {
    throw httpError(
      "Allocation is no longer available for picking",
      409
    );
  }

  // Mark the picking task completed.
  const taskResult = db.prepare(`
    UPDATE pick_tasks
    SET picked_qty = ?, status = 'COMPLETED'
    WHERE id = ? AND status = 'ASSIGNED'
  `).run(pickedQty, taskId);

  if (taskResult.changes !== 1) {
    throw httpError(
      "Picking task status changed. Refresh and retry",
      409
    );
  }

  // Record the inventory movement.
  db.prepare(`
    INSERT INTO inventory_transactions
      (inventory_id, transaction_type, quantity_change, reference, performed_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    task.inventory_id,
    "PICK",
    -pickedQty,
    `PICK-TASK-${taskId}`,
    req.user.id
  );

  // Update wave status when every task is complete.
  const remainingTasks = db.prepare(`
    SELECT COUNT(*) AS count
    FROM pick_tasks
    WHERE wave_id = ? AND status != 'COMPLETED'
  `).get(task.wave_id).count;

  if (remainingTasks === 0) {
    db.prepare(`
      UPDATE waves
      SET status = 'COMPLETED'
      WHERE id = ?
    `).run(task.wave_id);
  }

  // Record picking activity.
  db.prepare(`
    INSERT INTO activity_logs
      (user_id, module, action, reference, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    "PICKING",
    "TASK_COMPLETED",
    `PICK-TASK-${taskId}`,
    `Picked ${pickedQty} units of ${task.sku_code} from ${task.location_code}`
  );

  return {
    remainingTasks
  };
});

    const result = completeTransaction();

    res.json({
      message: "Picking task completed successfully",
      pick_task_id: taskId,
      wave_id: task.wave_id,
      order_number: task.order_number,
      sku_code: task.sku_code,
      location_code: task.location_code,
      picked_qty: pickedQty,
      status: "COMPLETED",
      remaining_tasks: result.remainingTasks,
      wave_status:
        result.remainingTasks === 0 ? "COMPLETED" : "PICKING"
    });
  })
);


// ---------- GET: Wave Picking Progress ----------

app.get("/api/picking/waves/:id/progress", (req, res) => {
  const waveId = Number(req.params.id);

  if (!positiveInt(waveId)) {
    return res.status(400).json({
      message: "Invalid wave ID"
    });
  }

  const wave = db.prepare(`
    SELECT
      w.id,
      w.wave_number,
      w.warehouse_id,
      w.status,
      w.created_at
    FROM waves w
    WHERE w.id = ?
  `).get(waveId);

  if (!wave) {
    return res.status(404).json({
      message: "Wave not found"
    });
  }

  const progress = db.prepare(`
    SELECT
      COUNT(*) AS total_tasks,
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_tasks,
      SUM(CASE WHEN status = 'ASSIGNED' THEN 1 ELSE 0 END) AS assigned_tasks,
      SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_tasks,
      COALESCE(SUM(picked_qty), 0) AS total_picked_units
    FROM pick_tasks
    WHERE wave_id = ?
  `).get(waveId);

  const percentage = progress.total_tasks > 0
    ? Math.round(
        (progress.completed_tasks / progress.total_tasks) * 100
      )
    : 0;

  res.json({
    wave,
    progress: {
      ...progress,
      completion_percentage: percentage
    }
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