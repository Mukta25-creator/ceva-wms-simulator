import bcrypt from "bcryptjs";
import db from "./database.js";

const seed = db.transaction(() => {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count === 0) {
    const hash = bcrypt.hashSync("Admin@123", 10);
    db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)")
      .run("WMS Administrator", "admin@wms.local", hash, "ADMIN");
  }
  if (db.prepare("SELECT COUNT(*) AS n FROM warehouses").get().n === 0) {
    const wh = db.prepare("INSERT INTO warehouses (code,name,address,status) VALUES (?,?,?,?)");
    const wh1 = wh.run("WH01","Bangalore Distribution Centre","Bengaluru, India","ACTIVE").lastInsertRowid;
    const wh2 = wh.run("WH02","Mumbai Distribution Centre","Mumbai, India","ACTIVE").lastInsertRowid;
    const sku = db.prepare("INSERT INTO skus (code,description,barcode,uom,category) VALUES (?,?,?,?,?)");
    const s1 = sku.run("SKU1001","Laptop","8900001001001","EA","Electronics").lastInsertRowid;
    const s2 = sku.run("SKU1002","Wireless Keyboard","8900001001002","EA","Accessories").lastInsertRowid;
    const loc = db.prepare("INSERT INTO locations (warehouse_id,code,type,capacity) VALUES (?,?,?,?)");
    const l1 = loc.run(wh1,"PICK-001","PICK",100).lastInsertRowid;
    const l2 = loc.run(wh1,"BULK-001","BULK",500).lastInsertRowid;
    loc.run(wh2,"PICK-001","PICK",100);
    db.prepare("INSERT INTO inventory (warehouse_id,location_id,sku_id,pallet_id,lot_number,quantity,allocated_qty,status) VALUES (?,?,?,?,?,?,?,?)")
      .run(wh1,l1,s1,"PLT-10001","LOT-A",25,0,"AVAILABLE");
    db.prepare("INSERT INTO inventory (warehouse_id,location_id,sku_id,pallet_id,lot_number,quantity,allocated_qty,status) VALUES (?,?,?,?,?,?,?,?)")
      .run(wh1,l2,s1,"PLT-10002","LOT-A",75,0,"AVAILABLE");
    db.prepare("INSERT INTO inventory (warehouse_id,location_id,sku_id,pallet_id,lot_number,quantity,allocated_qty,status) VALUES (?,?,?,?,?,?,?,?)")
      .run(wh1,l1,s2,"PLT-10003","LOT-B",60,0,"AVAILABLE");
    const orderId = db.prepare("INSERT INTO orders (order_number,customer_name,warehouse_id,status,notes) VALUES (?,?,?,?,?)")
      .run("ORD-10001","Demo Customer",wh1,"CREATED","Seed order for local testing").lastInsertRowid;
    db.prepare("INSERT INTO order_lines (order_id,sku_id,ordered_qty) VALUES (?,?,?)").run(orderId,s1,5);
  }
});
seed();
