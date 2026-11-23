# CEVA WMS Simulator — Phase 1 Starter

A learning project that simulates core warehouse-management workflows. This is an independent training simulator, **not CEVA's or Blue Yonder's proprietary software**.

## Stack
- Frontend: React + Vite
- Backend: Node.js + Express
- Database: SQLite (`better-sqlite3`)
- Authentication: JWT + bcrypt
- API: REST

## Requirements
- Node.js 20 or newer
- npm
- Git

## Quick start

Open the repository in VS Code or a GitHub Codespace.

### 1. Install backend dependencies
```bash
cd backend
cp .env.example .env
npm install
npm run dev
```
The API starts at `http://localhost:5000`. The SQLite database is created automatically at `backend/data/wms.sqlite` and seeded with demo records.

### 2. Install and run frontend
Open a second terminal:
```bash
cd frontend
npm install
npm run dev
```
Open the URL printed by Vite (normally `http://localhost:5173`).

### Demo login
- Email: `admin@wms.local`
- Password: `Admin@123`

**Change the demo password and JWT secret before any deployment.** The demo account is for local development only.

## GitHub / vscode.dev
1. Create a GitHub repository named `ceva-wms-simulator`.
2. Upload this folder or push it with Git:
```bash
git init
git add .
git commit -m "Initial Phase 1 WMS simulator"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ceva-wms-simulator.git
git push -u origin main
```
3. Open the repository at `https://vscode.dev/github/YOUR_USERNAME/ceva-wms-simulator`.
4. To execute Node.js and SQLite, use local VS Code or GitHub Codespaces. `vscode.dev` is a browser editor and does not itself run the backend.

## Phase 1 features
- Login / JWT authentication and role field
- Dashboard KPI summary
- Warehouse master CRUD
- SKU / item master CRUD
- Location master CRUD
- Inventory view and stock adjustment
- Customer order CRUD with order lines
- Basic validation and audit timestamps

## API overview
All endpoints except `/api/auth/login` require:
`Authorization: Bearer <token>`

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Current user |
| GET | `/api/dashboard` | KPI summary |
| GET/POST | `/api/warehouses` | List / create |
| PUT/DELETE | `/api/warehouses/:id` | Update / delete |
| GET/POST | `/api/skus` | List / create |
| PUT/DELETE | `/api/skus/:id` | Update / delete |
| GET/POST | `/api/locations` | List / create |
| PUT/DELETE | `/api/locations/:id` | Update / delete |
| GET | `/api/inventory` | Inventory list |
| POST | `/api/inventory/adjust` | Adjust stock |
| GET/POST | `/api/orders` | List / create |
| GET | `/api/orders/:id` | Order detail |
| PUT | `/api/orders/:id/status` | Update order status |

## Notes / next steps
- SQLite is used to make the starter easy to run. The schema is intentionally relational and can later be migrated to Oracle.
- Stock adjustment creates an inventory transaction record.
- Order creation validates warehouse and SKU references. Phase 1 does not yet reserve or allocate inventory.
- Add automated tests, pagination, stronger role-based permissions, CSRF strategy if using cookies, and production secrets before deployment.
- Never use real customer, employee, shipment, or proprietary production data in this learning project.
