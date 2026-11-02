# tengaPOS — Cloud POS & Inventory Management System

A premium, production-grade cloud-based POS and Inventory Management System built for African SMEs. Supports both **Retail POS** (blue theme) and **Restaurant POS** (green theme) modes.

## Tech Stack

- **Frontend:** React 19 + Vite + TailwindCSS v4
- **State:** Zustand + TanStack Query
- **Animations:** Framer Motion
- **Backend:** Supabase (PostgreSQL, Auth, Realtime, Storage, Edge Functions, RLS)
- **Offline:** IndexedDB via Dexie.js + PWA (vite-plugin-pwa)
- **Charts:** Recharts
- **Export:** xlsx, jsPDF, file-saver

## Getting Started

```bash
npm install
npm run dev
```

## Windows Desktop App

The Electron desktop app has a fail-closed license gate for first-time use. A device must receive a server-signed, device-bound license before local shop setup is available. The gate expects `VITE_DESKTOP_LICENSE_API_URL` and `VITE_DESKTOP_LICENSE_PUBLIC_KEY` at build time. The exact API and token contract is documented in [docs/DESKTOP-LICENSE-CONTRACT.md](docs/DESKTOP-LICENSE-CONTRACT.md). The online app/backend does not yet provide those endpoints or Super Admin desktop license management, so activation is intentionally unavailable until that service is implemented and deployed. Do not distribute an installer built without the production licensing service configuration.

For development, configure the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` environment values used for the web build, then run:

```bash
npm run desktop
```

Create a Windows installer with `npm run desktop:dist`; the installer is written to `release/`. The desktop shell serves the bundled app locally at `http://127.0.0.1:4179`. Installer artifacts are not committed to this source repository.

After activation, desktop shop, catalog, stock, checkout, and transaction history use local IndexedDB storage and are intended for one independent terminal. An active locally signed license has no offline expiry. The app attempts check-in on startup while online, immediately when connectivity returns, on foreground, and at least every 24 hours while online. If the OS reports online but the licensing service cannot be reached, the desktop shows an unblock/connectivity screen and retries; a firewall block cannot be distinguished reliably from an outage, DNS, captive-portal, or routing issue. Confirmed offline operation remains available. License events are stored separately from sales sync. Online payments and cloud integrations are unavailable in standalone mode. Local data does not automatically sync to another computer, and backup/restore is not yet implemented; protect the computer and back up its data before production use.

## Features

- **Dual POS Modes:** Retail (blue) + Restaurant (green) with theme switching
- **Enterprise Dashboard:** Revenue charts, analytics, alerts, staff activity
- **POS Checkout:** Product search, barcode/SKU lookup, cart, multiple payment methods
- **Inventory Management:** Products, categories, stock alerts, CSV/Excel import/export
- **Kitchen Display:** Real-time order queue with status tracking (Restaurant mode)
- **Task Management:** Create, assign, track staff tasks
- **Staff Management:** Role-based access (Vendor, Manager, Supervisor, Cashier, etc.)
- **Multi-Branch:** Branch-level inventory and performance tracking
- **Reports:** Revenue, orders, branch performance with export
- **Offline-First:** PWA with IndexedDB, background sync queue
- **Theme System:** Light/Dark mode + Retail/Restaurant accent colors
- **Export:** CSV, Excel, PDF, Access on every data table
- **ZIMRA Fiscalisation:** Optional fiscal compliance add-on
- **White Label:** Optional custom branding with tenant subdomains

## Business Model

| Plan | Price |
|------|-------|
| Hardware + System Combo | FREE for 6 months, $10/6mo renewal |
| Software Only | $50/month |
| ZIMRA Fiscalisation | $20/device/month |
| White Label Branding | $50 once-off |

## Architecture

- Multi-tenant SaaS with strict RLS isolation
- Every entity includes `tenant_id` + optional `branch_id`
- Role-based permissions (Developer + Vendor hierarchies)
- Offline queue with conflict resolution and retry logic
- PWA installable with cached assets

## License

Proprietary — All rights reserved.
