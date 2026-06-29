// ─────────────────────────────────────────────
// PropMS — Application Logic (v2) app.js
// ─────────────────────────────────────────────

// ── STATE ────────────────────────────────────
let properties    = [];
let tenants       = [];
let payments      = [];
let maintenances  = [];
let recurringSchedules = [];
let expenses      = [];
let vendors       = [];
let units         = [];
let documents     = [];

let currentPage         = 'dashboard';
let currentReportPeriod = 'monthly';
let currentExportRange  = '1d';
let currentReceiptPayId = null;
let _currentReceiptNo   = null;
let invoiceCounter      = 1000;

let globalSearchActive = false;

let tenantPage = 1, tenantPageSize = 10, tenantFilteredData = [];
let paymentPage = 1, paymentPageSize = 10, paymentFilteredData = [];
let maintPage = 1, maintPageSize = 10, maintFilteredData = [];

let selectedTenantIds  = new Set();
let selectedPaymentIds = new Set();

let pendingLeaseDoc = null;

// ── PAGE → FEATURE MAP (single source of truth) ──
const PAGE_FEATURE_MAP = {
  dashboard:   'dashboard',
  properties:  'properties',
  tenants:     'tenants',
  payments:    'payments',
  maintenance: 'maintenance',
  expenses:    'expenses',
  vendors:     'vendors',
  units:       'units',
  calendar:    'calendar',
  documents:   'documents',
  reports:     'reports_advanced',
  support:     null,   // always accessible — no plan required
  settings:    null,   // always accessible
};

// ── SIDEBAR COLLAPSE ──────────────────────────
let sidebarCollapsed = JSON.parse(localStorage.getItem('propms_sidebar_collapsed') || 'false');

function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const isMobile = window.innerWidth <= 700;
  if (isMobile) {
    sidebar.classList.toggle('mobile-open');
    document.body.classList.toggle('sidebar-mobile-open');
  } else {
    sidebarCollapsed = !sidebarCollapsed;
    sidebar.classList.toggle('collapsed', sidebarCollapsed);
    localStorage.setItem('propms_sidebar_collapsed', JSON.stringify(sidebarCollapsed));
  }
}

// ── RECEIPT COUNTER ─────────────────────────
function getNextReceiptNumber(prefix = 'RCP') {
  const today = new Date();
  const y = String(today.getFullYear()).slice(2);
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const dateKey = `${y}${m}${d}`;
  const storageKey = `propms_receipt_counter_${dateKey}`;
  let counter = parseInt(localStorage.getItem(storageKey) || '0', 10) + 1;
  localStorage.setItem(storageKey, String(counter));
  return `${prefix}-${dateKey}-${String(counter).padStart(2, '0')}`;
}

// ── SETTINGS ─────────────────────────────────
let appSettings = {};
const DEFAULT_SETTINGS = {
  currency: 'GHS', dateformat: 'DMY',
  lightMode: false, leaseAlerts: true, overdueAlerts: true,
  autoLateFee: false, lateFeePercent: 5,
  '2fa': false, companyName: '', businessAddress: '',
  contactEmail: '', contactPhone: '', logoDataUrl: ''
};

function loadSettings() {
  const saved = JSON.parse(localStorage.getItem('propms_settings') || '{}');
  appSettings = { ...DEFAULT_SETTINGS, ...saved };
}

function saveSetting(key, val) {
  appSettings[key] = val;
  localStorage.setItem('propms_settings', JSON.stringify(appSettings));

  if (currentUser && currentProfile) {
    saveSettingToSupabase(key, val);
  }

  if (key === 'currency' || key === 'dateformat') {
    if (currentPage === 'dashboard')   loadDashboard();
    if (currentPage === 'properties')  renderProperties();
    if (currentPage === 'tenants')     renderTenantsPage();
    if (currentPage === 'payments')    renderPaymentsPage();
    if (currentPage === 'reports')     renderReports();
  }
}

async function saveSettingToSupabase(key, val) {
  try {
    const client = getSupabaseClient();
    if (!client) return;
    const updatedSettings = { ...currentProfile.settings, [key]: val };
    const { error } = await client
      .from('user_profiles')
      .update({ settings: updatedSettings })
      .eq('id', currentUser.id);
    if (error) throw error;
    currentProfile.settings = updatedSettings;
  } catch (e) {
    // silent
  }
}

function loadSettingsFromProfile(profile) {
  if (profile.settings) {
    appSettings = { ...DEFAULT_SETTINGS, ...profile.settings };
    localStorage.setItem('propms_settings', JSON.stringify(appSettings));
  } else {
    saveSettingToSupabaseBulk(appSettings);
  }
}

async function saveSettingToSupabaseBulk(settings) {
  try {
    const client = getSupabaseClient();
    if (!client) return;
    const { error } = await client
      .from('user_profiles')
      .update({ settings: settings })
      .eq('id', currentUser.id);
    if (error) throw error;
    currentProfile.settings = settings;
  } catch (e) {
    // silent
  }
}

function getCurrencySymbol() {
  const map = { USD: '$', GHS: '₵', EUR: '€', GBP: '£', NGN: '₦', KES: 'KSh ', ZAR: 'R ' };
  return map[appSettings.currency] || '₵';
}

function fmt(n) {
  const sym = getCurrencySymbol();
  const num = Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sym + num;
}

// ── SUPABASE ─────────────────────────────────
const SUPABASE_CONFIGURED = (typeof window !== 'undefined' && window.ENV) ? window.ENV.CONFIGURED : false;
const PLAN_LIMITS = (typeof CONFIG !== 'undefined' && CONFIG.PLANS) ? CONFIG.PLANS : {};

let _sbClient = null;
function getSupabaseClient() {
  if (_sbClient) return _sbClient;
  if (SUPABASE_CONFIGURED && window.supabase && typeof window.supabase.createClient === 'function') {
    _sbClient = window.supabase.createClient(window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY);
  }
  return _sbClient;
}

function ensureSupabaseLoaded() {
  if (window.supabase) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

let currentUser    = null;
let currentProfile = null;
let currentPlan    = null;

const TABLE_MAP = {
  properties:   'properties',
  tenants:      'tenants',
  payments:     'payments',
  maintenances: 'maintenance_requests',
  recurring:    'recurring',
  expenses:     'expenses',
  vendors:      'vendors',
  units:        'units',
  comm_logs:    'comm_logs',
  documents:    'documents',
};

const sb = {
  async get(table) {
    if (!currentUser) return { data: [], error: { message: 'Not authenticated' } };
    const client  = getSupabaseClient();
    const sbTable = TABLE_MAP[table] || table;
    const { data, error } = await client.from(sbTable).select('*').order('created_at', { ascending: false });
    return { data: data || [], error };
  },

  async insert(table, body) {
    if (!currentUser) return { data: [], error: { message: 'Not authenticated' } };
    const client  = getSupabaseClient();
    const sbTable = TABLE_MAP[table] || table;
    const { data, error } = await client
      .from(sbTable)
      .insert({ ...body, user_id: currentUser.id })
      .select()
      .single();
    return { data: data ? [data] : [], error };
  },

  async update(table, id, body) {
    if (!currentUser) return { data: [], error: { message: 'Not authenticated' } };
    const client  = getSupabaseClient();
    const sbTable = TABLE_MAP[table] || table;
    const { data, error } = await client
      .from(sbTable)
      .update(body)
      .eq('id', id)
      .eq('user_id', currentUser.id)
      .select()
      .single();
    return { data: data ? [data] : [], error };
  },

  async delete(table, id) {
    if (!currentUser) return { error: { message: 'Not authenticated' } };
    const client  = getSupabaseClient();
    const sbTable = TABLE_MAP[table] || table;
    const { error } = await client
      .from(sbTable)
      .delete()
      .eq('id', id)
      .eq('user_id', currentUser.id);
    return { error };
  }
};

// ── PLAN LIMIT CHECK ──────────────────────────
function getPlanLimit(resource) {
  if (!currentPlan) return 999;
  const key = 'max_' + resource;
  const val = currentPlan[key];
  return (val === undefined || val === -1) ? Infinity : val;
}

async function checkPlanLimit(resource) {
  if (!currentProfile) return true;
  if (!currentPlan) return true;

  const status = currentProfile.plan_status;
  if (status === 'suspended' || status === 'cancelled') {
    showPlanBlockModal('suspended');
    return false;
  }

  if (currentProfile.plan_id === 'free_trial' && currentProfile.trial_ends_at) {
    if (new Date(currentProfile.trial_ends_at) < new Date()) {
      showPlanBlockModal('trial_expired');
      return false;
    }
  }

  const limit = getPlanLimit(resource);
  if (limit === Infinity) return true;

  const countMap = {
    properties: properties.length,
    tenants:    tenants.length,
    units:      units.length,
    documents:  documents.length,
  };
  const current = countMap[resource] ?? 0;
  if (current >= limit) {
    showPlanLimitModal(resource, current, limit);
    return false;
  }
  return true;
}

function showPlanBlockModal(reason) {
  const msg = reason === 'suspended'
    ? 'Your account has been suspended. Please contact support to reactivate.'
    : 'Your free trial has expired. Please contact your administrator to upgrade your plan.';
  openConfirmModal('Account Restricted', msg, 'danger', () => {});
  setTimeout(() => {
    const btn = document.getElementById('confirm-modal-ok');
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-arrow-up-right-dots"></i> Upgrade'; btn.className = 'btn btn-primary'; }
  }, 50);
}

function showPlanLimitModal(resource, current, limit) {
  const plan = currentPlan || PLAN_LIMITS[currentProfile?.plan_id] || { name: currentProfile?.plan_id || 'Current', color: '#6366F1' };
  openConfirmModal(
    'Plan Limit Reached',
    'You have reached the <strong>' + limit + ' ' + resource + '</strong> limit on your <strong>' + (plan.name || currentProfile?.plan_id || 'Current') + '</strong> plan. Upgrade to add more.',
    'danger',
    () => {}
  );
  setTimeout(() => {
    const btn = document.getElementById('confirm-modal-ok');
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-star"></i> Upgrade Plan'; btn.className = 'btn btn-primary'; }
  }, 50);
}

// ── FEATURE GATING ────────────────────────────
// Priority: DB plan features array → static config fallback → deny
function hasFeature(feature) {
  if (!feature) return true; // null feature = always accessible (e.g. settings)
  if (currentPlan && Array.isArray(currentPlan.features)) {
    return currentPlan.features.includes(feature);
  }
  const staticPlan = PLAN_LIMITS[currentProfile?.plan_id];
  if (staticPlan && Array.isArray(staticPlan.features)) {
    return staticPlan.features.includes(feature);
  }
  return false;
}

function requireFeature(feature, pageName) {
  if (hasFeature(feature)) return true;
  const planName = currentPlan?.name || PLAN_LIMITS[currentProfile?.plan_id]?.name || 'your current plan';
  toast('"' + pageName + '" is not available on ' + planName + '. Please upgrade.', 'error');
  return false;
}

// ── SIDEBAR FEATURE VISIBILITY ─────────────────
function refreshSidebarAccess() {
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    const page    = el.getAttribute('data-page');
    const feature = PAGE_FEATURE_MAP[page];
    // null = always show (settings); undefined = not in map = show by default
    const allowed = (feature === null || feature === undefined) ? true : hasFeature(feature);
    el.style.display = allowed ? '' : 'none';
  });

  // Hide section labels that have no visible nav items underneath them
  document.querySelectorAll('.nav-section-label').forEach(label => {
    let next = label.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains('nav-section-label')) {
      if (next.classList.contains('nav-item') && next.style.display !== 'none') {
        hasVisible = true;
        break;
      }
      next = next.nextElementSibling;
    }
    label.style.display = hasVisible ? '' : 'none';
  });
}

// ── LOGIN ─────────────────────────────────────
async function doLogin() {
  if (!SUPABASE_CONFIGURED) {
    showLoginError('Supabase is not configured. Update your env.js with valid credentials to enable login.');
    return;
  }

  const email = document.getElementById('login-email').value.trim();
  const pwd   = document.getElementById('login-password').value;
  if (!email || !pwd) { toast('Please enter your email and password', 'error'); return; }

  const btn = document.querySelector('#login-screen .btn-primary');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Signing in…';

  const resetBtn = () => {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
  };

  try {
    const client = getSupabaseClient();
    const { data: authData, error: authErr } = await client.auth.signInWithPassword({ email, password: pwd });

    if (authErr) {
      resetBtn();
      showLoginError(authErr.status === 400 ? 'Invalid email or password.' : authErr.message);
      return;
    }

    currentUser = authData.user;

    const { data: profile, error: profileErr } = await client
      .from('user_profiles')
      .select('*')
      .eq('id', currentUser.id)
      .single();

    if (profileErr || !profile) {
      resetBtn();
      showLoginError('Account profile not found. Please contact your administrator.');
      await client.auth.signOut();
      return;
    }

    currentProfile = profile;

    if (!currentProfile.plan_id) {
      await client.from('user_profiles').update({ plan_id: 'free_trial' }).eq('id', currentUser.id);
      currentProfile.plan_id = 'free_trial';
    }

    await loadPlan(client, currentProfile.plan_id);

    if (profile.plan_status === 'suspended') {
      resetBtn();
      showLoginError('Your account has been suspended. Reason: ' + (profile.suspended_reason || 'Contact support.'));
      await client.auth.signOut();
      return;
    }

    // Block expired free trials
    if (profile.plan_id === 'free_trial' && profile.trial_ends_at && new Date(profile.trial_ends_at) < new Date()) {
      resetBtn();
      showLoginError('Your free trial has expired. Please contact support to resubscribe.');
      await client.auth.signOut();
      return;
    }

    // Block expired paid subscriptions
    if (profile.plan_id !== 'free_trial' && profile.subscription_ends_at && new Date(profile.subscription_ends_at) < new Date()) {
      resetBtn();
      showLoginError('Your subscription has expired. Please contact support to renew.');
      await client.auth.signOut();
      return;
    }

    loadSettingsFromProfile(profile);
    startApp(email, profile);
  } catch (e) {
    resetBtn();
    showLoginError('Login failed: ' + e.message);
  }
}

// ── PLAN LOADER (shared by login + restoreSession) ──
async function loadPlan(client, planId) {
  const { data: planData, error: planError } = await client
    .from('plans')
    .select('*')
    .eq('id', planId)
    .single();

  if (!planError && planData) {
    currentPlan = planData;
  } else {
    // Fallback to static config only — no toasts
    currentPlan = PLAN_LIMITS[planId] || null;
  }
}

function showLoginError(msg) {
  let errEl = document.getElementById('login-error');
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.id = 'login-error';
    errEl.style.cssText = 'color:var(--danger);font-size:12.5px;padding:8px 12px;background:var(--danger-dim);border:1px solid var(--danger);border-radius:8px;margin-bottom:12px';
    const btn = document.querySelector('#login-screen .btn-primary');
    btn.parentNode.insertBefore(errEl, btn);
  }
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

// ── SESSION RESTORE ───────────────────────────
async function restoreSession() {
  const client = getSupabaseClient();
  if (!client) return;

  const { data: { session }, error } = await client.auth.getSession();
  if (error || !session) return;

  const user = session.user;
  const { data: profile, error: profileErr } = await client
    .from('user_profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) {
    await client.auth.signOut();
    return;
  }

  if (profile.plan_status === 'suspended') {
    showLoginError('Your account has been suspended. Reason: ' + (profile.suspended_reason || 'Contact support.'));
    await client.auth.signOut();
    return;
  }
  if (profile.plan_id === 'free_trial' && profile.trial_ends_at && new Date(profile.trial_ends_at) < new Date()) {
    showLoginError('Your free trial has expired. Please contact support to resubscribe.');
    await client.auth.signOut();
    return;
  }
  if (profile.plan_id !== 'free_trial' && profile.subscription_ends_at && new Date(profile.subscription_ends_at) < new Date()) {
    showLoginError('Your subscription has expired. Please contact support to renew.');
    await client.auth.signOut();
    return;
  }

  currentUser = user;
  currentProfile = profile;

  if (!currentProfile.plan_id) {
    await client.from('user_profiles').update({ plan_id: 'free_trial' }).eq('id', currentUser.id);
    currentProfile.plan_id = 'free_trial';
  }

  await loadPlan(client, currentProfile.plan_id);

  loadSettingsFromProfile(profile);
  startApp(user.email, profile);
}

// ── START APP ─────────────────────────────────
function startApp(email, profile) {
  const uname = email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  document.getElementById('sidebar-username').textContent = uname;

  const roleEl = document.querySelector('.user-role');
  if (roleEl) {
    roleEl.textContent = profile.is_admin ? 'Admin' : 'User';
  }

  updatePlanBadge(profile);

  const planBadge = document.getElementById('plan-badge');
  if (planBadge) planBadge.remove();
  const newBadge = document.createElement('span');
  newBadge.id = 'plan-badge';
  newBadge.style.cssText = 'font-size:10px;background:var(--accent-dim);color:var(--accent-hover);padding:2px 8px;border-radius:10px;margin-left:8px;display:inline-block;';
  newBadge.textContent = currentPlan ? currentPlan.name : 'No Plan';
  const userNameEl = document.getElementById('sidebar-username');
  if (userNameEl) {
    userNameEl.parentNode.insertBefore(newBadge, userNameEl.nextSibling);
  }

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-shell').style.display    = 'flex';

  // Apply sidebar access based on loaded plan before rendering anything
  refreshSidebarAccess();

  appInit();
}

// ── UPDATE PLAN BADGE ─────────────────────────
function updatePlanBadge(profile) {
  if (!profile) return;
  const planCard = document.querySelector('.settings-section .card');
  if (!planCard) return;

  const plan = currentPlan || PLAN_LIMITS[profile.plan_id] || { name: profile.plan_id, color: '#6366F1' };
  const statusColor = profile.plan_status === 'active' ? 'var(--success)' : 'var(--danger)';
  const trialInfo = profile.plan_id === 'free_trial' && profile.trial_ends_at
    ? '<div style="font-size:11px;color:var(--warning);margin-top:4px"><i class="fa-solid fa-clock"></i> Trial ends ' + new Date(profile.trial_ends_at).toLocaleDateString() + '</div>'
    : '';

  const showUpgrade = !['premium', 'special'].includes(profile.plan_id);

  planCard.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div>
        <div style="font-size:15px;font-weight:600">${plan.name || profile.plan_id} Plan</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
          ${plan.max_properties === -1 ? 'Unlimited' : plan.max_properties} properties ·
          ${plan.max_tenants === -1 ? 'Unlimited' : plan.max_tenants} tenants
        </div>
        ${trialInfo}
      </div>
      <span class="badge" style="background:${plan.color || '#6366F1'}22;color:${plan.color || '#6366F1'};border:1px solid ${plan.color || '#6366F1'}44">${plan.name || profile.plan_id}</span>
    </div>
    <div style="font-size:12px;margin-bottom:10px">Status: <strong style="color:${statusColor}">${profile.plan_status}</strong></div>
    ${showUpgrade
    ? '<button class="btn btn-primary btn-sm"><i class="fa-solid fa-star"></i> Upgrade Plan</button>'
    : '<div style="font-size:13px;color:var(--success)"><i class="fa-solid fa-circle-check"></i> You are on the best plan</div>'
  }
  `;
}

function toggleLoginPwd() {
  const input = document.getElementById('login-password');
  const eye   = document.getElementById('login-pwd-eye');
  if (input.type === 'password') { input.type = 'text'; eye.className = 'fa-solid fa-eye-slash'; }
  else { input.type = 'password'; eye.className = 'fa-solid fa-eye'; }
}

function togglePwdVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  const icon  = btn.querySelector('i');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fa-solid fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fa-solid fa-eye';
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') {
    doLogin();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    toggleGlobalSearch();
  }
  if (e.key === 'Escape') {
    closeGlobalSearch();
    document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
  }
});

// ── NAVIGATION ────────────────────────────────
function navigate(page) {
  const requiredFeature = PAGE_FEATURE_MAP[page];

  // Gate check: if feature is defined (not null/undefined) and user lacks it, block
  if (requiredFeature !== null && requiredFeature !== undefined && !hasFeature(requiredFeature)) {
    const planName = currentPlan?.name || PLAN_LIMITS[currentProfile?.plan_id]?.name || 'your current plan';
    toast(`"${page.charAt(0).toUpperCase() + page.slice(1)}" is not available on ${planName}. Please upgrade.`, 'error');
    // Fall back to the first accessible page
    const fallback = ['dashboard', 'properties', 'tenants', 'payments', 'maintenance', 'settings']
      .find(p => {
        const f = PAGE_FEATURE_MAP[p];
        return f === null || f === undefined || hasFeature(f);
      });
    if (fallback && fallback !== page) navigate(fallback);
    return;
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page)?.classList.add('active');
  const navEl = document.querySelector(`[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');
  currentPage = page;

  const titles = {
    dashboard: 'Dashboard', properties: 'Properties', tenants: 'Tenants',
    payments: 'Payments', maintenance: 'Maintenance', expenses: 'Expenses',
    vendors: 'Vendors', units: 'Unit Manager', calendar: 'Calendar',
    documents: 'Documents', reports: 'Reports & Analysis',
    support: 'Support', settings: 'Settings'
  };
  document.getElementById('topbar-title').textContent = titles[page] || page;

  const actions = document.getElementById('topbar-actions');
  actions.innerHTML = '';
  if (page === 'properties') {
    actions.innerHTML = `<button class="btn btn-primary" onclick="openPropertyModal()"><i class="fa-solid fa-plus"></i> Add Property</button>`;
  } else if (page === 'tenants') {
    actions.innerHTML = `<button class="btn btn-primary" onclick="openTenantModal()"><i class="fa-solid fa-plus"></i> Add Tenant</button>`;
  } else if (page === 'payments') {
    // Only show Schedules button if user has recurring feature
    const recurringBtn = hasFeature('recurring')
      ? `<button class="btn" onclick="openRecurringModal()" title="Recurring payments"><i class="fa-solid fa-repeat"></i> Schedules</button>`
      : '';
    actions.innerHTML = `
      ${recurringBtn}
      <button class="btn btn-primary" onclick="openPaymentModal()"><i class="fa-solid fa-plus"></i> Record Payment</button>`;
  } else if (page === 'maintenance') {
    actions.innerHTML = `<button class="btn btn-primary" onclick="openMaintenanceModal()"><i class="fa-solid fa-plus"></i> New Request</button>`;
  } else if (page === 'expenses') {
    actions.innerHTML = `<button class="btn btn-primary" onclick="openExpenseModal()"><i class="fa-solid fa-plus"></i> Add Expense</button>`;
  } else if (page === 'vendors') {
    actions.innerHTML = `<button class="btn btn-primary" onclick="openVendorModal()"><i class="fa-solid fa-plus"></i> Add Vendor</button>`;
  } else if (page === 'units') {
    actions.innerHTML = `<button class="btn btn-primary" onclick="openUnitModal()"><i class="fa-solid fa-plus"></i> Add Unit</button>`;
  } else if (page === 'documents') {
    actions.innerHTML = `<button class="btn btn-primary" onclick="openDocModal()"><i class="fa-solid fa-upload"></i> Upload Document</button>`;
  } else if (page === 'reports') {
    // Export buttons only if user has export features
    const exportBtn = (hasFeature('export_csv') || hasFeature('export_json'))
      ? `<button class="btn" onclick="openExportModal()"><i class="fa-solid fa-file-export"></i> Export</button>`
      : '';
    actions.innerHTML = exportBtn;
  }

  if (page === 'dashboard')   loadDashboard();
  if (page === 'properties')  renderProperties();
  if (page === 'tenants')     { tenantPage = 1; filterTenants(); }
  if (page === 'payments')    { paymentPage = 1; filterPayments(); }
  if (page === 'maintenance') { maintPage = 1; filterMaintenance(); }
  if (page === 'expenses')    renderExpenses();
  if (page === 'vendors')     renderVendors();
  if (page === 'units')       renderUnits();
  if (page === 'calendar')    renderCalendar();
  if (page === 'documents')   renderDocuments();
  if (page === 'reports')     renderReports();
  if (page === 'support')     renderSupportPage();
  if (page === 'settings')    loadSettingsPage();
}

// ── DATA LOAD ─────────────────────────────────
async function loadAll() {
  const [p, t, pay, m, r, ex, v, u, d] = await Promise.all([
    sb.get('properties'), sb.get('tenants'), sb.get('payments'),
    sb.get('maintenances'), sb.get('recurring'),
    sb.get('expenses'), sb.get('vendors'), sb.get('units'),
    sb.get('documents')
  ]);
  if (p.data)   properties         = p.data;
  if (t.data)   tenants            = t.data;
  if (pay.data) payments           = pay.data;
  if (m.data)   maintenances       = m.data;
  if (r.data)   recurringSchedules = r.data;
  if (ex.data)  expenses           = ex.data;
  if (v.data)   vendors            = v.data;
  if (u.data)   units              = u.data;
  if (d.data)   documents          = d.data;
  processRecurringSchedules();
  updateNavBadges();
}

function updateNavBadges() {
  document.getElementById('nb-props').textContent   = properties.length;
  document.getElementById('nb-tenants').textContent = tenants.filter(t => t.status === 'active').length;
  const openMaint = maintenances.filter(m => m.status !== 'resolved').length;
  const nb = document.getElementById('nb-maintenance');
  if (openMaint > 0) { nb.textContent = openMaint; nb.style.display = ''; }
  else { nb.style.display = 'none'; }
}

// ── LOGO HELPERS ──────────────────────────────
// FIX: #sidebar-logo-icon and #login-logo-icon ALWAYS show images/logo.svg.
// They NEVER use appSettings.logoDataUrl.
// User-uploaded logo (Settings) appears ONLY in #user-avatar and receipts/PDFs.

const PLATFORM_LOGO_SRC = 'images/logo.svg';

function refreshAllLogos() {
  // Sidebar brand logo → ALWAYS images/logo.svg (platform logo)
  const sli = document.getElementById('sidebar-logo-icon');
  if (sli) {
    sli.innerHTML = `<img src="${PLATFORM_LOGO_SRC}"
      style="width:32px;height:32px;border-radius:8px;object-fit:contain;"
      onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'fa-solid fa-building logo-icon-fallback'}))">`;
  }

  // Login screen logo → ALWAYS images/logo.svg (platform logo)
  const lliEl = document.getElementById('login-logo-icon');
  if (lliEl) {
    lliEl.innerHTML = `<img src="${PLATFORM_LOGO_SRC}"
      style="width:100%;height:100%;object-fit:contain;border-radius:10px;"
      onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'fa-solid fa-building'}))">`;
  }

  // User avatar in sidebar footer → user-uploaded logo from Settings
  const avatarEl = document.getElementById('user-avatar');
  if (avatarEl) {
    avatarEl.innerHTML = appSettings.logoDataUrl
      ? `<img src="${appSettings.logoDataUrl}" style="width:100%;height:100%;object-fit:contain;background:#fff;padding:2px;border-radius:50%;">`
      : `<span>PM</span>`;
  }

  // Settings page logo preview → user-uploaded logo
  const settingsPreview = document.getElementById('settings-logo-preview');
  if (settingsPreview) {
    settingsPreview.innerHTML = appSettings.logoDataUrl
      ? `<img class="logo-preview-img" src="${appSettings.logoDataUrl}" alt="Company logo" /><div><div style="font-size:13px;font-weight:600">${appSettings.companyName || 'Your Company'}</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px">Logo uploaded</div></div>`
      : `<div class="logo-preview-placeholder"><i class="fa-solid fa-building"></i></div><div><div style="font-size:13px;font-weight:600">${appSettings.companyName || 'Your Company'}</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px">No logo uploaded</div></div>`;
  }
}

// ── DASHBOARD ─────────────────────────────────
function loadDashboard() {
  const occupied    = properties.filter(p => p.status === 'occupied').length;
  const vacant      = properties.filter(p => p.status === 'vacant').length;
  const maintenance = properties.filter(p => p.status === 'maintenance').length;
  const activeTenants = tenants.filter(t => t.status === 'active').length;
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const revenue = payments
    .filter(p => p.date && p.date.startsWith(thisMonth) && p.status === 'paid')
    .reduce((s, p) => s + Number(p.amount), 0);
  const occPct = properties.length ? Math.round(occupied / properties.length * 100) : 0;

  document.getElementById('s-props').textContent   = properties.length;
  document.getElementById('s-tenants').textContent = activeTenants;
  document.getElementById('s-revenue').textContent = fmt(revenue);
  document.getElementById('s-occ').textContent     = occPct + '%';

  const ring = document.getElementById('occ-ring');
  if (ring) ring.style.strokeDashoffset = 314 - (314 * occPct / 100);
  const orpEl = document.getElementById('occ-ring-pct');
  if (orpEl) orpEl.textContent = occPct + '%';
  const loEl = document.getElementById('leg-occupied');    if (loEl) loEl.textContent = `${occupied} occupied`;
  const lvEl = document.getElementById('leg-vacant');      if (lvEl) lvEl.textContent = `${vacant} vacant`;
  const lmEl = document.getElementById('leg-maintenance'); if (lmEl) lmEl.textContent = `${maintenance} maintenance`;

  buildActivityFeed();
  buildUpcomingRent();
  buildDashMaintenance();
}

function buildActivityFeed() {
  const items = [];
  [...payments]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5)
    .forEach(pay => {
      const tenant = tenants.find(t => t.id == pay.tenant_id);
      const name = tenant ? `${tenant.first_name} ${tenant.last_name}` : 'Unknown';
      const iconClass = pay.status === 'paid' ? 'fa-circle-check' : pay.status === 'overdue' ? 'fa-circle-xmark' : 'fa-clock';
      const iconColor = pay.status === 'paid' ? 'var(--success)' : pay.status === 'overdue' ? 'var(--danger)' : 'var(--warning)';
      items.push({
        icon: `<i class="fa-solid ${iconClass}" style="color:${iconColor}"></i>`,
        text: `<strong>${name}</strong> — ${fmt(pay.amount)} ${pay.type.replace('_', ' ')} <em>${pay.status}</em>`,
        time: fmtDate(pay.date)
      });
    });
  [...tenants]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 2)
    .forEach(t => {
      items.push({ icon: `<i class="fa-solid fa-user-plus" style="color:var(--accent-hover)"></i>`, text: `Tenant <strong>${t.first_name} ${t.last_name}</strong> added`, time: fmtDate(t.created_at) });
    });
  const feedEl = document.getElementById('activity-feed');
  if (!feedEl) return;
  if (!items.length) {
    feedEl.innerHTML = `<div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-clipboard-list"></i></div><div class="empty-sub">No activity yet</div></div>`;
    return;
  }
  feedEl.innerHTML = items.slice(0, 6).map(i =>
    `<div class="feed-item"><div class="feed-icon">${i.icon}</div><div><div class="feed-text">${i.text}</div><div class="feed-time">${i.time}</div></div></div>`
  ).join('');
}

function buildUpcomingRent() {
  const now = new Date();
  const upcoming = tenants
    .filter(t => {
      if (t.status !== 'active' || !t.lease_end) return false;
      const days = Math.ceil((new Date(t.lease_end) - now) / (1000 * 60 * 60 * 24));
      return days > 0 && days <= 60;
    })
    .sort((a, b) => new Date(a.lease_end) - new Date(b.lease_end));

  const dcEl = document.getElementById('due-count');
  if (dcEl) dcEl.textContent = upcoming.length ? `(${upcoming.length})` : '';
  const urEl = document.getElementById('upcoming-rent');
  if (!urEl) return;
  if (!upcoming.length) {
    urEl.innerHTML = `<div class="empty-state"><div class="empty-sub">No leases expiring within 60 days</div></div>`;
    return;
  }
  urEl.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Tenant</th><th>Property</th><th>Lease End</th><th>Days Left</th><th>Monthly Rent</th></tr></thead>
    <tbody>${upcoming.map(t => {
    const prop = properties.find(p => p.id == t.property_id);
    const days = Math.ceil((new Date(t.lease_end) - now) / (1000 * 60 * 60 * 24));
    const cls  = days < 14 ? 'badge-danger' : days < 30 ? 'badge-warning' : 'badge-info';
    return `<tr>
        <td>${t.first_name} ${t.last_name}</td>
        <td>${prop ? prop.name : '—'}</td>
        <td>${fmtDate(t.lease_end)}</td>
        <td><span class="badge ${cls}">${days} days</span></td>
        <td class="payment-amount">${fmt(t.rent)}</td>
      </tr>`;
  }).join('')}</tbody></table></div>`;
}

function buildDashMaintenance() {
  const open  = maintenances.filter(m => m.status !== 'resolved').slice(0, 5);
  const dmEl  = document.getElementById('dash-maintenance');
  const dmcEl = document.getElementById('dash-maint-count');
  if (dmcEl) dmcEl.textContent = open.length ? `(${open.length} open)` : '';
  if (!dmEl) return;
  if (!open.length) {
    dmEl.innerHTML = `<div class="empty-state"><div class="empty-sub">No open maintenance requests</div></div>`;
    return;
  }
  const priorCls = { low: 'badge-info', medium: 'badge-warning', high: 'badge-danger', urgent: 'badge-danger' };
  const statCls  = { open: 'badge-danger', in_progress: 'badge-warning', resolved: 'badge-success' };
  dmEl.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Property</th><th>Issue</th><th>Priority</th><th>Status</th></tr></thead>
    <tbody>${open.map(m => {
    const prop = properties.find(p => p.id == m.property_id);
    return `<tr>
        <td>${prop ? prop.name : '—'}</td>
        <td>${m.title}</td>
        <td><span class="badge ${priorCls[m.priority] || 'badge-info'}">${m.priority}</span></td>
        <td><span class="badge ${statCls[m.status] || 'badge-info'}">${m.status.replace('_', ' ')}</span></td>
      </tr>`;
  }).join('')}</tbody></table></div>`;
}

// ── PROPERTIES ────────────────────────────────
function renderProperties(list) {
  const data = list || properties;
  const grid = document.getElementById('properties-grid');
  if (!data.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon"><i class="fa-solid fa-building"></i></div><div class="empty-title">No properties yet</div><button class="btn btn-primary" onclick="openPropertyModal()"><i class="fa-solid fa-plus"></i> Add Property</button></div>`;
    return;
  }
  const typeIcon = { apartment: 'fa-building', house: 'fa-house', condo: 'fa-home', commercial: 'fa-warehouse', store: 'fa-store' };
  grid.innerHTML = data.map(p => `
    <div class="prop-card" onclick="viewPropertyDetail('${p.id}')">
      <div class="prop-thumb">
        ${p.photo
    ? `<img src="${p.photo}" style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0">`
    : `<i class="fa-solid ${typeIcon[p.type] || 'fa-building'}" style="font-size:40px"></i>`}
        <span class="prop-type-badge badge badge-info">${p.type}</span>
      </div>
      <div class="prop-body">
        <div class="prop-name">${p.name}</div>
        <div class="prop-address"><i class="fa-solid fa-location-dot"></i> ${p.address}</div>
        <div class="prop-meta">
          ${p.total_units > 1 ? `<span><i class="fa-solid fa-layer-group"></i> ${p.total_units} units</span>` : ''}
          ${p.bedrooms > 0 ? `<span><i class="fa-solid fa-bed"></i> ${p.bedrooms} bed</span>` : ''}
          ${p.bathrooms > 0 ? `<span><i class="fa-solid fa-shower"></i> ${p.bathrooms} bath</span>` : ''}
          ${p.size ? `<span><i class="fa-solid fa-ruler-combined"></i> ${p.size} sqft</span>` : ''}
        </div>
      </div>
      <div class="prop-footer">
        <span class="prop-rent">${fmt(p.rent)}/mo</span>
        <span class="badge ${p.status === 'occupied' ? 'badge-success' : p.status === 'vacant' ? 'badge-warning' : 'badge-danger'}">
          <span class="badge-dot" style="background:currentColor"></span>${p.status}
        </span>
        <div class="action-btns" style="margin-left:auto">
          <button class="btn btn-sm btn-icon" title="Edit" onclick="event.stopPropagation();editProperty('${p.id}')"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm btn-icon btn-danger" title="Delete" onclick="event.stopPropagation();deleteProperty('${p.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
    </div>`).join('');
}

function filterProperties() {
  const q  = document.getElementById('prop-search').value.toLowerCase();
  const st = document.getElementById('prop-status-filter').value;
  const tp = document.getElementById('prop-type-filter').value;
  renderProperties(properties.filter(p =>
    (!q  || p.name.toLowerCase().includes(q) || p.address.toLowerCase().includes(q)) &&
    (!st || p.status === st) &&
    (!tp || p.type === tp)
  ));
}

function viewPropertyDetail(id) {
  const p = properties.find(p => p.id == id);
  if (!p) return;
  const propTenants  = tenants.filter(t => t.property_id == id && t.status === 'active');
  const propPayments = payments.filter(pay => {
    const t = tenants.find(t => t.id == pay.tenant_id);
    return t && t.property_id == id;
  });
  const totalRev  = propPayments.filter(pay => pay.status === 'paid').reduce((s, pay) => s + Number(pay.amount), 0);
  const typeIcon  = { apartment: 'fa-building', house: 'fa-house', condo: 'fa-home', commercial: 'fa-warehouse', store: 'fa-store' };
  const statCls   = { occupied: 'badge-success', vacant: 'badge-warning', maintenance: 'badge-danger' };
  const priorCls  = { low: 'badge-info', medium: 'badge-warning', high: 'badge-danger', urgent: 'badge-danger' };
  const maintReqs = maintenances.filter(m => m.property_id == id);

  document.getElementById('property-detail-content').innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
      <div style="width:64px;height:64px;border-radius:12px;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--text-muted)">
        <i class="fa-solid ${typeIcon[p.type] || 'fa-building'}"></i>
      </div>
      <div>
        <div style="font-size:18px;font-weight:600">${p.name}</div>
        <div style="font-size:13px;color:var(--text-secondary);margin-top:2px"><i class="fa-solid fa-location-dot"></i> ${p.address}</div>
        <span class="badge ${statCls[p.status] || 'badge-info'}" style="margin-top:6px"><span class="badge-dot" style="background:currentColor"></span>${p.status}</span>
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Property Details</div>
      <div class="detail-grid">
        <div class="detail-item"><label>Type</label><div class="detail-value" style="text-transform:capitalize">${p.type}</div></div>
        <div class="detail-item"><label>Monthly Rent</label><div class="detail-value" style="color:var(--success)">${fmt(p.rent)}</div></div>
        <div class="detail-item"><label>Total Units</label><div class="detail-value">${p.total_units || 1}</div></div>
        <div class="detail-item"><label>Unit Label</label><div class="detail-value">${p.unit_label || '—'}</div></div>
        <div class="detail-item"><label>Bedrooms</label><div class="detail-value">${p.bedrooms || '—'}</div></div>
        <div class="detail-item"><label>Bathrooms</label><div class="detail-value">${p.bathrooms || '—'}</div></div>
        <div class="detail-item"><label>Size</label><div class="detail-value">${p.size ? p.size + ' sqft' : '—'}</div></div>
        <div class="detail-item"><label>Total Revenue</label><div class="detail-value" style="color:var(--success)">${fmt(totalRev)}</div></div>
      </div>
      ${p.notes ? `<div style="margin-top:12px"><label>Notes</label><div style="background:var(--bg-elevated);padding:10px 12px;border-radius:8px;font-size:13px;margin-top:4px">${p.notes}</div></div>` : ''}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Current Tenants (${propTenants.length})</div>
      ${propTenants.length === 0
    ? '<div style="color:var(--text-muted);font-size:13px">No active tenants</div>'
    : `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Unit</th><th>Lease End</th><th>Rent</th></tr></thead>
           <tbody>${propTenants.map(t => `<tr>
             <td>${t.first_name} ${t.last_name}</td>
             <td>${t.unit || '—'}</td>
             <td>${fmtDate(t.lease_end)}</td>
             <td class="payment-amount">${fmt(t.rent)}</td>
           </tr>`).join('')}</tbody></table></div>`}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Maintenance Requests (${maintReqs.length})</div>
      ${maintReqs.length === 0
    ? '<div style="color:var(--text-muted);font-size:13px">No maintenance requests</div>'
    : `<div class="table-wrap"><table><thead><tr><th>Issue</th><th>Priority</th><th>Status</th></tr></thead>
           <tbody>${maintReqs.map(m => `<tr>
             <td>${m.title}</td>
             <td><span class="badge ${priorCls[m.priority] || 'badge-info'}">${m.priority}</span></td>
             <td><span class="badge ${m.status === 'resolved' ? 'badge-success' : m.status === 'in_progress' ? 'badge-warning' : 'badge-danger'}">${m.status.replace('_', ' ')}</span></td>
           </tr>`).join('')}</tbody></table></div>`}
    </div>`;

  document.getElementById('prop-detail-edit-btn').onclick = () => {
    closeModal('modal-property-detail');
    editProperty(id);
  };
  openModal('modal-property-detail');
}

// ── TENANTS ───────────────────────────────────
function renderTenantsPage() {
  const start    = (tenantPage - 1) * tenantPageSize;
  const pageData = tenantFilteredData.slice(start, start + tenantPageSize);
  const colors   = ['#6366F1', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4'];
  const tbody    = document.getElementById('tenants-tbody');

  if (!tenantFilteredData.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-users"></i></div><div class="empty-title">No tenants found</div></div></td></tr>`;
    document.getElementById('tenants-pagination').innerHTML = '';
    return;
  }

  tbody.innerHTML = pageData.map(t => {
    const prop     = properties.find(p => p.id == t.property_id);
    const initials = (t.first_name[0] || '') + (t.last_name[0] || '');
    const color    = colors[t.id % colors.length] || colors[0];
    const checked  = selectedTenantIds.has(t.id) ? 'checked' : '';
    return `<tr>
      <td><input type="checkbox" ${checked} onchange="toggleTenantSelect('${t.id}',this)" onclick="event.stopPropagation()"></td>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="tenant-avatar" style="background:${color}22;color:${color}">${initials}</div>
          <div>
            <div style="font-weight:500">${t.first_name} ${t.last_name}</div>
            <div style="font-size:11.5px;color:var(--text-secondary)">${t.email}</div>
          </div>
        </div>
      </td>
      <td>${prop ? prop.name : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${t.unit || '—'}</td>
      <td>${fmtDate(t.lease_end)}</td>
      <td class="payment-amount">${fmt(t.rent)}</td>
      <td><span class="badge ${t.status === 'active' ? 'badge-success' : 'badge-info'}">${t.status}</span></td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-icon" title="View details" onclick="event.stopPropagation();viewTenantDetail('${t.id}')"><i class="fa-solid fa-eye"></i></button>
          ${hasFeature('comm_logs') ? `<button class="btn btn-sm btn-icon" title="Communication log" onclick="event.stopPropagation();openCommLog('${t.id}')"><i class="fa-solid fa-comments"></i></button>` : ''}
          <button class="btn btn-sm btn-icon" title="Edit" onclick="event.stopPropagation();editTenant('${t.id}')"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm btn-icon btn-danger" title="Delete" onclick="event.stopPropagation();deleteTenant('${t.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');

  buildPagination('tenants-pagination', tenantPage, tenantFilteredData.length, tenantPageSize, 'goToTenantPage', 'setTenantPageSize');
  const allBox = document.getElementById('tenant-select-all');
  if (allBox) allBox.checked = pageData.length > 0 && pageData.every(t => selectedTenantIds.has(t.id));
}

function filterTenants() {
  const q  = document.getElementById('tenant-search')?.value.toLowerCase() || '';
  const st = document.getElementById('tenant-status-filter')?.value || '';
  tenantFilteredData = tenants.filter(t =>
    (!q  || `${t.first_name} ${t.last_name} ${t.email}`.toLowerCase().includes(q)) &&
    (!st || t.status === st)
  );
  tenantPage = 1;
  renderTenantsPage();
}

function goToTenantPage(p) {
  const totalPages = Math.ceil(tenantFilteredData.length / tenantPageSize) || 1;
  tenantPage = Math.max(1, Math.min(p, totalPages));
  renderTenantsPage();
}
function setTenantPageSize(s) { tenantPageSize = Number(s); tenantPage = 1; renderTenantsPage(); }

function toggleTenantSelect(id, el) {
  if (el.checked) selectedTenantIds.add(id); else selectedTenantIds.delete(id);
  updateTenantBulkBar();
}
function toggleSelectAllTenants(el) {
  const start    = (tenantPage - 1) * tenantPageSize;
  const pageData = tenantFilteredData.slice(start, start + tenantPageSize);
  pageData.forEach(t => el.checked ? selectedTenantIds.add(t.id) : selectedTenantIds.delete(t.id));
  renderTenantsPage();
  updateTenantBulkBar();
}
function clearTenantSelection() { selectedTenantIds.clear(); renderTenantsPage(); updateTenantBulkBar(); }
function updateTenantBulkBar() {
  const bar = document.getElementById('tenant-bulk-bar');
  const cnt = document.getElementById('tenant-bulk-count');
  if (selectedTenantIds.size > 0) { bar.style.display = ''; cnt.textContent = `${selectedTenantIds.size} selected`; }
  else { bar.style.display = 'none'; }
}

async function bulkDeleteTenants() {
  if (!selectedTenantIds.size) return;
  const count = selectedTenantIds.size;
  openConfirmModal(
    'Delete ' + count + ' Tenant' + (count > 1 ? 's' : ''),
    'Are you sure you want to delete <strong>' + count + ' tenant' + (count > 1 ? 's' : '') + '</strong>? All their payment history will also be permanently removed.',
    'danger',
    async () => {
      for (const id of selectedTenantIds) {
        await sb.delete('tenants', id);
        const tPays = payments.filter(p => p.tenant_id == id);
        for (const pay of tPays) await sb.delete('payments', pay.id);
      }
      selectedTenantIds.clear();
      await loadAll();
      filterTenants();
      updateTenantBulkBar();
      toast('Tenants deleted', 'success');
    }
  );
}

async function viewTenantDetail(id) {
  const t = tenants.find(t => t.id == id);
  if (!t) return;
  const prop           = properties.find(p => p.id == t.property_id);
  const tenantPayments = payments.filter(p => p.tenant_id == t.id);
  const totalPaid      = tenantPayments.filter(p => p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
  const now            = new Date();
  const daysLeft       = t.lease_end ? Math.ceil((new Date(t.lease_end) - now) / (1000 * 60 * 60 * 24)) : null;

  document.getElementById('tenant-detail-content').innerHTML = `
    <div class="detail-section">
      <div class="detail-section-title">Personal Information</div>
      <div class="detail-grid">
        <div class="detail-item"><label>Full Name</label><div class="detail-value">${t.first_name} ${t.last_name}</div></div>
        <div class="detail-item"><label>Status</label><div class="detail-value"><span class="badge ${t.status === 'active' ? 'badge-success' : 'badge-info'}">${t.status}</span></div></div>
        <div class="detail-item"><label>Email</label><div class="detail-value">${t.email || '—'}</div></div>
        <div class="detail-item"><label>Phone</label><div class="detail-value">${t.phone || '—'}</div></div>
        <div class="detail-item"><label>Emergency Contact</label><div class="detail-value">${t.emergency_name || '—'}</div></div>
        <div class="detail-item"><label>Emergency Phone</label><div class="detail-value">${t.emergency_phone || '—'}</div></div>
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Lease Details</div>
      <div class="detail-grid">
        <div class="detail-item"><label>Property</label><div class="detail-value">${prop ? prop.name : '—'}</div></div>
        <div class="detail-item"><label>Unit</label><div class="detail-value">${t.unit || '—'}</div></div>
        <div class="detail-item"><label>Lease Start</label><div class="detail-value">${fmtDate(t.lease_start)}</div></div>
        <div class="detail-item"><label>Lease End</label><div class="detail-value">${fmtDate(t.lease_end)}${daysLeft !== null ? ` <span class="badge ${daysLeft < 14 ? 'badge-danger' : daysLeft < 30 ? 'badge-warning' : 'badge-info'}">${daysLeft}d left</span>` : ''}</div></div>
        <div class="detail-item"><label>Move-in Date</label><div class="detail-value">${fmtDate(t.move_in) || '—'}</div></div>
        <div class="detail-item"><label>Move-out Date</label><div class="detail-value">${fmtDate(t.move_out) || '—'}</div></div>
        <div class="detail-item"><label>Monthly Rent</label><div class="detail-value" style="color:var(--success)">${fmt(t.rent)}</div></div>
        <div class="detail-item"><label>Total Paid</label><div class="detail-value" style="color:var(--success)">${fmt(totalPaid)}</div></div>
      </div>
      <div style="margin-top:12px">
        <label style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">Lease Document</label>
        <div style="margin-top:6px">
          ${t.lease_doc
    ? `<a class="btn btn-sm btn-success" href="${t.lease_doc}" download="lease-${t.first_name}-${t.last_name}"><i class="fa-solid fa-download"></i> Download Lease Document</a>`
    : `<span style="font-size:13px;color:var(--text-muted)"><i class="fa-solid fa-file-slash" style="margin-right:6px"></i>No lease document uploaded</span>`}
        </div>
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Recent Payments (${tenantPayments.length})</div>
      ${tenantPayments.length === 0
    ? '<div style="color:var(--text-muted);font-size:13px">No payments recorded</div>'
    : `<div class="table-wrap"><table>
           <thead><tr><th>Date</th><th>Amount</th><th>Type</th><th>Status</th></tr></thead>
           <tbody>${tenantPayments.slice(0, 5).map(pay => `<tr>
             <td>${fmtDate(pay.date)}</td>
             <td class="payment-amount">${fmt(pay.amount)}</td>
             <td style="text-transform:capitalize">${pay.type.replace('_', ' ')}</td>
             <td><span class="badge ${pay.status === 'paid' ? 'badge-success' : pay.status === 'pending' ? 'badge-warning' : 'badge-danger'}">${pay.status}</span></td>
           </tr>`).join('')}</tbody></table></div>`}
    </div>
    ${hasFeature('comm_logs') ? `
    <div class="detail-section">
      <div class="detail-section-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Communication Log</span>
        <button class="btn btn-sm" onclick="openCommLog('${t.id}')"><i class="fa-solid fa-plus"></i> Add Entry</button>
      </div>
      <div id="tenant-detail-comm-log"><div class="loading"><div class="spinner"></div></div></div>
    </div>` : ''}`;

  document.getElementById('tenant-detail-edit-btn').onclick = () => { closeModal('modal-tenant-detail'); editTenant(id); };
  openModal('modal-tenant-detail');
  if (hasFeature('comm_logs')) loadCommLogsIntoDetail(id);
}

async function loadCommLogsIntoDetail(tenantId) {
  const container = document.getElementById('tenant-detail-comm-log');
  if (!container) return;
  const client = getSupabaseClient();
  if (!client) { container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Unable to load logs.</div>'; return; }
  const { data: logs, error } = await client.from('comm_logs').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false });
  if (error) { container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Error loading logs.</div>'; return; }
  const typeIcon = { call: 'fa-phone', email: 'fa-envelope', message: 'fa-comment', visit: 'fa-handshake', notice: 'fa-file-lines' };
  if (!logs.length) { container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No communication recorded</div>'; return; }
  container.innerHTML = logs.slice(0, 5).map(c => `
    <div class="feed-item">
      <div class="feed-icon"><i class="fa-solid ${typeIcon[c.type] || 'fa-comment'}" style="color:var(--accent-hover)"></i></div>
      <div><div class="feed-text"><strong style="text-transform:capitalize">${c.type}</strong> — ${c.note}</div><div class="feed-time">${fmtDate(c.date)}</div></div>
    </div>`).join('');
}

// ── PAYMENTS ──────────────────────────────────
function renderPaymentsPage() {
  const start    = (paymentPage - 1) * paymentPageSize;
  const pageData = paymentFilteredData.slice(start, start + paymentPageSize);
  const tbody    = document.getElementById('payments-tbody');

  if (!paymentFilteredData.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-money-bill-wave"></i></div><div class="empty-title">No payments found</div></div></td></tr>`;
    document.getElementById('payments-pagination').innerHTML = '';
    return;
  }

  const statusCls = { paid: 'badge-success', pending: 'badge-warning', overdue: 'badge-danger' };
  tbody.innerHTML = pageData.map(pay => {
    const tenant  = tenants.find(t => t.id == pay.tenant_id);
    const prop    = tenant ? properties.find(p => p.id == tenant.property_id) : null;
    const checked = selectedPaymentIds.has(pay.id) ? 'checked' : '';
    return `<tr>
      <td><input type="checkbox" ${checked} onchange="togglePaymentSelect('${pay.id}',this)"></td>
      <td>${fmtDate(pay.date)}</td>
      <td>${tenant ? `${tenant.first_name} ${tenant.last_name}` : '—'}</td>
      <td style="font-size:12px;color:var(--text-secondary)">${prop ? prop.name : '—'}</td>
      <td class="payment-amount">${fmt(pay.amount)}</td>
      <td style="text-transform:capitalize">${pay.type.replace('_', ' ')}</td>
      <td><span class="badge ${statusCls[pay.status] || 'badge-info'}">${pay.status}</span></td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-icon" title="View details" onclick="viewPaymentDetail('${pay.id}')"><i class="fa-solid fa-eye"></i></button>
          <button class="btn btn-sm btn-icon" title="Edit" onclick="editPayment('${pay.id}')"><i class="fa-solid fa-pen"></i></button>
          ${pay.status !== 'paid' ? `<button class="btn btn-sm btn-icon btn-success" title="Mark as paid" onclick="quickMarkPaid('${pay.id}')"><i class="fa-solid fa-circle-check"></i></button>` : ''}
          <button class="btn btn-sm btn-icon btn-success" title="Receipt" onclick="openReceipt('${pay.id}')"><i class="fa-solid fa-receipt"></i></button>
          <button class="btn btn-sm btn-icon btn-danger" title="Delete" onclick="deletePayment('${pay.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');

  buildPagination('payments-pagination', paymentPage, paymentFilteredData.length, paymentPageSize, 'goToPaymentPage', 'setPaymentPageSize');
  const allBox = document.getElementById('payment-select-all');
  if (allBox) allBox.checked = pageData.length > 0 && pageData.every(p => selectedPaymentIds.has(p.id));
}

function populateMonthFilter() {
  const sel = document.getElementById('pay-month-filter');
  if (!sel) return;
  const existing = sel.value;
  const months   = [...new Set(payments.map(p => p.date ? p.date.slice(0, 7) : '').filter(Boolean))].sort().reverse();
  sel.innerHTML  = '<option value="">All months</option>' + months.map(m => {
    const d = new Date(m + '-01');
    return `<option value="${m}" ${m === existing ? 'selected' : ''}>${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</option>`;
  }).join('');
}

function filterPayments() {
  populateMonthFilter();
  const q       = document.getElementById('pay-search')?.value.toLowerCase() || '';
  const st      = document.getElementById('pay-status-filter')?.value || '';
  const mo      = document.getElementById('pay-month-filter')?.value || '';
  const type    = document.getElementById('pay-type-filter')?.value || '';
  const amtMin  = parseFloat(document.getElementById('pay-amount-min')?.value) || null;
  const amtMax  = parseFloat(document.getElementById('pay-amount-max')?.value) || null;
  const dateFrom = document.getElementById('pay-date-from')?.value || '';
  const dateTo   = document.getElementById('pay-date-to')?.value || '';

  paymentFilteredData = payments.filter(pay => {
    const tenant  = tenants.find(t => t.id == pay.tenant_id);
    const name    = tenant ? `${tenant.first_name} ${tenant.last_name}`.toLowerCase() : '';
    return (!q       || name.includes(q) || String(pay.amount).includes(q)) &&
      (!st      || pay.status === st) &&
      (!mo      || (pay.date && pay.date.startsWith(mo))) &&
      (!type    || pay.type === type) &&
      (amtMin === null || Number(pay.amount) >= amtMin) &&
      (amtMax === null || Number(pay.amount) <= amtMax) &&
      (!dateFrom || (pay.date && pay.date >= dateFrom)) &&
      (!dateTo   || (pay.date && pay.date <= dateTo));
  });
  paymentPage = 1;
  renderPaymentsPage();
}

function goToPaymentPage(p) {
  const totalPages = Math.ceil(paymentFilteredData.length / paymentPageSize) || 1;
  paymentPage = Math.max(1, Math.min(p, totalPages));
  renderPaymentsPage();
}
function setPaymentPageSize(s) { paymentPageSize = Number(s); paymentPage = 1; renderPaymentsPage(); }

function togglePaymentSelect(id, el) {
  if (el.checked) selectedPaymentIds.add(id); else selectedPaymentIds.delete(id);
  updatePaymentBulkBar();
}
function toggleSelectAllPayments(el) {
  const start    = (paymentPage - 1) * paymentPageSize;
  const pageData = paymentFilteredData.slice(start, start + paymentPageSize);
  pageData.forEach(p => el.checked ? selectedPaymentIds.add(p.id) : selectedPaymentIds.delete(p.id));
  renderPaymentsPage();
  updatePaymentBulkBar();
}
function clearPaymentSelection() { selectedPaymentIds.clear(); renderPaymentsPage(); updatePaymentBulkBar(); }
function updatePaymentBulkBar() {
  const bar = document.getElementById('payment-bulk-bar');
  const cnt = document.getElementById('payment-bulk-count');
  if (selectedPaymentIds.size > 0) { bar.style.display = ''; cnt.textContent = `${selectedPaymentIds.size} selected`; }
  else { bar.style.display = 'none'; }
}

async function bulkMarkPaid() {
  if (!selectedPaymentIds.size) return;
  for (const id of selectedPaymentIds) await sb.update('payments', id, { status: 'paid' });
  selectedPaymentIds.clear();
  await loadAll();
  filterPayments();
  updatePaymentBulkBar();
  toast('Payments marked as paid', 'success');
}

async function bulkDeletePayments() {
  if (!selectedPaymentIds.size) return;
  const count = selectedPaymentIds.size;
  openConfirmModal(
    'Delete ' + count + ' Payment' + (count > 1 ? 's' : ''),
    'Are you sure you want to permanently delete <strong>' + count + ' payment record' + (count > 1 ? 's' : '') + '</strong>? This cannot be undone.',
    'danger',
    async () => {
      for (const id of selectedPaymentIds) await sb.delete('payments', id);
      selectedPaymentIds.clear();
      await loadAll();
      filterPayments();
      updatePaymentBulkBar();
      toast('Payments deleted', 'success');
    }
  );
}

function viewPaymentDetail(id) {
  const pay    = payments.find(p => p.id == id);
  if (!pay) return;
  const tenant = tenants.find(t => t.id == pay.tenant_id);
  const prop   = tenant ? properties.find(p => p.id == tenant.property_id) : null;

  document.getElementById('payment-detail-content').innerHTML = `
    <div class="detail-section">
      <div class="detail-section-title">Payment Information</div>
      <div class="detail-grid">
        <div class="detail-item"><label>Amount</label><div class="detail-value" style="color:var(--success);font-family:var(--font-mono)">${fmt(pay.amount)}</div></div>
        <div class="detail-item"><label>Status</label><div class="detail-value"><span class="badge ${pay.status === 'paid' ? 'badge-success' : pay.status === 'pending' ? 'badge-warning' : 'badge-danger'}">${pay.status}</span></div></div>
        <div class="detail-item"><label>Date</label><div class="detail-value">${fmtDate(pay.date)}</div></div>
        <div class="detail-item"><label>Type</label><div class="detail-value" style="text-transform:capitalize">${pay.type.replace('_', ' ')}</div></div>
        <div class="detail-item"><label>Reference ID</label><div class="detail-value" style="font-family:var(--font-mono);font-size:12px">#${pay.id}</div></div>
        <div class="detail-item"><label>Recorded</label><div class="detail-value">${fmtDate(pay.created_at)}</div></div>
      </div>
      ${pay.notes ? `<div style="margin-top:12px"><label>Notes</label><div style="background:var(--bg-elevated);padding:10px 12px;border-radius:8px;font-size:13px;margin-top:4px">${pay.notes}</div></div>` : ''}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Tenant &amp; Property</div>
      <div class="detail-grid">
        <div class="detail-item"><label>Tenant</label><div class="detail-value">${tenant ? `${tenant.first_name} ${tenant.last_name}` : '—'}</div></div>
        <div class="detail-item"><label>Email</label><div class="detail-value">${tenant ? tenant.email : '—'}</div></div>
        <div class="detail-item"><label>Property</label><div class="detail-value">${prop ? prop.name : '—'}</div></div>
        <div class="detail-item"><label>Unit</label><div class="detail-value">${tenant ? (tenant.unit || '—') : '—'}</div></div>
      </div>
    </div>`;

  openModal('modal-payment-detail');
}

// ── MAINTENANCE ───────────────────────────────
function renderMaintenancePage() {
  const start    = (maintPage - 1) * maintPageSize;
  const pageData = maintFilteredData.slice(start, start + maintPageSize);
  const tbody    = document.getElementById('maintenance-tbody');

  if (!maintFilteredData.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-screwdriver-wrench"></i></div><div class="empty-title">No maintenance requests</div><button class="btn btn-primary" onclick="openMaintenanceModal()"><i class="fa-solid fa-plus"></i> New Request</button></div></td></tr>`;
    document.getElementById('maintenance-pagination').innerHTML = '';
    return;
  }

  const priorCls = { low: 'badge-info', medium: 'badge-warning', high: 'badge-danger', urgent: 'badge-danger' };
  const statCls  = { open: 'badge-danger', in_progress: 'badge-warning', resolved: 'badge-success' };
  tbody.innerHTML = pageData.map(m => {
    const prop   = properties.find(p => p.id == m.property_id);
    const tenant = m.tenant_id ? tenants.find(t => t.id == m.tenant_id) : null;
    return `<tr>
      <td>${fmtDate(m.created_at)}</td>
      <td>${prop ? prop.name : '—'}</td>
      <td>${tenant ? `${tenant.first_name} ${tenant.last_name}` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${m.title}</td>
      <td><span class="badge ${priorCls[m.priority] || 'badge-info'}">${m.priority}</span></td>
      <td><span class="badge ${statCls[m.status] || 'badge-info'}">${m.status.replace('_', ' ')}</span></td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-icon" title="View" onclick="viewMaintenanceDetail('${m.id}')"><i class="fa-solid fa-eye"></i></button>
          <button class="btn btn-sm btn-icon" title="Edit" onclick="editMaintenance('${m.id}')"><i class="fa-solid fa-pen"></i></button>
          ${m.status !== 'resolved' ? `<button class="btn btn-sm btn-icon btn-success" title="Mark resolved" onclick="resolveMaintenanceQuick('${m.id}')"><i class="fa-solid fa-check"></i></button>` : ''}
          <button class="btn btn-sm btn-icon btn-danger" title="Delete" onclick="deleteMaintenance('${m.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');

  buildPagination('maintenance-pagination', maintPage, maintFilteredData.length, maintPageSize, 'goToMaintPage', 'setMaintPageSize');
}

function filterMaintenance() {
  const q  = document.getElementById('maint-search')?.value.toLowerCase() || '';
  const st = document.getElementById('maint-status-filter')?.value || '';
  const pr = document.getElementById('maint-priority-filter')?.value || '';
  maintFilteredData = maintenances.filter(m => {
    const prop = properties.find(p => p.id == m.property_id);
    return (!q  || m.title.toLowerCase().includes(q) || (prop && prop.name.toLowerCase().includes(q))) &&
      (!st || m.status === st) &&
      (!pr || m.priority === pr);
  });
  maintPage = 1;
  renderMaintenancePage();
}

function goToMaintPage(p) {
  const totalPages = Math.ceil(maintFilteredData.length / maintPageSize) || 1;
  maintPage = Math.max(1, Math.min(p, totalPages));
  renderMaintenancePage();
}
function setMaintPageSize(s) { maintPageSize = Number(s); maintPage = 1; renderMaintenancePage(); }

function viewMaintenanceDetail(id) {
  const m    = maintenances.find(m => m.id == id);
  if (!m) return;
  const prop   = properties.find(p => p.id == m.property_id);
  const tenant = m.tenant_id ? tenants.find(t => t.id == m.tenant_id) : null;
  const priorCls = { low: 'badge-info', medium: 'badge-warning', high: 'badge-danger', urgent: 'badge-danger' };
  const statCls  = { open: 'badge-danger', in_progress: 'badge-warning', resolved: 'badge-success' };

  document.getElementById('maintenance-detail-content').innerHTML = `
    <div class="detail-section">
      <div class="detail-section-title">Request Details</div>
      <div class="detail-grid">
        <div class="detail-item"><label>Property</label><div class="detail-value">${prop ? prop.name : '—'}</div></div>
        <div class="detail-item"><label>Reported By</label><div class="detail-value">${tenant ? `${tenant.first_name} ${tenant.last_name}` : 'Management'}</div></div>
        <div class="detail-item"><label>Priority</label><div class="detail-value"><span class="badge ${priorCls[m.priority] || 'badge-info'}">${m.priority}</span></div></div>
        <div class="detail-item"><label>Status</label><div class="detail-value"><span class="badge ${statCls[m.status] || 'badge-info'}">${m.status.replace('_', ' ')}</span></div></div>
        <div class="detail-item"><label>Est. Cost</label><div class="detail-value">${m.cost ? fmt(m.cost) : '—'}</div></div>
        <div class="detail-item"><label>Date Reported</label><div class="detail-value">${fmtDate(m.created_at)}</div></div>
        ${m.status === 'resolved' ? `<div class="detail-item"><label>Date Resolved</label><div class="detail-value" style="color:var(--success)"><i class="fa-solid fa-circle-check" style="margin-right:5px"></i>${m.resolved_at ? fmtDate(m.resolved_at) : '—'}</div></div>` : ''}
      </div>
      <div style="margin-top:12px"><label>Issue</label><div style="background:var(--bg-elevated);padding:10px 12px;border-radius:8px;font-size:13px;margin-top:4px">${m.description || m.title}</div></div>
      ${m.notes ? `<div style="margin-top:10px"><label>Notes / Resolution</label><div style="background:var(--bg-elevated);padding:10px 12px;border-radius:8px;font-size:13px;margin-top:4px">${m.notes}</div></div>` : ''}
    </div>`;

  document.getElementById('maint-detail-edit-btn').onclick = () => { closeModal('modal-maintenance-detail'); editMaintenance(id); };
  openModal('modal-maintenance-detail');
}

async function resolveMaintenanceQuick(id) {
  await sb.update('maintenances', id, { status: 'resolved', resolved_at: new Date().toISOString() });
  await loadAll();
  filterMaintenance();
  toast('Marked as resolved', 'success');
}

// ── RECEIPT / INVOICE ─────────────────────────
function openReceipt(payId) {
  const pay = payments.find(p => p.id == payId);
  if (!pay) return;
  currentReceiptPayId = payId;
  const tenant    = tenants.find(t => t.id == pay.tenant_id);
  const prop      = tenant ? properties.find(p => p.id == tenant.property_id) : null;
  const isReceipt = pay.status === 'paid';
  const prefix = isReceipt ? 'RCP' : 'INV';
  const receiptNo = getNextReceiptNumber(prefix);
  _currentReceiptNo = receiptNo;
  document.getElementById('receipt-modal-title').textContent = isReceipt ? 'Payment Receipt' : 'Invoice';

  const co         = appSettings.companyName    || 'PropMS Management';
  const coAddr     = appSettings.businessAddress || '';
  const coEmail    = appSettings.contactEmail    || '';
  const tenantName = tenant ? `${tenant.first_name} ${tenant.last_name}` : 'Unknown';
  const tenantEmail = tenant ? tenant.email : '';
  const propName   = prop ? prop.name : '—';
  const unit       = tenant ? (tenant.unit || '—') : '—';

  const logoBlock = appSettings.logoDataUrl
    ? `<img class="receipt-logo-img" src="${appSettings.logoDataUrl}" alt="${co} logo" />`
    : `<div class="receipt-logo-icon"><i class="fa-solid fa-building"></i></div>`;

  document.getElementById('receipt-preview-wrap').innerHTML = `
    <div class="receipt-preview" id="receipt-print-area">
      <div class="receipt-header">
        <div>
          <div class="receipt-logo-wrap">
            ${logoBlock}
            <div>
              <div class="receipt-company-name">${co}</div>
              ${coAddr  ? `<div class="receipt-company-sub">${coAddr}</div>`  : ''}
              ${coEmail ? `<div class="receipt-company-sub">${coEmail}</div>` : ''}
            </div>
          </div>
        </div>
        <div class="receipt-meta">
          <div class="receipt-doc-title" style="color:${isReceipt ? '#10B981' : '#6366F1'}">${isReceipt ? 'RECEIPT' : 'INVOICE'}</div>
          <div><strong>${receiptNo}</strong></div>
          <div>Date: ${fmtDate(pay.date)}</div>
          <div style="margin-top:4px">
            <span style="padding:2px 8px;background:${isReceipt ? '#d1fae5' : '#fef3c7'};color:${isReceipt ? '#065f46' : '#92400e'};border-radius:20px;font-size:11px;font-weight:600">
              ${pay.status.toUpperCase()}
            </span>
          </div>
        </div>
      </div>
      <hr class="receipt-divider">
      <div class="receipt-from-to">
        <div>
          <div class="receipt-party-label">From</div>
          <div class="receipt-party-name">${co}</div>
          ${coAddr ? `<div style="font-size:12px;color:#666">${coAddr}</div>` : ''}
        </div>
        <div>
          <div class="receipt-party-label">To</div>
          <div class="receipt-party-name">${tenantName}</div>
          <div style="font-size:12px;color:#666">${tenantEmail}</div>
          <div style="font-size:12px;color:#666">${propName}${unit !== '—' ? ` · ${unit}` : ''}</div>
        </div>
      </div>
      <table class="receipt-table">
        <thead><tr><th>Description</th><th>Type</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>
          <tr>
            <td>${pay.notes || (pay.type.replace('_', ' ').charAt(0).toUpperCase() + pay.type.replace('_', ' ').slice(1))}</td>
            <td style="text-transform:capitalize">${pay.type.replace('_', ' ')}</td>
            <td style="text-align:right;font-weight:600">${fmt(pay.amount)}</td>
          </tr>
        </tbody>
      </table>
      <div class="receipt-total-row">
        <span>Total</span>
        <span style="font-size:16px">${fmt(pay.amount)}</span>
      </div>
      <div class="receipt-footer">
        Thank you for your payment · Generated by ${co} · ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
      </div>
    </div>`;

  openModal('modal-receipt');
}

function downloadReceiptPDF() {
  const pay = payments.find(p => p.id == currentReceiptPayId);
  if (!pay) return;

  const tenant      = tenants.find(t => t.id == pay.tenant_id);
  const prop        = tenant ? properties.find(p => p.id == tenant.property_id) : null;
  const isReceipt   = pay.status === 'paid';
  const filename    = `${isReceipt ? 'receipt' : 'invoice'}-${pay.id}.pdf`;
  const co          = appSettings.companyName     || 'PropMS Management';
  const coAddr      = appSettings.businessAddress || '';
  const coEmail     = appSettings.contactEmail    || '';
  const tenantName  = tenant ? `${tenant.first_name} ${tenant.last_name}` : 'Unknown';
  const tenantEmail = tenant ? tenant.email : '';
  const propName    = prop ? prop.name : '—';
  const unit        = tenant ? (tenant.unit || '') : '';
  const receiptNo   = _currentReceiptNo || getNextReceiptNumber(isReceipt ? 'RCP' : 'INV');
  const dateStr     = fmtDate(pay.date);
  const currencyCode = appSettings.currency || 'GHS';
  const amountStr   = currencyCode + ' ' + Number(pay.amount).toFixed(2);
  const typeStr     = pay.type.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  const noteStr     = pay.notes || typeStr;
  const genDate     = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W   = 595, margin = 40;
  let y     = margin;

  const text    = (str, x, yy, opts) => doc.text(String(str), x, yy, opts || {});
  const setFont = (style, size, color) => {
    doc.setFont('helvetica', style || 'normal');
    doc.setFontSize(size || 11);
    doc.setTextColor(...(color || [30, 30, 30]));
  };

  if (appSettings.logoDataUrl && appSettings.logoDataUrl.startsWith('data:image')) {
    try {
      const fmt2 = appSettings.logoDataUrl.includes('data:image/png') ? 'PNG' : 'JPEG';
      doc.addImage(appSettings.logoDataUrl, fmt2, margin, y, 40, 40);
    } catch (e) {
      doc.setFillColor(99, 102, 241);
      doc.rect(margin, y, 40, 40, 'F');
      setFont('bold', 18, [255, 255, 255]);
      text('P', margin + 13, y + 27);
    }
  } else {
    doc.setFillColor(99, 102, 241);
    doc.rect(margin, y, 40, 40, 'F');
    setFont('bold', 18, [255, 255, 255]);
    text('P', margin + 13, y + 27);
  }

  setFont('bold', 14, [15, 23, 42]);
  text(co, margin + 50, y + 14);
  setFont('normal', 9, [100, 116, 139]);
  if (coAddr)  text(coAddr,  margin + 50, y + 26);
  if (coEmail) text(coEmail, margin + 50, y + (coAddr ? 38 : 26));

  const docColor = isReceipt ? [16, 185, 129] : [99, 102, 241];
  setFont('bold', 20, docColor);
  doc.text(isReceipt ? 'RECEIPT' : 'INVOICE', W - margin, y + 14, { align: 'right' });
  setFont('normal', 9, [100, 116, 139]);
  text(receiptNo, W - margin, y + 28, { align: 'right' });
  text(`Date: ${dateStr}`, W - margin, y + 40, { align: 'right' });

  y += 56;
  const pillLabel = pay.status.toUpperCase();
  const pillColor = isReceipt ? [209, 250, 229] : [254, 243, 199];
  const pillText  = isReceipt ? [6, 95, 70]     : [146, 64, 14];
  const pillW     = doc.getTextWidth(pillLabel) + 14;
  doc.setFillColor(...pillColor);
  doc.roundedRect(W - margin - pillW, y, pillW, 16, 8, 8, 'F');
  setFont('bold', 8, pillText);
  text(pillLabel, W - margin - pillW / 2, y + 11, { align: 'center' });
  y += 26;

  doc.setDrawColor(...docColor);
  doc.setLineWidth(1.5);
  doc.line(margin, y, W - margin, y);
  doc.setLineWidth(0.5);
  doc.setDrawColor(220, 220, 220);
  y += 20;

  setFont('bold', 8, [148, 163, 184]);
  text('FROM', margin, y);
  text('TO', W / 2 + 10, y);
  y += 14;
  setFont('bold', 11, [15, 23, 42]);
  text(co, margin, y);
  text(tenantName, W / 2 + 10, y);
  y += 14;
  setFont('normal', 9, [100, 116, 139]);
  if (coAddr)      text(coAddr, margin, y);
  if (tenantEmail) text(tenantEmail, W / 2 + 10, y);
  y += 12;
  if (coEmail && coAddr) text(coEmail, margin, y);
  text(propName + (unit ? ` · ${unit}` : ''), W / 2 + 10, y);
  y += 28;

  doc.setFillColor(248, 248, 255);
  doc.rect(margin, y, W - margin * 2, 24, 'F');
  setFont('bold', 9, [148, 163, 184]);
  text('DESCRIPTION', margin + 8, y + 16);
  text('TYPE',        margin + 260, y + 16);
  text('AMOUNT',      W - margin - 8, y + 16, { align: 'right' });
  y += 24;
  doc.setDrawColor(230, 230, 240);
  doc.line(margin, y, W - margin, y);
  y += 18;

  setFont('normal', 10, [30, 30, 30]);
  let desc = noteStr;
  while (doc.getTextWidth(desc + '…') > 200 && desc.length > 0) desc = desc.slice(0, -1);
  if (desc !== noteStr) desc += '…';
  text(desc, margin + 8, y);
  setFont('normal', 10, [100, 116, 139]);
  text(typeStr, margin + 260, y);
  setFont('bold', 10, [30, 30, 30]);
  text(amountStr, W - margin - 8, y, { align: 'right' });
  y += 8;
  doc.line(margin, y, W - margin, y);
  y += 16;

  doc.setFillColor(248, 248, 255);
  doc.rect(margin, y, W - margin * 2, 32, 'F');
  setFont('bold', 11, [100, 116, 139]);
  text('TOTAL', margin + 8, y + 21);
  setFont('bold', 13, ...([docColor]));
  text(amountStr, W - margin - 8, y + 21, { align: 'right' });
  y += 52;

  doc.setDrawColor(230, 230, 240);
  doc.setLineWidth(0.5);
  doc.line(margin, y, W - margin, y);
  y += 14;
  setFont('normal', 8, [148, 163, 184]);
  text(`Thank you for your payment  ·  Generated by ${co}  ·  ${genDate}`, W / 2, y, { align: 'center' });

  doc.save(filename);
  toast('PDF downloaded', 'success');
}

// ── REPORTS ───────────────────────────────────
function setReportPeriod(period, btn) {
  currentReportPeriod = period;
  document.querySelectorAll('.period-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderReports();
}

function getReportDateRange() {
  const now    = new Date();
  const labels = { daily: 'Today', weekly: 'This Week', monthly: 'This Month', yearly: 'This Year' };
  let start;
  if (currentReportPeriod === 'daily')   { start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); }
  else if (currentReportPeriod === 'weekly')  { start = new Date(now); start.setDate(now.getDate() - 6); }
  else if (currentReportPeriod === 'monthly') { start = new Date(now.getFullYear(), now.getMonth(), 1); }
  else { start = new Date(now.getFullYear(), 0, 1); }
  return { start, end: now, label: labels[currentReportPeriod] };
}

function renderReports() {
  const { start, end, label } = getReportDateRange();
  document.getElementById('report-period-label').textContent = label;

  const periodPayments = payments.filter(p => {
    if (!p.date) return false;
    const d = new Date(p.date);
    return d >= start && d <= end;
  });

  const totalRevenue = periodPayments.filter(p => p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
  const pending      = periodPayments.filter(p => p.status === 'pending').reduce((s, p) => s + Number(p.amount), 0);
  const overdue      = periodPayments.filter(p => p.status === 'overdue').reduce((s, p) => s + Number(p.amount), 0);

  const periodExpenses = expenses.filter(e => {
    if (!e.date) return false;
    const d = new Date(e.date);
    return d >= start && d <= end;
  });
  const totalExpenses = periodExpenses.reduce((s, e) => s + Number(e.amount), 0);
  const netIncome     = totalRevenue - totalExpenses;
  const collectionRate = (totalRevenue + pending + overdue) > 0
    ? Math.round(totalRevenue / (totalRevenue + pending + overdue) * 100) : 0;

  document.getElementById('report-metrics').innerHTML = `
    <div class="report-metric"><div class="report-metric-label">Revenue Collected</div><div class="report-metric-value" style="color:var(--success)">${fmt(totalRevenue)}</div><div class="report-metric-sub">${periodPayments.filter(p => p.status === 'paid').length} transactions</div></div>
    <div class="report-metric"><div class="report-metric-label">Total Expenses</div><div class="report-metric-value" style="color:var(--danger)">${fmt(totalExpenses)}</div><div class="report-metric-sub">${periodExpenses.length} expense records</div></div>
    <div class="report-metric"><div class="report-metric-label">Net Income</div><div class="report-metric-value" style="color:${netIncome >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmt(netIncome)}</div><div class="report-metric-sub">revenue minus expenses</div></div>
    <div class="report-metric"><div class="report-metric-label">Pending</div><div class="report-metric-value" style="color:var(--warning)">${fmt(pending)}</div><div class="report-metric-sub">${periodPayments.filter(p => p.status === 'pending').length} payments</div></div>
    <div class="report-metric"><div class="report-metric-label">Overdue</div><div class="report-metric-value" style="color:var(--danger)">${fmt(overdue)}</div><div class="report-metric-sub">${periodPayments.filter(p => p.status === 'overdue').length} payments</div></div>
    <div class="report-metric"><div class="report-metric-label">Collection Rate</div><div class="report-metric-value" style="color:${collectionRate > 80 ? 'var(--success)' : collectionRate > 60 ? 'var(--warning)' : 'var(--danger)'}">${collectionRate}%</div><div class="report-metric-sub">paid vs total billed</div></div>`;

  renderRevenueChart();
  renderPaymentBreakdown(periodPayments);
  updateExportCount();
}

function renderRevenueChart() {
  const now      = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  let cols       = [];

  if (currentReportPeriod === 'daily') {
    const dayNames    = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const dow         = now.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    for (let i = 0; i < 7; i++) {
      const d  = new Date(now); d.setDate(now.getDate() + mondayOffset + i);
      const ds = d.toISOString().slice(0, 10);
      const rev = payments.filter(p => p.date === ds && p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
      cols.push({ label: dayNames[i], val: rev, highlight: ds === todayStr });
    }
  } else if (currentReportPeriod === 'weekly') {
    const yr = now.getFullYear(), mo = now.getMonth();
    const dim = new Date(yr, mo + 1, 0).getDate();
    const weeks = [
      { label: 'Week 1', start: 1,  end: 7   },
      { label: 'Week 2', start: 8,  end: 14  },
      { label: 'Week 3', start: 15, end: 21  },
      { label: 'Week 4', start: 22, end: dim },
    ];
    const currentDay = now.getDate();
    weeks.forEach(w => {
      const rev = payments.filter(p => {
        if (!p.date || p.status !== 'paid') return false;
        const d = new Date(p.date);
        return d.getFullYear() === yr && d.getMonth() === mo && d.getDate() >= w.start && d.getDate() <= w.end;
      }).reduce((s, p) => s + Number(p.amount), 0);
      cols.push({ label: w.label, val: rev, highlight: currentDay >= w.start && currentDay <= w.end });
    });
  } else if (currentReportPeriod === 'monthly') {
    const mNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const curMo  = now.getMonth();
    for (let mo = 0; mo < 12; mo++) {
      const rev = payments.filter(p => {
        if (!p.date || p.status !== 'paid') return false;
        const d = new Date(p.date);
        return d.getFullYear() === now.getFullYear() && d.getMonth() === mo;
      }).reduce((s, p) => s + Number(p.amount), 0);
      cols.push({ label: mNames[mo], val: rev, highlight: mo === curMo });
    }
  } else {
    const curYr = now.getFullYear();
    for (let yr = curYr - 4; yr <= curYr; yr++) {
      const rev = payments.filter(p => {
        if (!p.date || p.status !== 'paid') return false;
        return new Date(p.date).getFullYear() === yr;
      }).reduce((s, p) => s + Number(p.amount), 0);
      cols.push({ label: String(yr), val: rev, highlight: yr === curYr });
    }
  }

  const maxVal = Math.max(...cols.map(c => c.val), 1);
  document.getElementById('revenue-chart').innerHTML =
    '<div class="chart-bar-wrap">' +
    cols.map(c =>
      '<div class="chart-bar-col">' +
      '<div class="chart-bar-val">' + (c.val > 0 ? fmt(c.val) : '') + '</div>' +
      '<div class="chart-bar' + (c.highlight ? ' chart-bar-active' : '') + '" style="height:' + Math.max(4, c.val / maxVal * 100) + 'px" title="' + fmt(c.val) + '"></div>' +
      '<div class="chart-bar-label' + (c.highlight ? ' chart-bar-label-active' : '') + '">' + c.label + '</div>' +
      '</div>'
    ).join('') +
    '</div>';
}

function renderPaymentBreakdown(periodPayments) {
  const paid    = periodPayments.filter(p => p.status === 'paid').length;
  const pending = periodPayments.filter(p => p.status === 'pending').length;
  const overdue = periodPayments.filter(p => p.status === 'overdue').length;
  const total   = paid + pending + overdue || 1;
  const items   = [
    { label: 'Paid',    count: paid,    color: 'var(--success)', pct: Math.round(paid    / total * 100) },
    { label: 'Pending', count: pending, color: 'var(--warning)', pct: Math.round(pending / total * 100) },
    { label: 'Overdue', count: overdue, color: 'var(--danger)',  pct: Math.round(overdue / total * 100) },
  ];
  document.getElementById('payment-breakdown').innerHTML = items.map(i => `
    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
        <span style="color:${i.color};font-weight:500">${i.label}</span>
        <span style="color:var(--text-muted)">${i.count} payments · ${i.pct}%</span>
      </div>
      <div style="background:var(--bg-elevated);border-radius:4px;height:8px;overflow:hidden">
        <div style="height:100%;width:${i.pct}%;background:${i.color};border-radius:4px;transition:width 0.5s ease"></div>
      </div>
    </div>`).join('');
}

function printReport() {
  const { label } = getReportDateRange();
  const w         = window.open('', '_blank');
  const metricsHtml = document.getElementById('report-metrics').innerHTML;
  const chartHtml   = document.getElementById('revenue-chart').innerHTML;
  const breakHtml   = document.getElementById('payment-breakdown').innerHTML;
  const co = appSettings.companyName || 'PropMS';
  w.document.write(`<!DOCTYPE html><html><head><title>${co} — Report</title>
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
      body{font-family:'Sora',sans-serif;background:#fff;color:#0f172a;padding:32px;font-size:13px;}
      h1{font-size:20px;margin-bottom:4px}
      .sub{color:#64748b;font-size:12px;margin-bottom:24px}
      .metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}
      .metric{border:1px solid #e2e8f0;border-radius:8px;padding:14px}
      .metric-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;margin-bottom:6px}
      .metric-value{font-size:20px;font-weight:600;font-family:'DM Mono',monospace}
      .metric-sub{font-size:11px;color:#94a3b8}
      .chart-bar-wrap{display:flex;align-items:flex-end;gap:8px;height:120px;padding:0 4px}
      .chart-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}
      .chart-bar{width:100%;background:#e0e7ff;border-radius:4px 4px 0 0;min-height:4px}
      .chart-bar-label{font-size:10px;color:#94a3b8}
      .chart-bar-val{font-size:10px;color:#475569;font-family:'DM Mono',monospace}
      .section-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;border-bottom:1px solid #e2e8f0;padding-bottom:6px;margin:20px 0 12px}
      @media print{body{padding:16px}}
    </style></head><body>
    <h1>${co} — ${label} Report</h1>
    <div class="sub">Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
    <div class="section-title">Key Metrics</div>
    <div class="metrics">${metricsHtml.replace(/var\(--success\)/g, '#10B981').replace(/var\(--warning\)/g, '#F59E0B').replace(/var\(--danger\)/g, '#EF4444').replace(/var\(--text-muted\)/g, '#94A3B8')}</div>
    <div class="section-title">Revenue Trend</div>
    <div>${chartHtml.replace(/var\(--accent-dim\)/g, '#e0e7ff').replace(/var\(--accent\)/g, '#6366F1').replace(/var\(--text-muted\)/g, '#94A3B8').replace(/var\(--text-secondary\)/g, '#475569')}</div>
    <div class="section-title">Payment Status</div>
    <div>${breakHtml.replace(/var\(--bg-elevated\)/g, '#f1f5f9').replace(/var\(--success\)/g, '#10B981').replace(/var\(--warning\)/g, '#F59E0B').replace(/var\(--danger\)/g, '#EF4444').replace(/var\(--text-muted\)/g, '#94A3B8')}</div>
    <script>window.onload=()=>window.print()<\/script>
  </body></html>`);
  w.document.close();
}

// ── EXPORT ────────────────────────────────────
function openExportModal() {
  currentExportRange = '1d';
  document.querySelectorAll('#modal-export .range-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  document.getElementById('modal-export-custom').style.display = 'none';
  updateExportCount();
  openModal('modal-export');
}

function setExportRange(range, btn) {
  currentExportRange = range;
  document.querySelectorAll('#modal-export .range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('modal-export-custom').style.display = range === 'custom' ? 'block' : 'none';
  updateExportCount();
}

function getDateRangeFilter() {
  const now = new Date();
  if (currentExportRange === 'custom') {
    const from = document.getElementById('modal-export-from')?.value;
    const to   = document.getElementById('modal-export-to')?.value;
    return { from, to, custom: true };
  }
  const ranges = { '1d': 1, '7d': 7, '1m': 30, '3m': 90, '6m': 180 };
  const days   = ranges[currentExportRange] || 1;
  const start  = new Date(now); start.setDate(now.getDate() - days);
  return { start };
}

function getExportPayments() {
  const { from, to, start, custom } = getDateRangeFilter();
  if (custom) {
    if (!from || !to) return payments;
    return payments.filter(p => p.date && p.date >= from && p.date <= to);
  }
  return payments.filter(p => p.date && new Date(p.date) >= start);
}

function getExportExpenses() {
  const { from, to, start, custom } = getDateRangeFilter();
  if (custom) {
    if (!from || !to) return expenses;
    return expenses.filter(e => e.date && e.date >= from && e.date <= to);
  }
  return expenses.filter(e => e.date && new Date(e.date) >= start);
}

function updateExportCount() {
  const pCount = getExportPayments().length;
  const eCount = getExportExpenses().length;
  const el = document.getElementById('modal-export-count');
  if (el) el.textContent = pCount + ' payment' + (pCount !== 1 ? 's' : '') + ', ' + eCount + ' expense' + (eCount !== 1 ? 's' : '') + ' in range';
}

function exportCSV() {
  if (!hasFeature('export_csv')) {
    toast('CSV export is not available on your current plan. Please upgrade.', 'error');
    return;
  }
  const exportType = document.getElementById('modal-export-type')?.value || 'payments';
  if (exportType === 'expenses') {
    const data = getExportExpenses();
    if (!data.length) { toast('No expenses in selected range', 'error'); return; }
    const headers = ['Date', 'Property', 'Vendor', 'Category', 'Description', 'Amount', 'Notes'];
    const rows    = data.map(e => {
      const prop = properties.find(p => p.id == e.property_id);
      const vend = vendors.find(v => v.id == e.vendor_id);
      return [e.date, prop ? prop.name : '', vend ? vend.name : '', e.category, e.description, e.amount, e.notes || '']
        .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',');
    });
    downloadFile([headers.join(','), ...rows].join('\n'), 'propms-expenses-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv');
    toast('Exported ' + data.length + ' expense records', 'success');
  } else {
    const data = getExportPayments();
    if (!data.length) { toast('No payments in selected range', 'error'); return; }
    const headers = ['Date', 'Tenant', 'Property', 'Amount', 'Type', 'Status', 'Notes'];
    const rows    = data.map(pay => {
      const tenant = tenants.find(t => t.id == pay.tenant_id);
      const prop   = tenant ? properties.find(p => p.id == tenant.property_id) : null;
      return [pay.date, tenant ? tenant.first_name + ' ' + tenant.last_name : '', prop ? prop.name : '', pay.amount, pay.type, pay.status, pay.notes || '']
        .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',');
    });
    downloadFile([headers.join(','), ...rows].join('\n'), 'propms-payments-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv');
    toast('Exported ' + data.length + ' payment records', 'success');
  }
  closeModal('modal-export');
}

function exportJSON() {
  if (!hasFeature('export_json')) {
    toast('JSON export is not available on your current plan. Please upgrade.', 'error');
    return;
  }
  const exportType = document.getElementById('modal-export-type')?.value || 'payments';
  if (exportType === 'expenses') {
    const data = getExportExpenses().map(e => {
      const prop = properties.find(p => p.id == e.property_id);
      const vend = vendors.find(v => v.id == e.vendor_id);
      return Object.assign({}, e, { property_name: prop ? prop.name : null, vendor_name: vend ? vend.name : null });
    });
    if (!data.length) { toast('No expenses in selected range', 'error'); return; }
    downloadFile(JSON.stringify(data, null, 2), 'propms-expenses-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    toast('Exported ' + data.length + ' expense records', 'success');
  } else {
    const data = getExportPayments().map(pay => {
      const tenant = tenants.find(t => t.id == pay.tenant_id);
      const prop   = tenant ? properties.find(p => p.id == tenant.property_id) : null;
      return Object.assign({}, pay, { tenant_name: tenant ? tenant.first_name + ' ' + tenant.last_name : null, property_name: prop ? prop.name : null });
    });
    if (!data.length) { toast('No payments in selected range', 'error'); return; }
    downloadFile(JSON.stringify(data, null, 2), 'propms-payments-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    toast('Exported ' + data.length + ' payment records', 'success');
  }
  closeModal('modal-export');
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── SETTINGS ──────────────────────────────────
function loadSettingsPage() {
  document.getElementById('toggle-light').checked          = appSettings.lightMode || false;
  document.getElementById('settings-currency').value      = appSettings.currency || 'GHS';
  document.getElementById('settings-dateformat').value    = appSettings.dateformat || 'DMY';
  document.getElementById('toggle-lease-alerts').checked    = appSettings.leaseAlerts !== false;
  document.getElementById('toggle-overdue-alerts').checked  = appSettings.overdueAlerts !== false;
  document.getElementById('toggle-late-fee').checked        = appSettings.autoLateFee || false;
  document.getElementById('settings-late-fee-pct').value   = appSettings.lateFeePercent || 5;
  document.getElementById('toggle-2fa').checked            = appSettings['2fa'] || false;
  document.getElementById('settings-company').value       = appSettings.companyName || '';
  document.getElementById('settings-address').value       = appSettings.businessAddress || '';
  document.getElementById('settings-email').value         = appSettings.contactEmail || '';
  document.getElementById('settings-phone').value         = appSettings.contactPhone || '';
  refreshAllLogos();
  updatePlanBadge(currentProfile);
}

function toggleLightMode(checkbox) {
  saveSetting('lightMode', checkbox.checked);
  document.body.classList.toggle('light-mode', checkbox.checked);
  document.documentElement.classList.toggle('light-mode-pre', checkbox.checked);
}

function saveCompanySettings() {
  saveSetting('companyName',     document.getElementById('settings-company').value);
  saveSetting('businessAddress', document.getElementById('settings-address').value);
  saveSetting('contactEmail',    document.getElementById('settings-email').value);
  saveSetting('contactPhone',    document.getElementById('settings-phone').value);
  refreshAllLogos();
  toast('Company info saved', 'success');
}

function handleLogoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please select an image file', 'error'); return; }
  if (file.size > 2 * 1024 * 1024) { toast('Image must be under 2MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = e => { saveSetting('logoDataUrl', e.target.result); refreshAllLogos(); toast('Logo uploaded successfully', 'success'); };
  reader.readAsDataURL(file);
}

function removeLogo() { saveSetting('logoDataUrl', ''); refreshAllLogos(); toast('Logo removed', 'success'); }

// ── CHANGE PASSWORD ────────────────────────────
async function changePassword() {
  const currentPwd = document.getElementById('pwd-current').value;
  const newPwd     = document.getElementById('pwd-new').value;
  const confirmPwd = document.getElementById('pwd-confirm').value;

  if (!currentPwd || !newPwd || !confirmPwd) {
    toast('All fields are required', 'error');
    return;
  }
  if (newPwd !== confirmPwd) {
    toast('New passwords do not match', 'error');
    return;
  }
  if (newPwd.length < 8) {
    toast('Password must be at least 8 characters', 'error');
    return;
  }

  const btn = document.querySelector('#modal-change-password .btn-primary');
  setLoading(btn, true, 'Updating…');

  try {
    const client = getSupabaseClient();
    if (!client) throw new Error('Supabase client not available');

    const { error: signInError } = await client.auth.signInWithPassword({
      email: currentUser.email,
      password: currentPwd,
    });
    if (signInError) {
      toast('Current password is incorrect', 'error');
      setLoading(btn, false);
      return;
    }

    const { error: updateError } = await client.auth.updateUser({ password: newPwd });
    if (updateError) throw updateError;

    closeModal('modal-change-password');
    toast('Password updated successfully', 'success');
    document.getElementById('pwd-current').value = '';
    document.getElementById('pwd-new').value     = '';
    document.getElementById('pwd-confirm').value = '';
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  } finally {
    setLoading(btn, false);
  }
}

// ── PROFILE POPUP ─────────────────────────────
function toggleProfilePopup() { document.getElementById('profile-popup').classList.toggle('open'); }
function closeProfilePopup()  { document.getElementById('profile-popup').classList.remove('open'); }
function handleLogout()       { closeProfilePopup(); openModal('modal-logout'); }

async function confirmLogout() {
  closeModal('modal-logout');
  const client = getSupabaseClient();
  if (client) {
    try { await client.auth.signOut(); } catch (e) { /* ignore */ }
  }
  currentUser    = null;
  currentProfile = null;
  currentPlan    = null;
  toast('Logged out successfully', 'success');
  setTimeout(() => {
    document.getElementById('app-shell').style.display   = 'none';
    document.getElementById('login-screen').style.display = '';
    document.getElementById('login-email').value    = '';
    document.getElementById('login-password').value = '';
    const errEl = document.getElementById('login-error');
    if (errEl) errEl.style.display = 'none';
  }, 800);
}

document.addEventListener('click', e => {
  const popup = document.getElementById('profile-popup');
  const pill  = document.querySelector('.user-pill');
  if (popup && popup.classList.contains('open') && pill && !popup.contains(e.target) && !pill.contains(e.target)) {
    closeProfilePopup();
  }
  const panel = document.getElementById('notif-panel');
  const bell  = document.getElementById('notif-bell');
  if (panel && panel.classList.contains('open') && bell && !panel.contains(e.target) && !bell.contains(e.target)) {
    panel.classList.remove('open');
  }
});

// ── CONFIRM MODAL ─────────────────────────────
let _confirmCallback = null;
function openConfirmModal(title, message, type, callback) {
  _confirmCallback = callback;
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-body').innerHTML    = message;
  const btn = document.getElementById('confirm-modal-ok');
  btn.className = 'btn ' + (type === 'danger' ? 'btn-danger' : type === 'success' ? 'btn-success' : 'btn-primary');
  btn.innerHTML = type === 'danger' ? '<i class="fa-solid fa-trash"></i> Delete' : '<i class="fa-solid fa-check"></i> Confirm';
  openModal('modal-confirm');
}

async function confirmModalOk() {
  closeModal('modal-confirm');
  if (_confirmCallback) { await _confirmCallback(); _confirmCallback = null; }
}

// ── NOTIFICATIONS ─────────────────────────────
let notifications = [];
let readNotifIds  = new Set(JSON.parse(localStorage.getItem('propms_read_notifs') || '[]'));

function buildNotifications() {
  const now = new Date();
  notifications = [];

  if (appSettings.overdueAlerts) {
    payments.filter(p => p.status === 'overdue').forEach(p => {
      const t = tenants.find(t => t.id == p.tenant_id);
      notifications.push({
        id: 'pay-' + p.id,
        icon: 'fa-circle-xmark', color: 'var(--danger)',
        title: 'Overdue Payment',
        body:  (t ? t.first_name + ' ' + t.last_name : 'Tenant') + ' — ' + fmt(p.amount),
        time:  fmtDate(p.date)
      });
    });
  }

  if (appSettings.leaseAlerts) {
    tenants.filter(t => {
      if (t.status !== 'active' || !t.lease_end) return false;
      const days = Math.ceil((new Date(t.lease_end) - now) / 86400000);
      return days > 0 && days <= 60;
    }).forEach(t => {
      const days = Math.ceil((new Date(t.lease_end) - now) / 86400000);
      notifications.push({
        id: 'lease-' + t.id,
        icon: 'fa-calendar-xmark', color: days < 14 ? 'var(--danger)' : 'var(--warning)',
        title: 'Lease Expiring Soon',
        body:  t.first_name + ' ' + t.last_name + ' — ' + days + ' days left',
        time:  fmtDate(t.lease_end)
      });
    });
  }

  maintenances.filter(m => m.status !== 'resolved' && (m.priority === 'high' || m.priority === 'urgent')).forEach(m => {
    const prop = properties.find(p => p.id == m.property_id);
    notifications.push({
      id: 'maint-' + m.id,
      icon: 'fa-screwdriver-wrench', color: 'var(--warning)',
      title: m.priority === 'urgent' ? 'Urgent Maintenance' : 'High Priority Maintenance',
      body:  (prop ? prop.name + ' — ' : '') + m.title,
      time:  fmtDate(m.created_at)
    });
  });

  // ── Plan expiry alert: daily notification in the last 7 days before expiry ──
  // Checks free_trial → trial_ends_at, paid plans → subscription_ends_at
  if (currentProfile && currentProfile.plan_status !== 'suspended') {
    const expiryDate = currentProfile.plan_id === 'free_trial'
      ? currentProfile.trial_ends_at
      : currentProfile.subscription_ends_at;

    if (expiryDate) {
      const daysLeft = Math.ceil((new Date(expiryDate) - now) / 86400000);
      if (daysLeft > 0 && daysLeft <= 7) {
        const urgentColor = daysLeft <= 2 ? 'var(--danger)' : daysLeft <= 4 ? 'var(--warning)' : 'var(--accent-hover)';
        const planLabel   = currentProfile.plan_id === 'free_trial' ? 'Free Trial' : (currentPlan?.name || 'subscription');
        notifications.push({
          id:    'plan-expiry-' + new Date().toISOString().slice(0, 10),
          icon:  'fa-crown',
          color: urgentColor,
          title: daysLeft === 1 ? 'Plan Expires Tomorrow!' : 'Plan Expires in ' + daysLeft + ' Days',
          body:  'Your ' + planLabel + ' expires on ' + fmtDate(expiryDate) + '. Contact support to renew and avoid losing access.',
          time:  fmtDate(expiryDate)
        });
      }
    }
  }


  renderNotifBadge();
}

function renderNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const unread = notifications.filter(n => !readNotifIds.has(n.id)).length;
  if (unread > 0) { badge.textContent = unread > 9 ? '9+' : unread; badge.style.display = ''; }
  else { badge.style.display = 'none'; }
}

function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (isOpen) renderNotifPanel();
}

function markNotifRead(id) {
  readNotifIds.add(id);
  localStorage.setItem('propms_read_notifs', JSON.stringify([...readNotifIds]));
  renderNotifBadge();
  renderNotifPanel();
}

function markAllNotifsRead() {
  notifications.forEach(n => readNotifIds.add(n.id));
  localStorage.setItem('propms_read_notifs', JSON.stringify([...readNotifIds]));
  renderNotifBadge();
  renderNotifPanel();
}

function clearAllNotifs() {
  markAllNotifsRead();
  notifications = [];
  renderNotifBadge();
  renderNotifPanel();
}

function renderNotifPanel() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  const unread = notifications.filter(n => !readNotifIds.has(n.id));
  const read   = notifications.filter(n =>  readNotifIds.has(n.id));
  const all    = [...unread, ...read];

  const header = document.querySelector('.notif-panel-header');
  if (header) {
    header.innerHTML =
      '<span style="font-weight:600">Notifications</span>' +
      '<div style="display:flex;gap:6px">' +
      (notifications.length ? '<button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="markAllNotifsRead()">Mark all read</button>' : '') +
      (notifications.length ? '<button class="btn btn-sm btn-danger" style="padding:2px 8px;font-size:11px" onclick="clearAllNotifs()">Clear all</button>' : '') +
      '</div>';
  }

  if (!all.length) {
    list.innerHTML = '<div class="notif-empty"><i class="fa-solid fa-bell-slash"></i><div>All caught up! No active alerts.</div></div>';
    return;
  }

  list.innerHTML = all.map(n => {
    const isRead = readNotifIds.has(n.id);
    return '<div class="notif-item' + (isRead ? ' notif-read' : '') + '">' +
      '<div class="notif-icon" style="color:' + n.color + '"><i class="fa-solid ' + n.icon + '"></i></div>' +
      '<div class="notif-content">' +
      '<div class="notif-title">' + n.title + '</div>' +
      '<div class="notif-body">' + n.body + '</div>' +
      '<div class="notif-time">' + n.time + '</div>' +
      '</div>' +
      (!isRead ? '<button class="notif-read-btn" data-nid="' + n.id + '" onclick="markNotifRead(this.dataset.nid)" title="Mark as read"><i class="fa-solid fa-check"></i></button>' : '') +
      '</div>';
  }).join('');
}

// ── PROPERTY CRUD ─────────────────────────────
let pendingPropPhoto = null;

function openPropertyModal(prop) {
  document.getElementById('prop-modal-title').textContent = prop ? 'Edit Property' : 'Add Property';
  document.getElementById('prop-id').value         = prop ? prop.id : '';
  document.getElementById('prop-name').value       = prop ? prop.name : '';
  document.getElementById('prop-type').value       = prop ? prop.type : 'apartment';
  document.getElementById('prop-status').value     = prop ? prop.status : 'vacant';
  document.getElementById('prop-addr').value       = prop ? prop.address : '';
  document.getElementById('prop-units').value      = prop ? (prop.total_units || 1) : 1;
  document.getElementById('prop-unit-label').value = prop ? (prop.unit_label || '') : '';
  document.getElementById('prop-beds').value       = prop ? prop.bedrooms : '';
  document.getElementById('prop-baths').value      = prop ? prop.bathrooms : '';
  document.getElementById('prop-rent').value       = prop ? prop.rent : '';
  document.getElementById('prop-size').value       = prop ? prop.size : '';
  document.getElementById('prop-notes').value      = prop ? prop.notes : '';
  pendingPropPhoto = null;
  const preview = document.getElementById('prop-photo-preview');
  if (preview) {
    preview.innerHTML = (prop && prop.photo)
      ? '<img src="' + prop.photo + '" style="width:100%;height:140px;object-fit:cover;border-radius:8px;margin-bottom:8px">'
      : '';
  }
  openModal('modal-property');
}

function handlePropPhotoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please select an image file', 'error'); return; }
  if (file.size > 3 * 1024 * 1024) { toast('Image must be under 3MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    pendingPropPhoto = e.target.result;
    const preview = document.getElementById('prop-photo-preview');
    if (preview) preview.innerHTML = '<img src="' + e.target.result + '" style="width:100%;height:140px;object-fit:cover;border-radius:8px;margin-bottom:8px">';
    toast('Photo ready', 'success');
  };
  reader.readAsDataURL(file);
}

function editProperty(id) { const p = properties.find(p => p.id == id); if (p) openPropertyModal(p); }

async function saveProperty() {
  const id   = document.getElementById('prop-id').value;
  const name = document.getElementById('prop-name').value.trim();
  if (!name) return toast('Property name is required', 'error');
  if (!id && !(await checkPlanLimit('properties'))) return;

  const dup = properties.find(p => p.name.toLowerCase() === name.toLowerCase() && p.id != id);
  if (dup) return toast('A property with this name already exists', 'error');

  const existing = id ? properties.find(p => p.id == id) : null;
  const body = {
    name,
    type:        document.getElementById('prop-type').value,
    status:      document.getElementById('prop-status').value,
    address:     document.getElementById('prop-addr').value.trim(),
    total_units: Number(document.getElementById('prop-units').value) || 1,
    unit_label:  document.getElementById('prop-unit-label').value.trim(),
    bedrooms:    Number(document.getElementById('prop-beds').value)  || 0,
    bathrooms:   Number(document.getElementById('prop-baths').value) || 0,
    rent:        Number(document.getElementById('prop-rent').value)  || 0,
    size:        Number(document.getElementById('prop-size').value)  || 0,
    notes:       document.getElementById('prop-notes').value.trim(),
    photo:       pendingPropPhoto !== null ? pendingPropPhoto : (existing ? existing.photo : null)
  };

  const btn = document.getElementById('save-property-btn');
  setLoading(btn, true, 'Saving…');
  const { error } = id ? await sb.update('properties', id, body) : await sb.insert('properties', body);
  setLoading(btn, false, '<i class="fa-solid fa-floppy-disk"></i> Save Property');
  if (error) return toast('Error saving property: ' + error.message, 'error');
  await loadAll();
  closeModal('modal-property');
  renderProperties();
  toast(id ? 'Property updated' : 'Property added', 'success');
}

async function deleteProperty(id) {
  const p = properties.find(p => p.id == id);
  openConfirmModal('Delete Property',
    'Delete <strong>' + (p ? p.name : 'this property') + '</strong>? Tenants will be unlinked and related maintenance requests removed. Payments are kept.',
    'danger',
    async () => {
      const propTenants = tenants.filter(t => t.property_id == id);
      for (const t of propTenants) await sb.update('tenants', t.id, { property_id: null });
      const propMaint = maintenances.filter(m => m.property_id == id);
      for (const m of propMaint) await sb.delete('maintenances', m.id);
      await sb.delete('properties', id);
      await loadAll();
      renderProperties();
      toast('Property deleted', 'success');
    }
  );
}

// ── TENANT CRUD ───────────────────────────────
function openTenantModal(tenant) {
  document.getElementById('tenant-modal-title').textContent   = tenant ? 'Edit Tenant' : 'Add Tenant';
  document.getElementById('tenant-id').value                  = tenant ? tenant.id : '';
  document.getElementById('tenant-first').value               = tenant ? tenant.first_name : '';
  document.getElementById('tenant-last').value                = tenant ? tenant.last_name : '';
  document.getElementById('tenant-email').value               = tenant ? tenant.email : '';
  document.getElementById('tenant-phone').value               = tenant ? tenant.phone : '';
  document.getElementById('tenant-unit').value                = tenant ? tenant.unit : '';
  document.getElementById('tenant-lease-start').value         = tenant ? tenant.lease_start : '';
  document.getElementById('tenant-lease-end').value           = tenant ? tenant.lease_end : '';
  document.getElementById('tenant-rent').value                = tenant ? tenant.rent : '';
  document.getElementById('tenant-status').value              = tenant ? tenant.status : 'active';
  document.getElementById('tenant-emergency-name').value      = tenant ? (tenant.emergency_name || '') : '';
  document.getElementById('tenant-emergency-phone').value     = tenant ? (tenant.emergency_phone || '') : '';
  document.getElementById('tenant-movein').value              = tenant ? (tenant.move_in || '') : '';
  document.getElementById('tenant-moveout').value             = tenant ? (tenant.move_out || '') : '';
  pendingLeaseDoc = null;
  document.getElementById('lease-doc-label').textContent      = tenant && tenant.lease_doc ? 'Lease document attached' : 'Attach lease document…';
  document.getElementById('lease-doc-remove').style.display   = (tenant && tenant.lease_doc) ? '' : 'none';
  document.getElementById('lease-date-error').style.display   = 'none';
  const propSel = document.getElementById('tenant-property');
  propSel.innerHTML = '<option value="">— Select property —</option>' +
    properties.map(p => `<option value="${p.id}" ${tenant && tenant.property_id == p.id ? 'selected' : ''}>${p.name}</option>`).join('');
  openModal('modal-tenant');
}

function editTenant(id) { const t = tenants.find(t => t.id == id); if (t) openTenantModal(t); }

function validateLeaseDates() {
  const start = document.getElementById('tenant-lease-start').value;
  const end   = document.getElementById('tenant-lease-end').value;
  const errEl = document.getElementById('lease-date-error');
  if (start && end && end <= start) { errEl.style.display = ''; return false; }
  errEl.style.display = 'none';
  return true;
}

function handleLeaseDocUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('File must be under 5MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    pendingLeaseDoc = e.target.result;
    document.getElementById('lease-doc-label').textContent  = file.name;
    document.getElementById('lease-doc-remove').style.display = '';
    toast('Lease document attached', 'success');
  };
  reader.readAsDataURL(file);
}

function removeLeaseDoc() {
  pendingLeaseDoc = null;
  document.getElementById('tenant-lease-doc').value          = '';
  document.getElementById('lease-doc-label').textContent     = 'Attach lease document…';
  document.getElementById('lease-doc-remove').style.display  = 'none';
}

async function saveTenant() {
  if (!validateLeaseDates()) return toast('Lease end must be after lease start', 'error');
  const id        = document.getElementById('tenant-id').value;
  const firstName = document.getElementById('tenant-first').value.trim();
  const lastName  = document.getElementById('tenant-last').value.trim();
  if (!firstName || !lastName) return toast('Tenant name is required', 'error');
  if (!id && !(await checkPlanLimit('tenants'))) return;

  const propId = document.getElementById('tenant-property').value || null;
  const dup    = tenants.find(t =>
    t.first_name.toLowerCase() === firstName.toLowerCase() &&
    t.last_name.toLowerCase()  === lastName.toLowerCase()  &&
    String(t.property_id)      === String(propId) &&
    t.id != id
  );
  if (dup) return toast('This tenant is already assigned to this property', 'error');

  const existing = id ? tenants.find(t => t.id == id) : null;
  const body = {
    first_name:      firstName,
    last_name:       lastName,
    email:           document.getElementById('tenant-email').value.trim(),
    phone:           document.getElementById('tenant-phone').value.trim(),
    property_id:     propId,
    unit:            document.getElementById('tenant-unit').value.trim(),
    lease_start:     document.getElementById('tenant-lease-start').value || null,
    lease_end:       document.getElementById('tenant-lease-end').value || null,
    rent:            Number(document.getElementById('tenant-rent').value) || 0,
    status:          document.getElementById('tenant-status').value,
    lease_doc:       pendingLeaseDoc !== null ? pendingLeaseDoc : (existing ? existing.lease_doc : null),
    emergency_name:  document.getElementById('tenant-emergency-name').value.trim(),
    emergency_phone: document.getElementById('tenant-emergency-phone').value.trim(),
    move_in:         document.getElementById('tenant-movein').value || null,
    move_out:        document.getElementById('tenant-moveout').value || null
  };

  const btn = document.getElementById('save-tenant-btn');
  setLoading(btn, true, 'Saving…');
  const { error } = id ? await sb.update('tenants', id, body) : await sb.insert('tenants', body);
  setLoading(btn, false, '<i class="fa-solid fa-floppy-disk"></i> Save Tenant');
  if (error) return toast('Error saving tenant: ' + error.message, 'error');
  await loadAll();
  closeModal('modal-tenant');
  filterTenants();
  toast(id ? 'Tenant updated' : 'Tenant added', 'success');
}

async function deleteTenant(id) {
  const t     = tenants.find(t => t.id == id);
  const label = t ? t.first_name + ' ' + t.last_name : 'this tenant';
  openConfirmModal(
    'Delete Tenant',
    'Are you sure you want to delete <strong>' + label + '</strong>? Their payment history will also be permanently removed.',
    'danger',
    async () => {
      await sb.delete('tenants', id);
      const tPays = payments.filter(p => p.tenant_id == id);
      for (const pay of tPays) await sb.delete('payments', pay.id);
      await loadAll();
      filterTenants();
      toast('Tenant deleted', 'success');
    }
  );
}

// ── PAYMENT CRUD ──────────────────────────────
function openPaymentModal(pay) {
  document.getElementById('pay-modal-title').textContent = pay ? 'Edit Payment' : 'Record Payment';
  document.getElementById('pay-id').value     = pay ? pay.id : '';
  document.getElementById('pay-amount').value = pay ? pay.amount : '';
  document.getElementById('pay-date').value   = pay ? pay.date : new Date().toISOString().slice(0, 10);
  document.getElementById('pay-type').value   = pay ? pay.type : 'rent';
  document.getElementById('pay-status').value = pay ? pay.status : 'paid';
  document.getElementById('pay-notes').value  = pay ? pay.notes : '';
  const tenSel = document.getElementById('pay-tenant');
  tenSel.innerHTML = '<option value="">— Select tenant —</option>' +
    tenants.filter(t => t.status === 'active').map(t => `<option value="${t.id}" ${pay && pay.tenant_id == t.id ? 'selected' : ''}>${t.first_name} ${t.last_name}</option>`).join('');
  updateLateFeeHint();
  tenSel.onchange = updateLateFeeHint;
  document.getElementById('pay-type').onchange = updateLateFeeHint;
  openModal('modal-payment');
}

function editPayment(id) { const p = payments.find(p => p.id == id); if (p) openPaymentModal(p); }

function updateLateFeeHint() {
  const hintEl   = document.getElementById('late-fee-suggestion');
  if (!hintEl) return;
  if (!appSettings.autoLateFee) { hintEl.style.display = 'none'; return; }
  const type     = document.getElementById('pay-type')?.value;
  const tenantId = document.getElementById('pay-tenant')?.value;
  if (type !== 'late_fee' || !tenantId) { hintEl.style.display = 'none'; return; }
  const tenant = tenants.find(t => t.id == tenantId);
  if (!tenant) { hintEl.style.display = 'none'; return; }
  const pct = Number(appSettings.lateFeePercent) || 5;
  const fee = Math.round(tenant.rent * pct / 100);
  hintEl.style.display = '';
  hintEl.innerHTML = `<i class="fa-solid fa-circle-info"></i> Suggested late fee: <strong>${fmt(fee)}</strong> (${pct}% of ${fmt(tenant.rent)})
    <button type="button" class="btn btn-sm" style="margin-left:8px;padding:2px 8px" onclick="document.getElementById('pay-amount').value=${fee}">Apply</button>`;
}

async function savePayment() {
  const id   = document.getElementById('pay-id').value;
  const body = {
    tenant_id: document.getElementById('pay-tenant').value || null,
    amount:    Number(document.getElementById('pay-amount').value) || 0,
    date:      document.getElementById('pay-date').value,
    type:      document.getElementById('pay-type').value,
    status:    document.getElementById('pay-status').value,
    notes:     document.getElementById('pay-notes').value.trim()
  };
  if (!body.amount) return toast('Amount is required', 'error');

  if (!id) {
    const dup = payments.find(p =>
      p.tenant_id == body.tenant_id &&
      p.date      === body.date     &&
      Number(p.amount) === body.amount &&
      p.type      === body.type
    );
    if (dup && !confirm('A payment with the same tenant, date, amount, and type already exists. Record anyway?')) return;
  }

  const btn = document.getElementById('save-payment-btn');
  setLoading(btn, true, 'Saving…');
  const { error } = id ? await sb.update('payments', id, body) : await sb.insert('payments', body);
  setLoading(btn, false, '<i class="fa-solid fa-floppy-disk"></i> Save Payment');
  if (error) return toast('Error saving payment: ' + error.message, 'error');
  await loadAll();
  closeModal('modal-payment');
  filterPayments();
  toast(id ? 'Payment updated' : 'Payment recorded', 'success');
}

async function deletePayment(id) {
  const pay    = payments.find(p => p.id == id);
  const tenant = pay ? tenants.find(t => t.id == pay.tenant_id) : null;
  const label  = (tenant ? tenant.first_name + ' ' + tenant.last_name + ' — ' : '') + (pay ? fmt(pay.amount) : '');
  openConfirmModal(
    'Delete Payment',
    'Are you sure you want to permanently delete this payment record' + (label ? ' for <strong>' + label + '</strong>' : '') + '?',
    'danger',
    async () => {
      await sb.delete('payments', id);
      await loadAll();
      filterPayments();
      toast('Payment deleted', 'success');
    }
  );
}

async function quickMarkPaid(id) {
  await sb.update('payments', id, { status: 'paid' });
  await loadAll();
  filterPayments();
  toast('Payment marked as paid', 'success');
}

// ── MAINTENANCE CRUD ──────────────────────────
function openMaintenanceModal(m) {
  document.getElementById('maint-modal-title').textContent = m ? 'Edit Request' : 'New Maintenance Request';
  document.getElementById('maint-id').value       = m ? m.id : '';
  document.getElementById('maint-title').value    = m ? m.title : '';
  document.getElementById('maint-desc').value     = m ? m.description : '';
  document.getElementById('maint-priority').value = m ? m.priority : 'medium';
  document.getElementById('maint-status').value   = m ? m.status : 'open';
  document.getElementById('maint-cost').value     = m ? m.cost : '';
  document.getElementById('maint-notes').value    = m ? m.notes : '';
  const propSel = document.getElementById('maint-property');
  propSel.innerHTML = '<option value="">— Select property —</option>' +
    properties.map(p => `<option value="${p.id}" ${m && m.property_id == p.id ? 'selected' : ''}>${p.name}</option>`).join('');
  const tenSel = document.getElementById('maint-tenant');
  tenSel.innerHTML = '<option value="">— Select tenant (optional) —</option>' +
    tenants.filter(t => t.status === 'active').map(t => `<option value="${t.id}" ${m && m.tenant_id == t.id ? 'selected' : ''}>${t.first_name} ${t.last_name}</option>`).join('');
  openModal('modal-maintenance');
}

function editMaintenance(id) { const m = maintenances.find(m => m.id == id); if (m) openMaintenanceModal(m); }

async function saveMaintenance() {
  const id          = document.getElementById('maint-id').value;
  const maintStatus = document.getElementById('maint-status').value;
  const existingMaint = id ? maintenances.find(m => m.id == id) : null;
  const body = {
    property_id: document.getElementById('maint-property').value || null,
    tenant_id:   document.getElementById('maint-tenant').value   || null,
    title:       document.getElementById('maint-title').value.trim(),
    description: document.getElementById('maint-desc').value.trim(),
    priority:    document.getElementById('maint-priority').value,
    status:      maintStatus,
    cost:        Number(document.getElementById('maint-cost').value) || 0,
    notes:       document.getElementById('maint-notes').value.trim(),
    resolved_at: maintStatus === 'resolved'
      ? (existingMaint && existingMaint.resolved_at ? existingMaint.resolved_at : new Date().toISOString())
      : null
  };
  if (!body.title)       return toast('Issue title is required', 'error');
  if (!body.property_id) return toast('Please select a property', 'error');
  const btn = document.getElementById('save-maint-btn');
  setLoading(btn, true, 'Saving…');
  const { error } = id ? await sb.update('maintenances', id, body) : await sb.insert('maintenances', body);
  setLoading(btn, false, '<i class="fa-solid fa-floppy-disk"></i> Save Request');
  if (error) return toast('Error saving request: ' + error.message, 'error');
  await loadAll();
  closeModal('modal-maintenance');
  filterMaintenance();
  toast(id ? 'Request updated' : 'Request created', 'success');
}

async function deleteMaintenance(id) {
  const m = maintenances.find(m => m.id == id);
  openConfirmModal(
    'Delete Maintenance Request',
    'Are you sure you want to delete the request <strong>' + (m ? m.title : '') + '</strong>? This cannot be undone.',
    'danger',
    async () => {
      await sb.delete('maintenances', id);
      await loadAll();
      filterMaintenance();
      toast('Request deleted', 'success');
    }
  );
}

// ── COMMUNICATION LOG ─────────────────────────
function openCommLog(tenantId) {
  if (!hasFeature('comm_logs')) {
    toast('Communication logs are not available on your current plan. Please upgrade.', 'error');
    return;
  }
  document.getElementById('comm-tenant-id').value = tenantId;
  document.getElementById('comm-date').value      = new Date().toISOString().slice(0, 10);
  document.getElementById('comm-note').value      = '';
  refreshCommLog(tenantId);
  openModal('modal-comm-log');
}

async function refreshCommLog(tenantId) {
  const client = getSupabaseClient();
  if (!client) return;

  const { data: logs, error } = await client
    .from('comm_logs')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('Failed to load comm logs:', error.message);
    document.getElementById('comm-log-content').innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">Error loading communication log.</div>';
    return;
  }

  const tenant = tenants.find(t => t.id == tenantId);
  const typeIcon = { call: 'fa-phone', email: 'fa-envelope', message: 'fa-comment', visit: 'fa-handshake', notice: 'fa-file-lines' };

  const logHtml = logs.length === 0
    ? `<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No entries yet for ${tenant ? tenant.first_name : 'this tenant'}.</div>`
    : logs.map(c => `
      <div class="feed-item" style="gap:10px;align-items:flex-start">
        <div class="feed-icon" style="margin-top:2px"><i class="fa-solid ${typeIcon[c.type] || 'fa-comment'}" style="color:var(--accent-hover)"></i></div>
        <div style="flex:1">
          <div class="feed-text"><strong style="text-transform:capitalize">${c.type}</strong> — ${c.note}</div>
          <div class="feed-time">${fmtDate(c.date)}</div>
        </div>
        <button class="btn btn-sm btn-icon btn-danger" onclick="deleteCommLog('${c.id}','${tenantId}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
      </div>`).join('');

  document.getElementById('comm-log-content').innerHTML = `<div style="max-height:280px;overflow-y:auto">${logHtml}</div>`;
}

async function addCommLog() {
  const tenantId = document.getElementById('comm-tenant-id').value;
  const note     = document.getElementById('comm-note').value.trim();
  const date     = document.getElementById('comm-date').value;
  const type     = document.getElementById('comm-type').value;

  if (!note) { toast('Please enter a note', 'error'); return; }

  const client = getSupabaseClient();
  if (!client) { toast('Supabase client not available', 'error'); return; }

  const { data, error } = await client
    .from('comm_logs')
    .insert({
      tenant_id: tenantId,
      user_id: currentUser.id,
      type: type,
      date: date,
      note: note
    })
    .select()
    .single();

  if (error) {
    toast('Failed to add entry: ' + error.message, 'error');
    return;
  }

  document.getElementById('comm-note').value = '';
  refreshCommLog(tenantId);
  toast('Entry added', 'success');
}

async function deleteCommLog(id, tenantId) {
  const client = getSupabaseClient();
  if (!client) { toast('Supabase client not available', 'error'); return; }

  openConfirmModal('Delete Entry', 'Delete this communication log entry?', 'danger', async () => {
    const { error } = await client
      .from('comm_logs')
      .delete()
      .eq('id', id)
      .eq('user_id', currentUser.id);

    if (error) {
      toast('Failed to delete: ' + error.message, 'error');
      return;
    }

    refreshCommLog(tenantId);
    toast('Entry deleted', 'success');
  });
}

// ── RECURRING PAYMENTS ────────────────────────
function openRecurringModal(rec) {
  if (!hasFeature('recurring')) {
    toast('Recurring payment schedules are not available on your current plan. Please upgrade.', 'error');
    return;
  }
  document.getElementById('recur-id').value     = rec ? rec.id : '';
  document.getElementById('recur-amount').value = rec ? rec.amount : '';
  document.getElementById('recur-type').value   = rec ? rec.type : 'rent';
  document.getElementById('recur-freq').value   = rec ? rec.freq : 'monthly';
  document.getElementById('recur-day').value    = rec ? rec.day : 1;
  document.getElementById('recur-start').value  = rec ? rec.start : new Date().toISOString().slice(0, 10);
  document.getElementById('recur-end').value    = rec ? (rec.end || '') : '';
  document.getElementById('recur-notes').value  = rec ? rec.notes : '';
  const tenSel = document.getElementById('recur-tenant');
  tenSel.innerHTML = '<option value="">— Select tenant —</option>' +
    tenants.filter(t => t.status === 'active').map(t => `<option value="${t.id}" ${rec && rec.tenant_id == t.id ? 'selected' : ''}>${t.first_name} ${t.last_name}</option>`).join('');
  if (rec) tenSel.value = rec.tenant_id;

  const schedList = recurringSchedules.map(r => {
    const t = tenants.find(t => t.id == r.tenant_id);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:12.5px">
      <div>
        <strong>${t ? `${t.first_name} ${t.last_name}` : '—'}</strong> — ${fmt(r.amount)} / ${r.freq}
        <span style="color:var(--text-muted);margin-left:6px">${fmtDate(r.start)} → ${r.end ? fmtDate(r.end) : 'ongoing'}</span>
      </div>
      <div class="action-btns">
        <button class="btn btn-sm btn-icon" onclick="openRecurringModal(recurringSchedules.find(x=>x.id==='${r.id}'))"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-icon btn-danger" onclick="deleteRecurring('${r.id}')"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`;
  }).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No schedules set up.</div>';

  const modal = document.querySelector('#modal-recurring .modal');
  if (modal) {
    let listDiv = modal.querySelector('#recur-existing-list');
    if (!listDiv) {
      listDiv = document.createElement('div');
      listDiv.id = 'recur-existing-list';
      listDiv.style.cssText = 'max-height:180px;overflow-y:auto;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border)';
      modal.insertBefore(listDiv, modal.querySelector('.form-row'));
    }
    listDiv.innerHTML = schedList;
  }
  openModal('modal-recurring');
}

async function saveRecurring() {
  const id   = document.getElementById('recur-id').value;
  const body = {
    tenant_id: document.getElementById('recur-tenant').value || null,
    amount:    Number(document.getElementById('recur-amount').value) || 0,
    type:      document.getElementById('recur-type').value,
    freq:      document.getElementById('recur-freq').value,
    day:       Number(document.getElementById('recur-day').value) || 1,
    start:     document.getElementById('recur-start').value,
    end:       document.getElementById('recur-end').value || null,
    notes:     document.getElementById('recur-notes').value.trim()
  };
  if (!body.tenant_id) return toast('Please select a tenant', 'error');
  if (!body.amount)    return toast('Amount is required', 'error');
  const btn = document.getElementById('save-recur-btn');
  setLoading(btn, true, 'Saving…');
  const { error } = id ? await sb.update('recurring', id, body) : await sb.insert('recurring', body);
  setLoading(btn, false, '<i class="fa-solid fa-floppy-disk"></i> Save Schedule');
  if (error) return toast('Error saving schedule: ' + error.message, 'error');
  const { data } = await sb.get('recurring');
  recurringSchedules = data || [];
  openRecurringModal();
  toast(id ? 'Schedule updated' : 'Schedule created', 'success');
}

async function deleteRecurring(id) {
  openConfirmModal('Delete Schedule', 'Delete this recurring payment schedule? Existing payments will not be affected.', 'danger', async () => {
    await sb.delete('recurring', id);
    const { data } = await sb.get('recurring');
    recurringSchedules = data || [];
    openRecurringModal();
    toast('Schedule deleted', 'success');
  });
}

// ── PROCESS RECURRING SCHEDULES ──────────────
function processRecurringSchedules() {
  const today = new Date().toISOString().slice(0, 10);
  recurringSchedules.forEach(r => {
    if (r.end && today > r.end) return;
    if (today < r.start) return;
    const d = new Date(today);
    if (d.getDate() !== Number(r.day)) return;
    const monthStr = today.slice(0, 7);
    const already  = payments.find(p =>
      p.tenant_id == r.tenant_id &&
      p.type      === r.type     &&
      p.date && p.date.startsWith(monthStr) &&
      Number(p.amount) === Number(r.amount)
    );
    if (!already) {
      sb.insert('payments', {
        tenant_id: r.tenant_id,
        amount:    r.amount,
        date:      today,
        type:      r.type,
        status:    'pending',
        notes:     'Auto-generated from recurring schedule'
      });
    }
  });
}

// ── EXPENSES PAGE ─────────────────────────────
let expensePage = 1, expensePageSize = 10, expenseFilteredData = [];

function renderExpenses(list) {
  expenseFilteredData = list || [...expenses].sort((a, b) => new Date(b.date) - new Date(a.date));
  const tbody = document.getElementById('expenses-tbody');
  if (!tbody) return;
  if (!expenseFilteredData.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-file-invoice-dollar"></i></div><div class="empty-title">No expenses recorded</div></div></td></tr>';
    document.getElementById('expenses-pagination').innerHTML = '';
    return;
  }
  const start    = (expensePage - 1) * expensePageSize;
  const page     = expenseFilteredData.slice(start, start + expensePageSize);
  const catCls   = { utilities: 'badge-info', maintenance: 'badge-warning', repairs: 'badge-danger', insurance: 'badge-success', other: 'badge-info' };
  tbody.innerHTML = page.map(e => {
    const prop = properties.find(p => p.id == e.property_id);
    const vend = vendors.find(v => v.id == e.vendor_id);
    return '<tr>' +
      '<td>' + fmtDate(e.date) + '</td>' +
      '<td>' + (prop ? prop.name : '—') + '</td>' +
      '<td style="font-size:12px;color:var(--text-secondary)">' + (vend ? vend.name : '—') + '</td>' +
      '<td>' + e.description + '</td>' +
      '<td><span class="badge ' + (catCls[e.category] || 'badge-info') + '">' + e.category + '</span></td>' +
      '<td class="payment-amount" style="color:var(--danger)">' + fmt(e.amount) + '</td>' +
      '<td><div class="action-btns">' +
      '<button class="btn btn-sm btn-icon" onclick="editExpense(\'' + e.id + '\')"><i class="fa-solid fa-pen"></i></button>' +
      '<button class="btn btn-sm btn-icon btn-danger" onclick="deleteExpense(\'' + e.id + '\')"><i class="fa-solid fa-trash"></i></button>' +
      '</div></td>' +
      '</tr>';
  }).join('');
  buildPagination('expenses-pagination', expensePage, expenseFilteredData.length, expensePageSize, 'goToExpensePage', 'setExpensePageSize');
}

function goToExpensePage(p) { expensePage = Math.max(1, Math.min(p, Math.ceil(expenseFilteredData.length / expensePageSize) || 1)); renderExpenses(expenseFilteredData); }
function setExpensePageSize(s) { expensePageSize = Number(s); expensePage = 1; renderExpenses(expenseFilteredData); }

function filterExpenses() {
  const q     = document.getElementById('expense-search')?.value.toLowerCase() || '';
  const cat   = document.getElementById('expense-cat-filter')?.value || '';
  const dfrom = document.getElementById('expense-date-from')?.value || '';
  const dto   = document.getElementById('expense-date-to')?.value || '';
  renderExpenses(expenses.filter(e => {
    const prop = properties.find(p => p.id == e.property_id);
    return (!q    || e.description.toLowerCase().includes(q) || (prop && prop.name.toLowerCase().includes(q))) &&
      (!cat  || e.category === cat) &&
      (!dfrom || (e.date && e.date >= dfrom)) &&
      (!dto   || (e.date && e.date <= dto));
  }));
}

function openExpenseModal(exp) {
  document.getElementById('exp-id').value       = exp ? exp.id : '';
  document.getElementById('exp-desc').value     = exp ? exp.description : '';
  document.getElementById('exp-amount').value   = exp ? exp.amount : '';
  document.getElementById('exp-date').value     = exp ? exp.date : new Date().toISOString().slice(0, 10);
  document.getElementById('exp-category').value = exp ? exp.category : 'maintenance';
  document.getElementById('exp-notes').value    = exp ? exp.notes : '';
  const propSel = document.getElementById('exp-property');
  propSel.innerHTML = '<option value="">— Select property —</option>' +
    properties.map(p => '<option value="' + p.id + '"' + (exp && exp.property_id == p.id ? ' selected' : '') + '>' + p.name + '</option>').join('');
  const vendSel = document.getElementById('exp-vendor');
  vendSel.innerHTML = '<option value="">— None —</option>' +
    vendors.map(v => '<option value="' + v.id + '"' + (exp && exp.vendor_id == v.id ? ' selected' : '') + '>' + v.name + '</option>').join('');
  openModal('modal-expense');
}

function editExpense(id) { const e = expenses.find(e => e.id == id); if (e) openExpenseModal(e); }

async function saveExpense() {
  const id   = document.getElementById('exp-id').value;
  const body = {
    property_id: document.getElementById('exp-property').value || null,
    vendor_id:   document.getElementById('exp-vendor').value   || null,
    description: document.getElementById('exp-desc').value.trim(),
    amount:      Number(document.getElementById('exp-amount').value) || 0,
    date:        document.getElementById('exp-date').value,
    category:    document.getElementById('exp-category').value,
    notes:       document.getElementById('exp-notes').value.trim()
  };
  if (!body.description) return toast('Description is required', 'error');
  if (!body.amount)      return toast('Amount is required', 'error');
  const btn = document.getElementById('save-exp-btn');
  setLoading(btn, true, 'Saving…');
  const { error } = id ? await sb.update('expenses', id, body) : await sb.insert('expenses', body);
  setLoading(btn, false, '<i class="fa-solid fa-floppy-disk"></i> Save Expense');
  if (error) return toast('Error saving expense: ' + error.message, 'error');
  await loadAll();
  closeModal('modal-expense');
  renderExpenses();
  toast(id ? 'Expense updated' : 'Expense added', 'success');
}

async function deleteExpense(id) {
  openConfirmModal('Delete Expense', 'Delete this expense record? This cannot be undone.', 'danger', async () => {
    await sb.delete('expenses', id);
    await loadAll();
    renderExpenses();
    toast('Expense deleted', 'success');
  });
}

// ── VENDORS PAGE ──────────────────────────────
function filterVendors() {
  const q   = document.getElementById('vendor-search')?.value.toLowerCase() || '';
  const cat = document.getElementById('vendor-cat-filter')?.value || '';
  renderVendors(vendors.filter(v =>
    (!q   || v.name.toLowerCase().includes(q) || (v.email && v.email.toLowerCase().includes(q)) || (v.phone && v.phone.includes(q))) &&
    (!cat || v.category === cat)
  ));
}

function renderVendors(list) {
  const data  = list || vendors;
  const tbody = document.getElementById('vendors-tbody');
  if (!tbody) return;
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-helmet-safety"></i></div><div class="empty-title">No vendors found</div></div></td></tr>';
    return;
  }
  tbody.innerHTML = data.map(v =>
    '<tr>' +
    '<td><strong>' + v.name + '</strong></td>' +
    '<td style="text-transform:capitalize">' + v.category + '</td>' +
    '<td>' + (v.phone || '—') + '</td>' +
    '<td>' + (v.email || '—') + '</td>' +
    '<td style="font-size:12px;color:var(--text-muted)">' + (v.notes || '—') + '</td>' +
    '<td><div class="action-btns">' +
    '<button class="btn btn-sm btn-icon" onclick="editVendor(\'' + v.id + '\')"><i class="fa-solid fa-pen"></i></button>' +
    '<button class="btn btn-sm btn-icon btn-danger" onclick="deleteVendor(\'' + v.id + '\')"><i class="fa-solid fa-trash"></i></button>' +
    '</div></td>' +
    '</tr>'
  ).join('');
}

function openVendorModal(v) {
  document.getElementById('vendor-id').value       = v ? v.id : '';
  document.getElementById('vendor-name').value     = v ? v.name : '';
  document.getElementById('vendor-category').value = v ? v.category : 'general';
  document.getElementById('vendor-phone').value    = v ? v.phone : '';
  document.getElementById('vendor-email').value    = v ? v.email : '';
  document.getElementById('vendor-notes').value    = v ? v.notes : '';
  openModal('modal-vendor');
}

function editVendor(id) { const v = vendors.find(v => v.id == id); if (v) openVendorModal(v); }

async function saveVendor() {
  const id   = document.getElementById('vendor-id').value;
  const body = {
    name:     document.getElementById('vendor-name').value.trim(),
    category: document.getElementById('vendor-category').value,
    phone:    document.getElementById('vendor-phone').value.trim(),
    email:    document.getElementById('vendor-email').value.trim(),
    notes:    document.getElementById('vendor-notes').value.trim()
  };
  if (!body.name) return toast('Vendor name is required', 'error');
  const btn = document.getElementById('save-vendor-btn');
  setLoading(btn, true, 'Saving…');
  const { error } = id ? await sb.update('vendors', id, body) : await sb.insert('vendors', body);
  setLoading(btn, false, '<i class="fa-solid fa-floppy-disk"></i> Save Vendor');
  if (error) return toast('Error saving vendor: ' + error.message, 'error');
  await loadAll();
  closeModal('modal-vendor');
  renderVendors();
  toast(id ? 'Vendor updated' : 'Vendor added', 'success');
}

async function deleteVendor(id) {
  openConfirmModal('Delete Vendor', 'Delete this vendor?', 'danger', async () => {
    await sb.delete('vendors', id);
    await loadAll();
    renderVendors();
    toast('Vendor deleted', 'success');
  });
}

// ── UNIT MANAGER PAGE ─────────────────────────
function filterUnits() { renderUnits(); }

function renderUnits() {
  const tbody        = document.getElementById('units-tbody');
  if (!tbody) return;
  const propFilter   = document.getElementById('unit-prop-filter')?.value   || '';
  const statusFilter = document.getElementById('unit-status-filter')?.value || '';
  const q            = document.getElementById('unit-search')?.value.toLowerCase() || '';

  const pf = document.getElementById('unit-prop-filter');
  if (pf) {
    const cur = pf.value;
    pf.innerHTML = '<option value="">All properties</option>' +
      properties.map(p => '<option value="' + p.id + '"' + (cur == p.id ? ' selected' : '') + '>' + p.name + '</option>').join('');
  }

  const filtered = units.filter(u => {
    const prop = properties.find(p => p.id == u.property_id);
    return (!propFilter   || u.property_id == propFilter) &&
      (!statusFilter || u.status === statusFilter) &&
      (!q            || u.label.toLowerCase().includes(q) || (prop && prop.name.toLowerCase().includes(q)));
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-door-open"></i></div><div class="empty-title">No units yet</div></div></td></tr>';
    return;
  }

  const statCls = { occupied: 'badge-success', vacant: 'badge-warning', maintenance: 'badge-danger' };
  tbody.innerHTML = filtered.map(u => {
    const prop   = properties.find(p => p.id == u.property_id);
    const tenant = tenants.find(t => t.property_id == u.property_id && t.unit === u.label && t.status === 'active');
    return '<tr>' +
      '<td>' + (prop ? prop.name : '—') + '</td>' +
      '<td><strong>' + u.label + '</strong></td>' +
      '<td>' + (u.floor || '—') + '</td>' +
      '<td>' + (u.bedrooms || 0) + ' bed / ' + (u.bathrooms || 0) + ' bath</td>' +
      '<td>' + (u.size ? u.size + ' sqft' : '—') + '</td>' +
      '<td class="payment-amount">' + fmt(u.rent) + '/mo</td>' +
      '<td>' + (tenant ? '<span style="font-weight:500">' + tenant.first_name + ' ' + tenant.last_name + '</span>' : '<span style="color:var(--text-muted)">Vacant</span>') + '</td>' +
      '<td><span class="badge ' + (statCls[u.status] || 'badge-info') + '">' + u.status + '</span></td>' +
      '<td><div class="action-btns">' +
      '<button class="btn btn-sm btn-icon" onclick="editUnit(\'' + u.id + '\')"><i class="fa-solid fa-pen"></i></button>' +
      '<button class="btn btn-sm btn-icon btn-danger" onclick="deleteUnit(\'' + u.id + '\')"><i class="fa-solid fa-trash"></i></button>' +
      '</div></td>' +
      '</tr>';
  }).join('');
}

function openUnitModal(u) {
  document.getElementById('unit-id').value     = u ? u.id : '';
  document.getElementById('unit-label').value  = u ? u.label : '';
  document.getElementById('unit-floor').value  = u ? (u.floor || '') : '';
  document.getElementById('unit-beds').value   = u ? (u.bedrooms || '') : '';
  document.getElementById('unit-baths').value  = u ? (u.bathrooms || '') : '';
  document.getElementById('unit-size').value   = u ? (u.size || '') : '';
  document.getElementById('unit-rent').value   = u ? (u.rent || '') : '';
  document.getElementById('unit-status').value = u ? (u.status || 'vacant') : 'vacant';
  document.getElementById('unit-notes').value  = u ? (u.notes || '') : '';
  const ps = document.getElementById('unit-property');
  ps.innerHTML = '<option value="">— Select property —</option>' +
    properties.map(p => '<option value="' + p.id + '"' + (u && u.property_id == p.id ? ' selected' : '') + '>' + p.name + '</option>').join('');
  openModal('modal-unit');
}

function editUnit(id) { const u = units.find(u => u.id == id); if (u) openUnitModal(u); }

async function saveUnit() {
  const id   = document.getElementById('unit-id').value;
  const body = {
    property_id: document.getElementById('unit-property').value || null,
    label:       document.getElementById('unit-label').value.trim(),
    floor:       Number(document.getElementById('unit-floor').value) || null,
    bedrooms:    Number(document.getElementById('unit-beds').value)  || 0,
    bathrooms:   Number(document.getElementById('unit-baths').value) || 0,
    size:        Number(document.getElementById('unit-size').value)  || 0,
    rent:        Number(document.getElementById('unit-rent').value)  || 0,
    status:      document.getElementById('unit-status').value,
    notes:       document.getElementById('unit-notes').value.trim()
  };
  if (!body.label)       return toast('Unit label is required', 'error');
  if (!body.property_id) return toast('Please select a property', 'error');
  if (!id && !(await checkPlanLimit('units'))) return;
  const btn = document.getElementById('save-unit-btn');
  setLoading(btn, true, 'Saving…');
  const { error } = id ? await sb.update('units', id, body) : await sb.insert('units', body);
  setLoading(btn, false, '<i class="fa-solid fa-floppy-disk"></i> Save Unit');
  if (error) return toast('Error saving unit: ' + error.message, 'error');
  await loadAll();
  closeModal('modal-unit');
  renderUnits();
  toast(id ? 'Unit updated' : 'Unit added', 'success');
}

async function deleteUnit(id) {
  openConfirmModal('Delete Unit', 'Delete this unit?', 'danger', async () => {
    await sb.delete('units', id);
    await loadAll();
    renderUnits();
    toast('Unit deleted', 'success');
  });
}

// ── CALENDAR PAGE ─────────────────────────────
let calViewYear  = new Date().getFullYear();
let calViewMonth = new Date().getMonth();

function renderCalendar() {
  const el = document.getElementById('calendar-grid');
  if (!el) return;
  const yr    = calViewYear, mo = calViewMonth;
  const today = new Date();
  const firstDay    = new Date(yr, mo, 1).getDay();
  const daysInMonth = new Date(yr, mo + 1, 0).getDate();
  document.getElementById('calendar-month-label').textContent = new Date(yr, mo, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const events = {};
  const addEv  = (day, label, cls) => { if (!events[day]) events[day] = []; events[day].push({ label, cls }); };

  tenants.filter(t => t.lease_end && t.status === 'active').forEach(t => {
    const d = new Date(t.lease_end);
    if (d.getFullYear() === yr && d.getMonth() === mo) addEv(d.getDate(), t.first_name + ' lease ends', 'cal-ev-warning');
  });

  const moStr = yr + '-' + String(mo + 1).padStart(2, '0');
  payments.filter(p => p.date && p.date.startsWith(moStr)).forEach(p => {
    const t = tenants.find(t => t.id == p.tenant_id);
    addEv(new Date(p.date).getDate(), (t ? t.first_name : '') + ' ' + p.status, 'cal-ev-' + (p.status === 'paid' ? 'success' : p.status === 'overdue' ? 'danger' : 'info'));
  });

  maintenances.filter(m => {
    if (!m.created_at) return false;
    const d = new Date(m.created_at);
    return d.getFullYear() === yr && d.getMonth() === mo;
  }).forEach(m => addEv(new Date(m.created_at).getDate(), 'Maint: ' + m.title.slice(0, 14), 'cal-ev-warning'));

  let html = '<div class="cal-grid">';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => { html += '<div class="cal-header-cell">' + d + '</div>'; });
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-cell cal-empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = d === today.getDate() && mo === today.getMonth() && yr === today.getFullYear();
    const evs = events[d] || [];
    html += '<div class="cal-cell' + (isToday ? ' cal-today' : '') + '">' +
      '<div class="cal-day-num">' + d + '</div>' +
      evs.slice(0, 3).map(e => '<div class="cal-ev ' + e.cls + '">' + e.label + '</div>').join('') +
      (evs.length > 3 ? '<div class="cal-ev cal-ev-more">+' + (evs.length - 3) + ' more</div>' : '') +
      '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

function calPrevMonth() {
  calViewMonth--;
  if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
  renderCalendar();
}
function calNextMonth() {
  calViewMonth++;
  if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
  renderCalendar();
}

// ── DOCUMENTS PAGE ────────────────────────────
function renderDocuments() {
  const grid = document.getElementById('docs-grid');
  if (!grid) return;
  if (!documents.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon"><i class="fa-solid fa-folder-open"></i></div><div class="empty-title">No documents uploaded</div><div class="empty-sub">Upload lease agreements, inspection reports, insurance docs and more.</div></div>';
    return;
  }
  const extIcon = name => {
    const ext = name.split('.').pop().toLowerCase();
    if (['pdf'].includes(ext)) return 'fa-file-pdf';
    if (['doc', 'docx'].includes(ext)) return 'fa-file-word';
    if (['jpg', 'jpeg', 'png', 'gif'].includes(ext)) return 'fa-file-image';
    return 'fa-file';
  };
  const fmtBytes = b => {
    if (!b) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  };
  grid.innerHTML = documents.map(d => {
    // storage_path is the public URL from Supabase Storage
    const downloadHref = d.storage_path || '#';
    const sizeLabel = d.size_bytes ? '<div class="doc-meta">' + fmtBytes(d.size_bytes) + '</div>' : '';
    return '<div class="doc-card">' +
      '<div class="doc-icon"><i class="fa-solid ' + extIcon(d.name) + '"></i></div>' +
      '<div class="doc-name">' + d.name + '</div>' +
      '<div class="doc-meta">' + (d.property_id ? (properties.find(p => p.id == d.property_id) || { name: '—' }).name : 'General') + '</div>' +
      sizeLabel +
      '<div class="doc-meta">' + fmtDate(d.created_at) + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:8px">' +
      (d.storage_path
        ? '<a class="btn btn-sm" href="' + downloadHref + '" target="_blank" download="' + d.name + '"><i class="fa-solid fa-download"></i></a>'
        : '<button class="btn btn-sm" disabled title="File not available"><i class="fa-solid fa-download"></i></button>') +
      '<button class="btn btn-sm btn-danger" onclick="deleteDoc(\'' + d.id + '\',\'' + (d.storage_path || '') + '\')"><i class="fa-solid fa-trash"></i></button>' +
      '</div></div>';
  }).join('');
}

function openDocModal() {
  const fileInput = document.getElementById('doc-file');
  if (fileInput) fileInput.value = '';
  _resetDocFileDisplay();
  const ps = document.getElementById('doc-property');
  if (ps) ps.innerHTML = '<option value="">— General / No property —</option>' + properties.map(p => '<option value="' + p.id + '">' + p.name + '</option>').join('');
  openModal('modal-doc');
}

// FIX: called by onchange on #doc-file — updates the visible zone immediately
function onDocFileSelected(input) {
  const file  = input.files && input.files[0];
  const wrap  = document.getElementById('doc-file-display');
  const icon  = document.getElementById('doc-file-icon');
  const label = document.getElementById('doc-file-name');
  if (!file) { _resetDocFileDisplay(); return; }
  if (wrap)  { wrap.style.borderColor = 'var(--success)'; wrap.style.background = 'color-mix(in srgb, var(--success) 8%, transparent)'; }
  if (icon)  { icon.className = 'fa-solid fa-file-circle-check'; icon.style.color = 'var(--success)'; }
  if (label) { label.textContent = file.name; label.style.color = 'var(--success)'; label.style.fontWeight = '500'; }
}

function _resetDocFileDisplay() {
  const wrap  = document.getElementById('doc-file-display');
  const icon  = document.getElementById('doc-file-icon');
  const label = document.getElementById('doc-file-name');
  if (wrap)  { wrap.style.borderColor = ''; wrap.style.background = ''; }
  if (icon)  { icon.className = 'fa-solid fa-upload'; icon.style.color = ''; }
  if (label) { label.textContent = 'Click or drag a file here\u2026'; label.style.color = ''; label.style.fontWeight = ''; }
}

async function saveDoc() {
  const input  = document.getElementById('doc-file');
  const propId = document.getElementById('doc-property').value || null;
  const file   = input.files[0];
  if (!file) return toast('Please select a file', 'error');
  if (file.size > 5 * 1024 * 1024) return toast('File must be under 5MB', 'error');
  if (!(await checkPlanLimit('documents'))) return;
  const btn = document.getElementById('save-doc-btn');
  setLoading(btn, true, 'Uploading…');
  try {
    const client = getSupabaseClient();
    if (!client) throw new Error('Supabase client not available');

    // 1. Upload to Supabase Storage bucket named "documents"
    const safeName  = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath  = currentUser.id + '/' + Date.now() + '_' + safeName;
    const { error: storageErr } = await client.storage
      .from('documents')
      .upload(filePath, file, { upsert: false });
    if (storageErr) throw new Error('Storage upload failed: ' + storageErr.message);

    // 2. Get public URL
    const { data: urlData } = client.storage.from('documents').getPublicUrl(filePath);
    const publicUrl = urlData?.publicUrl || '';

    // 3. Insert row using actual column names from schema
    const { error: dbErr } = await client.from('documents').insert({
      user_id:      currentUser.id,
      name:         file.name,
      property_id:  propId || null,
      storage_path: publicUrl,
      size_bytes:   file.size,
    });
    if (dbErr) throw new Error('DB insert failed: ' + dbErr.message);

    await loadAll();
    renderDocuments();
    closeModal('modal-doc');
    toast('Document uploaded', 'success');
  } catch (err) {
    toast('Failed to upload: ' + err.message, 'error');
  } finally {
    setLoading(btn, false, '<i class="fa-solid fa-upload"></i> Upload');
  }
}

async function deleteDoc(id, storagePath) {
  openConfirmModal('Delete Document', 'Permanently delete this document?', 'danger', async () => {
    try {
      const client = getSupabaseClient();

      // 1. Delete from Storage if we have a path
      if (storagePath && client) {
        // Extract the path segment after the bucket public URL
        const match = storagePath.match(/\/documents\/(.+)$/);
        if (match) {
          await client.storage.from('documents').remove([decodeURIComponent(match[1])]);
        }
      }

      // 2. Delete the DB row
      const { error } = await sb.delete('documents', id);
      if (error) throw error;

      await loadAll();
      renderDocuments();
      toast('Document deleted', 'success');
    } catch (err) {
      toast('Failed to delete document: ' + err.message, 'error');
    }
  });
}

function renderSupportPage() {
  const page = document.getElementById('page-support'); if (!page) return;
  page.innerHTML = `
    <div style="max-width:720px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
        <div class="card" style="padding:20px 24px;display:flex;align-items:flex-start;gap:16px">
          <div style="width:46px;height:46px;border-radius:12px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fa-solid fa-phone" style="color:var(--accent-hover);font-size:18px"></i>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Phone Support</div>
            <div style="font-weight:600;font-size:15px">+233 30 000 0000</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:3px">Mon&ndash;Fri, 8am&ndash;6pm GMT</div>
          </div>
        </div>
        <div class="card" style="padding:20px 24px;display:flex;align-items:flex-start;gap:16px">
          <div style="width:46px;height:46px;border-radius:12px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fa-solid fa-envelope" style="color:var(--accent-hover);font-size:18px"></i>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Email Support</div>
            <div style="font-weight:600;font-size:15px">support@propms.app</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:3px">We reply within 24 hours</div>
          </div>
        </div>
      </div>
      <div class="card" style="padding:24px 28px;margin-bottom:20px">
        <div class="card-title" style="margin-bottom:18px">
          <i class="fa-solid fa-paper-plane" style="margin-right:8px;color:var(--accent-hover)"></i>Send a Message
        </div>
        <div class="form-row">
          <label>Subject</label>
          <input type="text" id="support-title" placeholder="e.g. Issue with payment records, Billing question&hellip;">
        </div>
        <div class="form-row">
          <label>Message</label>
          <textarea id="support-message" placeholder="Describe your issue or question in detail&hellip;" style="min-height:120px;resize:vertical"></textarea>
        </div>
        <div style="padding-top:4px">
          <button class="btn btn-primary" id="support-submit-btn" onclick="submitSupportMessage()">
            <i class="fa-solid fa-paper-plane"></i> Send Message
          </button>
        </div>
      </div>
    </div>`;
}

async function submitSupportMessage() {
  const title   = document.getElementById('support-title')?.value.trim();
  const message = document.getElementById('support-message')?.value.trim();
  if (!title)   return toast('Please enter a subject', 'error');
  if (!message) return toast('Please enter a message', 'error');
  const btn = document.getElementById('support-submit-btn');
  setLoading(btn, true, 'Sending\u2026');
  const client = getSupabaseClient();
  if (!client) { setLoading(btn, false, '<i class="fa-solid fa-paper-plane"></i> Send Message'); toast('Database not available', 'error'); return; }
  const { error } = await client.from('support_messages').insert({ user_id: currentUser.id, email: currentUser.email, title, message, status: 'open' });
  setLoading(btn, false, '<i class="fa-solid fa-paper-plane"></i> Send Message');
  if (error) { toast('Failed to send: ' + error.message, 'error'); return; }
  document.getElementById('support-title').value   = '';
  document.getElementById('support-message').value = '';
  toast("Message sent! We'll get back to you within 24 hours.", 'success');
}

// ── GLOBAL SEARCH ─────────────────────────────
function toggleGlobalSearch() {
  const overlay = document.getElementById('global-search-overlay');
  if (!overlay) return;
  overlay.classList.toggle('open');
  if (overlay.classList.contains('open')) {
    document.getElementById('global-search-input')?.focus();
    document.getElementById('global-search-results').innerHTML = '';
  }
}

function runGlobalSearch() {
  const q       = (document.getElementById('global-search-input')?.value || '').toLowerCase().trim();
  const results = document.getElementById('global-search-results');
  if (!q || q.length < 2) { results.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0">Type at least 2 characters…</div>'; return; }
  const hits = [];

  // Only show results for pages the user has access to
  if (hasFeature('properties')) {
    properties.filter(p => p.name.toLowerCase().includes(q) || p.address.toLowerCase().includes(q)).forEach(p => {
      hits.push({ icon: 'fa-city', label: p.name, sub: p.address, action: "navigate('properties')" });
    });
  }
  if (hasFeature('tenants')) {
    tenants.filter(t => (t.first_name + ' ' + t.last_name).toLowerCase().includes(q) || t.email.toLowerCase().includes(q)).forEach(t => {
      hits.push({ icon: 'fa-user', label: t.first_name + ' ' + t.last_name, sub: t.email, action: "viewTenantDetail('" + t.id + "');closeGlobalSearch()" });
    });
  }
  if (hasFeature('payments')) {
    payments.filter(p => String(p.amount).includes(q) || (p.notes && p.notes.toLowerCase().includes(q))).forEach(p => {
      const t = tenants.find(t => t.id == p.tenant_id);
      hits.push({ icon: 'fa-money-bill-wave', label: fmt(p.amount) + ' ' + p.type, sub: (t ? t.first_name + ' ' + t.last_name : '') + ' — ' + fmtDate(p.date), action: "navigate('payments')" });
    });
  }
  if (hasFeature('maintenance')) {
    maintenances.filter(m => m.title.toLowerCase().includes(q) || (m.description && m.description.toLowerCase().includes(q))).forEach(m => {
      hits.push({ icon: 'fa-screwdriver-wrench', label: m.title, sub: m.priority + ' · ' + m.status, action: "navigate('maintenance')" });
    });
  }

  if (!hits.length) { results.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0">No results found for "' + q + '"</div>'; return; }
  results.innerHTML = hits.slice(0, 8).map(h =>
    '<div class="search-result-item" onclick="' + h.action + ';closeGlobalSearch()">' +
    '<div class="search-result-icon"><i class="fa-solid ' + h.icon + '"></i></div>' +
    '<div><div style="font-size:13px;font-weight:500">' + h.label + '</div><div style="font-size:11.5px;color:var(--text-muted)">' + h.sub + '</div></div>' +
    '</div>'
  ).join('');
}

function closeGlobalSearch() {
  document.getElementById('global-search-overlay')?.classList.remove('open');
}

// ── DATA BACKUP / RESTORE (Supabase) ──────────
// Exports all user data from Supabase as a JSON file.
async function exportAllData() {
  const client = getSupabaseClient();
  if (!client) return toast('Not connected to database', 'error');
  const btn = document.querySelector('[onclick="exportAllData()"]');
  if (btn) setLoading(btn, true, 'Exporting…');
  try {
    const tables = ['properties', 'tenants', 'payments', 'maintenance_requests',
      'recurring', 'expenses', 'vendors', 'units', 'documents', 'comm_logs'];
    const result = {};
    for (const t of tables) {
      const { data } = await client.from(t).select('*').eq('user_id', currentUser.id);
      result[t] = data || [];
    }
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'propms-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup downloaded', 'success');
  } catch (err) {
    toast('Backup failed: ' + err.message, 'error');
  } finally {
    if (btn) setLoading(btn, false, '<i class="fa-solid fa-download"></i> Backup');
  }
}

// Imports a previously exported JSON backup into Supabase (upserts rows).
function importAllData(input) {
  const file = input.files[0];
  if (!file) return;
  const client = getSupabaseClient();
  if (!client) return toast('Not connected to database', 'error');
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      const tables = Object.keys(data);
      for (const table of tables) {
        const rows = data[table];
        if (!rows.length) continue;
        // Stamp user_id on every row so RLS accepts it
        const stamped = rows.map(r => ({ ...r, user_id: currentUser.id }));
        await client.from(table).upsert(stamped, { onConflict: 'id' });
      }
      await loadAll();
      navigate(currentPage);
      toast('Data restored successfully', 'success');
    } catch (err) {
      toast('Restore failed: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

// Deletes ALL user data from Supabase — irreversible.
async function clearAllData() {
  openConfirmModal(
    'Delete All Data',
    'This will <strong>permanently delete all your data</strong> from the database — properties, tenants, payments, documents and everything else. This cannot be undone.',
    'danger',
    async () => {
      const client = getSupabaseClient();
      if (!client) return toast('Not connected to database', 'error');
      const tables = ['comm_logs', 'documents', 'recurring', 'expenses', 'maintenance_requests',
        'payments', 'units', 'vendors', 'tenants', 'properties'];
      for (const t of tables) {
        await client.from(t).delete().eq('user_id', currentUser.id);
      }
      await loadAll();
      navigate('dashboard');
      toast('All data deleted', 'success');
    }
  );
}

// ── HELPERS ───────────────────────────────────
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});

function setLoading(btn, loading, html) {
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn._origHtml = btn.innerHTML;
    btn.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> ${html}`;
  } else {
    btn.innerHTML = html || btn._origHtml || html;
  }
}

function fmtDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date)) return d;
  const df = appSettings.dateformat || 'DMY';
  if (df === 'DMY') return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
  if (df === 'YMD') return date.toISOString().slice(0, 10);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${msg}`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── PAGINATION ────────────────────────────────
const PAGE_SIZE_OPTIONS = [5, 10, 25, 50];

function buildPagination(containerId, currentPage, totalItems, pageSize, onPageChange, onSizeChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const start      = Math.min((currentPage - 1) * pageSize + 1, totalItems);
  const end        = Math.min(currentPage * pageSize, totalItems);
  const pages      = [];
  const delta      = 2;
  const range      = [];
  for (let i = Math.max(1, currentPage - delta); i <= Math.min(totalPages, currentPage + delta); i++) range.push(i);
  if (range[0] > 1) { pages.push(1); if (range[0] > 2) pages.push('…'); }
  range.forEach(p => pages.push(p));
  if (range[range.length - 1] < totalPages) {
    if (range[range.length - 1] < totalPages - 1) pages.push('…');
    pages.push(totalPages);
  }
  const sizeOpts = PAGE_SIZE_OPTIONS.map(s =>
    `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s} / page</option>`).join('');
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted)">
      Showing <strong style="color:var(--text-secondary)">${totalItems ? start : 0}–${end}</strong> of <strong style="color:var(--text-secondary)">${totalItems}</strong>
    </div>
    <div class="pagination-pages">
      <button class="page-btn" onclick="${onPageChange}(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left" style="font-size:10px"></i></button>
      ${pages.map(p => p === '…'
    ? `<span style="padding:0 4px;color:var(--text-muted)">…</span>`
    : `<button class="page-btn${p === currentPage ? ' active' : ''}" onclick="${onPageChange}(${p})">${p}</button>`
  ).join('')}
      <button class="page-btn" onclick="${onPageChange}(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}><i class="fa-solid fa-chevron-right" style="font-size:10px"></i></button>
    </div>
    <select class="filter-select page-size-select" onchange="${onSizeChange}(this.value)">${sizeOpts}</select>`;
}

// ── APP INIT ──────────────────────────────────
function appInit() {
  if (SUPABASE_CONFIGURED && !window.supabase) {
    const s  = document.createElement('script');
    s.src    = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    s.onload = () => { _sbClient = null; };
    document.head.appendChild(s);
  }

  if (appSettings.lightMode) document.body.classList.add('light-mode');

  const sidebar = document.getElementById('sidebar');
  if (sidebarCollapsed && window.innerWidth > 700 && sidebar) sidebar.classList.add('collapsed');

  const footerYear = document.getElementById('footer-year');
  if (footerYear) footerYear.textContent = new Date().getFullYear();

  refreshAllLogos();
  checkAndAutoSuspend().then(() => {
    loadAll().then(() => {
      navigate('dashboard');
      updateExportCount();
      buildNotifications();
    });
  });
}

// ── AUTO-SUSPEND ON PLAN EXPIRY ───────────────
// ── AUTO-SUSPEND ON PLAN EXPIRY ───────────────
// Called every boot. Checks BOTH trial_ends_at (free trial) and
// subscription_ends_at (paid plans). Suspends + signs out if expired.
async function checkAndAutoSuspend() {
  if (!currentProfile || !currentUser) return;
  if (currentProfile.plan_status === 'suspended') return;

  // Pick the right expiry date depending on plan type
  const expiryDate = currentProfile.plan_id === 'free_trial'
    ? currentProfile.trial_ends_at
    : currentProfile.subscription_ends_at;

  if (!expiryDate) return; // no expiry set → no auto-suspend

  const expired = new Date(expiryDate) < new Date();
  if (!expired) return;

  const reason = currentProfile.plan_id === 'free_trial'
    ? 'Free trial expired'
    : 'Subscription expired';

  // Mark suspended in Supabase
  try {
    const client = getSupabaseClient();
    if (client) {
      await client.from('user_profiles').update({
        plan_status: 'suspended',
        suspended_at: new Date().toISOString(),
        suspended_reason: reason
      }).eq('id', currentUser.id);
    }
  } catch (e) { /* silent — still block locally */ }

  // Block access immediately
  currentProfile.plan_status     = 'suspended';
  currentProfile.suspended_reason = reason;

  // Sign out
  try { const c = getSupabaseClient(); if (c) await c.auth.signOut(); } catch (_) {}
  currentUser = null; currentProfile = null; currentPlan = null;

  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('login-screen').style.display = '';
  showLoginError('Your ' + (reason.includes('trial') ? 'free trial' : 'subscription') + ' has expired. Please contact support to resubscribe.');
}

// ── BOOT ──────────────────────────────────────
loadSettings();

if (document.documentElement.classList.contains('light-mode-pre')) {
  document.documentElement.classList.remove('light-mode-pre');
}

document.addEventListener('DOMContentLoaded', async function initApp() {
  if (!SUPABASE_CONFIGURED) {
    showLoginError('Supabase is not configured. Update your env.js with valid credentials.');
    const btn = document.querySelector('#login-screen .btn-primary');
    if (btn) btn.disabled = true;
    return;
  }

  const client = getSupabaseClient();
  if (!client) {
    showLoginError('Supabase client not available.');
    return;
  }

  await restoreSession();
});
