
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "../data");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "wms.sqlite"));

db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

db.exec(`

-- =====================================================
-- PHASE 1: USER MANAGEMENT
-- =====================================================

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'OPERATOR',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- PHASE 1: WAREHOUSE MASTER
-- =====================================================

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- PHASE 1: SKU MASTER
-- =====================================================

CREATE TABLE IF NOT EXISTS skus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  barcode TEXT DEFAULT '',
  uom TEXT NOT NULL DEFAULT 'EA',
  category TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- PHASE 1: LOCATION MASTER
-- =====================================================

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  code TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'PICK',
  capacity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(warehouse_id, code)
);

-- =====================================================
-- PHASE 1: INVENTORY
-- =====================================================

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  pallet_id TEXT DEFAULT '',
  lot_number TEXT DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  allocated_qty INTEGER NOT NULL DEFAULT 0
    CHECK(allocated_qty >= 0 AND allocated_qty <= quantity),
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- PHASE 1: CUSTOMER ORDERS
-- =====================================================

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'CREATED',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  ordered_qty INTEGER NOT NULL CHECK(ordered_qty > 0)
);

-- =====================================================
-- PHASE 1: INVENTORY TRANSACTION HISTORY
-- =====================================================

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_id INTEGER NOT NULL REFERENCES inventory(id),
  transaction_type TEXT NOT NULL,
  quantity_change INTEGER NOT NULL,
  reference TEXT DEFAULT '',
  performed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- PHASE 2: INVENTORY ALLOCATION
-- =====================================================

CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  inventory_id INTEGER NOT NULL REFERENCES inventory(id),
  allocated_qty INTEGER NOT NULL CHECK(allocated_qty > 0),
  picked_qty INTEGER NOT NULL DEFAULT 0 CHECK(picked_qty >= 0),
  status TEXT NOT NULL DEFAULT 'ALLOCATED',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- PHASE 2: WAVE MANAGEMENT
-- =====================================================

CREATE TABLE IF NOT EXISTS waves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_number TEXT NOT NULL UNIQUE,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wave_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_id INTEGER NOT NULL REFERENCES waves(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  UNIQUE(wave_id, order_id)
);

-- =====================================================
-- PHASE 2: PICKING MANAGEMENT
-- =====================================================

CREATE TABLE IF NOT EXISTS pick_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_id INTEGER NOT NULL REFERENCES waves(id),
  allocation_id INTEGER NOT NULL REFERENCES allocations(id),
  status TEXT NOT NULL DEFAULT 'PENDING',
  picked_qty INTEGER NOT NULL DEFAULT 0 CHECK(picked_qty >= 0),
  assigned_to INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(wave_id, allocation_id)
);

-- =====================================================
-- PHASE 2: PACKING MANAGEMENT
-- =====================================================

CREATE TABLE IF NOT EXISTS cartons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carton_number TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS carton_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carton_id INTEGER NOT NULL REFERENCES cartons(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  packed_qty INTEGER NOT NULL CHECK(packed_qty > 0)
);

-- =====================================================
-- PHASE 2: SHIPPING AND DISPATCH
-- =====================================================

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_number TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  carrier TEXT DEFAULT '',
  tracking_number TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'READY',
  shipped_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- PHASE 2: ACTIVITY LOGS
-- =====================================================

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  reference TEXT DEFAULT '',
  details TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- PERFORMANCE INDEXES
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_allocations_order_line
ON allocations(order_line_id);

CREATE INDEX IF NOT EXISTS idx_allocations_inventory
ON allocations(inventory_id);

CREATE INDEX IF NOT EXISTS idx_pick_tasks_wave
ON pick_tasks(wave_id);

CREATE INDEX IF NOT EXISTS idx_wave_orders_order
ON wave_orders(order_id);

CREATE INDEX IF NOT EXISTS idx_cartons_order
ON cartons(order_id);

CREATE INDEX IF NOT EXISTS idx_shipments_order
ON shipments(order_id);

`);

export default db;
