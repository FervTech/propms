// ─────────────────────────────────────────────
// PropMS — App Config (config.js)
// Place this file at the root of your project.
//
// Do NOT put secrets here.
// All Supabase credentials live in env.js (gitignored).
// This file is safe to commit.
// ─────────────────────────────────────────────

const CONFIG = {

  APP_NAME:    'PropMS',
  APP_VERSION: '2.0.0',

  // Key used for localStorage (comm logs, documents, settings)
  DEMO_STORAGE_KEY: 'propms_data',

  // ── Subscription Plans ────────────────────
  // Prices in USD. Set price_monthly/yearly to 0 for free plans.
  // max_* = -1 means unlimited.
  PLANS: {
    free_trial: {
      id:            'free_trial',
      name:          'Free Trial',
      badge:         'Trial',
      price_monthly: 0,
      price_yearly:  0,
      trial_days:    14,
      max_properties: 3,
      max_tenants:    10,
      max_units:      10,
      max_documents:  5,
      color:          '#6366F1',
      features: [
        'dashboard',
        'properties',
        'tenants',
        'payments',
        'reports_basic',
      ],
    },

    basic: {
      id:            'basic',
      name:          'Basic',
      badge:         'Basic',
      price_monthly: 19.99,
      price_yearly:  199.99,
      max_properties: 10,
      max_tenants:    50,
      max_units:      50,
      max_documents:  20,
      color:          '#10B981',
      features: [
        'dashboard',
        'properties',
        'tenants',
        'payments',
        'maintenance',
        'expenses',
        'reports_basic',
        'export_csv',
      ],
    },

    pro: {
      id:            'pro',
      name:          'Pro',
      badge:         'Pro',
      price_monthly: 49.99,
      price_yearly:  499.99,
      max_properties: 50,
      max_tenants:    200,
      max_units:      200,
      max_documents:  100,
      color:          '#F59E0B',
      features: [
        'dashboard',
        'properties',
        'tenants',
        'payments',
        'maintenance',
        'expenses',
        'vendors',
        'units',
        'calendar',
        'documents',
        'reports_advanced',
        'export_csv',
        'export_json',
        'recurring',
        'comm_logs',
      ],
    },

    premium: {
      id:            'premium',
      name:          'Premium',
      badge:         'Premium',
      price_monthly: 99.99,
      price_yearly:  999.99,
      max_properties: -1,
      max_tenants:    -1,
      max_units:      -1,
      max_documents:  -1,
      color:          '#EF4444',
      features: [
        'dashboard',
        'properties',
        'tenants',
        'payments',
        'maintenance',
        'expenses',
        'vendors',
        'units',
        'calendar',
        'documents',
        'reports_advanced',
        'export_csv',
        'export_json',
        'recurring',
        'comm_logs',
        'api_access',
        'priority_support',
        'white_label',
      ],
    },
  },

  special: {
    id:            'special',
    name:          'Special',
    badge:         'Special',
    price_monthly: 0,
    price_yearly:  0,
    max_properties: -1,   // unlimited
    max_tenants:    -1,
    max_units:      -1,
    max_documents:  -1,
    color:          '#8B5CF6',  // purple
    features: [
      'dashboard',
      'properties',
      'tenants',
      'payments',
      'maintenance',
      'expenses',
      'vendors',
      'units',
      'calendar',
      'documents',
      'reports_advanced',
      'export_csv',
      'export_json',
      'recurring',
      'comm_logs',
      'api_access',
      'priority_support',
      'white_label',
    ],
  },

  // ── Feature label display names ───────────
  FEATURE_LABELS: {
    dashboard:        'Dashboard',
    properties:       'Properties',
    tenants:          'Tenants',
    payments:         'Payments',
    maintenance:      'Maintenance Requests',
    expenses:         'Expense Tracking',
    vendors:          'Vendor Management',
    units:            'Unit Manager',
    calendar:         'Calendar View',
    documents:        'Document Library',
    reports_basic:    'Basic Reports',
    reports_advanced: 'Advanced Reports & Analytics',
    export_csv:       'CSV Export',
    export_json:      'JSON Export',
    recurring:        'Recurring Payment Schedules',
    comm_logs:        'Tenant Communication Logs',
    api_access:       'API Access',
    priority_support: 'Priority Support',
    white_label:      'White Label / Custom Branding',
  },

};
