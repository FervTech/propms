// ─────────────────────────────────────────────
// PropMS Admin Panel — admin.js
// ─────────────────────────────────────────────

// ── CONFIG ────────────────────────────────────
const SB_URL  = (window.ENV && window.ENV.SUPABASE_URL)         ? window.ENV.SUPABASE_URL         : '';
const SB_ANON = (window.ENV && window.ENV.SUPABASE_ANON_KEY)    ? window.ENV.SUPABASE_ANON_KEY    : '';
const SB_SVC  = (window.ENV && window.ENV.SUPABASE_SERVICE_KEY) ? window.ENV.SUPABASE_SERVICE_KEY : '';
const PLANS_CONFIG = (typeof CONFIG !== 'undefined') ? CONFIG.PLANS : {};
const FEATURE_LABELS = (typeof CONFIG !== 'undefined') ? CONFIG.FEATURE_LABELS : {};
const CONFIGURED = !!(window.ENV && window.ENV.CONFIGURED);

let sbAdmin   = null;
let adminUser = null;
let allUsers  = [];
let allEvents = [];
let dbPlans   = [];
let plansEditMode = false;

// Set of admin user IDs (for the Admin badge)
let adminUserIds = new Set();

let usersPage = 1, usersPageSize = 20;
let subsPage  = 1, subsPageSize  = 20;
let eventsPage = 1, eventsPageSize = 20;
let filteredUsers = [];
let filteredSubs  = [];

// ── CONFIRM MODAL CALLBACK ───────────────────
let _confirmCallback = null;
let _rateLimitCooldown = false;

// ── INIT ──────────────────────────────────────
function initSupabaseClients() {
  if (!CONFIGURED) return;
  if (!window.supabase || !window.supabase.createClient) return;
  sbAdmin = window.supabase.createClient(SB_URL, SB_ANON);
}

// ── SESSION RESTORE ───────────────────────────
async function restoreAdminSession() {
  if (!sbAdmin) return;
  const { data: { session }, error } = await sbAdmin.auth.getSession();
  if (error || !session) {
    sessionStorage.removeItem('propms_admin_session');
    return;
  }
  const user = session.user;
  const { data: adminRow, error: adminErr } = await sbAdmin
    .from('admin_users')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();

  if (adminErr || !adminRow) {
    await sbAdmin.auth.signOut();
    sessionStorage.removeItem('propms_admin_session');
    return;
  }

  adminUser = { id: user.id, email: user.email, role: adminRow.role };
  sessionStorage.setItem('propms_admin_session', JSON.stringify(adminUser));
  showAdminApp();
}

document.addEventListener('DOMContentLoaded', () => {
  initSupabaseClients();

  const badge = document.getElementById('admin-env-badge');
  if (badge) {
    badge.textContent = CONFIGURED ? 'LIVE' : 'NOT CONFIGURED';
    badge.style.background = CONFIGURED ? 'var(--success)' : 'var(--danger)';
  }

  if (!CONFIGURED) {
    showLoginError('Supabase is not configured. Update your env.js file with valid credentials.');
    const btn = document.querySelector('#admin-login .btn-primary');
    if (btn) btn.disabled = true;
    return;
  }

  restoreAdminSession();
});

// ── AUTH ──────────────────────────────────────
async function adminLogin() {
  if (!CONFIGURED) {
    showLoginError('Supabase is not configured.');
    return;
  }

  const email = document.getElementById('admin-email').value.trim();
  const pwd   = document.getElementById('admin-password').value;

  const errEl = document.getElementById('admin-login-error');
  errEl.style.display = 'none';

  if (!email || !pwd) {
    showLoginError('Please enter your email and password.');
    return;
  }

  const btn = document.querySelector('#admin-login .btn-primary');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Signing in…';

  try {
    const { data, error } = await sbAdmin.auth.signInWithPassword({ email, password: pwd });

    if (error) {
      showLoginError(error.status === 400 ? 'Invalid email or password.' : error.message);
      resetLoginBtn();
      return;
    }

    const { data: adminRow, error: adminErr } = await sbAdmin
      .from('admin_users')
      .select('role')
      .eq('user_id', data.user.id)
      .maybeSingle();

    if (adminErr) {
      showLoginError('Admin verification failed: ' + adminErr.message);
      await sbAdmin.auth.signOut();
      resetLoginBtn();
      return;
    }

    if (!adminRow) {
      showLoginError(
        'Access denied — this account is not an admin.\n\n' +
        'To grant access, run this in your Supabase SQL editor:\n' +
        `INSERT INTO admin_users (user_id, email, role) VALUES ('${data.user.id}', '${data.user.email}', 'super_admin');`
      );
      await sbAdmin.auth.signOut();
      resetLoginBtn();
      return;
    }

    adminUser = { id: data.user.id, email: data.user.email, role: adminRow.role };
    sessionStorage.setItem('propms_admin_session', JSON.stringify(adminUser));
    showAdminApp();

  } catch (e) {
    showLoginError('Login failed: ' + e.message);
    resetLoginBtn();
  }
}

function showLoginError(msg) {
  const el = document.getElementById('admin-login-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

function resetLoginBtn() {
  const btn = document.querySelector('#admin-login .btn-primary');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In to Admin';
  }
}

function adminLogout() {
  openAdminModal('modal-admin-logout');
}

async function confirmAdminLogout() {
  closeAdminModal('modal-admin-logout');
  sessionStorage.removeItem('propms_admin_session');
  if (sbAdmin) {
    try { await sbAdmin.auth.signOut(); } catch (e) { /* ignore */ }
  }
  document.getElementById('admin-app').style.display   = 'none';
  document.getElementById('admin-login').style.display = 'flex';
  adminUser = null;
  allUsers  = [];
  allEvents = [];
  adminUserIds = new Set();
}

function showAdminApp() {
  document.getElementById('admin-login').style.display = 'none';
  document.getElementById('admin-app').style.display   = 'flex';
  const nameEl = document.getElementById('admin-display-name');
  if (nameEl) nameEl.textContent = adminUser.email;
  loadAdminData().then(() => {
    ensurePlansExist().then(() => {
      adminNavigate('overview');
    });
  });
}

// ── AUDIT LOG HELPER ──────────────────────────
async function logAdminAction(action, targetUserId = null, targetUserEmail = null, details = {}) {
  try {
    const client = sbAdmin;
    if (!client) return;
    if (!adminUser) return;

    await client.from('admin_audit_log').insert({
      admin_id: adminUser.id,
      admin_email: adminUser.email,
      action: action,
      target_user_id: targetUserId,
      target_user_email: targetUserEmail,
      details: details,
      user_agent: navigator.userAgent || null
    });
  } catch (e) {
    console.warn('Failed to log admin action:', e.message);
  }
}

// ── CLEAR AUDIT LOG ───────────────────────────
async function clearAuditLog() {
  openConfirmModal(
    'Clear Audit Log',
    'Are you sure you want to permanently delete all audit log entries? This action cannot be undone.',
    'danger',
    async () => {
      try {
        const client = sbAdmin;
        if (!client) throw new Error('Supabase client not initialised');
        let deleteClient = client;
        if (SB_SVC) {
          deleteClient = window.supabase.createClient(SB_URL, SB_SVC, {
            auth: { autoRefreshToken: false, persistSession: false }
          });
        }
        const { error } = await deleteClient
          .from('admin_audit_log')
          .delete()
          .neq('id', 0);
        if (error) throw error;
        await loadAdminData();
        renderEvents();
        adminToast('Audit log cleared successfully', 'success');
      } catch (e) {
        adminToast('Failed to clear audit log: ' + e.message, 'error');
      }
    }
  );
}

// ── DATA ──────────────────────────────────────
async function loadAdminData() {
  const client = sbAdmin;
  if (!client) return;

  const [uRes, eRes, aRes, logRes, propsRes, tenantsRes, plansRes] = await Promise.all([
    client.from('user_profiles').select('*').order('created_at', { ascending: false }),
    client.from('subscription_events').select('*').order('created_at', { ascending: false }).limit(200),
    client.from('admin_users').select('user_id'),
    client.from('admin_audit_log').select('*').order('created_at', { ascending: false }).limit(500),
    client.from('properties').select('user_id'),
    client.from('tenants').select('user_id'),
    client.from('plans').select('*')
  ]);

  if (uRes.error) { adminToast('Failed to load users: ' + uRes.error.message, 'error'); }
  if (eRes.error) { adminToast('Failed to load events: ' + eRes.error.message, 'error'); }
  if (aRes.error) { console.warn('Failed to load admin list: ' + aRes.error.message); }
  if (logRes.error) { console.warn('Failed to load audit log: ' + logRes.error.message); }
  if (propsRes.error) { console.warn('Failed to load properties: ' + propsRes.error.message); }
  if (tenantsRes.error) { console.warn('Failed to load tenants: ' + tenantsRes.error.message); }
  if (plansRes.error) { console.warn('Failed to load plans: ' + plansRes.error.message); }

  allUsers = uRes.data || [];
  dbPlans = plansRes.data || [];

  // Compute property and tenant counts
  const propCounts = {};
  (propsRes.data || []).forEach(p => { propCounts[p.user_id] = (propCounts[p.user_id] || 0) + 1; });
  const tenantCounts = {};
  (tenantsRes.data || []).forEach(t => { tenantCounts[t.user_id] = (tenantCounts[t.user_id] || 0) + 1; });

  allUsers.forEach(u => {
    u.property_count = propCounts[u.id] || 0;
    u.tenant_count = tenantCounts[u.id] || 0;
  });

  const combined = [...(eRes.data || []), ...(logRes.data || [])];
  allEvents = combined.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  adminUserIds = new Set((aRes.data || []).map(row => row.user_id));

  updateNavBadges();
}

function updateNavBadges() {
  const nbUsers = document.getElementById('nb-users');
  if (nbUsers) nbUsers.textContent = allUsers.length;

  const susp = allUsers.filter(u => u.plan_status === 'suspended').length;
  const nbSusp = document.getElementById('nb-suspended');
  if (nbSusp) {
    nbSusp.textContent = susp;
    nbSusp.style.display = susp > 0 ? '' : 'none';
  }
}

// ── SEED PLANS ────────────────────────────────
async function ensurePlansExist() {
  if (dbPlans.length > 0) return true;
  if (!Object.keys(PLANS_CONFIG).length) return false;

  try {
    const client = sbAdmin;
    if (!client) return false;
    let insertClient = client;
    if (SB_SVC) {
      insertClient = window.supabase.createClient(SB_URL, SB_SVC, {
        auth: { autoRefreshToken: false, persistSession: false }
      });
    }

    const planList = Object.values(PLANS_CONFIG);
    for (const plan of planList) {
      const { error } = await insertClient
        .from('plans')
        .insert({
          id: plan.id,
          name: plan.name,
          price_monthly: plan.price_monthly || 0,
          price_yearly: plan.price_yearly || 0,
          max_properties: plan.max_properties ?? -1,
          max_tenants: plan.max_tenants ?? -1,
          max_units: plan.max_units ?? -1,
          max_documents: plan.max_documents ?? -1,
          features: plan.features || []
        })
        .select();
      if (error) console.warn('Failed to insert plan:', plan.id, error.message);
    }
    // Reload data after seeding
    await loadAdminData();
    return true;
  } catch (e) {
    console.warn('Error seeding plans:', e.message);
    return false;
  }
}

// ── NAVIGATION ────────────────────────────────
function adminNavigate(page) {
  document.querySelectorAll('.admin-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#admin-sidebar .nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('admin-page-' + page)?.classList.add('active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');

  const titles = {
    overview: 'Overview',
    analytics: 'Analytics & Reports',
    users: 'All Users',
    suspended: 'Suspended Accounts',
    plans: 'Subscription Plans',
    subscriptions: 'Subscriptions',
    events: 'Audit Log',
    settings: 'Admin Settings'
  };
  document.getElementById('admin-page-title').textContent = titles[page] || page;

  const actions = document.getElementById('admin-topbar-actions');
  if (actions) actions.innerHTML = '';

  if (page === 'overview')      renderOverview();
  if (page === 'users')         renderUsers();
  if (page === 'suspended')     renderSuspended();
  if (page === 'plans')         renderPlans();
  if (page === 'subscriptions') renderSubscriptions();
  if (page === 'events')        renderEvents();
  if (page === 'settings')      renderAdminSettings();
  if (page === 'analytics')     renderAnalytics();
}

// ── OVERVIEW ──────────────────────────────────
function renderOverview() {
  const total     = allUsers.length;
  const active    = allUsers.filter(u => u.plan_status === 'active').length;
  const suspended = allUsers.filter(u => u.plan_status === 'suspended').length;

  const mrr = allUsers
    .filter(u => u.plan_status === 'active' && PLANS_CONFIG[u.plan_id])
    .reduce((s, u) => {
      const plan  = PLANS_CONFIG[u.plan_id];
      const price = u.billing_cycle === 'yearly' ? plan.price_yearly / 12 : plan.price_monthly;
      return s + price;
    }, 0);

  document.getElementById('ov-total').textContent     = total;
  document.getElementById('ov-active').textContent    = active;
  document.getElementById('ov-suspended').textContent = suspended;
  document.getElementById('ov-mrr').textContent       = '$' + mrr.toFixed(2);

  const planCounts = {};
  allUsers.forEach(u => { planCounts[u.plan_id] = (planCounts[u.plan_id] || 0) + 1; });

  document.getElementById('ov-plan-breakdown').innerHTML =
    Object.entries(planCounts).map(([pid, count]) => {
      const plan = PLANS_CONFIG[pid] || { name: pid, color: '#6366F1' };
      const pct  = total ? Math.round(count / total * 100) : 0;
      return `<div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px">
          <span style="font-weight:500">${plan.name}</span>
          <span style="color:var(--text-muted)">${count} users · ${pct}%</span>
        </div>
        <div style="background:var(--bg-elevated);border-radius:4px;height:8px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${plan.color};border-radius:4px;transition:width .5s"></div>
        </div>
      </div>`;
    }).join('');

  const recent = [...allUsers].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
  document.getElementById('ov-recent-signups').innerHTML = recent.length
    ? recent.map(u => `
      <div class="feed-item">
        <div class="feed-icon"><i class="fa-solid fa-user-plus" style="color:var(--accent-hover)"></i></div>
        <div>
          <div class="feed-text"><strong>${u.full_name || u.email}</strong> —
            <span class="plan-pill" style="background:${(PLANS_CONFIG[u.plan_id] || { color: '#6366F1' }).color}22;color:${(PLANS_CONFIG[u.plan_id] || { color: '#6366F1' }).color}">
              ${(PLANS_CONFIG[u.plan_id] || { name: u.plan_id }).name}
            </span>
          </div>
          <div class="feed-time">${fmtAdminDate(u.created_at)}</div>
        </div>
      </div>`).join('')
    : '<div style="color:var(--text-muted);font-size:13px">No users yet</div>';

  const evTypeColor = { suspended: 'var(--danger)', reactivated: 'var(--success)', plan_change: 'var(--accent-hover)', trial_expired: 'var(--warning)', payment_failed: 'var(--danger)' };
  const evTypeIcon  = { suspended: 'fa-ban', reactivated: 'fa-circle-check', plan_change: 'fa-arrow-up-right-dots', trial_expired: 'fa-clock', payment_failed: 'fa-circle-xmark' };

  const subEvents = allEvents.filter(e => e.event_type);
  document.getElementById('ov-events').innerHTML = subEvents.slice(0, 8).length
    ? subEvents.slice(0, 8).map(ev => {
      const u = allUsers.find(u => u.id === ev.user_id);
      return `<div class="feed-item">
        <div class="feed-icon"><i class="fa-solid ${evTypeIcon[ev.event_type] || 'fa-circle-info'}" style="color:${evTypeColor[ev.event_type] || 'var(--text-muted)'}"></i></div>
        <div>
          <div class="feed-text"><strong>${u ? (u.full_name || u.email) : ev.user_id}</strong> — ${ev.event_type.replace('_', ' ')} ${ev.new_plan ? '→ <strong>' + ev.new_plan + '</strong>' : ''}</div>
          <div class="feed-time">${ev.notes ? ev.notes + ' · ' : ''}${fmtAdminDate(ev.created_at)}</div>
        </div>
      </div>`;
    }).join('')
    : '<div style="color:var(--text-muted);font-size:13px">No events recorded</div>';
}

// ── USERS TABLE ───────────────────────────────
function filterUsers() {
  const q      = document.getElementById('user-search')?.value.toLowerCase() || '';
  const plan   = document.getElementById('user-plan-filter')?.value || '';
  const status = document.getElementById('user-status-filter')?.value || '';

  filteredUsers = allUsers.filter(u =>
    (!q      || (u.email || '').toLowerCase().includes(q) || (u.full_name || '').toLowerCase().includes(q) || (u.company_name || '').toLowerCase().includes(q)) &&
    (!plan   || u.plan_id === plan) &&
    (!status || u.plan_status === status)
  );
  usersPage = 1;
  renderUsersPage();
}

function renderUsers() {
  filteredUsers = [...allUsers];
  renderUsersPage();
}

function renderUsersPage() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;

  if (!filteredUsers.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-users"></i></div><div class="empty-title">No users found</div></div></td></tr>';
    document.getElementById('users-pagination').innerHTML = '';
    return;
  }

  const start = (usersPage - 1) * usersPageSize;
  const page  = filteredUsers.slice(start, start + usersPageSize);
  const statusCls = { active: 'badge-success', suspended: 'badge-danger', cancelled: 'badge-info', past_due: 'badge-warning' };

  tbody.innerHTML = page.map(u => {
    const plan      = PLANS_CONFIG[u.plan_id] || { name: u.plan_id, color: '#6366F1' };
    const endDate   = u.plan_id === 'free_trial' ? u.trial_ends_at : u.subscription_ends_at;
    const isExpiring = endDate && new Date(endDate) < new Date(Date.now() + 7 * 86400000);

    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="user-initials-avatar">${(u.full_name || u.email || '?')[0].toUpperCase()}</div>
          <div>
            <div style="font-weight:500">${u.full_name || '—'}</div>
            <div style="font-size:11.5px;color:var(--text-secondary)">${u.email}</div>
            ${u.company_name ? `<div style="font-size:11px;color:var(--text-muted)">${u.company_name}</div>` : ''}
          </div>
        </div>
      </td>
      <td><span class="plan-pill" style="background:${plan.color}22;color:${plan.color};border:1px solid ${plan.color}44">${plan.name}</span></td>
      <td><span class="badge ${statusCls[u.plan_status] || 'badge-info'}">${u.plan_status}</span></td>
      <td>
        ${adminUserIds.has(u.id)
      ? `<span class="badge badge-admin" style="background:var(--accent-hover)22;color:var(--accent-hover);border:1px solid var(--accent-hover)"><i class="fa-solid fa-shield-halved"></i> Admin</span>`
      : `<span style="color:var(--text-muted);font-size:12px">—</span>`
    }
      </td>
      <td style="font-size:12px;${isExpiring ? 'color:var(--warning)' : ''}">
        ${endDate ? fmtAdminDate(endDate) + (isExpiring ? ' ⚠' : '') : '—'}
      </td>
      <td style="text-align:center;font-size:12px">${u.property_count ?? '—'}</td>
      <td style="text-align:center;font-size:12px">${u.tenant_count ?? '—'}</td>
      <td style="font-size:12px">${fmtAdminDate(u.created_at)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-icon" title="View details" onclick="viewUser('${u.id}')"><i class="fa-solid fa-eye"></i></button>
          <button class="btn btn-sm btn-icon" title="Edit user" onclick="openEditUser('${u.id}')"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm btn-icon" title="Change plan" onclick="openChangePlan('${u.id}')"><i class="fa-solid fa-tags"></i></button>
          <button class="btn btn-sm btn-icon" title="Reset password" onclick="openResetPassword('${u.id}')"><i class="fa-solid fa-key"></i></button>
          ${u.plan_status === 'suspended'
      ? `<button class="btn btn-sm btn-icon btn-success" title="Reactivate" onclick="openReactivate('${u.id}')"><i class="fa-solid fa-circle-check"></i></button>`
      : `<button class="btn btn-sm btn-icon btn-danger" title="Suspend" onclick="openSuspend('${u.id}')"><i class="fa-solid fa-ban"></i></button>`
    }
          <button class="btn btn-sm btn-icon btn-danger" title="Delete user permanently" onclick="deleteUser('${u.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');

  buildAdminPagination('users-pagination', usersPage, filteredUsers.length, usersPageSize, 'goToUsersPage', 'setUsersPageSize');
}

function goToUsersPage(p) { usersPage = Math.max(1, Math.min(p, Math.ceil(filteredUsers.length / usersPageSize) || 1)); renderUsersPage(); }
function setUsersPageSize(s) { usersPageSize = Number(s); usersPage = 1; renderUsersPage(); }

// ── USER DETAIL ───────────────────────────────
function viewUser(userId) {
  const u = allUsers.find(u => u.id === userId);
  if (!u) return;

  const plan        = PLANS_CONFIG[u.plan_id] || { name: u.plan_id, color: '#6366F1' };
  const userEvents  = allEvents.filter(e => e.user_id === userId);
  const statusCls   = { active: 'badge-success', suspended: 'badge-danger', cancelled: 'badge-info', past_due: 'badge-warning' };
  const evTypeIcon  = { suspended: 'fa-ban', reactivated: 'fa-circle-check', plan_change: 'fa-arrow-up', trial_expired: 'fa-clock', payment_failed: 'fa-circle-xmark' };

  document.getElementById('user-modal-name').textContent = u.full_name || u.email;
  document.getElementById('user-modal-content').innerHTML = `
    <div class="detail-grid" style="margin-bottom:18px">
      <div class="detail-item"><label>Email</label><div class="detail-value">${u.email}</div></div>
      <div class="detail-item"><label>Full Name</label><div class="detail-value">${u.full_name || '—'}</div></div>
      <div class="detail-item"><label>Company</label><div class="detail-value">${u.company_name || '—'}</div></div>
      <div class="detail-item"><label>Phone</label><div class="detail-value">${u.phone || '—'}</div></div>
      <div class="detail-item"><label>Plan</label><div class="detail-value"><span class="plan-pill" style="background:${plan.color}22;color:${plan.color}">${plan.name}</span></div></div>
      <div class="detail-item"><label>Status</label><div class="detail-value"><span class="badge ${statusCls[u.plan_status] || 'badge-info'}">${u.plan_status}</span></div></div>
      <div class="detail-item"><label>Billing Cycle</label><div class="detail-value">${u.billing_cycle || 'monthly'}</div></div>
      <div class="detail-item"><label>Joined</label><div class="detail-value">${fmtAdminDate(u.created_at)}</div></div>
      ${u.trial_ends_at ? `<div class="detail-item"><label>Trial Ends</label><div class="detail-value">${fmtAdminDate(u.trial_ends_at)}</div></div>` : ''}
      ${u.subscription_ends_at ? `<div class="detail-item"><label>Sub Ends</label><div class="detail-value">${fmtAdminDate(u.subscription_ends_at)}</div></div>` : ''}
      ${u.suspended_at ? `<div class="detail-item"><label>Suspended</label><div class="detail-value" style="color:var(--danger)">${fmtAdminDate(u.suspended_at)}</div></div>` : ''}
      ${u.suspended_reason ? `<div class="detail-item"><label>Suspend Reason</label><div class="detail-value" style="color:var(--danger)">${u.suspended_reason}</div></div>` : ''}
    </div>
    <div style="border-top:1px solid var(--border);padding-top:14px;margin-bottom:10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted)">Quick Actions</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px">
      <button class="btn btn-sm" onclick="closeAdminModal('modal-user');openChangePlan('${u.id}')"><i class="fa-solid fa-tags"></i> Change Plan</button>
      <button class="btn btn-sm" onclick="closeAdminModal('modal-user');openEditUser('${u.id}')"><i class="fa-solid fa-pen"></i> Edit Profile</button>
      <button class="btn btn-sm" onclick="closeAdminModal('modal-user');openResetPassword('${u.id}')"><i class="fa-solid fa-key"></i> Reset Password</button>
      ${u.plan_status === 'suspended'
    ? `<button class="btn btn-sm btn-success" onclick="closeAdminModal('modal-user');openReactivate('${u.id}')"><i class="fa-solid fa-circle-check"></i> Reactivate</button>`
    : `<button class="btn btn-sm btn-danger" onclick="closeAdminModal('modal-user');openSuspend('${u.id}')"><i class="fa-solid fa-ban"></i> Suspend</button>`
  }
    </div>
    <div style="border-top:1px solid var(--border);padding-top:14px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:10px">Subscription History (${userEvents.length})</div>
      ${userEvents.length === 0
    ? '<div style="color:var(--text-muted);font-size:13px">No events recorded</div>'
    : userEvents.map(ev => `
          <div class="feed-item">
            <div class="feed-icon"><i class="fa-solid ${evTypeIcon[ev.event_type] || 'fa-circle-info'}" style="color:var(--accent-hover)"></i></div>
            <div>
              <div class="feed-text"><strong style="text-transform:capitalize">${ev.event_type.replace('_', ' ')}</strong>${ev.new_plan ? ' → ' + ev.new_plan : ''}</div>
              <div class="feed-time">${ev.notes ? ev.notes + ' · ' : ''}${fmtAdminDate(ev.created_at)}</div>
            </div>
          </div>`).join('')}
    </div>`;

  openAdminModal('modal-user');
}

// ── SUSPENDED ─────────────────────────────────
function renderSuspended() {
  const suspended = allUsers.filter(u => u.plan_status === 'suspended');
  const tbody = document.getElementById('suspended-tbody');
  if (!tbody) return;

  if (!suspended.length) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-circle-check" style="color:var(--success)"></i></div><div class="empty-title">No suspended accounts</div></div></td></tr>';
    return;
  }

  tbody.innerHTML = suspended.map(u => {
    const plan = PLANS_CONFIG[u.plan_id] || { name: u.plan_id, color: '#6366F1' };
    return `<tr>
      <td>
        <div style="font-weight:500">${u.full_name || '—'}</div>
        <div style="font-size:11.5px;color:var(--text-secondary)">${u.email}</div>
      </td>
      <td><span class="plan-pill" style="background:${plan.color}22;color:${plan.color}">${plan.name}</span></td>
      <td style="font-size:12px">${u.suspended_at ? fmtAdminDate(u.suspended_at) : '—'}</td>
      <td style="font-size:12px;color:var(--danger)">${u.suspended_reason || '—'}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-success" onclick="openReactivate('${u.id}')"><i class="fa-solid fa-circle-check"></i> Reactivate</button>
          <button class="btn btn-sm btn-icon" onclick="viewUser('${u.id}')"><i class="fa-solid fa-eye"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── PLANS PAGE ────────────────────────────────
function togglePlansEditMode() {
  plansEditMode = !plansEditMode;
  renderPlans();
}

async function renderPlans() {
  const grid = document.getElementById('plans-grid');
  if (!grid) return;

  // If no plans in db, try to seed
  if (dbPlans.length === 0 && Object.keys(PLANS_CONFIG).length > 0) {
    await ensurePlansExist();
    // re-run this function after seeding
    renderPlans();
    return;
  }

  // Show edit/save buttons in topbar
  const actions = document.getElementById('admin-topbar-actions');
  if (actions) {
    if (plansEditMode) {
      actions.innerHTML = `
        <button class="btn btn-success" onclick="savePlans()"><i class="fa-solid fa-floppy-disk"></i> Save Plans</button>
        <button class="btn" onclick="togglePlansEditMode()"><i class="fa-solid fa-xmark"></i> Cancel</button>
      `;
    } else {
      actions.innerHTML = `
        <button class="btn btn-primary" onclick="togglePlansEditMode()"><i class="fa-solid fa-pen"></i> Edit Plans</button>
      `;
    }
  }

  if (!dbPlans.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-tags"></i></div><div class="empty-title">No plans found in database</div></div>';
    return;
  }

  const allFeatures = Object.keys(FEATURE_LABELS);
  const planOrder = ['free_trial', 'basic', 'pro', 'premium', 'special'];

  const sortedPlans = [...dbPlans].sort((a, b) => planOrder.indexOf(a.id) - planOrder.indexOf(b.id));

  grid.innerHTML = sortedPlans.map(plan => {
    const color = PLANS_CONFIG[plan.id]?.color || '#6366F1';
    const features = plan.features || [];

    let editControls = '';
    if (plansEditMode) {
      editControls = `
        <div class="plan-edit-controls" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
          <div class="form-row-2" style="margin-bottom:6px">
            <div><label style="font-size:11px">Monthly Price ($)</label><input type="number" class="plan-input" data-plan-id="${plan.id}" data-field="price_monthly" value="${plan.price_monthly}" step="0.01" min="0"></div>
            <div><label style="font-size:11px">Yearly Price ($)</label><input type="number" class="plan-input" data-plan-id="${plan.id}" data-field="price_yearly" value="${plan.price_yearly}" step="0.01" min="0"></div>
          </div>
          <div class="form-row-2" style="margin-bottom:6px">
            <div><label style="font-size:11px">Max Properties</label><input type="number" class="plan-input" data-plan-id="${plan.id}" data-field="max_properties" value="${plan.max_properties}" min="-1"></div>
            <div><label style="font-size:11px">Max Tenants</label><input type="number" class="plan-input" data-plan-id="${plan.id}" data-field="max_tenants" value="${plan.max_tenants}" min="-1"></div>
          </div>
          <div class="form-row-2" style="margin-bottom:6px">
            <div><label style="font-size:11px">Max Units</label><input type="number" class="plan-input" data-plan-id="${plan.id}" data-field="max_units" value="${plan.max_units}" min="-1"></div>
            <div><label style="font-size:11px">Max Documents</label><input type="number" class="plan-input" data-plan-id="${plan.id}" data-field="max_documents" value="${plan.max_documents}" min="-1"></div>
          </div>
          <div style="margin-top:8px">
            <label style="font-size:11px;margin-bottom:4px;display:block">Features</label>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${allFeatures.map(f => {
        const checked = features.includes(f) ? 'checked' : '';
        return `<label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
                  <input type="checkbox" class="plan-feature-toggle" data-plan-id="${plan.id}" data-feature="${f}" ${checked}>
                  ${FEATURE_LABELS[f] || f}
                </label>`;
      }).join('')}
            </div>
          </div>
        </div>
      `;
    }

    return `<div class="plan-card" style="border-color:${color}44">
      <div class="plan-card-header" style="background:${color}22;border-bottom:2px solid ${color}">
        <div class="plan-card-name" style="color:${color}">${plan.name}</div>
        <div class="plan-card-price">
          ${plan.price_monthly > 0 ? `$${plan.price_monthly}<span style="font-size:12px;font-weight:400">/mo</span>` : 'Free'}
        </div>
        ${plan.price_yearly > 0 ? `<div style="font-size:11px;color:var(--text-muted)">$${plan.price_yearly}/yr</div>` : ''}
      </div>
      <div class="plan-card-body">
        <div class="plan-stat"><span>Active users</span><strong>${allUsers.filter(u => u.plan_id === plan.id).length}</strong></div>
        <div class="plan-stat"><span>MRR from plan</span><strong>$${allUsers.filter(u => u.plan_id === plan.id && u.plan_status === 'active').reduce((s,u) => s + (u.billing_cycle === 'yearly' ? plan.price_yearly/12 : plan.price_monthly), 0).toFixed(2)}</strong></div>
        <div class="plan-stat"><span>Properties limit</span><strong>${plan.max_properties === -1 ? 'Unlimited' : plan.max_properties}</strong></div>
        <div class="plan-stat"><span>Tenants limit</span><strong>${plan.max_tenants === -1 ? 'Unlimited' : plan.max_tenants}</strong></div>
        <div style="margin-top:12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px">Features</div>
        ${features.slice(0, 6).map(f => `<div style="font-size:12px;padding:2px 0;color:var(--text-secondary)"><i class="fa-solid fa-check" style="color:${color};margin-right:6px;font-size:10px"></i>${FEATURE_LABELS[f] || f}</div>`).join('')}
        ${features.length > 6 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">+${features.length - 6} more features</div>` : ''}
        ${editControls}
      </div>
    </div>`;
  }).join('');
}

async function savePlans() {
  try {
    const client = sbAdmin;
    if (!client) throw new Error('Supabase client not initialised');

    const inputs = document.querySelectorAll('.plan-input');
    const featureToggles = document.querySelectorAll('.plan-feature-toggle');

    const updates = {};
    inputs.forEach(inp => {
      const planId = inp.dataset.planId;
      const field = inp.dataset.field;
      if (!updates[planId]) updates[planId] = {};
      updates[planId][field] = field === 'price_monthly' || field === 'price_yearly' ? parseFloat(inp.value) : parseInt(inp.value);
    });

    featureToggles.forEach(toggle => {
      const planId = toggle.dataset.planId;
      const feature = toggle.dataset.feature;
      if (!updates[planId]) updates[planId] = {};
      if (!updates[planId].features) updates[planId].features = [];
      if (toggle.checked) updates[planId].features.push(feature);
    });

    const savePromises = Object.keys(updates).map(async (planId) => {
      const planUpdate = updates[planId];
      const payload = {
        price_monthly: planUpdate.price_monthly ?? 0,
        price_yearly: planUpdate.price_yearly ?? 0,
        max_properties: planUpdate.max_properties ?? -1,
        max_tenants: planUpdate.max_tenants ?? -1,
        max_units: planUpdate.max_units ?? -1,
        max_documents: planUpdate.max_documents ?? -1,
        features: planUpdate.features || []
      };
      let saveClient = client;
      if (SB_SVC) {
        saveClient = window.supabase.createClient(SB_URL, SB_SVC, {
          auth: { autoRefreshToken: false, persistSession: false }
        });
      }
      const { error } = await saveClient
        .from('plans')
        .update(payload)
        .eq('id', planId);
      if (error) throw error;
    });

    await Promise.all(savePromises);
    await loadAdminData();
    plansEditMode = false;
    renderPlans();
    adminToast('Plans updated successfully', 'success');
  } catch (e) {
    adminToast('Failed to save plans: ' + e.message, 'error');
  }
}

// ── SUBSCRIPTIONS TABLE ───────────────────────
function filterSubscriptions() {
  const plan   = document.getElementById('sub-plan-filter')?.value || '';
  const status = document.getElementById('sub-status-filter')?.value || '';
  filteredSubs = allUsers.filter(u =>
    (!plan   || u.plan_id === plan) &&
    (!status || u.plan_status === status)
  );
  subsPage = 1;
  renderSubsPage();
}

function renderSubscriptions() {
  filteredSubs = [...allUsers];
  renderSubsPage();
}

function renderSubsPage() {
  const tbody = document.getElementById('subs-tbody');
  if (!tbody) return;

  if (!filteredSubs.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-title">No subscriptions found</div></div></td></tr>';
    return;
  }

  const start = (subsPage - 1) * subsPageSize;
  const page  = filteredSubs.slice(start, start + subsPageSize);
  const statusCls = { active: 'badge-success', suspended: 'badge-danger', cancelled: 'badge-info', past_due: 'badge-warning' };

  tbody.innerHTML = page.map(u => {
    const plan      = PLANS_CONFIG[u.plan_id] || { name: u.plan_id, color: '#6366F1', price_monthly: 0, price_yearly: 0 };
    const mrr       = u.billing_cycle === 'yearly' ? plan.price_yearly / 12 : plan.price_monthly;
    const endDate   = u.plan_id === 'free_trial' ? u.trial_ends_at : u.subscription_ends_at;
    const isExpiring = endDate && new Date(endDate) < new Date(Date.now() + 7 * 86400000) && u.plan_status === 'active';

    return `<tr>
      <td>
        <div style="font-weight:500">${u.full_name || '—'}</div>
        <div style="font-size:11.5px;color:var(--text-secondary)">${u.email}</div>
      </td>
      <td><span class="plan-pill" style="background:${plan.color}22;color:${plan.color}">${plan.name}</span></td>
      <td style="text-transform:capitalize;font-size:12px">${u.billing_cycle || 'monthly'}</td>
      <td><span class="badge ${statusCls[u.plan_status] || 'badge-info'}">${u.plan_status}</span></td>
      <td style="font-size:12px;${isExpiring ? 'color:var(--warning)' : ''}">
        ${endDate ? fmtAdminDate(endDate) + (isExpiring ? ' ⚠' : '') : '—'}
      </td>
      <td style="font-family:var(--font-mono);font-size:12px">$${mrr.toFixed(2)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-sm btn-icon" title="Change plan" onclick="openChangePlan('${u.id}')"><i class="fa-solid fa-tags"></i></button>
          ${u.plan_status === 'suspended'
      ? `<button class="btn btn-sm btn-icon btn-success" onclick="openReactivate('${u.id}')"><i class="fa-solid fa-circle-check"></i></button>`
      : `<button class="btn btn-sm btn-icon btn-danger" onclick="openSuspend('${u.id}')"><i class="fa-solid fa-ban"></i></button>`
    }
        </div>
      </td>
    </tr>`;
  }).join('');

  buildAdminPagination('subs-pagination', subsPage, filteredSubs.length, subsPageSize, 'goToSubsPage', 'setSubsPageSize');
}

function goToSubsPage(p) { subsPage = Math.max(1, Math.min(p, Math.ceil(filteredSubs.length / subsPageSize) || 1)); renderSubsPage(); }
function setSubsPageSize(s) { subsPageSize = Number(s); subsPage = 1; renderSubsPage(); }

// ── AUDIT LOG ─────────────────────────────────
let filteredEvents = [];

function renderEvents() {
  const tbody = document.getElementById('events-tbody');
  if (!tbody) return;

  const search = document.getElementById('event-search')?.value.toLowerCase() || '';
  const actionFilter = document.getElementById('event-action-filter')?.value || '';
  const dateFrom = document.getElementById('event-date-from')?.value || '';
  const dateTo = document.getElementById('event-date-to')?.value || '';

  filteredEvents = allEvents.filter(ev => {
    const userEmail = ev.target_user_email || (ev.user_id ? (allUsers.find(u => u.id === ev.user_id)?.email || '') : '');
    const adminEmail = ev.admin_email || '';

    const matchesSearch = !search ||
      (adminEmail && adminEmail.toLowerCase().includes(search)) ||
      (userEmail && userEmail.toLowerCase().includes(search)) ||
      (ev.action && ev.action.toLowerCase().includes(search)) ||
      (ev.event_type && ev.event_type.toLowerCase().includes(search)) ||
      (ev.details && JSON.stringify(ev.details).toLowerCase().includes(search));

    const action = ev.action || ev.event_type || '';
    const matchesAction = !actionFilter || action === actionFilter;

    const matchesDate = (!dateFrom || (ev.created_at && ev.created_at >= dateFrom)) &&
      (!dateTo || (ev.created_at && ev.created_at <= dateTo));

    return matchesSearch && matchesAction && matchesDate;
  });

  if (!filteredEvents.length) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-clock-rotate-left"></i></div><div class="empty-title">No events found</div></div></td></tr>';
    document.getElementById('events-pagination').innerHTML = '';
    return;
  }

  const start = (eventsPage - 1) * eventsPageSize;
  const page  = filteredEvents.slice(start, start + eventsPageSize);

  const actionColors = {
    user_registered: 'var(--success)',
    user_deleted: 'var(--danger)',
    user_suspended: 'var(--danger)',
    user_reactivated: 'var(--success)',
    plan_changed: 'var(--accent-hover)',
    user_updated: 'var(--warning)',
    suspended: 'var(--danger)',
    reactivated: 'var(--success)',
    plan_change: 'var(--accent-hover)',
    trial_expired: 'var(--warning)',
    payment_failed: 'var(--danger)',
    cancelled: 'var(--text-muted)'
  };

  const actionIcons = {
    user_registered: 'fa-user-plus',
    user_deleted: 'fa-user-minus',
    user_suspended: 'fa-ban',
    user_reactivated: 'fa-circle-check',
    plan_changed: 'fa-tags',
    user_updated: 'fa-pen',
    suspended: 'fa-ban',
    reactivated: 'fa-circle-check',
    plan_change: 'fa-tags',
    trial_expired: 'fa-clock',
    payment_failed: 'fa-circle-xmark',
    cancelled: 'fa-times-circle'
  };

  tbody.innerHTML = page.map(ev => {
    const actionLabel = (ev.action || ev.event_type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const displayUser = ev.target_user_email || (ev.user_id ? (allUsers.find(u => u.id === ev.user_id)?.email || ev.user_id) : '—');
    const adminName = ev.admin_email || 'System';
    const detailsHtml = ev.details ? JSON.stringify(ev.details) : (ev.notes || '—');
    const actionKey = ev.action || ev.event_type || '';
    const color = actionColors[actionKey] || 'var(--text-secondary)';
    const icon = actionIcons[actionKey] || 'fa-circle-info';

    return `<tr>
      <td style="font-size:12px">${fmtAdminDate(ev.created_at)}</td>
      <td style="font-size:12px">${adminName}</td>
      <td>
        <span style="color:${color};font-weight:500;font-size:12.5px">
          <i class="fa-solid ${icon}" style="margin-right:4px"></i>
          ${actionLabel}
        </span>
      </td>
      <td style="font-size:12px">${displayUser}</td>
      <td style="font-size:12px;color:var(--text-secondary)">${detailsHtml}</td>
    </tr>`;
  }).join('');

  buildAdminPagination('events-pagination', eventsPage, filteredEvents.length, eventsPageSize, 'goToEventsPage', 'setEventsPageSize');
}

function goToEventsPage(p) {
  const totalPages = Math.ceil(filteredEvents.length / eventsPageSize) || 1;
  eventsPage = Math.max(1, Math.min(p, totalPages));
  renderEvents();
}

function setEventsPageSize(s) {
  eventsPageSize = Number(s);
  eventsPage = 1;
  renderEvents();
}

// ── ADMIN SETTINGS ────────────────────────────
function renderAdminSettings() {
  const connEl = document.getElementById('settings-connection-status');
  if (connEl) {
    connEl.innerHTML = CONFIGURED
      ? '<div style="color:var(--success);font-size:13px"><i class="fa-solid fa-circle-check"></i> Connected to Supabase</div>'
      : '<div style="color:var(--danger);font-size:13px"><i class="fa-solid fa-triangle-exclamation"></i> Supabase not configured. Update your env.js file.</div>';
  }
  const urlEl = document.getElementById('settings-sb-url');
  const keyEl = document.getElementById('settings-sb-key');
  if (urlEl) urlEl.value = SB_URL || '—';
  if (keyEl) keyEl.value = SB_ANON ? SB_ANON.slice(0, 20) + '…' : '—';
}

function saveAdminSettings() { adminToast('Settings saved', 'success'); }

async function runExpireTrials() {
  const client = sbAdmin;
  if (!client) return;
  try {
    const { error } = await client.rpc('expire_trials');
    if (error) throw error;
    await loadAdminData();
    adminNavigate('overview');
    adminToast('Trials processed', 'success');
  } catch (e) {
    adminToast('Failed to expire trials: ' + e.message, 'error');
  }
}

// ── CHANGE PLAN ───────────────────────────────
function openChangePlan(userId) {
  const u = allUsers.find(u => u.id === userId);
  if (!u) return;
  document.getElementById('cp-user-id').value            = userId;
  document.getElementById('cp-user-name').textContent    = u.full_name || u.email;
  document.getElementById('cp-plan').value               = u.plan_id;
  document.getElementById('cp-cycle').value              = u.billing_cycle || 'monthly';
  document.getElementById('cp-notes').value              = '';
  openAdminModal('modal-change-plan');
}

async function confirmChangePlan() {
  const userId  = document.getElementById('cp-user-id').value;
  const newPlan = document.getElementById('cp-plan').value;
  const cycle   = document.getElementById('cp-cycle').value;
  const notes   = document.getElementById('cp-notes').value.trim() || 'Plan changed by admin';
  const u       = allUsers.find(u => u.id === userId);
  if (!u) return;

  const client = sbAdmin;
  if (!client) return;

  const oldPlan = u.plan_id;

  try {
    const { error: updateErr } = await client.from('user_profiles').update({
      plan_id: newPlan, billing_cycle: cycle, plan_status: 'active',
      subscription_ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      trial_ends_at: newPlan === 'free_trial' ? new Date(Date.now() + 14 * 86400000).toISOString() : null,
    }).eq('id', userId);
    if (updateErr) throw updateErr;

    await client.from('subscription_events').insert({
      user_id: userId, event_type: 'plan_change',
      old_plan: oldPlan, new_plan: newPlan, notes,
      created_by: adminUser?.id
    });

    await logAdminAction('plan_changed', userId, u.email, { old_plan: oldPlan, new_plan: newPlan, cycle: cycle });

    await loadAdminData();
    closeAdminModal('modal-change-plan');
    adminToast('Plan updated to ' + (PLANS_CONFIG[newPlan]?.name || newPlan), 'success');
    renderUsers();
  } catch (e) {
    adminToast('Failed to change plan: ' + e.message, 'error');
  }
}

// ── SUSPEND ───────────────────────────────────
function openSuspend(userId) {
  const u = allUsers.find(u => u.id === userId);
  if (!u) return;
  document.getElementById('suspend-user-id').value        = userId;
  document.getElementById('suspend-user-name').textContent = (u.full_name || '') + ' (' + u.email + ')';
  document.getElementById('suspend-reason-preset').value  = '';
  document.getElementById('suspend-reason').value         = '';
  document.getElementById('suspend-custom-row').style.display = 'none';
  openAdminModal('modal-suspend');
}

function setSuspendReason(val) {
  const customRow = document.getElementById('suspend-custom-row');
  if (val === 'custom') {
    customRow.style.display = '';
  } else {
    customRow.style.display = 'none';
    document.getElementById('suspend-reason').value = val;
  }
}

async function confirmSuspend() {
  const userId = document.getElementById('suspend-user-id').value;
  const preset = document.getElementById('suspend-reason-preset').value;
  const reason = preset === 'custom'
    ? document.getElementById('suspend-reason').value.trim()
    : preset;

  if (!reason) { adminToast('Please select or enter a reason', 'error'); return; }

  const client = sbAdmin;
  if (!client) return;

  try {
    const { error } = await client.rpc('suspend_user', {
      p_user_id: userId,
      p_reason: reason,
      p_admin_id: adminUser?.id
    });
    if (error) throw error;

    await client.from('subscription_events').insert({
      user_id: userId, event_type: 'suspended',
      old_plan: allUsers.find(u => u.id === userId)?.plan_id || null,
      new_plan: null, notes: reason, created_by: adminUser?.id
    });

    await logAdminAction('user_suspended', userId, allUsers.find(u => u.id === userId)?.email, { reason: reason });

    await loadAdminData();
    closeAdminModal('modal-suspend');
    adminToast('Account suspended', 'success');
    renderUsers();
    renderSuspended();
  } catch (e) {
    try {
      await client.from('user_profiles').update({
        plan_status: 'suspended',
        suspended_at: new Date().toISOString(),
        suspended_reason: reason
      }).eq('id', userId);

      await client.from('subscription_events').insert({
        user_id: userId, event_type: 'suspended',
        old_plan: allUsers.find(u => u.id === userId)?.plan_id || null,
        new_plan: null, notes: reason, created_by: adminUser?.id
      });

      await logAdminAction('user_suspended', userId, allUsers.find(u => u.id === userId)?.email, { reason: reason });

      await loadAdminData();
      closeAdminModal('modal-suspend');
      adminToast('Account suspended', 'success');
      renderUsers();
      renderSuspended();
    } catch (e2) {
      adminToast('Failed to suspend: ' + e2.message, 'error');
    }
  }
}

// ── REACTIVATE ────────────────────────────────
function openReactivate(userId) {
  const u = allUsers.find(u => u.id === userId);
  if (!u) return;
  document.getElementById('react-user-id').value        = userId;
  document.getElementById('react-user-name').textContent = (u.full_name || '') + ' (' + u.email + ')';
  document.getElementById('react-plan').value           = u.plan_id === 'free_trial' ? 'basic' : u.plan_id;
  openAdminModal('modal-reactivate');
}

async function confirmReactivate() {
  const userId  = document.getElementById('react-user-id').value;
  const newPlan = document.getElementById('react-plan').value;
  const client  = sbAdmin;
  if (!client) return;

  try {
    const { error } = await client.rpc('reactivate_user', {
      p_user_id: userId,
      p_plan_id: newPlan,
      p_admin_id: adminUser?.id
    });
    if (error) throw error;

    await client.from('subscription_events').insert({
      user_id: userId, event_type: 'reactivated',
      old_plan: allUsers.find(u => u.id === userId)?.plan_id || null,
      new_plan: newPlan, notes: 'Reactivated by admin', created_by: adminUser?.id
    });

    await logAdminAction('user_reactivated', userId, allUsers.find(u => u.id === userId)?.email, { new_plan: newPlan });

    await loadAdminData();
    closeAdminModal('modal-reactivate');
    adminToast('Account reactivated', 'success');
    renderUsers();
    renderSuspended();
  } catch (e) {
    try {
      await client.from('user_profiles').update({
        plan_id: newPlan,
        plan_status: 'active',
        suspended_at: null,
        suspended_reason: null,
        subscription_ends_at: new Date(Date.now() + 30 * 86400000).toISOString()
      }).eq('id', userId);

      await client.from('subscription_events').insert({
        user_id: userId, event_type: 'reactivated',
        old_plan: allUsers.find(u => u.id === userId)?.plan_id || null,
        new_plan: newPlan, notes: 'Reactivated by admin', created_by: adminUser?.id
      });

      await logAdminAction('user_reactivated', userId, allUsers.find(u => u.id === userId)?.email, { new_plan: newPlan });

      await loadAdminData();
      closeAdminModal('modal-reactivate');
      adminToast('Account reactivated', 'success');
      renderUsers();
      renderSuspended();
    } catch (e2) {
      adminToast('Failed to reactivate: ' + e2.message, 'error');
    }
  }
}

// ── DELETE USER ───────────────────────────────
let _pendingDeleteUserId = null;

function deleteUser(userId) {
  const u = allUsers.find(u => u.id === userId);
  if (!u) return;

  if (adminUser && u.id === adminUser.id) {
    adminToast('You cannot delete your own admin account.', 'error');
    return;
  }

  _pendingDeleteUserId = userId;
  document.getElementById('delete-user-id').value = userId;
  document.getElementById('delete-user-name').textContent = (u.full_name || '') + ' (' + u.email + ')';
  document.getElementById('delete-reason-preset').value = '';
  document.getElementById('delete-reason').value = '';
  document.getElementById('delete-custom-row').style.display = 'none';
  openAdminModal('modal-delete');
}

function setDeleteReason(val) {
  const customRow = document.getElementById('delete-custom-row');
  if (val === 'custom') {
    customRow.style.display = '';
  } else {
    customRow.style.display = 'none';
    document.getElementById('delete-reason').value = val;
  }
}

async function confirmDeleteUser() {
  const userId = document.getElementById('delete-user-id').value;
  const preset = document.getElementById('delete-reason-preset').value;
  const reason = preset === 'custom'
    ? document.getElementById('delete-reason').value.trim()
    : preset;

  const finalReason = reason || 'No reason provided';
  const u = allUsers.find(u => u.id === userId);

  const client = sbAdmin;
  if (!client) { adminToast('Supabase client not initialised', 'error'); return; }

  const btn = document.getElementById('confirm-delete-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Deleting…';

  try {
    const { data, error } = await client.rpc('delete_user', { p_user_id: userId });
    if (error) throw error;

    if (u) {
      await logAdminAction('user_deleted', userId, u.email, { reason: finalReason, full_name: u.full_name });
    }

    await loadAdminData();
    renderUsers();
    closeAdminModal('modal-delete');
    adminToast('User deleted successfully', 'success');
  } catch (e) {
    adminToast('Failed to delete user: ' + e.message, 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete Permanently';
  _pendingDeleteUserId = null;
}

// ── RESET PASSWORD ────────────────────────────
function openResetPassword(userId) {
  const u = allUsers.find(u => u.id === userId);
  if (!u) return;
  document.getElementById('reset-user-id').value = userId;
  document.getElementById('reset-user-name').textContent = (u.full_name || '') + ' (' + u.email + ')';
  document.getElementById('reset-password').value = '';
  document.getElementById('reset-password-confirm').value = '';
  document.getElementById('reset-error').style.display = 'none';
  openAdminModal('modal-reset-password');
}

async function confirmResetPassword() {
  const userId = document.getElementById('reset-user-id').value;
  const newPwd = document.getElementById('reset-password').value;
  const confirm = document.getElementById('reset-password-confirm').value;
  const errEl = document.getElementById('reset-error');
  errEl.style.display = 'none';

  if (!newPwd || !confirm) {
    errEl.textContent = 'Both password fields are required.';
    errEl.style.display = 'block';
    return;
  }
  if (newPwd.length < 8) {
    errEl.textContent = 'Password must be at least 8 characters.';
    errEl.style.display = 'block';
    return;
  }
  if (newPwd !== confirm) {
    errEl.textContent = 'Passwords do not match.';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('reset-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Resetting…';

  try {
    const serviceKey = SB_SVC;
    let client = sbAdmin;
    if (serviceKey) {
      client = window.supabase.createClient(SB_URL, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
      });
    }

    if (serviceKey && client !== sbAdmin) {
      const { error } = await client.auth.admin.updateUserById(userId, { password: newPwd });
      if (error) throw error;
      adminToast('Password reset successfully. User can now log in with the new password.', 'success');
      closeAdminModal('modal-reset-password');
    } else {
      const u = allUsers.find(u => u.id === userId);
      if (!u) throw new Error('User not found');
      const { error } = await sbAdmin.auth.resetPasswordForEmail(u.email, {
        redirectTo: window.location.origin + '/reset-password'
      });
      if (error) throw error;
      adminToast('Password reset email sent to ' + u.email, 'success');
      closeAdminModal('modal-reset-password');
    }
  } catch (e) {
    errEl.textContent = 'Failed to reset password: ' + e.message;
    errEl.style.display = 'block';
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-key"></i> Reset Password';
}

// ── CONFIRM MODAL FUNCTIONS ────────────────────
function openConfirmModal(title, message, type, callback) {
  _confirmCallback = callback;
  const titleEl = document.getElementById('confirm-modal-title');
  const bodyEl  = document.getElementById('confirm-modal-body');
  const btn     = document.getElementById('confirm-modal-ok');

  if (titleEl) titleEl.textContent = title;
  if (bodyEl)  bodyEl.innerHTML    = message;

  if (btn) {
    btn.className = 'btn ' + (type === 'danger' ? 'btn-danger' : type === 'success' ? 'btn-success' : 'btn-primary');
    btn.innerHTML = type === 'danger' ? '<i class="fa-solid fa-trash"></i> Delete' : '<i class="fa-solid fa-check"></i> Confirm';
  }

  openAdminModal('modal-confirm');
}

async function confirmModalOk() {
  closeAdminModal('modal-confirm');
  if (_confirmCallback) {
    await _confirmCallback();
    _confirmCallback = null;
  }
}

// ── REGISTER USER ─────────────────────────────
function openRegisterModal() {
  document.getElementById('reg-name').value     = '';
  document.getElementById('reg-email').value    = '';
  document.getElementById('reg-password').value = '';
  document.getElementById('reg-plan').value     = 'free_trial';
  document.getElementById('reg-company').value  = '';
  document.getElementById('reg-is-admin').checked = false;
  document.getElementById('reg-error').style.display = 'none';
  _rateLimitCooldown = false;
  const btn = document.getElementById('reg-submit-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account'; }
  openAdminModal('modal-register');
}

async function registerUser() {
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const plan     = document.getElementById('reg-plan').value;
  const company  = document.getElementById('reg-company').value.trim();
  const grantAdmin = document.getElementById('reg-is-admin').checked;
  const errEl    = document.getElementById('reg-error');

  errEl.style.display = 'none';

  if (_rateLimitCooldown) {
    errEl.textContent = 'Please wait a moment before trying again (rate limit cooldown).';
    errEl.style.display = 'block';
    return;
  }

  if (!name || !email || !password) {
    errEl.textContent = 'Name, email and password are required.';
    errEl.style.display = 'block';
    return;
  }
  if (password.length < 8) {
    errEl.textContent = 'Password must be at least 8 characters.';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('reg-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Creating…';

  const resetBtn = () => {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';
  };

  const client = sbAdmin;
  if (!client) { errEl.textContent = 'Supabase client not initialised.'; errEl.style.display = 'block'; resetBtn(); return; }

  try {
    const { data: existingProfile, error: checkError } = await client
      .from('user_profiles')
      .select('email')
      .eq('email', email)
      .maybeSingle();

    if (checkError && checkError.code !== 'PGRST116') {
      console.warn('Email check warning:', checkError.message);
    }

    if (existingProfile) {
      errEl.textContent = `User with email "${email}" already exists. Please use a different email address.`;
      errEl.style.display = 'block';
      resetBtn();
      return;
    }

    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { full_name: name } }
    });

    if (error) {
      if (error.status === 429) {
        errEl.innerHTML = `
          <strong>Rate limit reached.</strong><br>
          Supabase free tier allows <strong>30 sign-ups per hour</strong>.
          Please wait a few minutes before trying again.<br>
          <span style="font-size:12px;color:var(--text-muted)">Alternatively, create users directly in the
          <a href="https://app.supabase.com/project/_/auth/users" target="_blank" style="color:var(--accent-hover)">Supabase Dashboard</a>.</span>
        `;
        errEl.style.display = 'block';
        _rateLimitCooldown = true;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-clock"></i> Wait 60s…';
        let seconds = 60;
        const countdown = setInterval(() => {
          seconds--;
          if (seconds <= 0) {
            clearInterval(countdown);
            _rateLimitCooldown = false;
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';
          } else {
            btn.innerHTML = `<i class="fa-solid fa-clock"></i> Wait ${seconds}s…`;
          }
        }, 1000);
        return;
      }

      if (error.message && error.message.toLowerCase().includes('already registered')) {
        errEl.textContent = `User with email "${email}" is already registered. Please use a different email address.`;
        errEl.style.display = 'block';
        resetBtn();
        return;
      }
      errEl.textContent = 'Failed to create user: ' + error.message;
      errEl.style.display = 'block';
      resetBtn();
      return;
    }

    const userId = data.user?.id;

    if (!userId) {
      errEl.textContent = 'User was created but no ID was returned. Check Supabase dashboard.';
      errEl.style.display = 'block';
      resetBtn();
      return;
    }

    const profileData = {
      id: userId,
      full_name: name,
      company_name: company || null,
      plan_id: plan,
      plan_status: 'active',
      billing_cycle: 'monthly',
      trial_ends_at: plan === 'free_trial' ? new Date(Date.now() + 14 * 86400000).toISOString() : null,
      subscription_ends_at: plan !== 'free_trial' ? new Date(Date.now() + 30 * 86400000).toISOString() : null,
    };

    const { error: upsertError } = await client
      .from('user_profiles')
      .upsert(profileData, { onConflict: 'id' });

    if (upsertError) {
      console.warn('Profile upsert warning:', upsertError.message);
      adminToast('User created but profile update had issues: ' + upsertError.message, 'error');
    }

    if (grantAdmin && userId) {
      try {
        const { error: adminError } = await client
          .from('admin_users')
          .insert({
            user_id: userId,
            email: email,
            role: 'admin'
          });

        if (adminError) {
          console.warn('Failed to grant admin privileges:', adminError.message);
          adminToast('User created but admin privileges failed: ' + adminError.message, 'error');
        } else {
          adminToast('✅ Admin privileges granted to ' + email, 'success');
        }
      } catch (adminErr) {
        console.warn('Admin grant error:', adminErr.message);
      }
    }

    await client.from('subscription_events').insert({
      user_id: userId,
      event_type: 'plan_change',
      old_plan: null,
      new_plan: plan,
      notes: 'Account created by admin' + (grantAdmin ? ' (with admin privileges)' : ''),
      created_by: adminUser?.id
    });

    await logAdminAction('user_registered', userId, email, { plan: plan, name: name, company: company, grantAdmin: grantAdmin });

    await loadAdminData();
    closeAdminModal('modal-register');
    renderUsers();
    adminToast('User ' + email + ' created on ' + (PLANS_CONFIG[plan]?.name || plan) + ' plan', 'success');

  } catch (e) {
    errEl.textContent = 'Unexpected error: ' + e.message;
    errEl.style.display = 'block';
  }

  resetBtn();
}

// ── EDIT USER PROFILE ─────────────────────────
function openEditUser(userId) {
  const u = allUsers.find(u => u.id === userId);
  if (!u) return;
  document.getElementById('edit-user-id').value      = userId;
  document.getElementById('edit-user-name').value    = u.full_name || '';
  document.getElementById('edit-user-email').value   = u.email || '';
  document.getElementById('edit-user-company').value = u.company_name || '';
  document.getElementById('edit-user-phone').value   = u.phone || '';
  document.getElementById('edit-user-plan').value    = u.plan_id || 'free_trial';
  document.getElementById('edit-user-status').value  = u.plan_status || 'active';
  document.getElementById('edit-user-cycle').value   = u.billing_cycle || 'monthly';
  document.getElementById('edit-user-error').style.display = 'none';
  openAdminModal('modal-edit-user');
}

async function saveEditUser() {
  const userId  = document.getElementById('edit-user-id').value;
  const name    = document.getElementById('edit-user-name').value.trim();
  const company = document.getElementById('edit-user-company').value.trim();
  const phone   = document.getElementById('edit-user-phone').value.trim();
  const plan    = document.getElementById('edit-user-plan').value;
  const status  = document.getElementById('edit-user-status').value;
  const cycle   = document.getElementById('edit-user-cycle').value;
  const errEl   = document.getElementById('edit-user-error');
  errEl.style.display = 'none';

  if (!name) { errEl.textContent = 'Full name is required.'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('edit-user-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Saving…';
  const resetBtn = () => { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes'; };

  const client = sbAdmin;
  if (!client) { errEl.textContent = 'Supabase client not initialised.'; errEl.style.display = 'block'; resetBtn(); return; }

  const existingUser = allUsers.find(u => u.id === userId);
  const updates = {
    full_name:    name,
    company_name: company || null,
    phone:        phone   || null,
    plan_id:      plan,
    plan_status:  status,
    billing_cycle: cycle,
  };

  if (status === 'active') {
    updates.suspended_at     = null;
    updates.suspended_reason = null;
    updates.subscription_ends_at = plan === 'free_trial' ? null : new Date(Date.now() + 30 * 86400000).toISOString();
  }
  if (status === 'suspended' && !allUsers.find(u => u.id === userId)?.suspended_at) {
    updates.suspended_at = new Date().toISOString();
  }

  try {
    const { error } = await client.from('user_profiles').update(updates).eq('id', userId);
    if (error) throw error;

    if (existingUser && (existingUser.plan_id !== plan || existingUser.plan_status !== status)) {
      await client.from('subscription_events').insert({
        user_id: userId,
        event_type: existingUser.plan_id !== plan ? 'plan_change' : 'suspended',
        old_plan: existingUser.plan_id,
        new_plan: plan,
        notes: 'Edited by admin',
        created_by: adminUser?.id
      });

      const changedFields = [];
      if (existingUser.plan_id !== plan) changedFields.push('plan');
      if (existingUser.plan_status !== status) changedFields.push('status');
      if (existingUser.full_name !== name) changedFields.push('name');
      if (existingUser.company_name !== company) changedFields.push('company');
      if (existingUser.phone !== phone) changedFields.push('phone');
      if (existingUser.billing_cycle !== cycle) changedFields.push('billing_cycle');

      await logAdminAction('user_updated', userId, existingUser.email, { changed_fields: changedFields });
    }

    await loadAdminData();
    closeAdminModal('modal-edit-user');
    renderUsers();
    adminToast('User profile updated', 'success');
  } catch (e) {
    errEl.textContent = 'Save failed: ' + e.message;
    errEl.style.display = 'block';
  }

  resetBtn();
}

// ── EXPORT ────────────────────────────────────
function exportUsersCSV() {
  const data = filteredUsers.length ? filteredUsers : allUsers;
  const headers = ['Email', 'Full Name', 'Company', 'Plan', 'Status', 'Billing', 'Joined', 'Trial Ends', 'Sub Ends'];
  const rows = data.map(u => [
    u.email, u.full_name || '', u.company_name || '', u.plan_id, u.plan_status,
    u.billing_cycle || 'monthly', fmtAdminDate(u.created_at),
    u.trial_ends_at ? fmtAdminDate(u.trial_ends_at) : '',
    u.subscription_ends_at ? fmtAdminDate(u.subscription_ends_at) : ''
  ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(','));

  const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' });
  const a    = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: 'propms-users-' + new Date().toISOString().slice(0, 10) + '.csv'
  });
  a.click();
  URL.revokeObjectURL(a.href);
  adminToast('Users exported', 'success');
}

// ── ANALYTICS ──────────────────────────────────
let analyticsPeriod = 'daily';
let analyticsRange = '24h';
let analyticsData = [];

function setAnalyticsPeriod(period, btn) {
  analyticsPeriod = period;
  document.querySelectorAll('#analytics-tabs .period-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderAnalytics();
}

function setAnalyticsRange(range, btn) {
  analyticsRange = range;
  document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('analytics-custom-range').style.display = range === 'custom' ? 'flex' : 'none';
  renderAnalytics();
}

function getAnalyticsDateRange() {
  const now = new Date();
  let start;
  switch (analyticsRange) {
    case '24h': start = new Date(now); start.setDate(now.getDate() - 1); break;
    case '7d':  start = new Date(now); start.setDate(now.getDate() - 7); break;
    case '1m':  start = new Date(now); start.setMonth(now.getMonth() - 1); break;
    case 'custom':
      start = document.getElementById('analytics-date-from').value ? new Date(document.getElementById('analytics-date-from').value) : new Date(0);
      break;
    default: start = new Date(0);
  }
  return { start, end: now };
}

function renderAnalytics() {
  const { start, end } = getAnalyticsDateRange();
  const filteredUsers = allUsers.filter(u => {
    const d = new Date(u.created_at);
    return d >= start && d <= end;
  });
  const total = filteredUsers.length;
  const active = filteredUsers.filter(u => u.plan_status === 'active').length;
  const suspended = filteredUsers.filter(u => u.plan_status === 'suspended').length;
  const newSignups = filteredUsers.length;

  document.getElementById('ana-total').textContent = total;
  document.getElementById('ana-active').textContent = active;
  document.getElementById('ana-suspended').textContent = suspended;
  document.getElementById('ana-new').textContent = newSignups;

  // User Growth Chart
  const labels = [];
  const values = [];
  if (analyticsPeriod === 'daily') {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(end); d.setDate(end.getDate() - i);
      days.push(d);
    }
    days.forEach(d => {
      const count = allUsers.filter(u => {
        const created = new Date(u.created_at);
        return created >= new Date(d.setHours(0,0,0,0)) && created < new Date(d.setHours(23,59,59,999));
      }).length;
      labels.push(d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' }));
      values.push(count);
    });
  } else if (analyticsPeriod === 'weekly') {
    const now = new Date(end);
    const month = now.getMonth();
    const year = now.getFullYear();
    const weeks = [
      { start: 1, end: 7 },
      { start: 8, end: 14 },
      { start: 15, end: 21 },
      { start: 22, end: 28 },
      { start: 29, end: 31 }
    ];
    weeks.forEach(w => {
      const count = allUsers.filter(u => {
        const d = new Date(u.created_at);
        return d.getMonth() === month && d.getFullYear() === year && d.getDate() >= w.start && d.getDate() <= w.end;
      }).length;
      labels.push('W' + Math.ceil(w.start/7));
      values.push(count);
    });
  } else if (analyticsPeriod === 'monthly') {
    const year = end.getFullYear();
    for (let m = 0; m < 12; m++) {
      const count = allUsers.filter(u => {
        const d = new Date(u.created_at);
        return d.getMonth() === m && d.getFullYear() === year;
      }).length;
      labels.push(new Date(year, m, 1).toLocaleString('en', { month: 'short' }));
      values.push(count);
    }
  } else {
    const currentYear = end.getFullYear();
    for (let y = currentYear - 4; y <= currentYear; y++) {
      const count = allUsers.filter(u => new Date(u.created_at).getFullYear() === y).length;
      labels.push(y);
      values.push(count);
    }
  }

  const maxVal = Math.max(...values, 1);
  const chartEl = document.getElementById('ana-growth-chart');
  chartEl.innerHTML = '<div class="chart-bar-wrap">' + labels.map((label, i) =>
    `<div class="chart-bar-col">
      <div class="chart-bar-val">${values[i]}</div>
      <div class="chart-bar" style="height:${Math.max(4, values[i] / maxVal * 100)}px;"></div>
      <div class="chart-bar-label">${label}</div>
    </div>`
  ).join('') + '</div>';

  // Plan Distribution
  const planCounts = {};
  filteredUsers.forEach(u => { planCounts[u.plan_id] = (planCounts[u.plan_id] || 0) + 1; });
  const totalPlans = filteredUsers.length || 1;
  const planDist = document.getElementById('ana-plan-distribution');
  planDist.innerHTML = Object.entries(planCounts).map(([pid, count]) => {
    const plan = PLANS_CONFIG[pid] || { name: pid, color: '#6366F1' };
    const pct = Math.round(count / totalPlans * 100);
    return `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
        <span style="color:${plan.color}">${plan.name}</span>
        <span>${count} (${pct}%)</span>
      </div>
      <div style="background:var(--bg-elevated);height:8px;border-radius:4px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${plan.color};border-radius:4px;"></div>
      </div>
    </div>`;
  }).join('') || '<div style="color:var(--text-muted);font-size:13px">No users in this range</div>';
}

function exportAnalytics(format) {
  const { start, end } = getAnalyticsDateRange();
  const data = allUsers.filter(u => new Date(u.created_at) >= start && new Date(u.created_at) <= end);
  if (data.length === 0) { adminToast('No data to export in this range', 'error'); return; }
  const filename = `analytics-${analyticsPeriod}-${new Date().toISOString().slice(0,10)}`;
  if (format === 'csv') {
    const headers = ['Email', 'Full Name', 'Plan', 'Status', 'Joined'];
    const rows = data.map(u => [u.email, u.full_name || '', u.plan_id, u.plan_status, fmtAdminDate(u.created_at)]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    downloadAnalyticsFile(csv, filename + '.csv', 'text/csv');
  } else {
    const json = JSON.stringify(data, null, 2);
    downloadAnalyticsFile(json, filename + '.json', 'application/json');
  }
  adminToast('Exported ' + data.length + ' records', 'success');
}

function downloadAnalyticsFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── HELPERS ───────────────────────────────────
function openAdminModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeAdminModal(id) { document.getElementById(id)?.classList.remove('open'); }

document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
  }
  if (e.key === 'Enter' && document.getElementById('admin-login')?.style.display !== 'none') {
    adminLogin();
  }
});

function fmtAdminDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function adminToast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'admin-toast ' + type;
  el.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${msg}`;
  document.getElementById('admin-toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
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

function buildAdminPagination(containerId, currentPage, totalItems, pageSize, onPageChange, onSizeChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const start      = Math.min((currentPage - 1) * pageSize + 1, totalItems);
  const end        = Math.min(currentPage * pageSize, totalItems);

  const pages = [];
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) pages.push(i);
  if (pages[0] > 1) { pages.unshift('…'); pages.unshift(1); }
  if (pages[pages.length - 1] < totalPages) { pages.push('…'); pages.push(totalPages); }

  const sizeOpts = [10, 20, 50]
    .map(s => `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s}/page</option>`)
    .join('');

  container.innerHTML = `
    <div style="font-size:12px;color:var(--text-muted)">
      Showing <strong>${totalItems ? start : 0}–${end}</strong> of <strong>${totalItems}</strong>
    </div>
    <div class="pagination-pages">
      <button class="page-btn" onclick="${onPageChange}(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>
        <i class="fa-solid fa-chevron-left" style="font-size:10px"></i>
      </button>
      ${pages.map(p => p === '…'
    ? `<span style="padding:0 4px;color:var(--text-muted)">…</span>`
    : `<button class="page-btn${p === currentPage ? ' active' : ''}" onclick="${onPageChange}(${p})">${p}</button>`
  ).join('')}
      <button class="page-btn" onclick="${onPageChange}(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>
        <i class="fa-solid fa-chevron-right" style="font-size:10px"></i>
      </button>
    </div>
    <select class="filter-select page-size-select" onchange="${onSizeChange}(this.value)">${sizeOpts}</select>`;
}
