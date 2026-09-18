(() => {
  const APP_VERSION = '2.3.0';
  const app = document.getElementById('app');
  const state = {
    token: localStorage.getItem('edusend_token') || '',
    me: null,
    assessments: [],
    page: 'dashboard',
    eventSource: null,
    refreshTimer: null,
    notificationTimer: null,
    unread: 0,
    activeSheet: null,
    autosaveTimer: null
  };

  const esc = (s) => String(s ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  const byId = (id) => document.getElementById(id);
  const fmtDate = (s) => s ? new Date(s).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : '—';
  const firstAssessmentId = () => state.assessments[0]?.id || '';
  const roles = () => state.me?.user?.roles || [];
  const isRole = r => roles().includes(r);
  const isClassTeacher = () => !!state.me?.classTeacherClasses?.length;
  const DRAFT_PREFIX = 'edusend_local_draft_v2_3:';

  function localDraftKey(assignmentId, assessmentId) {
    const userId = state.me?.user?.id || 'unknown';
    return `${DRAFT_PREFIX}${userId}:${assignmentId}:${assessmentId}`;
  }

  function storeLocalDraft(rows, meta = {}) {
    if (!state.activeSheet) return;
    try {
      const payload = {
        assignmentId: state.activeSheet.assignment.id,
        assessmentId: state.activeSheet.assessment.id,
        rows,
        savedAt: meta.serverSavedAt || new Date().toISOString(),
        serverSavedAt: meta.serverSavedAt || null,
        submittedCopy: !!meta.submittedCopy
      };
      localStorage.setItem(localDraftKey(payload.assignmentId, payload.assessmentId), JSON.stringify(payload));
    } catch {}
  }

  function readLocalDraft(assignmentId, assessmentId) {
    try {
      const raw = localStorage.getItem(localDraftKey(assignmentId, assessmentId));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function removeLocalDraft(assignmentId, assessmentId) {
    try { localStorage.removeItem(localDraftKey(assignmentId, assessmentId)); } catch {}
  }

  function snapshotActiveDraft() {
    if (!state.activeSheet || ['SUBMITTED','LOCKED'].includes(state.activeSheet.sheet?.status)) return null;
    const markEls = [...document.querySelectorAll('[data-mark]')];
    if (!markEls.length) return null;
    const rows = collectSheetRows();
    storeLocalDraft(rows);
    return rows;
  }

  function syncActiveDraftOnHide() {
    const rows = snapshotActiveDraft();
    if (!rows || !state.token || !state.activeSheet) return;
    const body = JSON.stringify({
      assignmentId: state.activeSheet.assignment.id,
      assessmentId: state.activeSheet.assessment.id,
      rows,
      action: 'draft'
    });
    try {
      fetch('/api/teacher/sheet', {
        method: 'PUT',
        headers: { 'Content-Type':'application/json', Authorization:`Bearer ${state.token}` },
        body,
        keepalive: true,
        cache: 'no-store'
      }).catch(() => {});
    } catch {}
  }

  function toast(message, bad = false) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el);
    }
    el.classList.toggle('bad', bad); el.textContent = message; el.style.display = 'block';
    clearTimeout(el._t); el._t = setTimeout(() => el.style.display = 'none', 3600);
  }

  function actionPopup(title, message, kind = 'success') {
    byId('actionPopup')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'actionPopup';
    wrap.className = 'action-popup-backdrop';
    wrap.innerHTML = `<div class="action-popup ${kind==='error'?'error':''}"><div class="action-popup-icon">${kind==='error'?'!':'✓'}</div><h3>${esc(title)}</h3><p>${esc(message)}</p><button class="btn ${kind==='error'?'btn-secondary':'btn-primary'} full" data-popup-close>OK</button></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('[data-popup-close]').onclick = () => wrap.remove();
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const body = opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body;
    const res = await fetch(path, { ...opts, headers, body, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(false); throw new Error(data.error || 'Session expired'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function checkVersion() {
    try {
      const d = await fetch(`/api/version?t=${Date.now()}`, { cache:'no-store' }).then(r => r.json());
      if (d.version && d.version !== APP_VERSION) showUpdateBanner(d.version);
    } catch {}
  }

  function showUpdateBanner(serverVersion) {
    let banner = byId('updateBanner');
    if (!banner) {
      banner = document.createElement('div'); banner.id = 'updateBanner'; banner.className = 'update-banner';
      banner.innerHTML = `<b>EduSend update available.</b> <span>Server v${esc(serverVersion)} • App v${APP_VERSION}</span><button id="applyUpdate" class="btn btn-gold">Update now</button>`;
      document.body.appendChild(banner);
      byId('applyUpdate').onclick = async () => {
        try {
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) await r.update().catch(() => {});
          }
        } catch {}
        location.reload(true);
      };
    }
  }

  function statusPill(status, deadline) {
    if (status === 'LOCKED') return '<span class="pill pill-violet">Locked</span>';
    if (status === 'SUBMITTED') return '<span class="pill pill-green">Submitted</span>';
    if (status === 'CORRECTION_REQUESTED') return '<span class="pill pill-orange">Correction requested</span>';
    if (status === 'DRAFT') return '<span class="pill pill-blue">Draft</span>';
    if (deadline?.code === 'OVERDUE') return '<span class="pill pill-red">Overdue</span>';
    if (deadline?.code === 'DUE_SOON') return '<span class="pill pill-orange">Due soon</span>';
    return '<span class="pill pill-grey">Not started</span>';
  }

  function deadlineBanner(reminders) {
    if (!reminders?.length) return '<div class="alert alert-green"><b>✓ All your assigned result sheets are complete.</b></div>';
    const overdue = reminders.filter(r => r.deadline.code === 'OVERDUE');
    const soon = reminders.filter(r => r.deadline.code === 'DUE_SOON');
    if (overdue.length) return `<div class="alert alert-red"><b>${overdue.length} sheet${overdue.length===1?'':'s'} overdue.</b> Open My Result Sheets and finish them.</div>`;
    if (soon.length) return `<div class="alert alert-orange"><b>${soon.length} sheet${soon.length===1?'':'s'} due soon.</b> Finish them before the deadline.</div>`;
    return `<div class="alert alert-blue"><b>${reminders.length} result sheet${reminders.length===1?'':'s'} still open.</b></div>`;
  }

  function renderLogin() {
    disconnectEvents();
    app.innerHTML = `
      <div class="login-page">
        <div class="login-card premium-login">
          <div class="brand"><div class="brand-mark">ES</div><div><h1>EduSend School Results</h1><p>One mark entry. One school workflow. — V2.3</p></div></div>
          <div class="login-hero"><b>School Results Workflow</b><span>Teachers enter once • Class teachers receive automatically • Parents get reports</span></div>
          <form id="loginForm">
            <div class="field"><label>Username</label><input id="username" autocomplete="username" value="kamanga" required></div>
            <div class="field"><label>Password</label><input id="password" type="password" autocomplete="current-password" value="teach123" required></div>
            <button class="btn btn-primary full btn-lg" type="submit">Sign in to EduSend</button>
          </form>
          <div class="demo-box">
            <div class="quick-login-head"><div><b>Starter accounts</b><div class="tiny muted">Tap an account to test each role.</div></div></div>
            <div class="demo-grid" style="margin-top:10px">
              ${demoAccount('Administrator','admin','admin123')}
              ${demoAccount('Head Teacher','head','head123')}
              ${demoAccount('Deputy Head Teacher','deputy','deputy123')}
              ${demoAccount('Science HOD','hod.science','hod123')}
              ${demoAccount('Languages HOD','hod.languages','hod123')}
              ${demoAccount('Social Sciences HOD','hod.social','hod123')}
              ${demoAccount('Business & Technology HOD','hod.business','hod123')}
              ${demoAccount('Home Economics HOD','hod.home','hod123')}
              ${demoAccount('Mr Kamanga P','kamanga','teach123','Teacher • Class Teacher')}
              ${demoAccount('12L Class Teacher','chanda.commerce','teach123','Ms Esther Chanda')}
              ${demoAccount('English Teacher','tembo.english','teach123')}
            </div>
          </div>
        </div>
      </div>`;
    document.querySelectorAll('.demo-account').forEach(card => card.addEventListener('click', () => {
      byId('username').value = card.dataset.username; byId('password').value = card.dataset.password; byId('loginForm').requestSubmit();
    }));
    byId('loginForm').addEventListener('submit', async e => {
      e.preventDefault(); const btn = e.submitter || e.target.querySelector('button[type="submit"]');
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const d = await api('/api/login', { method:'POST', body:{ username:byId('username').value, password:byId('password').value } });
        state.token = d.token; localStorage.setItem('edusend_token', state.token); await bootstrap();
      } catch (err) { toast(err.message, true); }
      finally { btn.disabled = false; btn.textContent = 'Sign in to EduSend'; }
    });
  }

  function demoAccount(role, username, password, note='') {
    return `<button type="button" class="demo-account" data-username="${esc(username)}" data-password="${esc(password)}"><span class="demo-role">${esc(role)}</span><span class="demo-user">${esc(note || username)}</span><span class="demo-go">Open →</span></button>`;
  }

  function logout(show = true) {
    state.token = ''; state.me = null; localStorage.removeItem('edusend_token'); disconnectEvents(); renderLogin(); if (show) toast('Signed out');
  }

  async function bootstrap() {
    try {
      const [me, assessments] = await Promise.all([api('/api/me'), api('/api/assessments')]);
      state.me = me; state.assessments = assessments.assessments || [];
      renderShell(); connectEvents(); await refreshNotifications(); await navigate('dashboard'); checkVersion();
    } catch (err) {
      state.token = ''; localStorage.removeItem('edusend_token'); renderLogin(); toast(err.message, true);
    }
  }

  function roleNames() {
    const out = [...roles()]; if (isClassTeacher()) out.push('CLASS TEACHER'); return out;
  }

  function navItems() {
    const items = [{ id:'dashboard', label:'Home', icon:'⌂' }, { id:'practice', label:'Practice Guide', icon:'?' }];
    if (isRole('TEACHER')) items.push({ id:'teacher', label:'Enter Results', icon:'✎' });
    if (isClassTeacher() || isAdminOrHeadFront()) {
      items.push({ id:'classTeacher', label:'Class Progress', icon:'▦' });
      items.push({ id:'reports', label:'Reports', icon:'▤' });
    }
    items.push({ id:'notifications', label:'Notifications', icon:'●' });
    if (isRole('HOD')) { items.push({ id:'hodAssignments', label:'Assignments', icon:'⇄' }); items.push({ id:'hodProgress', label:'Dept Progress', icon:'◫' }); }
    if (isClassTeacher() || isRole('HOD') || isAdminOrHeadFront()) items.push({ id:'escalations', label:'Escalations', icon:'!' });
    if (isRole('ADMIN')) items.push({ id:'admin', label:'School Setup', icon:'⚙' });
    if (isAdminOrHeadFront()) { items.push({ id:'schoolProgress', label:'School Progress', icon:'◉' }); items.push({ id:'audit', label:'Audit', icon:'≡' }); }
    return items;
  }
  function isAdminOrHeadFront() { return isRole('ADMIN') || isRole('HEAD'); }

  function renderShell() {
    const u = state.me.user; const items = navItems();
    const nav = items.map(n => `<button data-nav="${n.id}"><span class="nav-ico">${n.icon}</span><span>${esc(n.label)}</span>${n.id==='notifications'?'<span id="sideUnread" class="nav-badge hidden">0</span>':''}</button>`).join('');
    const bottom = items.slice(0, 7).map(n => `<button data-nav="${n.id}"><span>${n.icon}</span><small>${esc(n.label)}</small>${n.id==='notifications'?'<i id="mobileUnread" class="mobile-unread hidden"></i>':''}</button>`).join('');
    app.innerHTML = `
      <div class="shell">
        <aside class="sidebar">
          <div class="side-brand"><div class="brand-mark">ES</div><div><strong>EduSend</strong><div class="tiny">School Results V2.3</div></div></div>
          <div class="nav">${nav}</div>
          <div class="side-user"><div class="name">${esc(u.name)}</div><div>${roleNames().map(r=>`<span class="role-chip">${esc(r)}</span>`).join('')}</div><button id="logoutBtn" class="btn btn-secondary full" style="margin-top:12px">Sign out</button></div>
        </aside>
        <main class="main">
          <header class="topbar">
            <div><h2 id="pageTitle">Home</h2><div class="tiny muted">${esc(state.me.school.name)} ${state.me.school.demoMode?'<span class="practice-badge">PRACTICE DATA</span>':''}</div></div>
            <div class="topbar-actions"><button id="notifBell" class="icon-btn" aria-label="Notifications">🔔<span id="topUnread" class="counter hidden">0</span></button><div class="topbar-user"><div class="small"><b>${esc(u.name)}</b></div><button id="logoutTopBtn" class="btn btn-secondary btn-signout">Sign out</button></div></div>
          </header>
          <div id="content" class="content"></div>
        </main>
        <nav class="mobile-nav">${bottom}</nav>
      </div>`;
    document.querySelectorAll('[data-nav]').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.nav)));
    byId('logoutBtn').onclick = () => logout(); byId('logoutTopBtn').onclick = () => logout(); byId('notifBell').onclick = () => navigate('notifications');
  }

  async function navigate(page) {
    state.page = page;
    document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === page));
    const titles = { dashboard:'Home', practice:'Practice Guide', teacher:'Enter Results', classTeacher:'Class Progress', reports:'Report Centre', notifications:'Notifications', hodAssignments:'Department Assignments', hodProgress:'Department Progress', escalations:'Escalations', admin:'School Setup', schoolProgress:'School Progress', audit:'Audit Trail' };
    if (byId('pageTitle')) byId('pageTitle').textContent = titles[page] || 'EduSend';
    const content = byId('content'); content.innerHTML = '<div class="loading-card">Loading…</div>';
    try {
      if (page==='dashboard') await renderDashboard(content);
      else if (page==='practice') await renderPractice(content);
      else if (page==='teacher') await renderTeacher(content);
      else if (page==='classTeacher') await renderClassTeacher(content);
      else if (page==='reports') await renderReports(content);
      else if (page==='notifications') await renderNotifications(content);
      else if (page==='hodAssignments') await renderHodAssignments(content);
      else if (page==='hodProgress') await renderHodProgress(content);
      else if (page==='escalations') await renderEscalations(content);
      else if (page==='admin') await renderAdmin(content);
      else if (page==='schoolProgress') await renderSchoolProgress(content);
      else if (page==='audit') await renderAudit(content);
    } catch (err) { content.innerHTML = `<div class="alert alert-red"><b>Could not load this page.</b><br>${esc(err.message)}</div>`; }
  }

  async function renderPractice(content) {
    const demo = !!state.me?.school?.demoMode;
    content.innerHTML = `
      <div class="practice-hero">
        <div><span class="eyebrow">GUIDED ORIENTATION</span><h2>Learn EduSend by doing the real workflow</h2><p>${demo?'You are using 80 fictional pupils across 16 practice classes. Nothing here is a real learner record.':'Ask the administrator to load the Lumezi practice school from School Setup.'}</p></div>
        <div class="practice-count">${demo?'80':'—'}<small>practice pupils</small></div>
      </div>
      <div class="practice-steps">
        <article class="practice-step"><span>1</span><div><b>Administrator</b><p>Sign in as <code>admin</code> / <code>admin123</code>. Open School Setup. Review 16 classes, staff, departments, subjects and the practice assessment.</p></div></article>
        <article class="practice-step"><span>2</span><div><b>Subject teacher</b><p>Sign in as <code>kamanga</code> / <code>teach123</code>. Open Enter Results → 12L Physics. Use <b>Fill demo marks</b>, then <b>Finish & Submit</b>.</p></div></article>
        <article class="practice-step"><span>3</span><div><b>Class teacher receives automatically</b><p>Sign out and sign in as <code>chanda.commerce</code> / <code>teach123</code>. Ms Esther Chanda is the 12L class teacher. Open Notifications and Class Progress: the Physics marks should already be in the master mark schedule.</p></div></article>
        <article class="practice-step"><span>4</span><div><b>HOD monitors</b><p>Sign in as <code>hod.science</code> / <code>hod123</code>. Open Dept Progress. You will see submitted, draft and outstanding Mathematics/Natural Sciences result sheets.</p></div></article>
        <article class="practice-step"><span>5</span><div><b>Escalate a late subject</b><p>As a class teacher, choose an outstanding subject and press Escalate. Then sign in as the HOD or Administrator to follow the escalation path.</p></div></article>
        <article class="practice-step"><span>6</span><div><b>Generate reports</b><p>When all required subjects are submitted, the class teacher opens Reports. CBC classes use Grades 1–5; Grade 10–12 use the legacy profile. Not Taking never becomes zero.</p></div></article>
      </div>
      <div class="card space-top"><h3>Practice school structure</h3><p class="muted">Form 1: 1L, 1M • Form 2: 2L, 2M • Grade 10: 10N, 10M, 10P, 10L • Grade 11: 11M, 11N, 11P, 11L • Grade 12: 12M, 12N, 12P, 12L. Each class has 5 fictional pupils. Every class is staffed by nine distinct practice teachers. In Form 1–2, the two option-track teachers each handle the paired option subjects, so pupils still take exactly nine subjects.</p><p class="small"><b>Practice teacher password:</b> <code>teach123</code>. HOD password: <code>hod123</code>. Open Administrator → School Setup → Staff & Teaching Load to see every teacher, username, subject and class allocation.</p></div>`;
  }

  async function renderDashboard(content) {
    const [rem, teacher] = await Promise.all([
      api('/api/reminders'), isRole('TEACHER') ? api('/api/teacher/assignments') : Promise.resolve({ assignments:[] })
    ]);
    const assignments = teacher.assignments || [];
    const sheets = assignments.flatMap(a => a.sheets || []);
    const submitted = sheets.filter(s => ['SUBMITTED','LOCKED','CORRECTION_REQUESTED'].includes(s.status)).length;
    const due = rem.reminders?.filter(r => ['OVERDUE','DUE_SOON'].includes(r.deadline.code)).length || 0;
    const classCount = state.me.classTeacherClasses?.length || 0;
    const firstName = (state.me.user.name || '').replace(/^Mr\.?\s+|^Mrs\.?\s+|^Ms\.?\s+/i,'').split(' ')[0] || state.me.user.name;
    content.innerHTML = `
      <section class="hero-card"><div><span class="eyebrow">EDUSEND V2.3</span><h1>Welcome, ${esc(firstName)}</h1><p>Enter results once. EduSend moves them to the right class teacher automatically.</p></div><div class="hero-orb">ES</div></section>
      ${deadlineBanner(rem.reminders)}
      <div class="grid grid-4 stats-grid">
        <div class="card stat-card"><div class="stat">${assignments.length}</div><div class="stat-label">Teaching allocations</div></div>
        <div class="card stat-card"><div class="stat">${submitted}/${sheets.length || 0}</div><div class="stat-label">Sheets completed</div></div>
        <div class="card stat-card"><div class="stat">${due}</div><div class="stat-label">Urgent deadlines</div></div>
        <div class="card stat-card"><div class="stat">${classCount}</div><div class="stat-label">Class-teacher classes</div></div>
      </div>
      <div class="section-title space-top"><h3>Quick actions</h3></div>
      <div class="action-grid">
        ${isRole('TEACHER')?actionTile('✎','Enter results','Open your assigned class/subject sheets.','teacher'):''}
        ${isClassTeacher()||isAdminOrHeadFront()?actionTile('▦','Class progress','See which subjects have arrived automatically.','classTeacher'):''}
        ${isClassTeacher()||isAdminOrHeadFront()?actionTile('▤','Report centre','Generate, download and share pupil reports.','reports'):''}
        ${isRole('HOD')?actionTile('⇄','Department assignments','Allocate teachers to class subjects.','hodAssignments'):''}
        ${isRole('ADMIN')?actionTile('⚙','School setup','Manage staff, classes, subjects and deadlines.','admin'):''}
        ${actionTile('🔔','Notifications',`${state.unread} unread notification${state.unread===1?'':'s'}.`,'notifications')}
      </div>`;
    content.querySelectorAll('[data-action-nav]').forEach(b => b.onclick = () => navigate(b.dataset.actionNav));
  }

  function actionTile(icon, title, text, page) {
    return `<button class="action-tile" data-action-nav="${page}"><span class="action-icon">${icon}</span><b>${esc(title)}</b><small>${esc(text)}</small><span class="arrow">→</span></button>`;
  }

  async function renderTeacher(content) {
    const d = await api('/api/teacher/assignments');
    const rows = d.assignments.flatMap(a => (a.sheets || []).map(s => ({ a, s })));
    content.innerHTML = `
      <div class="page-intro"><div><h3>Your result sheets</h3><p>Only classes and subjects assigned to you are visible.</p></div><span class="pill pill-blue">One-entry workflow</span></div>
      ${rows.length ? `<div class="sheet-grid">${rows.map(({a,s}) => `
        <article class="sheet-card">
          <div class="sheet-card-top"><span class="class-chip">${esc(a.className)}</span>${statusPill(s.status,s.deadline)}</div>
          <h3>${esc(a.subjectName)}</h3><p>${esc(s.assessment.name)}</p>
          <div class="mini-metrics"><span><b>${s.entered}</b> entered</span><span><b>${s.pupilCount}</b> pupils</span></div>
          <div class="deadline-row"><span>${esc(s.deadline.text)}</span><span>${fmtDate(s.deadline.dueAt)}</span></div>
          <button class="btn ${['SUBMITTED','LOCKED'].includes(s.status)?'btn-secondary':'btn-primary'} full" data-open-sheet="${a.id}" data-assessment="${s.assessment.id}">${['SUBMITTED','LOCKED'].includes(s.status)?'View sheet':'Open & enter results'}</button>
        </article>`).join('')}</div>` : '<div class="empty">No class/subject has been assigned to you yet.</div>'}`;
    content.querySelectorAll('[data-open-sheet]').forEach(b => b.onclick = () => openResultSheet(b.dataset.openSheet, b.dataset.assessment));
  }

  async function openResultSheet(assignmentId, assessmentId) {
    const d = await api(`/api/teacher/sheet?assignmentId=${encodeURIComponent(assignmentId)}&assessmentId=${encodeURIComponent(assessmentId)}`);
    const readOnly = ['SUBMITTED','LOCKED'].includes(d.sheet.status);
    let recovered = false;
    let recoveredAt = '';
    if (!readOnly) {
      const local = readLocalDraft(assignmentId, assessmentId);
      const localTime = Date.parse(local?.savedAt || '');
      const serverTime = Date.parse(d.sheet.updatedAt || '') || 0;
      if (local?.rows?.length && Number.isFinite(localTime) && localTime > serverTime) {
        const lm = {}; const ls = {};
        for (const row of local.rows) {
          if (row.mark !== null && row.mark !== '' && row.mark !== undefined) lm[row.pupilId] = Number(row.mark);
          ls[row.pupilId] = row.state || (row.mark !== null && row.mark !== '' ? 'PRESENT' : 'PENDING');
        }
        d.sheet.marks = lm;
        d.sheet.markStates = ls;
        recovered = true;
        recoveredAt = local.savedAt;
      }
    }
    state.activeSheet = d;
    const rows = d.pupils.map((p,i) => {
      const mark = d.sheet.marks[p.id] ?? '';
      const st = d.sheet.markStates[p.id] || (mark!==''?'PRESENT':'PENDING');
      return `<tr><td>${i+1}</td><td><b>${esc(p.name)}</b>${p.isRepeater?'<span class="repeater-tag">Repeater</span>':''}<div class="tiny muted">${esc(p.examNo || '')}</div></td><td class="center"><input class="mark-input" data-mark="${p.id}" type="number" min="0" max="100" step="0.1" value="${esc(mark)}" ${readOnly?'disabled':''}></td><td><select class="status-select" data-state="${p.id}" ${readOnly?'disabled':''}><option value="PENDING" ${st==='PENDING'?'selected':''}>Pending</option><option value="PRESENT" ${st==='PRESENT'?'selected':''}>Mark entered</option><option value="ABSENT" ${st==='ABSENT'?'selected':''}>Absent</option><option value="NOT_TAKING" ${st==='NOT_TAKING'?'selected':''}>Not taking</option></select></td></tr>`;
    }).join('');
    showModal(`
      <div class="modal-head"><div><b>${esc(d.assignment.className)} — ${esc(d.assignment.subjectName)}</b><div class="tiny muted">${esc(d.assessment.name)} • ${esc(d.sheet.deadline.text)} • ${fmtDate(d.sheet.deadline.dueAt)}</div></div><button class="close" data-close>×</button></div>
      <div class="modal-body">
        <div class="workflow-strip"><span>1. Enter mark</span><span>2. Mark absent/not taking where needed</span><span>3. Finish & Submit</span></div>
        ${readOnly?'<div class="alert alert-green"><b>This sheet is already submitted.</b> Marks are read-only unless a correction is requested.</div>':'<div class="alert alert-blue"><b>Double-save protection is on.</b> Changes are kept on this device immediately and also saved to the school server.</div>'}
        ${recovered?`<div class="alert alert-orange"><b>Recovered draft.</b> EduSend restored newer unsent work saved on this device at ${fmtDate(recoveredAt)}.</div>`:''}
        <div id="autosaveStatus" class="save-state ${readOnly?'saved':''}">${readOnly?'Submitted '+fmtDate(d.sheet.submittedAt):recovered?'Recovered locally — syncing to school server…':d.sheet.updatedAt?'Last server save '+fmtDate(d.sheet.updatedAt):'Ready — not yet saved'}</div>
        <div class="table-wrap"><table class="table result-entry"><thead><tr><th>#</th><th>Pupil</th><th class="center">Mark %</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>
      <div class="modal-foot"><button class="btn btn-secondary" data-close>Close</button>${readOnly?'':`${state.me?.school?.demoMode?'<button type="button" id="fillDemoMarks" class="btn btn-gold">Fill demo marks</button>':''}<button type="button" id="saveDraft" class="btn btn-secondary">Save Draft</button><button type="button" id="submitResults" class="btn btn-green">Finish & Submit</button>`}</div>`);
    if (!readOnly) {
      const localThenAutosave = () => { snapshotActiveDraft(); scheduleAutosave(); };
      document.querySelectorAll('[data-mark],[data-state]').forEach(el => el.addEventListener('input', localThenAutosave));
      document.querySelectorAll('[data-state]').forEach(el => el.addEventListener('change', () => {
        const mark=document.querySelector(`[data-mark="${el.dataset.state}"]`);
        if(mark && ['ABSENT','NOT_TAKING','PENDING'].includes(el.value)) mark.value='';
        snapshotActiveDraft(); scheduleAutosave();
      }));
      document.querySelectorAll('[data-mark]').forEach(el => el.addEventListener('input', () => {
        if (el.value !== '') { const st = document.querySelector(`[data-state="${el.dataset.mark}"]`); if (st) st.value = 'PRESENT'; }
        snapshotActiveDraft();
      }));
      if (byId('fillDemoMarks')) byId('fillDemoMarks').onclick = fillPracticeMarks;
      byId('saveDraft').onclick = () => saveActiveSheet('draft', false);
      byId('submitResults').onclick = () => saveActiveSheet('submit', false);
      if (recovered) setTimeout(() => saveActiveSheet('draft', true), 150);
    }
  }

  function fillPracticeMarks() {
    if (!state.activeSheet) return;
    const subjectSeed = (state.activeSheet.assignment.subjectName || '').length * 3;
    [...document.querySelectorAll('[data-mark]')].forEach((el, i) => {
      const st = document.querySelector(`[data-state="${el.dataset.mark}"]`);
      if (!st || st.value === 'NOT_TAKING') return;
      el.value = String(48 + ((i * 7 + subjectSeed) % 43));
      st.value = 'PRESENT';
    });
    const s = byId('autosaveStatus'); if (s) s.textContent = 'Practice marks filled — saving draft…';
    saveActiveSheet('draft', true).then(() => toast('Demo marks filled. Review them, then press Finish & Submit.'));
  }

  function collectSheetRows() {
    return [...document.querySelectorAll('[data-mark]')].map(el => ({ pupilId:el.dataset.mark, mark:el.value===''?null:Number(el.value), state:document.querySelector(`[data-state="${el.dataset.mark}"]`)?.value || 'PENDING' }));
  }

  function scheduleAutosave() {
    clearTimeout(state.autosaveTimer);
    const s = byId('autosaveStatus');
    if (s) { s.textContent = 'Saved on this device • syncing to school server…'; s.className = 'save-state syncing'; }
    state.autosaveTimer = setTimeout(() => saveActiveSheet('draft', true), 850);
  }

  async function saveActiveSheet(action, silent) {
    if (!state.activeSheet) return;
    clearTimeout(state.autosaveTimer);
    const current = state.activeSheet;
    const rows = collectSheetRows();
    storeLocalDraft(rows);
    const saveBtn = byId('saveDraft'); const submitBtn = byId('submitResults');
    if (action === 'submit') {
      const pending = rows.filter(r => r.state === 'PENDING');
      if (pending.length) {
        actionPopup('Cannot submit yet', `${pending.length} pupil${pending.length===1?' is':'s are'} still marked Pending. Enter a mark or choose Absent / Not Taking first.`, 'error');
        return;
      }
      if (!confirm(`Finish and submit ${current.assignment.subjectName} results for ${current.assignment.className}? After submission the class teacher receives them automatically.`)) return;
    }
    if (saveBtn) saveBtn.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    const s = byId('autosaveStatus');
    if (s) { s.textContent = action==='submit'?'Sending results to the school server…':'Saving draft to the school server…'; s.className='save-state syncing'; }
    try {
      const result = await api('/api/teacher/sheet', { method:'PUT', body:{ assignmentId:current.assignment.id, assessmentId:current.assessment.id, rows, action } });
      storeLocalDraft(rows, { serverSavedAt: result.updatedAt, submittedCopy: action==='submit' });
      if (s) { s.textContent = action==='submit' ? `Submitted successfully • receipt #${result.storageRevision||'—'}` : `Saved to school server • receipt #${result.storageRevision||'—'} • ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`; s.className='save-state saved'; }
      if (action === 'submit') {
        const assignmentId=current.assignment.id, assessmentId=current.assessment.id;
        removeLocalDraft(assignmentId, assessmentId);
        closeModal(true);
        const who = result.classTeacherName ? `${result.classTeacherName} has been notified as class teacher.` : 'No class teacher is assigned yet; the HOD and administration were notified and the administrator must assign a class teacher.';
        actionPopup('Results sent successfully', `${result.subjectName || current.assignment.subjectName} results for ${result.className || current.assignment.className} have been submitted. ${who}`);
        await navigate('teacher');
      } else if (!silent) {
        actionPopup('Draft saved', `Your ${current.assignment.subjectName} results for ${current.assignment.className} are saved on this device and on the school server. You can close EduSend and continue later.`);
      }
    } catch (err) {
      if (s) { s.textContent = `Server save failed — your work is still safe on this device. ${err.message}`; s.className='save-state local-only'; }
      if (!silent) actionPopup('Could not reach school server', `Your work has been kept on this device, but the server did not confirm the save. Reopen the sheet while online and EduSend will try to sync it again. ${err.message}`, 'error');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  async function renderClassTeacher(content) {
    const d = await api('/api/class-teacher/classes'); const classes = d.classes || [];
    if (!classes.length) { content.innerHTML = '<div class="empty">No class is assigned to you as class teacher.</div>'; return; }
    content.innerHTML = `<div class="toolbar premium-toolbar"><select id="classSelect">${classes.map(c=>`<option value="${c.id}">${esc(c.name)} • ${esc(c.gradingSystem)}</option>`).join('')}</select><select id="assessmentSelect">${state.assessments.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select><button id="refreshClass" class="btn btn-secondary">Refresh</button><button id="goReports" class="btn btn-primary">Open Report Centre</button></div><div id="classOverview"></div>`;
    const load = () => loadClassOverview(byId('classSelect').value, byId('assessmentSelect').value);
    byId('classSelect').onchange = load; byId('assessmentSelect').onchange = load; byId('refreshClass').onclick = load; byId('goReports').onclick = () => navigate('reports'); await load();
  }

  async function loadClassOverview(classId, assessmentId) {
    const h = byId('classOverview'); if (!h) return; h.innerHTML = '<div class="loading-card">Loading class results…</div>';
    const d = await api(`/api/class-teacher/overview?classId=${encodeURIComponent(classId)}&assessmentId=${encodeURIComponent(assessmentId)}`);
    const r = d.reportReadiness; const pct = r.totalSubjects ? Math.round(r.submittedSubjects/r.totalSubjects*100) : 0;
    const subjects = d.subjects.map(s => `<article class="subject-progress-card"><div><b>${esc(s.subjectName)}</b><small>${esc(s.teacherName||'Unassigned')}</small></div>${statusPill(s.status,s.deadline)}<div class="subject-actions">${!['SUBMITTED','LOCKED','CORRECTION_REQUESTED'].includes(s.status)?`<button class="action-link" data-escalate="${s.assignmentId}">Escalate</button>`:`<button class="action-link" data-correct="${s.assignmentId}">Request correction</button>`}</div></article>`).join('');
    const heads = d.subjects.map(s => `<th class="center">${esc(s.subjectName)}</th>`).join('');
    const rows = d.pupils.map((p,i) => `<tr><td>${i+1}</td><td><b>${esc(p.name)}</b>${p.isRepeater?'<span class="repeater-tag">R</span>':''}<div class="tiny muted">${esc(p.parentPrimary||'No parent number')}</div></td>${d.subjects.map(s=>{const x=p.results[s.subjectId]||{};return `<td class="center">${x.state==='NOT_TAKING'?'N/T':x.state==='ABSENT'?'ABS':x.mark??'—'}</td>`}).join('')}</tr>`).join('');
    h.innerHTML = `
      <div class="readiness-banner ${r.finalReady?'ready':r.provisionalAllowed?'provisional':'blocked'}"><div><span class="eyebrow">REPORT READINESS</span><h3>${r.finalReady?'Reports are complete':r.provisionalAllowed?'Provisional reports authorized':'Waiting for missing subjects'}</h3><p>${r.submittedSubjects}/${r.totalSubjects} subjects received${r.missingSubjects.length?` • Missing: ${r.missingSubjects.map(x=>x.subjectName).join(', ')}`:''}</p></div><div class="progress-ring">${pct}%</div></div>
      <div class="grid grid-3 space-top"><div class="card"><div class="stat">${r.submittedSubjects}/${r.totalSubjects}</div><div class="stat-label">Subjects received</div></div><div class="card"><div class="stat">${d.pupils.length}</div><div class="stat-label">Pupils</div></div><div class="card"><div class="stat">${d.class.gradingSystem}</div><div class="stat-label">Grading profile</div></div></div>
      <div class="section-title space-top"><h3>Subject submission flow</h3><span class="tiny muted">Marks appear automatically after Finish & Submit.</span></div>
      <div class="subject-progress-grid">${subjects}</div>
      <div class="section-title space-top"><h3>Master mark schedule</h3><span class="pill pill-blue">No retyping</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Pupil / Parent</th>${heads}</tr></thead><tbody>${rows}</tbody></table></div>`;
    h.querySelectorAll('[data-escalate]').forEach(b => b.onclick = () => escalateMissing(b.dataset.escalate, assessmentId));
    h.querySelectorAll('[data-correct]').forEach(b => b.onclick = () => requestCorrection(b.dataset.correct, assessmentId));
  }

  async function escalateMissing(assignmentId, assessmentId) {
    const note = prompt('Optional note to the HOD/Administration:', 'Subject result is still outstanding and report preparation is affected.');
    if (note === null) return;
    try { await api('/api/escalations', { method:'POST', body:{ assignmentId, assessmentId, note } }); toast('Escalated to HOD and Administration'); if (state.page==='classTeacher') await loadClassOverview(byId('classSelect').value, byId('assessmentSelect').value); }
    catch (err) { toast(err.message, true); }
  }

  async function requestCorrection(assignmentId, assessmentId) {
    const note = prompt('What needs correction?'); if (note === null) return;
    try { await api('/api/class-teacher/request-correction', { method:'POST', body:{ assignmentId, assessmentId, note } }); toast('Correction request sent to subject teacher'); if (state.page==='classTeacher') await loadClassOverview(byId('classSelect').value, byId('assessmentSelect').value); }
    catch (err) { toast(err.message, true); }
  }

  async function renderReports(content) {
    const d = await api('/api/class-teacher/classes'); const classes = d.classes || [];
    if (!classes.length) { content.innerHTML = '<div class="empty">No class available for report generation.</div>'; return; }
    content.innerHTML = `<div class="toolbar premium-toolbar"><select id="reportClass">${classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><select id="reportAssessment">${state.assessments.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select><button id="loadReports" class="btn btn-primary">Load reports</button></div><div id="reportBody"></div>`;
    const load = () => loadReportCentre(byId('reportClass').value, byId('reportAssessment').value);
    byId('loadReports').onclick = load; byId('reportClass').onchange = load; byId('reportAssessment').onchange = load; await load();
  }

  async function loadReportCentre(classId, assessmentId) {
    const holder = byId('reportBody'); holder.innerHTML = '<div class="loading-card">Preparing report centre…</div>';
    const [d, hist] = await Promise.all([
      api(`/api/class-teacher/overview?classId=${encodeURIComponent(classId)}&assessmentId=${encodeURIComponent(assessmentId)}`),
      api(`/api/class-teacher/report-history?classId=${encodeURIComponent(classId)}&assessmentId=${encodeURIComponent(assessmentId)}`)
    ]);
    const sentSet = new Set((hist.rows||[]).map(x=>x.pupilId)); const r=d.reportReadiness;
    holder.innerHTML = `
      <div class="readiness-banner ${r.finalReady?'ready':r.provisionalAllowed?'provisional':'blocked'}"><div><span class="eyebrow">${r.finalReady?'FINAL REPORTS':'REPORT CONTROL'}</span><h3>${r.finalReady?'Ready to generate and send':r.provisionalAllowed?'Provisional release approved':'Reports are blocked'}</h3><p>${r.finalReady?'All required subjects are in.':r.provisionalAllowed?'Missing subjects will show Pending and final aggregate/position is withheld.':`Missing: ${r.missingSubjects.map(x=>x.subjectName).join(', ') || 'No subject assignments'}`}</p></div><button id="downloadAll" class="btn btn-gold" ${r.canSend?'':'disabled'}>Download class PDF</button></div>
      <div class="report-list">${d.pupils.map(p=>`<article class="pupil-report-card"><div class="pupil-avatar">${esc((p.name||'?')[0])}</div><div class="pupil-main"><b>${esc(p.name)}</b><small>${esc(p.examNo||'No exam number')} ${p.isRepeater?'• Repeater':''}</small><span>${esc(p.parentPrimary||'No parent number')}</span></div><div class="report-status">${sentSet.has(p.id)?'<span class="pill pill-green">Sent</span>':'<span class="pill pill-grey">Not sent</span>'}</div><div class="report-actions"><button class="btn btn-secondary" data-preview="${p.id}">Preview</button><button class="btn btn-secondary" data-pdf="${p.id}" ${r.canSend?'':'disabled'}>PDF</button><button class="btn btn-primary" data-share="${p.id}" ${r.canSend?'':'disabled'}>Share</button></div></article>`).join('')}</div>`;
    holder.querySelectorAll('[data-preview]').forEach(b=>b.onclick=()=>previewReport(d,b.dataset.preview));
    holder.querySelectorAll('[data-pdf]').forEach(b=>b.onclick=()=>downloadReport(d,b.dataset.pdf));
    holder.querySelectorAll('[data-share]').forEach(b=>b.onclick=()=>shareReport(d,b.dataset.share));
    byId('downloadAll').onclick = () => downloadAllReports(d);
  }

  function gradeLegacy(mark) { const n=Number(mark); return n>=75?1:n>=70?2:n>=65?3:n>=60?4:n>=55?5:n>=50?6:n>=45?7:n>=40?8:9; }
  function legacyRemark(g) { return g===1?'EXCELLENT KEEP IT UP':g===2?'EXCELLENT':g<=4?'VERY GOOD':g<=6?'GOOD':g<=8?'FAIR':'FAIL'; }
  function gradeCBC(mark) { const n=Number(mark); return n>=70?1:n>=60?2:n>=50?3:n>=40?4:5; }
  function cbcRemark(g) { return ['','OUTSTANDING','ADVANCED','BASIC','SATISFACTORY','UNSATISFACTORY'][g]; }

  function pupilReportModel(d, pupil) {
    const rows = d.subjects.map(s => { const r=pupil.results[s.subjectId]||{mark:null,state:'PENDING'}; const has=r.mark!==null && r.mark!==undefined && r.mark!=='' && Number.isFinite(Number(r.mark)); const grade=has?(d.class.gradingSystem==='CBC'?gradeCBC(r.mark):gradeLegacy(r.mark)):null; return { subject:s.subjectName, mark:has?Number(r.mark):null, state:r.state, grade, remark:grade?(d.class.gradingSystem==='CBC'?cbcRemark(grade):legacyRemark(grade)):r.state==='ABSENT'?'ABSENT':r.state==='NOT_TAKING'?'NOT TAKING':'PENDING' }; });
    const numeric = rows.filter(x=>x.mark!==null && x.state!=='NOT_TAKING');
    let summary = {};
    const completeForOverall = rows.every(x => x.state === 'PRESENT' || x.state === 'NOT_TAKING');
    if (d.class.gradingSystem==='LEGACY' && d.reportReadiness.finalReady && completeForOverall && numeric.length>=6) {
      const best6 = [...numeric].sort((a,b)=>b.mark-a.mark).slice(0,6); const points = best6.reduce((n,x)=>n+x.grade,0); const total=best6.reduce((n,x)=>n+x.mark,0);
      const totals = d.pupils.map(q => {
        const qr=d.subjects.map(s=>{const z=q.results[s.subjectId]||{mark:null,state:'PENDING'};const ok=z.mark!==null&&z.mark!==undefined&&z.mark!==''&&Number.isFinite(Number(z.mark));return {mark:ok?Number(z.mark):null,state:z.state};});
        const qComplete=qr.every(x=>x.state==='PRESENT'||x.state==='NOT_TAKING'); const nums=qr.filter(x=>x.mark!==null&&x.state!=='NOT_TAKING').map(x=>x.mark).sort((a,b)=>b-a).slice(0,6);
        return qComplete&&nums.length>=6?{id:q.id,total:nums.reduce((a,b)=>a+b,0)}:null;
      }).filter(Boolean).sort((a,b)=>b.total-a.total);
      let rank=null; let last=null; let shown=0; for(let i=0;i<totals.length;i++){if(totals[i].total!==last){shown=i+1;last=totals[i].total}if(totals[i].id===pupil.id){rank=shown;break}}
      summary = { best6Total:total, points, division:points<=12?'I':points<=17?'II':points<=24?'III':points<=35?'IV':'FAIL', position:rank };
    } else if (d.class.gradingSystem==='CBC' && completeForOverall && numeric.length) {
      summary = { average:Math.round(numeric.reduce((n,x)=>n+x.mark,0)/numeric.length*10)/10 };
    }
    return { rows, summary };
  }

  function teacherComment(d,pupil,model) {
    const entered=model.rows.filter(x=>x.mark!==null).sort((a,b)=>b.mark-a.mark); if(!entered.length)return 'Results are still incomplete. Please continue supporting the learner as the remaining subject results are being finalized.';
    const best=entered[0], weak=entered[entered.length-1];
    if(d.reportReadiness.provisional)return `This is a provisional report because some subject results are still pending. ${pupil.name.split(' ')[0]} performed strongest in ${best.subject} (${best.mark}%) and should continue working consistently, especially in ${weak.subject} (${weak.mark}%). Final aggregate and position will be confirmed when all required results are available.`;
    if(d.class.gradingSystem==='CBC') return `${pupil.name.split(' ')[0]} has shown ${best.remark.toLowerCase()} performance in ${best.subject}. Continued practice is encouraged, with extra attention to ${weak.subject}. The learner should review corrections, practise regularly and ask for help where concepts are not yet secure.`;
    return `${pupil.name.split(' ')[0]} performed strongest in ${best.subject} (${best.mark}%) and should maintain that effort. More focused revision is needed in ${weak.subject} (${weak.mark}%). Regular practice, correction of mistakes and consistent study will help improve the overall result.`;
  }

  function previewReport(d, pupilId) {
    const p=d.pupils.find(x=>x.id===pupilId); if(!p)return; const m=pupilReportModel(d,p);
    showModal(`<div class="modal-head"><div><b>Report Preview — ${esc(p.name)}</b><div class="tiny muted">${esc(d.class.name)} • ${esc(d.assessment.name)}</div></div><button class="close" data-close>×</button></div><div class="modal-body"><div class="report-preview ${d.reportReadiness.provisional?'is-provisional':''}"><div class="rp-head"><div>REPUBLIC OF ZAMBIA<br><b>MINISTRY OF EDUCATION</b></div><h2>${esc(state.me.school.name)}</h2><h3>PUPIL'S PROGRESS REPORT</h3>${d.reportReadiness.provisional?'<div class="provisional-stamp">PROVISIONAL REPORT</div>':''}</div><div class="rp-meta"><span><b>Name:</b> ${esc(p.name)}</span><span><b>Class:</b> ${esc(d.class.name)}</span><span><b>Assessment:</b> ${esc(d.assessment.name)}</span><span><b>Exam No:</b> ${esc(p.examNo||'—')}</span></div><table class="rp-table"><thead><tr><th>Subject</th><th>Mark</th><th>Grade</th><th>Remark</th></tr></thead><tbody>${m.rows.map(x=>`<tr><td>${esc(x.subject)}</td><td>${x.mark??'—'}</td><td>${x.grade??'—'}</td><td>${esc(x.remark)}</td></tr>`).join('')}</tbody></table><div class="rp-summary">${d.class.gradingSystem==='CBC'?`Average: <b>${m.summary.average??'—'}%</b>`:`Best 6 Total: <b>${m.summary.best6Total??'—'}</b> • Points: <b>${m.summary.points??'—'}</b> • Division: <b>${m.summary.division??'—'}</b> • Position: <b>${m.summary.position??'—'}</b>`}</div><div class="rp-comment"><b>Class Teacher's Comment:</b><p>${esc(teacherComment(d,p,m))}</p></div><div class="rp-footer">Class Teacher: ${esc(d.classTeacher?.name||state.me.user.name)} ${d.classTeacher?.phone?`• ${esc(d.classTeacher.phone)}`:''}</div></div></div><div class="modal-foot"><button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" id="previewPdf">Download PDF</button></div>`);
    byId('previewPdf').onclick = () => downloadReport(d,p.id);
  }

  async function ensurePdf() {
    if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
    await new Promise((resolve,reject)=>{ const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'; s.onload=resolve; s.onerror=()=>reject(new Error('PDF library could not load. Check your internet connection.')); document.head.appendChild(s); });
    return window.jspdf.jsPDF;
  }

  function drawReportPdf(doc,d,p,pageNo=1) {
    const model=pupilReportModel(d,p); const W=210; const blue=[11,47,107], gold=[241,182,0];
    doc.setDrawColor(...blue); doc.setLineWidth(.7); doc.rect(8,8,194,281); doc.setFillColor(...blue); doc.rect(8,8,194,8,'F'); doc.setFillColor(...gold); doc.rect(8,16,194,2,'F');
    doc.setTextColor(0); doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text('REPUBLIC OF ZAMBIA',W/2,25,{align:'center'}); doc.text('MINISTRY OF EDUCATION',W/2,30,{align:'center'}); doc.setTextColor(...blue); doc.setFontSize(14); doc.text(String(state.me.school.name||'').toUpperCase(),W/2,37,{align:'center'}); doc.setTextColor(0); doc.setFontSize(11); doc.text("PUPIL'S PROGRESS REPORT",W/2,44,{align:'center'});
    if(d.reportReadiness.provisional){doc.setTextColor(185,40,40);doc.setFontSize(10);doc.text('PROVISIONAL REPORT — SOME SUBJECT RESULTS PENDING',W/2,50,{align:'center'});}
    let y=d.reportReadiness.provisional?57:52; doc.setTextColor(0);doc.setFontSize(9);doc.setFont('helvetica','normal');
    const meta=[`NAME: ${p.name}`,`CLASS: ${d.class.name}`,`ASSESSMENT: ${d.assessment.name}`,`EXAM NO: ${p.examNo||'—'}`]; meta.forEach((t,i)=>doc.text(t,14+i%2*96,y+Math.floor(i/2)*6)); y+=16;
    const col=[14,82,112,136,196]; doc.setFillColor(239,245,255);doc.rect(14,y,182,8,'F');doc.setFont('helvetica','bold');['SUBJECT','MARK','GRADE','REMARK'].forEach((t,i)=>doc.text(t,[16,86,116,140][i],y+5.5)); y+=8; doc.setFont('helvetica','normal');
    model.rows.forEach(r=>{doc.setDrawColor(220);doc.rect(14,y,182,7);doc.text(String(r.subject).slice(0,30),16,y+4.8);doc.text(r.mark===null?'—':String(r.mark),88,y+4.8);doc.text(r.grade===null?'—':String(r.grade),118,y+4.8);doc.text(String(r.remark).slice(0,28),140,y+4.8);y+=7;});
    y+=5; doc.setFont('helvetica','bold'); if(d.class.gradingSystem==='CBC') doc.text(`Average: ${model.summary.average??'—'}%`,14,y); else doc.text(`Best 6 Total: ${model.summary.best6Total??'—'}    Points: ${model.summary.points??'—'}    Division: ${model.summary.division??'—'}    Position: ${model.summary.position??'—'}`,14,y); y+=8;
    doc.setFont('helvetica','bold');doc.text("Class Teacher's Comment:",14,y);y+=5;doc.setFont('helvetica','normal');const comment=teacherComment(d,p,model);const lines=doc.splitTextToSize(comment,180);doc.text(lines,14,y);y+=lines.length*4.5+6;
    if(d.reportReadiness.provisional){doc.setTextColor(185,40,40);doc.setFont('helvetica','bold');doc.text('Missing subject results are shown as Pending. Final aggregate/division/position is withheld until completion.',14,y);y+=7;doc.setTextColor(0);}
    doc.setDrawColor(...gold);doc.line(14,270,196,270);doc.setFontSize(8);doc.setTextColor(...blue);doc.text(`Class Teacher: ${d.classTeacher?.name||state.me.user.name}${d.classTeacher?.phone?` • ${d.classTeacher.phone}`:''}`,14,276);doc.text(`EduSend • Page ${pageNo}`,196,276,{align:'right'});doc.setTextColor(0);
  }

  async function buildReportDoc(d,pupils) {
    const JsPDF=await ensurePdf(); const doc=new JsPDF({orientation:'portrait',unit:'mm',format:'a4'}); pupils.forEach((p,i)=>{if(i)doc.addPage();drawReportPdf(doc,d,p,i+1)}); return doc;
  }

  async function downloadReport(d,pupilId) { try { const p=d.pupils.find(x=>x.id===pupilId); const doc=await buildReportDoc(d,[p]); doc.save(`${d.class.name}_${p.name.replace(/\s+/g,'_')}_${d.assessment.name.replace(/\s+/g,'_')}.pdf`); } catch(err){toast(err.message,true);} }
  async function downloadAllReports(d) { try { const doc=await buildReportDoc(d,d.pupils); doc.save(`${d.class.name}_${d.assessment.name.replace(/\s+/g,'_')}_Reports.pdf`); } catch(err){toast(err.message,true);} }

  function normalizePhone(x) { const d=String(x||'').replace(/\D/g,''); if(d.startsWith('260'))return d;if(d.startsWith('0'))return '260'+d.slice(1);return d; }
  async function shareReport(d,pupilId) {
    const p=d.pupils.find(x=>x.id===pupilId); if(!p)return;
    try {
      const doc=await buildReportDoc(d,[p]); const blob=doc.output('blob'); const file=new File([blob],`${d.class.name}_${p.name.replace(/\s+/g,'_')}.pdf`,{type:'application/pdf'}); const text=`${state.me.school.name}\n${d.assessment.name}\nPupil: ${p.name}\nClass: ${d.class.name}${d.reportReadiness.provisional?'\nPROVISIONAL REPORT — some results pending':''}`;
      let channel='DOWNLOAD';
      if(navigator.share && (!navigator.canShare || navigator.canShare({files:[file]}))){await navigator.share({files:[file],title:'EduSend pupil report',text});channel='SHARE';}
      else {doc.save(file.name);const phone=normalizePhone(p.parentPrimary);if(phone)window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text+'\nPDF has been generated for sharing.')}`,'_blank');}
      await api('/api/class-teacher/report-sent',{method:'POST',body:{classId:d.class.id,assessmentId:d.assessment.id,pupilId:p.id,parentNumber:p.parentPrimary,channel}}).catch(()=>{}); toast('Report prepared for the parent'); await loadReportCentre(d.class.id,d.assessment.id);
    } catch(err){ if(err.name!=='AbortError')toast(err.message,true); }
  }

  async function refreshNotifications() {
    if(!state.token)return; try { const d=await api('/api/notifications'); state.unread=d.unread||0; updateUnreadBadges(); } catch {}
  }
  function updateUnreadBadges(){[['topUnread',true],['sideUnread',false]].forEach(([id])=>{const e=byId(id);if(e){e.textContent=state.unread;e.classList.toggle('hidden',!state.unread)}});const m=byId('mobileUnread');if(m)m.classList.toggle('hidden',!state.unread);}
  async function renderNotifications(content) {
    const d=await api('/api/notifications');
    content.innerHTML=`<div class="page-intro"><div><h3>Notifications</h3><p>Result submissions, corrections, assignments and escalations appear here.</p></div><button id="markRead" class="btn btn-secondary">Mark all read</button></div><div class="notification-list">${d.notifications.length?d.notifications.map(n=>`<article class="notification-item ${n.readAt?'':'unread'}"><span class="notification-dot"></span><div><b>${esc(n.title)}</b><p>${esc(n.message)}</p><small>${fmtDate(n.createdAt)}</small></div></article>`).join(''):'<div class="empty">No notifications yet.</div>'}</div>`;
    byId('markRead').onclick=async()=>{await api('/api/notifications/read',{method:'POST',body:{}});state.unread=0;updateUnreadBadges();await renderNotifications(content)};
  }

  async function renderHodAssignments(content) {
    const d=await api('/api/hod/assignments');
    content.innerHTML=`<div class="page-intro"><div><h3>${esc(d.department.name)}</h3><p>Assign each class subject to the teacher who will enter the marks once.</p></div></div><div class="grid grid-2"><div class="card"><h3>Assign teacher</h3><form id="hodAssignForm" class="stack"><div><label>Class</label><select id="hodClass">${d.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div><label>Subject</label><select id="hodSubject">${d.subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div><div><label>Teacher</label><select id="hodTeacher">${d.teachers.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div><button class="btn btn-primary">Save assignment</button></form></div><div class="card"><h3>How it works</h3><p class="muted">Once assigned, the teacher sees only that class and subject. When Finish & Submit is pressed, the class teacher receives the marks automatically.</p></div></div><div class="card space-top"><h3>Current assignments</h3><div class="table-wrap"><table class="table"><thead><tr><th>Class</th><th>Subject</th><th>Teacher</th></tr></thead><tbody>${d.assignments.map(a=>`<tr><td>${esc(a.className)}</td><td><b>${esc(a.subjectName)}</b></td><td>${esc(a.teacherName)}</td></tr>`).join('')}</tbody></table></div></div>`;
    byId('hodAssignForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/hod/assign',{method:'POST',body:{classId:byId('hodClass').value,subjectId:byId('hodSubject').value,teacherUserId:byId('hodTeacher').value}});toast('Assignment saved');await renderHodAssignments(content)}catch(err){toast(err.message,true)}};
  }

  async function renderHodProgress(content) {
    if(!state.assessments.length){content.innerHTML='<div class="empty">No assessment.</div>';return;}
    content.innerHTML=`<div class="toolbar premium-toolbar"><select id="hodAssess">${state.assessments.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div><div id="hodProgressBody"></div>`;
    const load=async()=>{const d=await api(`/api/hod/progress?assessmentId=${encodeURIComponent(byId('hodAssess').value)}`);const done=d.rows.filter(r=>['SUBMITTED','LOCKED','CORRECTION_REQUESTED'].includes(r.status)).length;const overdue=d.rows.filter(r=>r.deadline.code==='OVERDUE').length;byId('hodProgressBody').innerHTML=`<div class="grid grid-3"><div class="card"><div class="stat">${done}/${d.rows.length}</div><div class="stat-label">Submitted</div></div><div class="card"><div class="stat">${overdue}</div><div class="stat-label">Overdue</div></div><div class="card"><div class="stat">${d.rows.length-done}</div><div class="stat-label">Outstanding</div></div></div><div class="table-wrap space-top"><table class="table"><thead><tr><th>Class</th><th>Subject</th><th>Teacher</th><th>Status</th><th>Deadline</th></tr></thead><tbody>${d.rows.map(r=>`<tr><td>${esc(r.className)}</td><td><b>${esc(r.subjectName)}</b></td><td>${esc(r.teacherName)}</td><td>${statusPill(r.status,r.deadline)}</td><td>${fmtDate(r.deadline.dueAt)}</td></tr>`).join('')}</tbody></table></div>`};byId('hodAssess').onchange=load;await load();
  }

  async function renderEscalations(content) {
    const d=await api('/api/escalations');
    content.innerHTML=`<div class="page-intro"><div><h3>Escalations</h3><p>Outstanding results move through class teacher → HOD → Administration without being hidden.</p></div></div><div class="escalation-list">${d.escalations.length?d.escalations.map(e=>`<article class="escalation-card"><div class="escalation-head"><div><span class="class-chip">${esc(e.assignment?.className||'')}</span><b>${esc(e.assignment?.subjectName||'')}</b><small>${esc(e.assignment?.teacherName||'')}</small></div><span class="pill pill-orange">${esc(e.status)}</span></div><p>${esc(e.note||'No note')}</p><div class="tiny muted">${esc(e.assessment?.name||'')} • Opened ${fmtDate(e.createdAt)}</div><div class="escalation-actions">${isRole('HOD')?`<button class="btn btn-secondary" data-hod-follow="${e.id}">Follow up teacher</button>`:''}${isRole('ADMIN')?`<button class="btn btn-secondary" data-remind-hod="${e.id}">Send to HOD</button><button class="btn btn-secondary" data-extend="${e.id}">Extend deadline</button><button class="btn btn-gold" data-provisional="${e.id}">Authorize provisional report</button><button class="btn btn-green" data-resolve="${e.id}">Resolve</button>`:''}</div></article>`).join(''):'<div class="empty">No escalations.</div>'}</div>`;
    content.querySelectorAll('[data-hod-follow]').forEach(b=>b.onclick=()=>hodFollow(b.dataset.hodFollow));
    content.querySelectorAll('[data-remind-hod]').forEach(b=>b.onclick=()=>adminEsc(b.dataset.remindHod,'REMIND_HOD'));
    content.querySelectorAll('[data-provisional]').forEach(b=>b.onclick=()=>adminEsc(b.dataset.provisional,'AUTHORIZE_PROVISIONAL'));
    content.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=()=>adminEsc(b.dataset.resolve,'RESOLVE'));
    content.querySelectorAll('[data-extend]').forEach(b=>b.onclick=()=>extendDeadline(b.dataset.extend));
  }
  async function hodFollow(id){const note=prompt('Message to the teacher:','Please submit the outstanding results as soon as possible.');if(note===null)return;try{await api('/api/hod/escalation-action',{method:'POST',body:{escalationId:id,note}});toast('Teacher notified');await navigate('escalations')}catch(e){toast(e.message,true)}}
  async function adminEsc(id,action){const note=prompt(action==='AUTHORIZE_PROVISIONAL'?'Reason for provisional release:':'Optional note:','');if(note===null)return;try{await api('/api/admin/escalation-action',{method:'POST',body:{escalationId:id,action,note}});toast('Escalation updated');await navigate('escalations')}catch(e){toast(e.message,true)}}
  async function extendDeadline(id){const due=prompt('New deadline (example: 2026-09-23T16:00:00+02:00):');if(!due)return;try{await api('/api/admin/escalation-action',{method:'POST',body:{escalationId:id,action:'EXTEND_DEADLINE',dueAt:due}});toast('Deadline extended');await navigate('escalations')}catch(e){toast(e.message,true)}}

  async function renderAdmin(content) {
    const d=await api('/api/admin/setup'); const teachers=d.users.filter(u=>(u.roles||[]).includes('TEACHER'));
    content.innerHTML=`<div class="admin-hero"><div><span class="eyebrow">ADMIN CONTROL CENTRE</span><h2>Configure the school once</h2><p>The administrator creates the structure and officially assigns each class teacher. EduSend recognizes that role immediately.</p></div><button id="backupBtn" class="btn btn-gold">Download data backup</button></div>
    <div class="demo-loader-card"><div><span class="eyebrow">ORIENTATION MODE</span><h3>Lumezi practice school</h3><p>Load 16 classes, 80 fictional pupils (5 per class), realistic staff roles, nine-subject pupil programmes and teaching assignments so you can practise the complete workflow.</p></div><button id="loadDemoBtn" class="btn btn-primary">${d.school.demoMode?'Reset practice school':'Load practice school'}</button></div>
    <div class="admin-grid">
      <div class="card"><h3>Add staff account</h3><form id="addUserForm" class="stack"><input id="newName" placeholder="Full name" required><input id="newUsername" placeholder="Username" required><input id="newPhone" placeholder="Phone (optional)"><input id="newPassword" value="change123" required><select id="newDept"><option value="">No department</option>${d.departments.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select><select id="newRole"><option value="TEACHER">Teacher</option><option value="HOD_TEACHER">HOD + Teacher</option><option value="HEAD">Head Teacher</option></select><button class="btn btn-primary">Create staff account</button></form></div>
      <div class="card"><h3>Create department / subject</h3><form id="deptForm" class="inline-form"><input id="deptName" placeholder="Department name"><button class="btn btn-secondary">Add department</button></form><hr><form id="subjectForm" class="stack"><input id="subjectName" placeholder="Subject name"><select id="subjectDept">${d.departments.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select><button class="btn btn-primary">Add subject</button></form></div>
      <div class="card"><h3>Create class</h3><form id="classForm" class="stack"><input id="className" placeholder="e.g. 10P" required><input id="classLevel" placeholder="e.g. Grade 10 / Form 1"><select id="classGrading"><option value="CBC">CBC Grades 1–5</option><option value="LEGACY">Legacy Grades 1–9</option></select><button class="btn btn-primary">Create class</button></form></div>
      <div class="card class-teacher-explainer"><span class="eyebrow">WHO ASSIGNS CLASS TEACHERS?</span><h3>Administrator</h3><p>The administrator selects a teacher for each class below. The teacher immediately gains <b>Class Progress</b> and <b>Reports</b> access for that class. Reassignment is also controlled here.</p><button class="btn btn-secondary" data-jump-ct>Open assignment centre ↓</button></div>
      <div class="card"><h3>Create assessment & deadline</h3><form id="assessmentForm" class="stack"><input id="assessName" placeholder="Assessment name" required><input id="assessTerm" placeholder="Term"><input id="assessYear" type="number" value="${new Date().getFullYear()}"><input id="assessDue" type="datetime-local" required><button class="btn btn-primary">Create assessment</button></form></div>
      <div class="card"><h3>Add pupil</h3><form id="pupilForm" class="stack"><select id="pupilClass">${d.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><input id="pupilName" placeholder="Pupil name" required><div class="two-cols"><select id="pupilSex"><option value="">Sex</option><option value="M">Male</option><option value="F">Female</option></select><input id="pupilExam" placeholder="Exam number"></div><input id="pupilParent" placeholder="Parent/guardian phone"><label class="check-row"><input id="pupilRepeater" type="checkbox"> Repeater</label><button class="btn btn-primary">Add pupil</button></form></div>
      <div class="card"><h3>Import pupils from CSV</h3><p class="tiny muted">Columns: name, sex, examNo, parentPrimary, isRepeater</p><select id="csvClass">${d.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><input id="csvFile" type="file" accept=".csv,text/csv"><button id="importCsv" class="btn btn-secondary full">Import CSV</button></div>
      <div class="card"><h3>School details</h3><form id="schoolForm" class="stack"><input id="schoolName" value="${esc(d.school.name||'')}" placeholder="School name"><input id="schoolMotto" value="${esc(d.school.motto||'')}" placeholder="Motto"><input id="schoolAddress" value="${esc(d.school.address||'')}" placeholder="Address"><input id="schoolEmail" value="${esc(d.school.email||'')}" placeholder="Email"><button class="btn btn-secondary">Save school details</button></form></div>
    </div>
    <div id="classTeacherCentre" class="card space-top"><div class="section-title"><div><span class="eyebrow">CLASS TEACHER ASSIGNMENT CENTRE</span><h3 style="margin-top:4px">One official class teacher per class</h3></div><span class="pill pill-blue">Administrator controlled</span></div><p class="small muted">Choose a teacher and press Assign / Change. EduSend updates the teacher's permissions automatically and sends a notification.</p><div class="table-wrap"><table class="table"><thead><tr><th>Class</th><th>Level</th><th>Current class teacher</th><th>Assign / change to</th><th></th></tr></thead><tbody>${d.classes.map(c=>{const t=d.users.find(u=>u.id===c.classTeacherUserId);return `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.level)}</td><td>${t?`<span class="pill pill-green">${esc(t.name)}</span>`:'<span class="pill pill-orange">Not assigned</span>'}</td><td><select id="ctPick_${c.id}"><option value="">— Not assigned —</option>${teachers.map(x=>`<option value="${x.id}" ${x.id===c.classTeacherUserId?'selected':''}>${esc(x.name)}</option>`).join('')}</select></td><td><button class="btn btn-secondary" data-set-ct="${c.id}">${t?'Change':'Assign'}</button></td></tr>`}).join('')}</tbody></table></div></div>
    <div class="card space-top"><div class="section-title"><div><span class="eyebrow">STAFF & TEACHING LOAD</span><h3 style="margin-top:4px">Practice teacher directory</h3></div><span class="pill pill-blue">${teachers.length} teachers</span></div><p class="small muted">Every practice class has nine distinct teachers. The same teacher may teach several classes, just as in a real timetable. All ordinary practice teachers use password <b>teach123</b>.</p><div class="table-wrap"><table class="table"><thead><tr><th>Teacher</th><th>Username</th><th>Department</th><th>Teaching load</th><th>Class teacher of</th></tr></thead><tbody>${teachers.map(t=>{const loads=d.teachingAssignments.filter(a=>a.teacherUserId===t.id);const cls=d.classes.filter(c=>c.classTeacherUserId===t.id).map(c=>c.name);const dep=d.departments.find(x=>x.id===t.departmentId);return `<tr><td><b>${esc(t.name)}</b></td><td><code>${esc(t.username)}</code></td><td>${esc(dep?.name||'Multi-department')}</td><td>${loads.length?loads.map(a=>`${esc(a.className)} ${esc(a.subjectName)}`).join('<br>'):'—'}</td><td>${cls.length?esc(cls.join(', ')):'—'}</td></tr>`}).join('')}</tbody></table></div></div><div class="card space-top"><h3>Classes</h3><div class="table-wrap"><table class="table"><thead><tr><th>Class</th><th>Level</th><th>Grading</th><th>Class teacher</th></tr></thead><tbody>${d.classes.map(c=>{const t=d.users.find(u=>u.id===c.classTeacherUserId);return `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.level)}</td><td>${esc(c.gradingSystem)}</td><td>${esc(t?.name||'Not assigned')}</td></tr>`}).join('')}</tbody></table></div></div>`;
    wireAdminForms(content,d);
    content.querySelector('[data-jump-ct]')?.addEventListener('click',()=>byId('classTeacherCentre')?.scrollIntoView({behavior:'smooth',block:'start'}));
    content.querySelectorAll('[data-set-ct]').forEach(btn=>btn.addEventListener('click',async()=>{
      const classId=btn.dataset.setCt; const picker=byId(`ctPick_${classId}`); const teacherUserId=picker?.value||null;
      btn.disabled=true; const old=btn.textContent; btn.textContent='Saving…';
      try{
        const r=await api('/api/admin/class-teacher',{method:'POST',body:{classId,teacherUserId}});
        actionPopup(teacherUserId?'Class teacher assigned':'Class teacher cleared', teacherUserId?`${r.class.name} is now assigned to ${r.classTeacherName}. EduSend has updated the teacher's class-teacher access automatically.`:`${r.class.name} currently has no class teacher. Assign one before reports are released.`);
        await renderAdmin(content);
      }catch(err){actionPopup('Could not update class teacher',err.message,'error');btn.disabled=false;btn.textContent=old;}
    }));
  }

  function wireAdminForms(content,d){
    if (byId('loadDemoBtn')) byId('loadDemoBtn').onclick = async () => {
      const first = confirm('This will replace the current EduSend data with the Lumezi practice school. A server-side backup will be attempted first. Continue?');
      if (!first) return;
      const phrase = prompt('Type LOAD LUMEZI PRACTICE to confirm:');
      if (phrase !== 'LOAD LUMEZI PRACTICE') { toast('Practice school was not loaded.', true); return; }
      const btn = byId('loadDemoBtn'); btn.disabled = true; btn.textContent = 'Building practice school…';
      try {
        const r = await api('/api/admin/load-practice-demo', { method:'POST', body:{confirm:phrase} });
        if (r.token) { state.token = r.token; localStorage.setItem('edusend_token', r.token); }
        toast(`${r.summary.classes} classes and ${r.summary.pupils} pupils loaded`);
        await bootstrap();
        await navigate('practice');
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Load practice school'; }
    };
    byId('addUserForm').onsubmit=async e=>{e.preventDefault();const r=byId('newRole').value;try{await api('/api/admin/user',{method:'POST',body:{name:byId('newName').value,username:byId('newUsername').value,phone:byId('newPhone').value,password:byId('newPassword').value,departmentId:byId('newDept').value||null,roles:r==='HOD_TEACHER'?['HOD','TEACHER']:[r]}});toast('Staff account created');await renderAdmin(content)}catch(err){toast(err.message,true)}};
    byId('deptForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/department',{method:'POST',body:{name:byId('deptName').value}});toast('Department created');await renderAdmin(content)}catch(err){toast(err.message,true)}};
    byId('subjectForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/subject',{method:'POST',body:{name:byId('subjectName').value,departmentId:byId('subjectDept').value}});toast('Subject created');await renderAdmin(content)}catch(err){toast(err.message,true)}};
    byId('classForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/class',{method:'POST',body:{name:byId('className').value,level:byId('classLevel').value,gradingSystem:byId('classGrading').value}});toast('Class created');await renderAdmin(content)}catch(err){toast(err.message,true)}};
    byId('assessmentForm').onsubmit=async e=>{e.preventDefault();try{const due=new Date(byId('assessDue').value).toISOString();await api('/api/admin/assessment',{method:'POST',body:{name:byId('assessName').value,term:byId('assessTerm').value,year:byId('assessYear').value,dueAt:due}});toast('Assessment created');const a=await api('/api/assessments');state.assessments=a.assessments;await renderAdmin(content)}catch(err){toast(err.message,true)}};
    byId('pupilForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/pupil',{method:'POST',body:{classId:byId('pupilClass').value,name:byId('pupilName').value,sex:byId('pupilSex').value,examNo:byId('pupilExam').value,parentPrimary:byId('pupilParent').value,isRepeater:byId('pupilRepeater').checked}});toast('Pupil added');byId('pupilName').value='';}catch(err){toast(err.message,true)}};
    byId('schoolForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/school',{method:'POST',body:{name:byId('schoolName').value,motto:byId('schoolMotto').value,address:byId('schoolAddress').value,email:byId('schoolEmail').value}});toast('School details saved');await bootstrap()}catch(err){toast(err.message,true)}};
    byId('importCsv').onclick=()=>importCsvPupils();
    byId('backupBtn').onclick=async()=>{try{const x=await api('/api/admin/backup');const blob=new Blob([JSON.stringify(x,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`EduSend_Backup_${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);toast('Backup downloaded')}catch(e){toast(e.message,true)}};
  }

  async function importCsvPupils(){const f=byId('csvFile').files?.[0];if(!f){toast('Choose a CSV file first',true);return}const text=await f.text();const lines=text.split(/\r?\n/).filter(Boolean);if(lines.length<2){toast('CSV has no pupil rows',true);return}const headers=lines[0].split(',').map(x=>x.trim());const rows=lines.slice(1).map(line=>{const vals=line.split(',').map(x=>x.trim().replace(/^"|"$/g,''));const o={};headers.forEach((h,i)=>o[h]=vals[i]||'');return o});try{const r=await api('/api/admin/pupils-bulk',{method:'POST',body:{classId:byId('csvClass').value,pupils:rows}});toast(`${r.count} pupils imported`)}catch(e){toast(e.message,true)}}

  async function renderSchoolProgress(content){if(!state.assessments.length){content.innerHTML='<div class="empty">No assessment.</div>';return;}content.innerHTML=`<div class="toolbar premium-toolbar"><select id="schoolAssess">${state.assessments.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div><div id="schoolProgressBody"></div>`;const load=async()=>{const d=await api(`/api/school/progress?assessmentId=${encodeURIComponent(byId('schoolAssess').value)}`);const done=d.rows.filter(r=>['SUBMITTED','LOCKED','CORRECTION_REQUESTED'].includes(r.status)).length;const overdue=d.rows.filter(r=>r.deadline.code==='OVERDUE').length;byId('schoolProgressBody').innerHTML=`<div class="grid grid-3"><div class="card"><div class="stat">${done}/${d.rows.length}</div><div class="stat-label">School sheets received</div></div><div class="card"><div class="stat">${overdue}</div><div class="stat-label">Overdue</div></div><div class="card"><div class="stat">${d.classes.filter(c=>c.readiness.finalReady).length}/${d.classes.length}</div><div class="stat-label">Classes report-ready</div></div></div><div class="class-readiness-grid space-top">${d.classes.map(x=>`<div class="card"><b>${esc(x.class.name)}</b><div class="progressbar"><span style="width:${x.readiness.totalSubjects?Math.round(x.readiness.submittedSubjects/x.readiness.totalSubjects*100):0}%"></span></div><small>${x.readiness.submittedSubjects}/${x.readiness.totalSubjects} subjects • ${x.readiness.finalReady?'Ready':x.readiness.provisionalAllowed?'Provisional approved':'Waiting'}</small></div>`).join('')}</div><div class="table-wrap space-top"><table class="table"><thead><tr><th>Department</th><th>Class</th><th>Subject</th><th>Teacher</th><th>Status</th><th>Deadline</th></tr></thead><tbody>${d.rows.map(r=>`<tr><td>${esc(r.departmentName)}</td><td>${esc(r.className)}</td><td><b>${esc(r.subjectName)}</b></td><td>${esc(r.teacherName)}</td><td>${statusPill(r.status,r.deadline)}</td><td>${fmtDate(r.deadline.dueAt)}</td></tr>`).join('')}</tbody></table></div>`};byId('schoolAssess').onchange=load;await load();}

  async function renderAudit(content){const d=await api('/api/admin/audit');content.innerHTML=`<div class="page-intro"><div><h3>Audit trail</h3><p>Who changed what, and when.</p></div></div><div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>${d.rows.map(r=>`<tr><td>${fmtDate(r.at)}</td><td>${esc(r.actorName)}</td><td><b>${esc(r.action)}</b></td><td>${esc(r.detail)}</td></tr>`).join('')}</tbody></table></div>`;}

  function showModal(html){byId('modalBackdrop')?.remove();const w=document.createElement('div');w.className='modal-backdrop';w.id='modalBackdrop';w.innerHTML=`<div class="modal">${html}</div>`;document.body.appendChild(w);w.onclick=e=>{if(e.target===w||e.target.matches('[data-close]'))closeModal()};}
  function closeModal(skipSnapshot=false){clearTimeout(state.autosaveTimer);if(!skipSnapshot)snapshotActiveDraft();byId('modalBackdrop')?.remove();state.activeSheet=null;}

  function connectEvents(){
    disconnectEvents();if(!state.token)return;
    const es=new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);state.eventSource=es;
    es.addEventListener('update',async e=>{
      let d={};try{d=JSON.parse(e.data)}catch{}
      if(d.type==='NOTIFICATION'){
        toast(d.notification?.title||'New notification');
        if(d.notification?.type==='RESULTS_SUBMITTED') actionPopup(d.notification.title||'Results received',d.notification.message||'A subject teacher submitted results.');
        await refreshNotifications();
      }
      if(d.type==='CLASS_TEACHER_UPDATED'){
        try{const fresh=await api('/api/me');state.me=fresh;renderShell();await refreshNotifications();await navigate('dashboard');toast('Your class-teacher access has been updated');}catch{}
      }
      if(state.page==='classTeacher'&&d.type==='RESULT_SHEET_UPDATED'){const c=byId('classSelect'),a=byId('assessmentSelect');if(c&&a)loadClassOverview(c.value,a.value).catch(()=>{})}
      if(state.page==='hodProgress'&&d.type==='RESULT_SHEET_UPDATED')navigate('hodProgress');
      if(state.page==='schoolProgress'&&d.type==='RESULT_SHEET_UPDATED')navigate('schoolProgress');
      if(state.page==='escalations'&&d.type==='ESCALATION_UPDATED')navigate('escalations');
    });
    state.refreshTimer=setInterval(()=>{if(state.page==='classTeacher'){const c=byId('classSelect'),a=byId('assessmentSelect');if(c&&a)loadClassOverview(c.value,a.value).catch(()=>{})}},20000);
    state.notificationTimer=setInterval(refreshNotifications,30000);
  }
  function disconnectEvents(){if(state.eventSource){state.eventSource.close();state.eventSource=null}if(state.refreshTimer){clearInterval(state.refreshTimer);state.refreshTimer=null}if(state.notificationTimer){clearInterval(state.notificationTimer);state.notificationTimer=null}}

  window.addEventListener('pagehide', syncActiveDraftOnHide);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')syncActiveDraftOnHide();});

  if(state.token) bootstrap(); else renderLogin();
})();
