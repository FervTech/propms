// ─────────────────────────────────────────────
// PropMS — Configuration
// ─────────────────────────────────────────────
// Copy this file and fill in your real values to
// connect a live Supabase database.
//
// HOW TO USE:
//   1. Create a project at https://supabase.com
//   2. Go to Settings → API
//   3. Copy your "Project URL" and "anon public" key below
//   4. Set SUPABASE_CONFIGURED = true
//   5. Create the required tables (schema below)
// ─────────────────────────────────────────────

const CONFIG = {

  // ── Supabase ──────────────────────────────
  SUPABASE_URL: 'https://fjijydeyqruwcpodkfof.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_o4LkkCupGpCiv4Cvv2RNVw_H3nUJCXQ',
  SUPABASE_CONFIGURED: false,  // ← set true when credentials above are filled in

  // ── App ───────────────────────────────────
  APP_NAME: 'PropMS',
  APP_VERSION: '1.0.0',

  // ── Demo mode ─────────────────────────────
  // When SUPABASE_CONFIGURED = false, the app runs entirely on
  // localStorage. All changes persist across page reloads.
  DEMO_STORAGE_KEY: 'propms_demo_data',

};

// ─────────────────────────────────────────────
// REQUIRED DATABASE SCHEMA (Supabase SQL)
// Run these in the Supabase SQL editor:
// ─────────────────────────────────────────────
/*

-- Properties table
CREATE TABLE properties (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT DEFAULT 'apartment',
  status      TEXT DEFAULT 'vacant',
  address     TEXT,
  bedrooms    INT DEFAULT 0,
  bathrooms   NUMERIC(3,1) DEFAULT 0,
  rent        NUMERIC(12,2) DEFAULT 0,
  size        INT DEFAULT 0,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Tenants table
CREATE TABLE tenants (
  id           BIGSERIAL PRIMARY KEY,
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  email        TEXT,
  phone        TEXT,
  property_id  BIGINT REFERENCES properties(id) ON DELETE SET NULL,
  unit         TEXT,
  lease_start  DATE,
  lease_end    DATE,
  rent         NUMERIC(12,2) DEFAULT 0,
  status       TEXT DEFAULT 'active',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Payments table
CREATE TABLE payments (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
  amount      NUMERIC(12,2) NOT NULL,
  date        DATE,
  type        TEXT DEFAULT 'rent',
  status      TEXT DEFAULT 'pending',
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (optional but recommended)
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments   ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users full access (adjust as needed)
CREATE POLICY "allow_all" ON properties FOR ALL TO authenticated USING (true);
CREATE POLICY "allow_all" ON tenants    FOR ALL TO authenticated USING (true);
CREATE POLICY "allow_all" ON payments   FOR ALL TO authenticated USING (true);

*/
