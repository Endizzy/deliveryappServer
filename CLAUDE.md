# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands should be run from the `server/` directory:

```bash
# Start server (runs on port 4000)
npm start

# Development mode (same as start, no hot reload)
npm run dev

# Install dependencies
npm install

# Run tests (Node.js built-in test runner)
npm test
```

No build step or linting commands are configured.

## Architecture Overview

This is a **Node.js/Express delivery management API** with WebSocket support for real-time courier location tracking. It's a multi-tenant system where all data is scoped by `company_id`.

### Tech Stack
- **Runtime**: Node.js with ES6 modules
- **Framework**: Express.js 4.19
- **Database**: MySQL (mysql2/promise, raw SQL queries)
- **Auth**: JWT (30-minute expiry) + bcrypt
- **Real-time**: WebSocket (ws library)
- **Deployment**: Railway.app

### Project Structure

```
server/
├── index.js              # Entry point: Express + WebSocket server setup
├── db.js                 # MySQL connection pool
├── auth.js               # Auth routes + authMiddleware + roleMiddleware
├── currentOrder.js       # Orders router (factory pattern, receives broadcastToAdmins)
├── mobileOrdersRouter.js # Courier-facing orders API
├── menuApi.js            # Menu CRUD
├── companyUnits.js       # Staff/courier management
├── orderSupport.js       # Helper endpoints (couriers list, pickup points, menu search)
├── getUser.js            # GET /api/user/me
├── getCompany.js         # GET /api/company/me
└── companyLogo/          # Static files for company logos
```

### Key Architectural Patterns

1. **Router Factory Pattern**: `currentOrder.js` exports a factory function that receives `broadcastToAdmins` for WebSocket integration
   ```javascript
   export default function createCurrentOrderRouter(broadcastToAdmins) { ... }
   ```

2. **Multi-tenancy**: Every query filters by `company_id` from the JWT token. Helper functions resolve company context from various token formats.

3. **Database Transactions**: Order creation uses transactions with row locking for daily sequence allocation (`order_seq` per `order_seq_date`).

4. **No ORM**: All database access uses parameterized raw SQL queries via mysql2/promise.

### Authentication Flow

- `POST /api/auth/login` - User login (returns JWT with `userId`, `role`, `companyId`)
- `POST /api/auth/courierlogin` - Courier login (returns JWT with `unitId`, `role`, `companyId`, `unitNickname`)
- All protected routes use `authMiddleware` which injects `req.user` from decoded JWT

### Roles
- `client` - Regular users
- `courier` - Delivery staff (company_units)
- `admin` - Company administrators/pickup points

### WebSocket Protocol

Clients connect and send a `hello` message with their role:
- **Admins** receive `snapshot` with all courier locations, then real-time `location` updates
- **Couriers** send `location` messages with `{ lat, lng, speedKmh, orderId, status }`
- Order events: `order_created`, `order_updated`, `order_deleted`

### Database Schema (Key Tables)

- `users` - System users with `company_id` association
- `companies` - Delivery companies (owner, name, logo, phone, menu)
- `company_units` - Staff/couriers per company
- `current_orders` - Orders with status, customer info, address fields, items_json, amounts
- `menu` - Menu items per company
