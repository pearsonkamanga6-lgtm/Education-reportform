(() => {
  const APP_VERSION = '3.0.1';
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
    autosaveTimer: null,
    backgroundRefresh: null
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
    if (!state.activeSheet || (['SUBMITTED','LOCKED'].includes(state.activeSheet.sheet?.status) && !state.activeSheet.correctionMode)) return null;
    const markEls = [...document.querySelectorAll('[data-mark]')];
    if (!markEls.length) return null;
    const rows = collectSheetRows();
    storeLocalDraft(rows);
    return rows;
  }

  function syncActiveDraftOnHide() { snapshotActiveDraft(); }

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
        <div class="login-card simple-login-card">
          <div class="brand"><div class="brand-mark">ES</div><div><h1>Reportform ZM</h1><p>Enter results once. Send reports to parents. — V3.0.1</p></div></div>
          <div class="login-hero"><b>Welcome</b><span>Enter your name or staff ID to continue.</span></div>
          <form id="loginForm" class="simple-login-form">
            <div class="field"><label>Your name or staff ID</label><input id="identifier" list="staffSuggestions" autocomplete="username" placeholder="e.g. Kamanga or kamanga" required><datalist id="staffSuggestions"></datalist></div>
            <div class="field"><label>PIN / password</label><input id="password" type="password" inputmode="numeric" autocomplete="current-password" placeholder="Enter PIN or password" required></div>
            <button class="btn btn-primary full btn-lg" type="submit">Continue</button>
          </form>
          <div id="trainingHint" class="training-login-hint hidden"><b>Training mode</b><span>Practice accounts use PIN <code>1234</code>. Start typing a staff name above; the list appears only when you need it.</span></div>
        </div>
      </div>`;
    loadLoginSuggestions();
    byId('loginForm').addEventListener('submit', async e => {
      e.preventDefault(); const btn=e.submitter||e.target.querySelector('button[type="submit"]'); btn.disabled=true; btn.textContent='Opening…';
      try {
        const d=await api('/api/login',{method:'POST',body:{identifier:byId('identifier').value,password:byId('password').value}});
        state.token=d.token; localStorage.setItem('edusend_token',state.token); await bootstrap();
      } catch(err){toast(err.message,true)} finally {btn.disabled=false;btn.textContent='Continue'}
    });
  }

  async function loadLoginSuggestions(){
    try{
      const d=await api('/api/demo-accounts');
      const list=byId('staffSuggestions');
      if(list) list.innerHTML=(d.accounts||[]).map(x=>`<option value="${esc(x.name)}">${esc(x.username)}</option>`).join('');
      const hint=byId('trainingHint'); if(hint) hint.classList.toggle('hidden',!d.demoMode);
    }catch{}
  }

  function logout(show = true) {
    state.token = ''; state.me = null; localStorage.removeItem('edusend_token'); disconnectEvents(); renderLogin(); if (show) toast('Signed out');
  }

  async function bootstrap() {
    try {
      const [me, assessments] = await Promise.all([api('/api/me'), api('/api/assessments')]);
      state.me = me; state.assessments = assessments.assessments || [];
      renderShell(); connectEvents(); await refreshNotifications();
      const needsSetup = (me.user.roles||[]).includes('TEACHER') && !me.user.profileSetupComplete && !(me.classTeacherClasses||[]).length;
      await navigate(needsSetup ? 'profile' : 'dashboard');
      if (needsSetup) actionPopup('Set up your teaching profile','Choose what you teach and whether you are a class teacher. Your supervisor verifies it once.');
      checkVersion();
    } catch (err) {
      state.token = ''; localStorage.removeItem('edusend_token'); renderLogin(); toast(err.message, true);
    }
  }

  function roleNames() {
    const out = [...roles()]; if (isClassTeacher()) out.push('CLASS TEACHER'); return out;
  }

  function navItems() {
    return [
      { id:'dashboard', label:'Home', icon:'⌂' },
      { id:'work', label:'My Work', icon:'✓' },
      { id:'notifications', label:'Notifications', icon:'●' },
      { id:'more', label:'More', icon:'⋯' }
    ];
  }
  function isAdminOrHeadFront() { return isRole('ADMIN') || isRole('HEAD'); }

  function renderShell() {
    const u = state.me.user; const items = navItems();
    const nav = items.map(n => `<button data-nav="${n.id}"><span class="nav-ico">${n.icon}</span><span>${esc(n.label)}</span>${n.id==='notifications'?'<span id="sideUnread" class="nav-badge hidden">0</span>':''}</button>`).join('');
    const bottom = items.map(n => `<button data-nav="${n.id}"><span>${n.icon}</span><small>${esc(n.label)}</small>${n.id==='notifications'?'<i id="mobileUnread" class="mobile-unread hidden"></i>':''}</button>`).join('');
    app.innerHTML = `
      <div class="shell">
        <aside class="sidebar">
          <div class="side-brand"><div class="brand-mark">ES</div><div><strong>EduSend</strong><div class="tiny">School Results V3.0.1</div></div></div>
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
    state.backgroundRefresh = null;
    document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === page));
    const titles = {
      dashboard:'Home', work:'My Work', notifications:'Notifications', more:'More', profile:'My Teaching Profile',
      teacher:'Enter Results', classTeacher:'My Class Results', reports:'Prepare Reports',
      hodClaims:'Teaching Approvals', hodProgress:'Results Status', escalations:'Missing / Late Results',
      admin:'School Setup', schoolProgress:'School Results Status', repeatPolicy:'Repeat Policy', approvals:'Approval Requests',
      practice:'Training Mode', audit:'History'
    };
    if (byId('pageTitle')) byId('pageTitle').textContent = titles[page] || 'EduSend';
    const content = byId('content'); content.innerHTML = '<div class="loading-card">Loading…</div>';
    try {
      if (page==='dashboard') await renderDashboard(content);
      else if (page==='work') await renderWorkHub(content);
      else if (page==='more') await renderMoreHub(content);
      else if (page==='profile') await renderProfile(content);
      else if (page==='practice') await renderPractice(content);
      else if (page==='teacher') await renderTeacher(content);
      else if (page==='classTeacher') await renderClassTeacher(content);
      else if (page==='reports') await renderReports(content);
      else if (page==='notifications') await renderNotifications(content);
      else if (page==='hodClaims') await renderHodClaims(content);
      else if (page==='hodProgress') await renderHodProgress(content);
      else if (page==='escalations') await renderEscalations(content);
      else if (page==='admin') await renderAdmin(content);
      else if (page==='schoolProgress') await renderSchoolProgress(content);
      else if (page==='repeatPolicy') await renderRepeatPolicy(content);
      else if (page==='approvals') await renderApprovals(content);
      else if (page==='audit') await renderAudit(content);
    } catch (err) { content.innerHTML = `<div class="alert alert-red"><b>Could not load this page.</b><br>${esc(err.message)}</div>`; }
  }

  async function renderPractice(content) {
    const demo=!!state.me?.school?.demoMode;
    content.innerHTML=`
      <div class="practice-hero"><div><span class="eyebrow">SIMPLE TRAINING MODE</span><h2>Test the full report workflow without lots of typing</h2><p>${demo?'Two small training classes use marks transcribed from the uploaded 2026 Lumezi schedules. Pupil names are anonymized for safe testing: five pupils and six subjects per class.':'Ask the administrator to load the simple practice school from School Setup.'}</p></div><div class="practice-count">${demo?'10':'—'}<small>practice pupils</small></div></div>
      <div class="practice-steps">
        <article class="practice-step"><span>1</span><div><b>Sign in</b><p>Type a staff name or staff ID. In Training Mode all practice accounts use PIN <code>1234</code>.</p></div></article>
        <article class="practice-step"><span>2</span><div><b>Enter one subject</b><p>Sign in as <code>Kamanga</code>, open My Work → Enter Results → 11N Physics. Four marks are already transcribed; one pupil has no Physics mark on the source schedule, so the missing-result workflow can be tested before submission.</p></div></article>
        <article class="practice-step"><span>3</span><div><b>Class teacher receives automatically</b><p>Sign in as <code>Ms Ruth Tembo</code>. Open My Class Results. Physics appears automatically and remains read-only.</p></div></article>
        <article class="practice-step"><span>4</span><div><b>Generate and send a report</b><p>Open Prepare Reports. Complete reports can be generated immediately. Incomplete reports can be sent only after supervisor approval and remain clearly provisional.</p></div></article>
        <article class="practice-step"><span>5</span><div><b>Test first-time setup</b><p>Sign in as <code>Ms Esther Chanda</code>. She has no approved teaching load, so EduSend takes her straight to the teaching-profile setup.</p></div></article>
      </div>
      <div class="card space-top"><h3>Training school</h3><p class="muted"><b>10L</b>: English, Mathematics, Geography, Science, Commerce and Civic Education. <b>11N</b>: English, Mathematics, Chemistry, Physics, Biology and Civic Education. The practice subset preserves the first five clear mark patterns from each schedule but uses anonymized pupil names.</p><p class="small"><b>Training PIN:</b> <code>1234</code> for every practice account.</p></div>`;
  }

  async function renderDashboard(content) {
    const [rem, teacher] = await Promise.all([
      api('/api/reminders').catch(()=>({reminders:[]})), isRole('TEACHER') ? api('/api/teacher/assignments') : Promise.resolve({ assignments:[] })
    ]);
    const assignments = teacher.assignments || [];
    const sheets = assignments.flatMap(a => a.sheets || []);
    const submitted = sheets.filter(s => ['SUBMITTED','LOCKED','CORRECTION_REQUESTED'].includes(s.status)).length;
    const open = sheets.length - submitted;
    const classCount = state.me.classTeacherClasses?.length || 0;
    const firstName = (state.me.user.name || '').replace(/^Mr\.?\s+|^Mrs\.?\s+|^Ms\.?\s+/i,'').split(' ')[0] || state.me.user.name;
    const mainActions=[];
    if(isRole('TEACHER')) mainActions.push(actionTile('✎','Enter Results',open?`${open} result sheet${open===1?'':'s'} still open.`:'Your result sheets are up to date.','teacher'));
    if(isClassTeacher()) mainActions.push(actionTile('▦','My Class Results',`${classCount} class${classCount===1?'':'es'} assigned to you.`,'classTeacher'),actionTile('▤','Prepare Reports','View, generate and send pupil reports.','reports'));
    if(isRole('HOD')) mainActions.push(actionTile('✓','Teaching Approvals','Approve teachers who claim subjects in your department.','hodClaims'),actionTile('◫','Results Status','See submitted and missing department results.','hodProgress'));
    if(isAdminOrHeadFront()) mainActions.push(actionTile('◉','School Results','See school-wide submission progress.','schoolProgress'),actionTile('✓','Approval Requests','Approve incomplete report release and class-teacher claims.','approvals'));
    content.innerHTML = `
      <section class="hero-card simple-hero"><div><span class="eyebrow">REPORTFORM ZM • EDUSEND V3.0.1</span><h1>Welcome, ${esc(firstName)}</h1><p>Your main job is simple: enter results once, prepare the report, send it to the parent.</p></div><div class="hero-orb">ES</div></section>
      ${isRole('TEACHER')?deadlineBanner(rem.reminders):''}
      <div class="simple-summary">
        ${isRole('TEACHER')?`<div><b>${submitted}/${sheets.length||0}</b><span>result sheets submitted</span></div>`:''}
        ${isClassTeacher()?`<div><b>${classCount}</b><span>class${classCount===1?'':'es'} you manage</span></div>`:''}
        <div><b>${state.unread}</b><span>unread notification${state.unread===1?'':'s'}</span></div>
      </div>
      <div class="section-title space-top"><h3>What do you want to do?</h3></div>
      <div class="action-grid simple-actions">${mainActions.join('') || actionTile('●','Notifications','Open your latest school result updates.','notifications')}</div>`;
    content.querySelectorAll('[data-action-nav]').forEach(b => b.onclick = () => navigate(b.dataset.actionNav));
  }

  async function renderWorkHub(content) {
    const cards=[];
    if(isRole('TEACHER')) cards.push(actionTile('✎','Enter Results','Choose a class, type marks and submit.','teacher'));
    if(isClassTeacher()) cards.push(actionTile('▦','My Class Results','See all submitted subjects automatically.','classTeacher'),actionTile('▤','Prepare Reports','Generate or send complete/provisional reports.','reports'));
    if(isRole('HOD')) cards.push(actionTile('✓','Approve Teaching Claims','Confirm who really teaches each subject.','hodClaims'),actionTile('◫','Results Status','See missing and submitted results.','hodProgress'),actionTile('!','Missing / Late Results','Follow up outstanding subjects.','escalations'));
    if(isAdminOrHeadFront()) cards.push(actionTile('◉','School Results Status','See progress across the whole school.','schoolProgress'),actionTile('✓','Approval Requests','Incomplete report and class-teacher approvals.','approvals'),actionTile('⚑','Repeat Policy','Filter pupils against the school pass rule.','repeatPolicy'));
    content.innerHTML=`<div class="page-intro"><div><h3>My Work</h3><p>Only the jobs relevant to your role are shown here.</p></div></div><div class="action-grid simple-actions">${cards.join('')||'<div class="empty">No work is assigned to this account yet.</div>'}</div>`;
    content.querySelectorAll('[data-action-nav]').forEach(b=>b.onclick=()=>navigate(b.dataset.actionNav));
  }

  async function renderMoreHub(content) {
    const cards=[actionTile('👤','My Teaching Profile','Phone number, subjects, classes and class-teacher claim.','profile')];
    if(state.me?.school?.demoMode) cards.push(actionTile('?','Training Mode','Practice the workflow with fictional data.','practice'));
    if(isRole('ADMIN')) cards.push(actionTile('⚙','School Setup','Staff, classes, pupils, subjects and assessments.','admin'));
    if(isAdminOrHeadFront()) cards.push(actionTile('≡','History','See important result and approval actions.','audit'));
    if(isClassTeacher()||isRole('HOD')||isAdminOrHeadFront()) cards.push(actionTile('!','Missing / Late Results','Follow up outstanding subject results.','escalations'));
    content.innerHTML=`<div class="page-intro"><div><h3>More</h3><p>Less-used settings are kept here so daily work stays simple.</p></div></div><div class="action-grid simple-actions">${cards.join('')}</div>`;
    content.querySelectorAll('[data-action-nav]').forEach(b=>b.onclick=()=>navigate(b.dataset.actionNav));
  }

  async function renderProfile(content) {
    const d=await api('/api/profile/options');
    const pending=d.claims.filter(c=>c.status==='PENDING');
    content.innerHTML=`<div class="page-intro"><div><h3>My Teaching Profile</h3><p>Tell EduSend what you teach. Subject claims are verified once by the HOD; class-teacher claims are verified by administration.</p></div></div>
      <div class="grid grid-2">
        <div class="card"><h3>Contact number</h3><p class="small muted">Internal school use only. It never appears on pupil reports.</p><form id="phoneForm" class="stack"><input id="profilePhone" value="${esc(d.user.phone||'')}" placeholder="Staff phone number"><button class="btn btn-primary">Save number</button></form></div>
        <div class="card"><h3>Approved access</h3><div class="approved-list">${d.assignments.length?d.assignments.map(a=>`<div><b>${esc(a.className)} — ${esc(a.subjectName)}</b><span>Approved subject</span></div>`).join(''):'<div class="empty small">No approved subjects yet.</div>'}${d.classTeacherClasses.map(c=>`<div><b>${esc(c.name)}</b><span>Approved class teacher</span></div>`).join('')}</div></div>
      </div>
      ${isRole('TEACHER')?`<div class="card space-top"><h3>Request a teaching subject</h3><p class="small muted">Choose one class and subject. You can repeat this for each class you teach.</p><form id="claimForm" class="form-grid"><div><label>Class</label><select id="claimClass">${d.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div><label>Subject</label><select id="claimSubject">${d.subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div><button class="btn btn-primary span-2">Send for HOD approval</button></form></div>
      <div class="card space-top"><h3>Are you a class teacher?</h3><p class="small muted">If yes, choose the class. Administration will verify it once.</p><form id="classClaimForm" class="inline-form"><select id="claimClassTeacher"><option value="">Choose class…</option>${d.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><button class="btn btn-secondary">Request verification</button></form></div>`:''}
      <div class="card space-top"><h3>Requests</h3>${d.claims.length?`<div class="claim-list">${d.claims.slice(0,30).map(c=>{const cls=d.classes.find(x=>x.id===c.classId);const sub=d.subjects.find(x=>x.id===c.subjectId);return `<div><span class="pill ${c.status==='APPROVED'?'pill-green':c.status==='DECLINED'?'pill-red':'pill-orange'}">${esc(c.status)}</span><b>${esc(c.type==='CLASS_TEACHER'?`Class teacher — ${cls?.name||''}`:`${cls?.name||''} — ${sub?.name||''}`)}</b>${c.note?`<small>${esc(c.note)}</small>`:''}</div>`}).join('')}</div>`:'<div class="empty">No requests yet.</div>'}</div>`;
    byId('phoneForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/profile/phone',{method:'POST',body:{phone:byId('profilePhone').value}});toast('Phone number saved')}catch(err){toast(err.message,true)}};
    if(byId('claimForm')) byId('claimForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/profile/claims',{method:'POST',body:{phone:byId('profilePhone')?.value||d.user.phone,assignments:[{classId:byId('claimClass').value,subjectId:byId('claimSubject').value}]}});actionPopup('Request sent','Your HOD will verify this class and subject. You cannot enter its results until it is approved.');await renderProfile(content)}catch(err){toast(err.message,true)}};
    if(byId('classClaimForm')) byId('classClaimForm').onsubmit=async e=>{e.preventDefault();const classId=byId('claimClassTeacher').value;if(!classId){toast('Choose a class first',true);return}try{await api('/api/profile/claims',{method:'POST',body:{phone:byId('profilePhone')?.value||d.user.phone,assignments:[],classTeacherClassId:classId}});actionPopup('Request sent','Administration will verify your class-teacher role.');await renderProfile(content)}catch(err){toast(err.message,true)}};
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
          <button class="btn ${s.status==='LOCKED'?'btn-secondary':s.status==='SUBMITTED'?'btn-secondary':'btn-primary'} full" data-open-sheet="${a.id}" data-assessment="${s.assessment.id}">${s.status==='LOCKED'?'View locked sheet':s.status==='SUBMITTED'?'View / correct results':s.status==='CORRECTION_REQUESTED'?'Open correction request':'Open & enter results'}</button>
        </article>`).join('')}</div>` : '<div class="empty">No class/subject has been assigned to you yet.</div>'}`;
    content.querySelectorAll('[data-open-sheet]').forEach(b => b.onclick = () => openResultSheet(b.dataset.openSheet, b.dataset.assessment));
  }

  async function openResultSheet(assignmentId, assessmentId, correctionMode=false) {
    const d = await api(`/api/teacher/sheet?assignmentId=${encodeURIComponent(assignmentId)}&assessmentId=${encodeURIComponent(assessmentId)}`);
    const locked = d.sheet.status === 'LOCKED';
    const submitted = ['SUBMITTED','CORRECTION_REQUESTED'].includes(d.sheet.status);
    const effectiveCorrection = !locked && (correctionMode || d.sheet.status === 'CORRECTION_REQUESTED');
    const readOnly = locked || (submitted && !effectiveCorrection);
    d.correctionMode = effectiveCorrection;
    let recovered=false, recoveredAt='';
    if(!readOnly){const local=readLocalDraft(assignmentId,assessmentId);const localTime=Date.parse(local?.savedAt||'');const serverTime=Date.parse(d.sheet.updatedAt||'')||0;if(local?.rows?.length&&Number.isFinite(localTime)&&localTime>serverTime){const lm={},ls={},ln={};for(const row of local.rows){if(row.mark!==null&&row.mark!==''&&row.mark!==undefined)lm[row.pupilId]=Number(row.mark);ls[row.pupilId]=row.state||'PENDING';if(row.note)ln[row.pupilId]=row.note;}d.sheet.marks=lm;d.sheet.markStates=ls;d.sheet.markNotes=ln;recovered=true;recoveredAt=local.savedAt;}}
    state.activeSheet=d;
    const rows=d.pupils.map((p,i)=>{
      if(!p.takesSubject) return `<tr class="not-taking-row"><td>${i+1}</td><td><b>${esc(p.name)}</b><div class="tiny muted">${esc(p.examNo||'')}</div></td><td colspan="2"><span class="pill pill-grey">Not taking ${esc(d.assignment.subjectName)}</span></td></tr>`;
      const mark=d.sheet.marks[p.id]??''; const st=d.sheet.markStates[p.id]||(mark!==''?'PRESENT':'PENDING'); const note=d.sheet.markNotes?.[p.id]||'';
      let reason=''; if(st==='ABSENT') reason='ABSENT'; else if(st==='PENDING'&&note) reason=note.toUpperCase().includes('PAPER')?'PAPER_MISSING':note.toUpperCase().includes('DID NOT')?'DID_NOT_WRITE':'PENDING';
      return `<tr><td>${i+1}</td><td><b>${esc(p.name)}</b>${p.isRepeater?'<span class="repeater-tag">Repeater</span>':''}<div class="tiny muted">${esc(p.examNo||'')}</div></td><td class="center"><input class="mark-input" data-mark="${p.id}" type="number" inputmode="decimal" min="0" max="100" step="0.1" value="${esc(mark)}" ${readOnly?'disabled':''}></td><td><select class="reason-select" data-reason="${p.id}" ${readOnly?'disabled':''}><option value="" ${!reason?'selected':''}>No special reason</option><option value="ABSENT" ${reason==='ABSENT'?'selected':''}>Absent</option><option value="DID_NOT_WRITE" ${reason==='DID_NOT_WRITE'?'selected':''}>Did not write</option><option value="PAPER_MISSING" ${reason==='PAPER_MISSING'?'selected':''}>Paper missing</option><option value="PENDING" ${reason==='PENDING'?'selected':''}>Mark pending</option></select></td></tr>`;
    }).join('');
    const info = locked
      ? '<div class="alert alert-orange"><b>Locked by administration.</b> You can view the results but cannot change them until the sheet is unlocked.</div>'
      : effectiveCorrection
        ? `<div class="alert alert-orange"><b>${d.sheet.status==='CORRECTION_REQUESTED'?'Correction requested.':'Correction mode.'}</b> Change only the wrong result. Your class teacher and administration will be notified.</div>`
        : submitted
          ? '<div class="alert alert-green"><b>Submitted.</b> These are your subject results. If you notice a mistake, use <b>Correct a Mistake</b>.</div>'
          : '<div class="alert alert-blue"><b>Autosave is on.</b> You do not need a Save Draft button.</div>';
    showModal(`<div class="modal-head"><div><b>${esc(d.assignment.className)} — ${esc(d.assignment.subjectName)}</b><div class="tiny muted">${esc(d.assessment.name)} • ${esc(d.sheet.deadline.text)}</div></div><button class="close" data-close>×</button></div>
      <div class="modal-body"><div class="workflow-strip"><span>1. Type marks</span><span>2. Give a reason only where a mark is missing</span><span>3. ${effectiveCorrection?'Save correction':'Submit'}</span></div>
      ${info}
      ${recovered?`<div class="alert alert-orange"><b>Recovered work.</b> Newer work from this device was restored (${fmtDate(recoveredAt)}).</div>`:''}
      <div id="autosaveStatus" class="save-state ${readOnly?'saved':''}">${readOnly?(locked?'Locked':'Submitted '+fmtDate(d.sheet.submittedAt)):effectiveCorrection?'Correction not saved yet':d.sheet.updatedAt?'✓ Saved • '+fmtDate(d.sheet.updatedAt):'Ready — changes save automatically'}</div>
      <div class="table-wrap"><table class="table result-entry simple-entry"><thead><tr><th>#</th><th>Pupil</th><th class="center">Mark %</th><th>If no mark</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${effectiveCorrection?'<div class="field correction-reason"><label>Reason for correction</label><input id="correctionReason" maxlength="300" placeholder="Example: Entered 48 instead of 84 for one pupil"></div>':''}</div>
      <div class="modal-foot"><button class="btn btn-secondary" data-close>${effectiveCorrection?'Cancel':'Close'}</button>${locked?'':submitted&&!effectiveCorrection?'<button type="button" id="startCorrection" class="btn btn-primary">Correct a Mistake</button>':effectiveCorrection?'<button type="button" id="saveCorrection" class="btn btn-green btn-lg">Save Correction</button>':`${state.me?.school?.demoMode?'<button type="button" id="fillDemoMarks" class="btn btn-gold">Fill demo marks</button>':''}<button type="button" id="submitResults" class="btn btn-green btn-lg">Submit Results</button>`}</div>`);
    if(submitted&&!effectiveCorrection&&!locked){byId('startCorrection').onclick=()=>openResultSheet(assignmentId,assessmentId,true);return;}
    if(!readOnly){
      const changed=()=>{
        snapshotActiveDraft();
        if(effectiveCorrection){const st=byId('autosaveStatus');if(st){st.textContent='Correction not saved yet';st.className='save-state local-only';}}
        else scheduleAutosave();
      };
      document.querySelectorAll('[data-mark],[data-reason]').forEach(el=>{el.addEventListener('input',changed);el.addEventListener('change',changed)});
      document.querySelectorAll('[data-mark]').forEach(el=>el.addEventListener('input',()=>{if(el.value!==''){const r=document.querySelector(`[data-reason="${el.dataset.mark}"]`);if(r)r.value='';}}));
      if(effectiveCorrection){byId('saveCorrection').onclick=()=>saveActiveSheet('correct',false);}
      else{
        if(byId('fillDemoMarks'))byId('fillDemoMarks').onclick=fillPracticeMarks;
        byId('submitResults').onclick=()=>saveActiveSheet('submit',false);
        if(recovered)setTimeout(()=>saveActiveSheet('draft',true),150);
      }
    }
  }

  function fillPracticeMarks() {
    if(!state.activeSheet)return;
    const subjectSeed=(state.activeSheet.assignment.subjectName||'').length*3;
    [...document.querySelectorAll('[data-mark]')].forEach((el,i)=>{el.value=String(48+((i*7+subjectSeed)%43));const r=document.querySelector(`[data-reason="${el.dataset.mark}"]`);if(r)r.value='';});
    const st=byId('autosaveStatus');if(st)st.textContent='Practice marks filled — saving…';saveActiveSheet('draft',true).then(()=>toast('Practice marks filled. Review them, then submit.'));
  }

  function collectSheetRows() {
    return [...document.querySelectorAll('[data-mark]')].map(el=>{
      const mark=el.value===''?null:Number(el.value); const reason=document.querySelector(`[data-reason="${el.dataset.mark}"]`)?.value||'';
      let state=mark!==null?'PRESENT':reason==='ABSENT'?'ABSENT':'PENDING';
      const note=reason==='DID_NOT_WRITE'?'Did not write':reason==='PAPER_MISSING'?'Paper missing':reason==='PENDING'?'Mark pending':reason==='ABSENT'?'Absent':'';
      return {pupilId:el.dataset.mark,mark,state,note};
    });
  }

  function scheduleAutosave() {
    clearTimeout(state.autosaveTimer); const st=byId('autosaveStatus'); if(st){st.textContent='Saving…';st.className='save-state syncing';}
    state.autosaveTimer=setTimeout(()=>saveActiveSheet('draft',true),700);
  }

  async function saveActiveSheet(action,silent) {
    if(!state.activeSheet)return; clearTimeout(state.autosaveTimer); const current=state.activeSheet; const rows=collectSheetRows(); storeLocalDraft(rows);
    let correctionReason='';
    if(action==='submit'||action==='correct'){
      const unexplained=rows.filter(r=>r.mark===null&&!r.note); if(unexplained.length){actionPopup('Missing information',`${unexplained.length} pupil${unexplained.length===1?' has':'s have'} no mark and no reason. Enter a mark or choose a reason first.`,'error');return;}
    }
    if(action==='submit'){
      if(!confirm(`Submit ${current.assignment.subjectName} results for ${current.assignment.className}? The class teacher and administration will see them immediately.`))return;
    }
    if(action==='correct'){
      correctionReason=String(byId('correctionReason')?.value||'').trim();
      if(correctionReason.length<3){actionPopup('Reason required','Briefly state why you are correcting the submitted results.','error');byId('correctionReason')?.focus();return;}
      if(!confirm(`Save this correction to ${current.assignment.subjectName}? The class teacher and administration will be notified.`))return;
    }
    const submitBtn=action==='correct'?byId('saveCorrection'):byId('submitResults');if(submitBtn)submitBtn.disabled=true;const st=byId('autosaveStatus');if(st){st.textContent=action==='submit'?'Submitting results…':action==='correct'?'Saving correction…':'Saving…';st.className='save-state syncing';}
    try{
      const result=await api('/api/teacher/sheet',{method:'PUT',body:{assignmentId:current.assignment.id,assessmentId:current.assessment.id,rows,action,correctionReason,expectedRevision:current.sheet.revision}});
      current.sheet.revision=result.revision; current.sheet.updatedAt=result.updatedAt; current.sheet.status=result.status; storeLocalDraft(rows,{serverSavedAt:result.updatedAt,submittedCopy:action==='submit'||action==='correct'});
      if(st){st.textContent=action==='submit'?'✓ Submitted successfully':action==='correct'?'✓ Correction saved':`✓ Saved ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;st.className='save-state saved';}
      if(action==='submit'){
        const assignmentId=current.assignment.id,assessmentId=current.assessment.id;removeLocalDraft(assignmentId,assessmentId);closeModal(true);const who=result.classTeacherName?`${result.classTeacherName} can now see the results.`:'Administration was notified; no class teacher is assigned yet.';actionPopup('Results submitted',`${result.subjectName} • ${result.className}. ${who}`);await navigate('teacher');
      }
      if(action==='correct'){
        const assignmentId=current.assignment.id,assessmentId=current.assessment.id;removeLocalDraft(assignmentId,assessmentId);closeModal(true);const c=result.correction||{};const resend=c.affectedSentReports?` ${c.affectedSentReports} affected pupil report${c.affectedSentReports===1?' was':'s were'} already sent/shared; the class teacher has been warned that a corrected report may need to be resent.`:'';actionPopup('Correction saved',`${c.changedCount||1} result${(c.changedCount||1)===1?'':'s'} corrected. The class teacher and administration were notified.${resend}`);await navigate('teacher');
      }
    }catch(err){if(st){st.textContent=`Not synced — ${err.message}`;st.className='save-state local-only';}if(err.message.includes('newer version'))actionPopup('Newer copy found','This result sheet was changed on another device. Close it and reopen before continuing.','error');else if(!silent)actionPopup(action==='correct'?'Could not save correction':'Could not save to server',`Your latest typing is still kept on this device. ${err.message}`,'error');}
    finally{if(submitBtn)submitBtn.disabled=false;}
  }

  async function renderClassTeacher(content) {
    const d = await api('/api/class-teacher/classes'); const classes = d.classes || [];
    if (!classes.length) { content.innerHTML = '<div class="empty">No class is assigned to you as class teacher.</div>'; return; }
    content.innerHTML = `<div class="toolbar premium-toolbar"><select id="classSelect">${classes.map(c=>`<option value="${c.id}">${esc(c.name)} • ${esc(c.gradingSystem)}</option>`).join('')}</select><select id="assessmentSelect">${state.assessments.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select><button id="refreshClass" class="btn btn-secondary">Refresh</button><button id="goReports" class="btn btn-primary">Open Report Centre</button></div><div id="classOverview"></div>`;
    const load = () => loadClassOverview(byId('classSelect').value, byId('assessmentSelect').value);
    byId('classSelect').onchange = load; byId('assessmentSelect').onchange = load; byId('refreshClass').onclick = load; byId('goReports').onclick = () => navigate('reports'); await load();
    state.backgroundRefresh=()=>{const c=byId('classSelect'),a=byId('assessmentSelect');if(c&&a)return loadClassOverview(c.value,a.value,{silent:true});};
  }

  async function loadClassOverview(classId, assessmentId, options={}) {
    const h=byId('classOverview');if(!h)return;
    const silent=!!options.silent;
    const previousScroll=window.scrollY;
    const masterWasOpen=!!h.querySelector('details')?.open;
    if(!silent && !h.innerHTML.trim()) h.innerHTML='<div class="loading-card">Loading class results…</div>';
    const d=await api(`/api/class-teacher/overview?classId=${encodeURIComponent(classId)}&assessmentId=${encodeURIComponent(assessmentId)}`); const r=d.reportReadiness; const pct=r.totalSubjects?Math.round(r.submittedSubjects/r.totalSubjects*100):0;
    const subjects=d.subjects.map(s=>{const visible=['SUBMITTED','LOCKED','CORRECTION_REQUESTED'].includes(s.status);return `<article class="subject-progress-card"><div><b>${esc(s.subjectName)}</b><small>${esc(s.teacherName||'Unassigned')}${s.teacherPhone?` • ${esc(s.teacherPhone)}`:''}</small></div>${statusPill(s.status,s.deadline)}<div class="subject-actions">${visible?`<button class="action-link" data-view-results="${s.assignmentId}">View</button><button class="action-link" data-correct="${s.assignmentId}">Request correction</button>`:`<button class="action-link" data-ask="${s.assignmentId}">Ask teacher</button>${s.teacherPhone?`<a class="action-link" href="tel:${esc(s.teacherPhone)}">Call</a>`:''}<button class="action-link" data-escalate="${s.assignmentId}">Escalate</button>`}</div></article>`}).join('');
    const heads=d.subjects.map(s=>`<th class="center">${esc(s.subjectName)}</th>`).join('');
    const rows=d.pupils.map((p,i)=>`<tr><td>${i+1}</td><td><b>${esc(p.name)}</b><div class="tiny muted">${p.reportReadiness?.finalReady?'Ready':p.reportReadiness?.provisionalAllowed?'Provisional approved':`${p.reportReadiness?.submittedSubjects||0}/${p.reportReadiness?.totalSubjects||0} subjects`}</div></td>${d.subjects.map(s=>{const x=p.results[s.subjectId]||{};const val=x.state==='NOT_TAKING'?'N/T':x.state==='ABSENT'?'ABS':x.mark??'—';return `<td class="center" title="${esc(x.note||'')}">${val}${x.note&&x.mark==null?`<div class="tiny muted">${esc(x.note)}</div>`:''}</td>`}).join('')}</tr>`).join('');
    h.innerHTML=`<div class="readiness-banner ${r.finalReady?'ready':r.provisionalAllowed?'provisional':'blocked'}"><div><span class="eyebrow">MY CLASS RESULTS</span><h3>${r.submittedSubjects}/${r.totalSubjects} subjects received</h3><p>${r.missingSubjects.length?`Still incomplete: ${r.missingSubjects.map(x=>`${x.subjectName}${x.pendingPupilCount?` (${x.pendingPupilCount} pupil${x.pendingPupilCount===1?'':'s'})`:''}`).join(', ')}`:'All pupil results have arrived.'}</p></div><div class="progress-ring">${pct}%</div></div>
      <div class="section-title space-top"><h3>Subjects</h3><button class="btn btn-primary" id="simpleGoReports">Prepare Reports</button></div><div class="subject-progress-grid">${subjects}</div>
      <details class="card space-top"><summary><b>View full master mark schedule</b> <span class="muted">(read-only)</span></summary><div class="table-wrap space-top"><table class="table"><thead><tr><th>#</th><th>Pupil</th>${heads}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
    byId('simpleGoReports').onclick=()=>navigate('reports');
    h.querySelectorAll('[data-view-results]').forEach(b=>b.onclick=()=>openReadOnlyResults(b.dataset.viewResults,assessmentId));
    h.querySelectorAll('[data-escalate]').forEach(b=>b.onclick=()=>escalateMissing(b.dataset.escalate,assessmentId));
    h.querySelectorAll('[data-correct]').forEach(b=>b.onclick=()=>requestCorrection(b.dataset.correct,assessmentId));
    h.querySelectorAll('[data-ask]').forEach(b=>b.onclick=()=>askTeacher(b.dataset.ask,assessmentId));
    if(masterWasOpen){const d=h.querySelector('details');if(d)d.open=true;}
    if(silent) requestAnimationFrame(()=>window.scrollTo({top:previousScroll,left:0,behavior:'auto'}));
  }

  async function openReadOnlyResults(assignmentId, assessmentId) {
    try{
      const d=await api(`/api/results/read-only?assignmentId=${encodeURIComponent(assignmentId)}&assessmentId=${encodeURIComponent(assessmentId)}`);
      const rows=d.pupils.map((p,i)=>`<tr><td>${i+1}</td><td><b>${esc(p.name)}</b><div class="tiny muted">${esc(p.examNo||'')}</div></td><td class="center">${p.state==='NOT_TAKING'?'N/T':p.state==='ABSENT'?'ABS':p.mark??'—'}</td><td>${esc(p.note||'')}</td></tr>`).join('');
      showModal(`<div class="modal-head"><div><b>${esc(d.assignment.className)} — ${esc(d.assignment.subjectName)}</b><div class="tiny muted">Submitted ${fmtDate(d.submittedAt)} • Read-only</div></div><button class="close" data-close>×</button></div><div class="modal-body"><div class="alert alert-blue"><b>Only the subject teacher can change these marks.</b>${d.teacherPhone?` Teacher phone: ${esc(d.teacherPhone)}`:''}</div><div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Pupil</th><th>Mark</th><th>Note / reason</th></tr></thead><tbody>${rows}</tbody></table></div></div><div class="modal-foot"><button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" id="askFromView">Ask Teacher</button></div>`);
      byId('askFromView').onclick=()=>askTeacher(assignmentId,assessmentId);
    }catch(e){toast(e.message,true)}
  }

  async function askTeacher(assignmentId, assessmentId, pupilId='') {
    const quick=prompt('Message to the subject teacher:','Please clarify the missing result.'); if(quick===null||!quick.trim())return;
    try{await api('/api/result-messages',{method:'POST',body:{assignmentId,assessmentId,pupilId,text:quick.trim()}});actionPopup('Message sent','The subject teacher has been notified inside EduSend.');}catch(e){toast(e.message,true)}
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
    const holder=byId('reportBody');holder.innerHTML='<div class="loading-card">Preparing reports…</div>';
    const [d,hist]=await Promise.all([api(`/api/class-teacher/overview?classId=${encodeURIComponent(classId)}&assessmentId=${encodeURIComponent(assessmentId)}`),api(`/api/class-teacher/report-history?classId=${encodeURIComponent(classId)}&assessmentId=${encodeURIComponent(assessmentId)}`)]);
    const sentSet=new Set((hist.rows||[]).filter(x=>x.stage==='CONFIRMED_SENT'||x.stage==='SHARED'||!x.stage).map(x=>x.pupilId));const r=d.reportReadiness;
    const approval=r.approval; const approvalButton=!r.finalReady&&!r.provisionalAllowed?(approval?.status==='REQUESTED'?'<span class="pill pill-orange">Approval requested</span>':'<button id="requestRelease" class="btn btn-gold">Request permission to send incomplete reports</button>'):'';
    holder.innerHTML=`<div class="readiness-banner ${r.finalReady?'ready':r.provisionalAllowed?'provisional':'blocked'}"><div><span class="eyebrow">PREPARE REPORTS</span><h3>${r.finalReady?'Complete reports':r.provisionalAllowed?'Provisional sending approved':'Some subjects are still missing'}</h3><p>${r.submittedSubjects}/${r.totalSubjects} subject sheets received${r.pendingPupilResults?` • ${r.pendingPupilResults} pupil result${r.pendingPupilResults===1?'':'s'} still pending`:''}${r.missingSubjects.length?` • Incomplete: ${[...new Set(r.missingSubjects.map(x=>x.subjectName))].join(', ')}`:''}</p></div><div>${approvalButton}</div></div>
      <div class="report-list">${d.pupils.map(p=>{const pr=p.reportReadiness||r;const can=pr.canSend;return `<article class="pupil-report-card"><div class="pupil-avatar">${esc((p.name||'?')[0])}</div><div class="pupil-main"><b>${esc(p.name)}</b><small>${esc(p.examNo||'No exam number')}</small><span>${pr.finalReady?'Ready':pr.provisionalAllowed?'Provisional approved':`${pr.submittedSubjects}/${pr.totalSubjects} subjects ready`}</span></div><div class="report-status">${sentSet.has(p.id)?'<span class="pill pill-green">Shared</span>':can?'<span class="pill pill-blue">Ready</span>':'<span class="pill pill-orange">Waiting</span>'}</div><div class="report-actions"><button class="btn btn-secondary" data-preview="${p.id}">Preview</button><button class="btn btn-secondary" data-pdf="${p.id}" ${can?'':'disabled'}>PDF</button><button class="btn btn-primary" data-share="${p.id}" ${can?'':'disabled'}>Share</button></div></article>`}).join('')}</div>`;
    holder.querySelectorAll('[data-preview]').forEach(b=>b.onclick=()=>previewReport(d,b.dataset.preview)); holder.querySelectorAll('[data-pdf]').forEach(b=>b.onclick=()=>downloadReport(d,b.dataset.pdf)); holder.querySelectorAll('[data-share]').forEach(b=>b.onclick=()=>shareReport(d,b.dataset.share));
    if(byId('requestRelease'))byId('requestRelease').onclick=async()=>{const reason=prompt('Why should incomplete reports be sent?','Report deadline has arrived while some subject results are still outstanding.');if(reason===null)return;try{await api('/api/report-release/request',{method:'POST',body:{classId:d.class.id,assessmentId:d.assessment.id,reason}});actionPopup('Approval requested','Administration has been notified. The Send buttons will unlock if a supervisor approves.');await loadReportCentre(classId,assessmentId)}catch(e){toast(e.message,true)}};
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
    if (d.class.gradingSystem==='LEGACY' && (pupil.reportReadiness?.finalReady || d.reportReadiness.finalReady) && completeForOverall && numeric.length>=6) {
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
    if(pupil.reportReadiness?.provisional)return `This is a provisional report because some subject results are still pending. ${pupil.name.split(' ')[0]} performed strongest in ${best.subject} (${best.mark}%) and should continue working consistently, especially in ${weak.subject} (${weak.mark}%). Final aggregate and position will be confirmed when all required results are available.`;
    if(d.class.gradingSystem==='CBC') return `${pupil.name.split(' ')[0]} has shown ${best.remark.toLowerCase()} performance in ${best.subject}. Continued practice is encouraged, with extra attention to ${weak.subject}. The learner should review corrections, practise regularly and ask for help where concepts are not yet secure.`;
    return `${pupil.name.split(' ')[0]} performed strongest in ${best.subject} (${best.mark}%) and should maintain that effort. More focused revision is needed in ${weak.subject} (${weak.mark}%). Regular practice, correction of mistakes and consistent study will help improve the overall result.`;
  }

  function previewReport(d, pupilId) {
    const p=d.pupils.find(x=>x.id===pupilId); if(!p)return; const m=pupilReportModel(d,p);
    showModal(`<div class="modal-head"><div><b>Report Preview — ${esc(p.name)}</b><div class="tiny muted">${esc(d.class.name)} • ${esc(d.assessment.name)}</div></div><button class="close" data-close>×</button></div><div class="modal-body"><div class="report-preview ${p.reportReadiness?.provisional?'is-provisional':''}"><div class="rp-head"><div>REPUBLIC OF ZAMBIA<br><b>MINISTRY OF EDUCATION</b></div><h2>${esc(state.me.school.name)}</h2><h3>PUPIL'S PROGRESS REPORT</h3>${p.reportReadiness?.provisional?'<div class="provisional-stamp">PROVISIONAL REPORT</div>':''}</div><div class="rp-meta"><span><b>Name:</b> ${esc(p.name)}</span><span><b>Class:</b> ${esc(d.class.name)}</span><span><b>Assessment:</b> ${esc(d.assessment.name)}</span><span><b>Exam No:</b> ${esc(p.examNo||'—')}</span></div><table class="rp-table"><thead><tr><th>Subject</th><th>Mark</th><th>Grade</th><th>Remark</th></tr></thead><tbody>${m.rows.map(x=>`<tr><td>${esc(x.subject)}</td><td>${x.mark??'—'}</td><td>${x.grade??'—'}</td><td>${esc(x.remark)}</td></tr>`).join('')}</tbody></table><div class="rp-summary">${d.class.gradingSystem==='CBC'?`Average: <b>${m.summary.average??'—'}%</b>`:`Best 6 Total: <b>${m.summary.best6Total??'—'}</b> • Points: <b>${m.summary.points??'—'}</b> • Division: <b>${m.summary.division??'—'}</b> • Position: <b>${m.summary.position??'—'}</b>`}</div><div class="rp-comment"><b>Class Teacher's Comment:</b><p>${esc(teacherComment(d,p,m))}</p></div><div class="rp-footer">Class Teacher: ${esc(d.classTeacher?.name||state.me.user.name)}</div></div></div><div class="modal-foot"><button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" id="previewPdf">Download PDF</button></div>`);
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
    if(p.reportReadiness?.provisional){doc.setTextColor(185,40,40);doc.setFontSize(10);doc.text('PROVISIONAL REPORT — SOME SUBJECT RESULTS PENDING',W/2,50,{align:'center'});}
    let y=p.reportReadiness?.provisional?57:52; doc.setTextColor(0);doc.setFontSize(9);doc.setFont('helvetica','normal');
    const meta=[`NAME: ${p.name}`,`CLASS: ${d.class.name}`,`ASSESSMENT: ${d.assessment.name}`,`EXAM NO: ${p.examNo||'—'}`]; meta.forEach((t,i)=>doc.text(t,14+i%2*96,y+Math.floor(i/2)*6)); y+=16;
    const col=[14,82,112,136,196]; doc.setFillColor(239,245,255);doc.rect(14,y,182,8,'F');doc.setFont('helvetica','bold');['SUBJECT','MARK','GRADE','REMARK'].forEach((t,i)=>doc.text(t,[16,86,116,140][i],y+5.5)); y+=8; doc.setFont('helvetica','normal');
    model.rows.forEach(r=>{doc.setDrawColor(220);doc.rect(14,y,182,7);doc.text(String(r.subject).slice(0,30),16,y+4.8);doc.text(r.mark===null?'—':String(r.mark),88,y+4.8);doc.text(r.grade===null?'—':String(r.grade),118,y+4.8);doc.text(String(r.remark).slice(0,28),140,y+4.8);y+=7;});
    y+=5; doc.setFont('helvetica','bold'); if(d.class.gradingSystem==='CBC') doc.text(`Average: ${model.summary.average??'—'}%`,14,y); else doc.text(`Best 6 Total: ${model.summary.best6Total??'—'}    Points: ${model.summary.points??'—'}    Division: ${model.summary.division??'—'}    Position: ${model.summary.position??'—'}`,14,y); y+=8;
    doc.setFont('helvetica','bold');doc.text("Class Teacher's Comment:",14,y);y+=5;doc.setFont('helvetica','normal');const comment=teacherComment(d,p,model);const lines=doc.splitTextToSize(comment,180);doc.text(lines,14,y);y+=lines.length*4.5+6;
    if(p.reportReadiness?.provisional){doc.setTextColor(185,40,40);doc.setFont('helvetica','bold');doc.text('Missing subject results are shown as Pending. Final aggregate/division/position is withheld until completion.',14,y);y+=7;doc.setTextColor(0);}
    doc.setDrawColor(...gold);doc.line(14,270,196,270);doc.setFontSize(8);doc.setTextColor(...blue);doc.text(`Class Teacher: ${d.classTeacher?.name||state.me.user.name}`,14,276);doc.text(`EduSend • Page ${pageNo}`,196,276,{align:'right'});doc.setTextColor(0);
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
      const doc=await buildReportDoc(d,[p]); const blob=doc.output('blob'); const file=new File([blob],`${d.class.name}_${p.name.replace(/\s+/g,'_')}.pdf`,{type:'application/pdf'}); const text=`${state.me.school.name}\n${d.assessment.name}\nPupil: ${p.name}\nClass: ${d.class.name}${p.reportReadiness?.provisional?'\nPROVISIONAL / INCOMPLETE REPORT — some results pending':''}`;
      let channel='DOWNLOAD';
      if(navigator.share && (!navigator.canShare || navigator.canShare({files:[file]}))){await navigator.share({files:[file],title:'EduSend pupil report',text});channel='SHARE';}
      else {doc.save(file.name);const phone=normalizePhone(p.parentPrimary);if(phone)window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text+'\nPDF has been generated for sharing.')}`,'_blank');}
      await api('/api/class-teacher/report-sent',{method:'POST',body:{classId:d.class.id,assessmentId:d.assessment.id,pupilId:p.id,parentNumber:p.parentPrimary,channel,stage:'SHARED'}}).catch(()=>{}); toast('Report prepared for the parent'); await loadReportCentre(d.class.id,d.assessment.id);
    } catch(err){ if(err.name!=='AbortError')toast(err.message,true); }
  }

  async function refreshNotifications() {
    if(!state.token)return; try { const d=await api('/api/notifications'); state.unread=d.unread||0; updateUnreadBadges(); } catch {}
  }
  function updateUnreadBadges(){[['topUnread',true],['sideUnread',false]].forEach(([id])=>{const e=byId(id);if(e){e.textContent=state.unread;e.classList.toggle('hidden',!state.unread)}});const m=byId('mobileUnread');if(m)m.classList.toggle('hidden',!state.unread);}
  async function renderNotifications(content) {
    const d=await api('/api/notifications');
    content.innerHTML=`<div class="page-intro"><div><h3>Notifications</h3><p>Only result-related updates that need your attention appear here.</p></div><button id="markRead" class="btn btn-secondary">Mark all read</button></div><div class="notification-list">${d.notifications.length?d.notifications.map(n=>`<article class="notification-item ${n.readAt?'':'unread'}"><span class="notification-dot"></span><div><b>${esc(n.title)}</b><p>${esc(n.message)}</p><small>${fmtDate(n.createdAt)}</small>${n.type==='RESULT_MESSAGE'&&n.meta?.assignmentId?`<div class="space-top"><button class="btn btn-secondary btn-sm" data-reply-msg="${n.id}" data-assignment="${n.meta.assignmentId}" data-assessment="${n.meta.assessmentId||''}" data-pupil="${n.meta.pupilId||''}">Reply</button></div>`:''}</div></article>`).join(''):'<div class="empty">No notifications yet.</div>'}</div>`;
    byId('markRead').onclick=async()=>{await api('/api/notifications/read',{method:'POST',body:{}});state.unread=0;updateUnreadBadges();await renderNotifications(content)};
    content.querySelectorAll('[data-reply-msg]').forEach(b=>b.onclick=async()=>{const text=prompt('Reply:','');if(text===null||!text.trim())return;try{await api('/api/result-messages',{method:'POST',body:{assignmentId:b.dataset.assignment,assessmentId:b.dataset.assessment,pupilId:b.dataset.pupil,text:text.trim()}});toast('Reply sent');}catch(e){toast(e.message,true)}});
  }

  async function renderHodClaims(content) {
    const d=await api('/api/hod/claims'); const pending=d.claims.filter(c=>c.status==='PENDING');
    content.innerHTML=`<div class="page-intro"><div><h3>Teaching Approvals</h3><p>Teachers choose what they teach. You only verify the claim once.</p></div><span class="pill pill-blue">${pending.length} pending</span></div>${pending.length?`<div class="approval-list">${pending.map(c=>`<article class="approval-card"><div><span class="class-chip">${esc(c.className)}</span><h3>${esc(c.subjectName)}</h3><p>${esc(c.teacherName)}${c.teacherPhone?` • ${esc(c.teacherPhone)}`:''}</p></div><div class="approval-actions"><button class="btn btn-secondary" data-claim-no="${c.id}">Decline</button><button class="btn btn-green" data-claim-yes="${c.id}">Approve</button></div></article>`).join('')}</div>`:'<div class="empty">No teaching claims are waiting for approval.</div>'}`;
    content.querySelectorAll('[data-claim-yes]').forEach(b=>b.onclick=()=>decideTeachingClaim(b.dataset.claimYes,true,content));content.querySelectorAll('[data-claim-no]').forEach(b=>b.onclick=()=>decideTeachingClaim(b.dataset.claimNo,false,content));
  }
  async function decideTeachingClaim(id,approve,content){const note=approve?'':prompt('Reason for declining (optional):','')??'';try{await api('/api/hod/claim-decision',{method:'POST',body:{claimId:id,approve,note}});toast(approve?'Teaching claim approved':'Teaching claim declined');await renderHodClaims(content)}catch(e){toast(e.message,true)}}

  async function renderHodAssignments(content) { return renderHodClaims(content); }

  async function renderHodProgress(content) {
    if(!state.assessments.length){content.innerHTML='<div class="empty">No assessment.</div>';return;}
    content.innerHTML=`<div class="toolbar premium-toolbar"><select id="hodAssess">${state.assessments.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select><button id="hodRefresh" class="btn btn-secondary">Refresh</button></div><div id="hodProgressBody"></div>`;
    const load=async(options={})=>{const silent=!!options.silent;const previousScroll=window.scrollY;const assessmentId=byId('hodAssess')?.value;if(!assessmentId)return;const d=await api(`/api/hod/progress?assessmentId=${encodeURIComponent(assessmentId)}`);const done=d.rows.filter(r=>['SUBMITTED','LOCKED','CORRECTION_REQUESTED'].includes(r.status)).length;const overdue=d.rows.filter(r=>r.deadline.code==='OVERDUE').length;const body=byId('hodProgressBody');if(!body)return;body.innerHTML=`<div class="grid grid-3"><div class="card"><div class="stat">${done}/${d.rows.length}</div><div class="stat-label">Submitted</div></div><div class="card"><div class="stat">${overdue}</div><div class="stat-label">Overdue</div></div><div class="card"><div class="stat">${d.rows.length-done}</div><div class="stat-label">Outstanding</div></div></div><div class="table-wrap space-top"><table class="table"><thead><tr><th>Class</th><th>Subject</th><th>Teacher</th><th>Status</th><th>Deadline</th><th></th></tr></thead><tbody>${d.rows.map(r=>{const visible=['SUBMITTED','LOCKED','CORRECTION_REQUESTED'].includes(r.status);return `<tr><td>${esc(r.className)}</td><td><b>${esc(r.subjectName)}</b></td><td>${esc(r.teacherName)}</td><td>${statusPill(r.status,r.deadline)}</td><td>${fmtDate(r.deadline.dueAt)}</td><td>${visible?`<button class="action-link" data-view-hod="${r.id}">View marks</button>`:'—'}</td></tr>`}).join('')}</tbody></table></div>`;body.querySelectorAll('[data-view-hod]').forEach(b=>b.onclick=()=>openReadOnlyResults(b.dataset.viewHod,assessmentId));if(silent)requestAnimationFrame(()=>window.scrollTo({top:previousScroll,left:0,behavior:'auto'}));};
    byId('hodAssess').onchange=()=>load();byId('hodRefresh').onclick=()=>load();await load();
    state.backgroundRefresh=()=>load({silent:true});
  }

  async function renderEscalations(content, options={}) {
    const silent=!!options.silent; const previousScroll=window.scrollY;
    const d=await api('/api/escalations');
    content.innerHTML=`<div class="page-intro"><div><h3>Escalations</h3><p>Outstanding results move through class teacher → HOD → Administration without being hidden.</p></div></div><div class="escalation-list">${d.escalations.length?d.escalations.map(e=>`<article class="escalation-card"><div class="escalation-head"><div><span class="class-chip">${esc(e.assignment?.className||'')}</span><b>${esc(e.assignment?.subjectName||'')}</b><small>${esc(e.assignment?.teacherName||'')}</small></div><span class="pill pill-orange">${esc(e.status)}</span></div><p>${esc(e.note||'No note')}</p><div class="tiny muted">${esc(e.assessment?.name||'')} • Opened ${fmtDate(e.createdAt)}</div><div class="escalation-actions">${isRole('HOD')?`<button class="btn btn-secondary" data-hod-follow="${e.id}">Follow up teacher</button>`:''}${isRole('ADMIN')?`<button class="btn btn-secondary" data-remind-hod="${e.id}">Send to HOD</button><button class="btn btn-secondary" data-extend="${e.id}">Extend deadline</button><button class="btn btn-gold" data-provisional="${e.id}">Authorize provisional report</button><button class="btn btn-green" data-resolve="${e.id}">Resolve</button>`:''}</div></article>`).join(''):'<div class="empty">No escalations.</div>'}</div>`;
    content.querySelectorAll('[data-hod-follow]').forEach(b=>b.onclick=()=>hodFollow(b.dataset.hodFollow));
    content.querySelectorAll('[data-remind-hod]').forEach(b=>b.onclick=()=>adminEsc(b.dataset.remindHod,'REMIND_HOD'));
    content.querySelectorAll('[data-provisional]').forEach(b=>b.onclick=()=>adminEsc(b.dataset.provisional,'AUTHORIZE_PROVISIONAL'));
    content.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=()=>adminEsc(b.dataset.resolve,'RESOLVE'));
    content.querySelectorAll('[data-extend]').forEach(b=>b.onclick=()=>extendDeadline(b.dataset.extend));
    if(silent) requestAnimationFrame(()=>window.scrollTo({top:previousScroll,left:0,behavior:'auto'}));
    state.backgroundRefresh=()=>renderEscalations(content,{silent:true});
  }
  async function hodFollow(id){const note=prompt('Message to the teacher:','Please submit the outstanding results as soon as possible.');if(note===null)return;try{await api('/api/hod/escalation-action',{method:'POST',body:{escalationId:id,note}});toast('Teacher notified');await navigate('escalations')}catch(e){toast(e.message,true)}}
  async function adminEsc(id,action){const note=prompt(action==='AUTHORIZE_PROVISIONAL'?'Reason for provisional release:':'Optional note:','');if(note===null)return;try{await api('/api/admin/escalation-action',{method:'POST',body:{escalationId:id,action,note}});toast('Escalation updated');await navigate('escalations')}catch(e){toast(e.message,true)}}
  async function extendDeadline(id){const due=prompt('New deadline (example: 2026-09-23T16:00:00+02:00):');if(!due)return;try{await api('/api/admin/escalation-action',{method:'POST',body:{escalationId:id,action:'EXTEND_DEADLINE',dueAt:due}});toast('Deadline extended');await navigate('escalations')}catch(e){toast(e.message,true)}}

  async function renderApprovals(content) {
    if(!isAdminOrHeadFront()){content.innerHTML='<div class="empty">Administration access required.</div>';return;}
    const [ct,releases]=await Promise.all([api('/api/admin/class-teacher-claims'),api('/api/report-release/requests')]);
    const ctPending=ct.claims.filter(x=>x.status==='PENDING'), relPending=releases.requests.filter(x=>x.status==='REQUESTED');
    content.innerHTML=`<div class="page-intro"><div><h3>Approval Requests</h3><p>Only decisions that need a supervisor are shown here.</p></div><span class="pill pill-blue">${ctPending.length+relPending.length} pending</span></div>
      <div class="section-title"><h3>Incomplete report release</h3></div>${relPending.length?`<div class="approval-list">${relPending.map(r=>`<article class="approval-card"><div><span class="class-chip">${esc(r.className)}</span><h3>${esc(r.assessmentName)}</h3><p>Requested by ${esc(r.requestedByName||'Class teacher')}</p><small>Missing: ${esc((r.missingSnapshot||[]).join(', ')||'subjects outstanding')}</small></div><div class="approval-actions"><button class="btn btn-secondary" data-release-no="${r.id}">Decline</button><button class="btn btn-green" data-release-yes="${r.id}">Approve sending</button></div></article>`).join('')}</div>`:'<div class="empty">No incomplete-report approvals are waiting.</div>'}
      <div class="section-title space-top"><h3>Class-teacher verification</h3></div>${ctPending.length?`<div class="approval-list">${ctPending.map(c=>`<article class="approval-card"><div><span class="class-chip">${esc(c.className)}</span><h3>${esc(c.teacherName)}</h3><p>${esc(c.teacherPhone||'No phone saved')}</p></div><div class="approval-actions"><button class="btn btn-secondary" data-ct-no="${c.id}">Decline</button><button class="btn btn-green" data-ct-yes="${c.id}">Approve</button></div></article>`).join('')}</div>`:'<div class="empty">No class-teacher claims are waiting.</div>'}`;
    const decideRelease=async(id,approve)=>{const reason=prompt(approve?'Approval note (optional):':'Reason for declining:','')??'';try{await api('/api/report-release/decision',{method:'POST',body:{releaseId:id,approve,reason}});toast(approve?'Incomplete report sending approved':'Request declined');await renderApprovals(content)}catch(e){toast(e.message,true)}};
    const decideCt=async(id,approve)=>{const note=prompt(approve?'Note (optional):':'Reason for declining:','')??'';try{await api('/api/admin/class-teacher-claim-decision',{method:'POST',body:{claimId:id,approve,note}});toast(approve?'Class teacher verified':'Claim declined');await renderApprovals(content)}catch(e){toast(e.message,true)}};
    content.querySelectorAll('[data-release-yes]').forEach(b=>b.onclick=()=>decideRelease(b.dataset.releaseYes,true));content.querySelectorAll('[data-release-no]').forEach(b=>b.onclick=()=>decideRelease(b.dataset.releaseNo,false));content.querySelectorAll('[data-ct-yes]').forEach(b=>b.onclick=()=>decideCt(b.dataset.ctYes,true));content.querySelectorAll('[data-ct-no]').forEach(b=>b.onclick=()=>decideCt(b.dataset.ctNo,false));
  }

  async function renderRepeatPolicy(content) {
    if(!state.assessments.length){content.innerHTML='<div class="empty">Create an assessment first.</div>';return;}
    content.innerHTML=`<div class="page-intro"><div><h3>Repeat Policy</h3><p>Flag pupils by number of subjects passed — not by overall average.</p></div></div><div class="toolbar premium-toolbar"><select id="rpAssessment">${state.assessments.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div><div id="rpBody"></div>`;
    const load=async()=>{const d=await api(`/api/admin/repeat-policy?assessmentId=${encodeURIComponent(byId('rpAssessment').value)}`);byId('rpBody').innerHTML=`<div class="card policy-card"><form id="policyForm" class="policy-form"><label>Pass mark<input id="rpPass" type="number" min="0" max="100" value="${d.policy.passMark}"></label><label>Minimum subjects to pass<input id="rpMin" type="number" min="1" max="20" value="${d.policy.minPassSubjects}"></label><button class="btn btn-primary">Save rule</button></form><p class="small muted">Example: 50% in at least 5 subjects. Pupils who cannot reach the required number are flagged for review. Incomplete results remain Pending rather than being treated as zero.</p></div><div class="grid grid-3 space-top"><div class="card"><div class="stat">${d.counts.review}</div><div class="stat-label">Repeat-policy review</div></div><div class="card"><div class="stat">${d.counts.pending}</div><div class="stat-label">Waiting for results</div></div><div class="card"><div class="stat">${d.counts.subjectWarnings}</div><div class="stat-label">Pupils with a subject below ${d.policy.passMark}%</div></div></div><div class="filter-tabs space-top"><button class="btn btn-secondary active" data-rp-filter="REVIEW">Repeat review</button><button class="btn btn-secondary" data-rp-filter="WARNING">Subject warnings</button><button class="btn btn-secondary" data-rp-filter="ALL">All pupils</button></div><div id="rpRows" class="policy-list"></div>`;
      const renderRows=filter=>{let rows=d.rows;if(filter==='REVIEW')rows=rows.filter(r=>r.repeatStatus==='REVIEW');if(filter==='WARNING')rows=rows.filter(r=>r.belowPassMark.length);byId('rpRows').innerHTML=rows.length?rows.map(r=>`<article class="policy-row"><div><b>${esc(r.pupilName)}</b><small>${esc(r.className)}</small></div><div><b>${r.passedSubjects}/${r.requiredSubjects}</b><span>subjects passed</span></div><div><span class="pill ${r.repeatStatus==='REVIEW'?'pill-red':r.repeatStatus==='CLEAR'?'pill-green':'pill-orange'}">${r.repeatStatus==='REVIEW'?'Review':r.repeatStatus==='CLEAR'?'Clear':'Pending'}</span>${r.belowPassMark.length?`<small>${esc(r.belowPassMark.map(x=>`${x.subjectName} ${x.mark}%`).join(' • '))}</small>`:''}</div></article>`).join(''):'<div class="empty">No pupils in this filter.</div>'};renderRows('REVIEW');document.querySelectorAll('[data-rp-filter]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-rp-filter]').forEach(x=>x.classList.remove('active'));b.classList.add('active');renderRows(b.dataset.rpFilter)});
      byId('policyForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/repeat-policy',{method:'POST',body:{assessmentId:d.assessment.id,passMark:Number(byId('rpPass').value),minPassSubjects:Number(byId('rpMin').value)}});toast('Repeat policy saved');await load()}catch(err){toast(err.message,true)}};
    };byId('rpAssessment').onchange=load;await load();
  }

  async function renderAdmin(content) {
    const [d,storage]=await Promise.all([api('/api/admin/setup'),api('/api/admin/storage-status')]); const teachers=d.users.filter(u=>(u.roles||[]).includes('TEACHER'));
    const classStaffing=d.classes.map(c=>{
      const rows=d.teachingAssignments.filter(a=>a.classId===c.id);
      const groups=new Map();
      rows.forEach(a=>{const key=a.teacherUserId;const g=groups.get(key)||{teacherId:key,teacherName:a.teacherName||'Teacher',subjects:[]};g.subjects.push(a.subjectName);groups.set(key,g)});
      const classTeacher=d.users.find(u=>u.id===c.classTeacherUserId);
      const teachersHere=[...groups.values()];
      const expectedTeachers=rows.length;
      return {class:c,classTeacher,teachers:teachersHere,teacherCount:teachersHere.length,expectedTeachers,complete:rows.length>0&&!!classTeacher};
    });
    const fullStaffed=classStaffing.filter(x=>x.complete).length;
    const classTeachersAssigned=classStaffing.filter(x=>!!x.classTeacher).length;
    const teachingStaffWithLoad=teachers.filter(t=>d.teachingAssignments.some(a=>a.teacherUserId===t.id)).length;
    content.innerHTML=`<div class="admin-hero"><div><span class="eyebrow">ADMIN CONTROL CENTRE</span><h2>Configure the school once</h2><p>The administrator creates the structure and officially assigns each class teacher. EduSend recognizes that role immediately.</p></div><button id="backupBtn" class="btn btn-gold">Download data backup</button></div>
    <div class="storage-safety-card ${storage.productionReady?'protected':'warning'}"><div><span class="eyebrow">DATA SAFETY</span><h3>${storage.productionReady?'PostgreSQL storage protected':'Temporary local storage'}</h3><p>${storage.productionReady?'School data is being saved in PostgreSQL and survives app redeploys/restarts.':'DATABASE_URL is not connected yet. Do not use this mode for permanent school records.'}</p><small>Revision ${storage.revision||0} • Last saved ${storage.lastSavedAt?fmtDate(storage.lastSavedAt):'Not yet'}${storage.entityCount?` • ${storage.entityCount} database records`:''}${storage.snapshotCount?` • ${storage.snapshotCount} recovery snapshots`:''}</small></div><div class="storage-actions"><label class="btn btn-secondary file-btn">Choose backup<input id="restoreBackupFile" type="file" accept="application/json,.json" hidden></label><button id="restoreBackupBtn" class="btn btn-secondary">Restore backup</button></div></div>
    <div class="demo-loader-card"><div><span class="eyebrow">ORIENTATION MODE</span><h3>Lumezi practice school</h3><p>Load 2 classes, 10 fictional pupils, 10 staff and five subjects per class so you can practise the complete workflow quickly.</p></div><button id="loadDemoBtn" class="btn btn-primary">${d.school.demoMode?'Reset practice school':'Load practice school'}</button></div>
    ${d.school.demoMode?`<div class="practice-results-card"><div><span class="eyebrow">FAST TESTING</span><h3>Generate practice results automatically</h3><p>You do not need to type every mark. Create a mixed school scenario, submit every subject instantly, or clear only the practice results and start again. These tools never change staff, classes or pupils.</p></div><div class="practice-result-actions"><button id="practiceMixedBtn" class="btn btn-secondary">Create mixed scenario</button><button id="practiceSubmitAllBtn" class="btn btn-green">Submit all practice results</button><button id="practiceClearBtn" class="btn btn-danger-soft">Clear practice results</button></div></div>`:''}
    <div class="grid grid-4 staffing-health">
      <div class="card"><div class="stat">${d.classes.length}</div><div class="stat-label">Practice classes</div></div>
      <div class="card"><div class="stat">${fullStaffed}/${d.classes.length}</div><div class="stat-label">Classes fully staffed</div></div>
      <div class="card"><div class="stat">${classTeachersAssigned}/${d.classes.length}</div><div class="stat-label">Class teachers assigned</div></div>
      <div class="card"><div class="stat">${teachingStaffWithLoad}/${teachers.length}</div><div class="stat-label">Teaching staff with subjects</div></div>
    </div>
    <div class="card space-top"><div class="section-title"><div><span class="eyebrow">CLASS STAFFING MATRIX</span><h3 style="margin-top:4px">Every class, every teacher, every subject</h3></div><span class="pill ${fullStaffed===d.classes.length&&classTeachersAssigned===d.classes.length?'pill-green':'pill-orange'}">${fullStaffed===d.classes.length&&classTeachersAssigned===d.classes.length?'Complete':'Needs attention'}</span></div><p class="small muted">This training school is deliberately small: five subject allocations per class and one class teacher, so the whole results-to-parent workflow is easy to test.</p><div class="staffing-matrix">${classStaffing.map(x=>`<article class="staffing-class ${x.complete?'complete':'incomplete'}"><div class="staffing-class-head"><div><b>${esc(x.class.name)}</b><small>${esc(x.class.level)}</small></div><span class="pill ${x.teacherCount===x.expectedTeachers?'pill-green':'pill-red'}">${x.teacherCount}/${x.expectedTeachers} teachers</span></div><div class="ct-line"><b>Class teacher:</b> ${x.classTeacher?esc(x.classTeacher.name):'<span class="danger-text">Not assigned</span>'}</div><div class="staff-list">${x.teachers.map(t=>`<div><b>${esc(t.teacherName)}</b><span>${t.subjects.map(esc).join(' + ')}</span></div>`).join('')}</div></article>`).join('')}</div></div>
    <div class="admin-grid">
      <div class="card"><h3>Add staff account</h3><form id="addUserForm" class="stack"><input id="newName" placeholder="Full name" required><input id="newUsername" placeholder="Username" required><input id="newPhone" placeholder="Phone (optional)"><input id="newPassword" value="change123" required><select id="newDept"><option value="">No department</option>${d.departments.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select><select id="newRole"><option value="TEACHER">Teacher</option><option value="HOD_TEACHER">HOD + Teacher</option><option value="HEAD">Head Teacher</option></select><button class="btn btn-primary">Create staff account</button></form></div>
      <div class="card"><h3>Create department / subject</h3><form id="deptForm" class="inline-form"><input id="deptName" placeholder="Department name"><button class="btn btn-secondary">Add department</button></form><hr><form id="subjectForm" class="stack"><input id="subjectName" placeholder="Subject name"><select id="subjectDept">${d.departments.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select><button class="btn btn-primary">Add subject</button></form></div>
      <div class="card"><h3>Create class</h3><form id="classForm" class="stack"><input id="className" placeholder="e.g. 10P" required><input id="classLevel" placeholder="e.g. Grade 10 / Form 1"><select id="classGrading"><option value="CBC">CBC Grades 1–5</option><option value="LEGACY">Legacy Grades 1–9</option></select><button class="btn btn-primary">Create class</button></form></div>
      <div class="card class-teacher-explainer"><span class="eyebrow">WHO ASSIGNS CLASS TEACHERS?</span><h3>Administrator</h3><p>The administrator selects a teacher for each class below. The teacher immediately gains <b>Class Progress</b> and <b>Reports</b> access for that class. Reassignment is also controlled here.</p><button class="btn btn-secondary" data-jump-ct>Open assignment centre ↓</button></div>
      <div class="card"><h3>Create assessment & deadline</h3><form id="assessmentForm" class="stack"><input id="assessName" placeholder="Assessment name" required><input id="assessTerm" placeholder="Term"><input id="assessYear" type="number" value="${new Date().getFullYear()}"><input id="assessDue" type="datetime-local" required><label>Classes <small>(leave none selected for all classes)</small></label><select id="assessClasses" multiple size="6">${d.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><div class="two-cols"><label>Pass mark<input id="assessPassMark" type="number" value="50" min="0" max="100"></label><label>Min. subjects passed<input id="assessMinSubjects" type="number" value="5" min="1" max="20"></label></div><button class="btn btn-primary">Create assessment</button></form></div>
      <div class="card"><h3>Add pupil</h3><form id="pupilForm" class="stack"><select id="pupilClass">${d.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><input id="pupilName" placeholder="Pupil name" required><div class="two-cols"><select id="pupilSex"><option value="">Sex</option><option value="M">Male</option><option value="F">Female</option></select><input id="pupilExam" placeholder="Exam number"></div><input id="pupilParent" placeholder="Parent/guardian phone"><label>Subjects taken</label><select id="pupilSubjects" multiple size="6">${d.subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select><label class="check-row"><input id="pupilRepeater" type="checkbox"> Repeater</label><button class="btn btn-primary">Add pupil</button></form></div>
      <div class="card"><h3>Import pupils from CSV</h3><p class="tiny muted">Columns: name, sex, examNo, parentPrimary, isRepeater</p><select id="csvClass">${d.classes.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><input id="csvFile" type="file" accept=".csv,text/csv"><button id="importCsv" class="btn btn-secondary full">Import CSV</button></div>
      <div class="card"><h3>School details</h3><form id="schoolForm" class="stack"><input id="schoolName" value="${esc(d.school.name||'')}" placeholder="School name"><input id="schoolMotto" value="${esc(d.school.motto||'')}" placeholder="Motto"><input id="schoolAddress" value="${esc(d.school.address||'')}" placeholder="Address"><input id="schoolEmail" value="${esc(d.school.email||'')}" placeholder="Email"><button class="btn btn-secondary">Save school details</button></form></div>
    </div>
    <div id="classTeacherCentre" class="card space-top"><div class="section-title"><div><span class="eyebrow">CLASS TEACHER ASSIGNMENT CENTRE</span><h3 style="margin-top:4px">One official class teacher per class</h3></div><span class="pill pill-blue">Administrator controlled</span></div><p class="small muted">Choose a teacher and press Assign / Change. EduSend updates the teacher's permissions automatically and sends a notification.</p><div class="table-wrap"><table class="table"><thead><tr><th>Class</th><th>Level</th><th>Current class teacher</th><th>Assign / change to</th><th></th></tr></thead><tbody>${d.classes.map(c=>{const t=d.users.find(u=>u.id===c.classTeacherUserId);return `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.level)}</td><td>${t?`<span class="pill pill-green">${esc(t.name)}</span>`:'<span class="pill pill-orange">Not assigned</span>'}</td><td><select id="ctPick_${c.id}"><option value="">— Not assigned —</option>${teachers.map(x=>`<option value="${x.id}" ${x.id===c.classTeacherUserId?'selected':''}>${esc(x.name)}</option>`).join('')}</select></td><td><button class="btn btn-secondary" data-set-ct="${c.id}">${t?'Change':'Assign'}</button></td></tr>`}).join('')}</tbody></table></div></div>
    <div class="card space-top"><div class="section-title"><div><span class="eyebrow">STAFF & TEACHING LOAD</span><h3 style="margin-top:4px">Practice teacher directory</h3></div><span class="pill pill-blue">${teachers.length} teachers</span></div><p class="small muted">The training school is deliberately small. The same teacher may teach both classes, just as in a real timetable. All practice accounts use PIN <b>1234</b>.</p><div class="table-wrap"><table class="table"><thead><tr><th>Teacher</th><th>Username</th><th>Department</th><th>Teaching load</th><th>Class teacher of</th></tr></thead><tbody>${teachers.map(t=>{const loads=d.teachingAssignments.filter(a=>a.teacherUserId===t.id);const cls=d.classes.filter(c=>c.classTeacherUserId===t.id).map(c=>c.name);const dep=d.departments.find(x=>x.id===t.departmentId);return `<tr><td><b>${esc(t.name)}</b></td><td><code>${esc(t.username)}</code></td><td>${esc(dep?.name||'Multi-department')}</td><td>${loads.length?loads.map(a=>`${esc(a.className)} ${esc(a.subjectName)}`).join('<br>'):'—'}</td><td>${cls.length?esc(cls.join(', ')):'—'}</td></tr>`}).join('')}</tbody></table></div></div><div class="card space-top"><h3>Classes</h3><div class="table-wrap"><table class="table"><thead><tr><th>Class</th><th>Level</th><th>Grading</th><th>Class teacher</th></tr></thead><tbody>${d.classes.map(c=>{const t=d.users.find(u=>u.id===c.classTeacherUserId);return `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.level)}</td><td>${esc(c.gradingSystem)}</td><td>${esc(t?.name||'Not assigned')}</td></tr>`}).join('')}</tbody></table></div></div>`;
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
      const first = confirm('This will replace the current EduSend data with the realistic source-schedule training subset. A server-side backup will be attempted first. Continue?');
      if (!first) return;
      const phrase = prompt('Type LOAD SOURCE PRACTICE to confirm:');
      if (phrase !== 'LOAD SOURCE PRACTICE') { toast('Practice school was not loaded.', true); return; }
      const btn = byId('loadDemoBtn'); btn.disabled = true; btn.textContent = 'Loading source-schedule practice…';
      try {
        const r = await api('/api/admin/load-practice-demo', { method:'POST', body:{confirm:phrase} });
        if (r.token) { state.token = r.token; localStorage.setItem('edusend_token', r.token); }
        toast(`${r.summary.classes} classes and ${r.summary.pupils} pupils loaded`);
        await bootstrap();
        await navigate('practice');
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Load practice school'; }
    };
    const runPracticeResults = async (action) => {
      const labels = {MIXED:'create a mixed testing scenario',SUBMIT_ALL:'generate and submit all practice results',CLEAR:'clear all practice results'};
      if (!confirm(`Do you want to ${labels[action]}?`)) return;
      const ids = ['practiceMixedBtn','practiceSubmitAllBtn','practiceClearBtn']; ids.forEach(id=>{const b=byId(id);if(b)b.disabled=true});
      try {
        const r = await api('/api/admin/practice-results',{method:'POST',body:{action,assessmentId:firstAssessmentId()}});
        const msg = action==='CLEAR' ? `Practice results cleared. ${r.notStarted} sheets are ready for fresh testing.` : `${r.submitted} submitted • ${r.draft} draft • ${r.notStarted} not started.`;
        actionPopup(action==='SUBMIT_ALL'?'All practice results submitted':action==='MIXED'?'Mixed practice scenario created':'Practice results cleared', msg);
        await renderAdmin(content);
      } catch(e) { actionPopup('Practice result tool failed',e.message,'error'); ids.forEach(id=>{const b=byId(id);if(b)b.disabled=false}); }
    };
    if (byId('practiceMixedBtn')) byId('practiceMixedBtn').onclick=()=>runPracticeResults('MIXED');
    if (byId('practiceSubmitAllBtn')) byId('practiceSubmitAllBtn').onclick=()=>runPracticeResults('SUBMIT_ALL');
    if (byId('practiceClearBtn')) byId('practiceClearBtn').onclick=()=>runPracticeResults('CLEAR');
    byId('addUserForm').onsubmit=async e=>{e.preventDefault();const r=byId('newRole').value;try{await api('/api/admin/user',{method:'POST',body:{name:byId('newName').value,username:byId('newUsername').value,phone:byId('newPhone').value,password:byId('newPassword').value,departmentId:byId('newDept').value||null,roles:r==='HOD_TEACHER'?['HOD','TEACHER']:[r]}});toast('Staff account created');await renderAdmin(content)}catch(err){toast(err.message,true)}};
    byId('deptForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/department',{method:'POST',body:{name:byId('deptName').value}});toast('Department created');await renderAdmin(content)}catch(err){toast(err.message,true)}};
    byId('subjectForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/subject',{method:'POST',body:{name:byId('subjectName').value,departmentId:byId('subjectDept').value}});toast('Subject created');await renderAdmin(content)}catch(err){toast(err.message,true)}};
    byId('classForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/class',{method:'POST',body:{name:byId('className').value,level:byId('classLevel').value,gradingSystem:byId('classGrading').value}});toast('Class created');await renderAdmin(content)}catch(err){toast(err.message,true)}};
    byId('assessmentForm').onsubmit=async e=>{e.preventDefault();try{const due=new Date(byId('assessDue').value).toISOString();const classIds=[...byId('assessClasses').selectedOptions].map(o=>o.value);await api('/api/admin/assessment',{method:'POST',body:{name:byId('assessName').value,term:byId('assessTerm').value,year:byId('assessYear').value,dueAt:due,classIds,passMark:Number(byId('assessPassMark').value),minPassSubjects:Number(byId('assessMinSubjects').value)}});toast('Assessment created');const a=await api('/api/assessments');state.assessments=a.assessments;await renderAdmin(content)}catch(err){toast(err.message,true)}};
    byId('pupilForm').onsubmit=async e=>{e.preventDefault();try{const subjectIds=[...byId('pupilSubjects').selectedOptions].map(o=>o.value);await api('/api/admin/pupil',{method:'POST',body:{classId:byId('pupilClass').value,name:byId('pupilName').value,sex:byId('pupilSex').value,examNo:byId('pupilExam').value,parentPrimary:byId('pupilParent').value,isRepeater:byId('pupilRepeater').checked,subjectIds}});toast('Pupil added');byId('pupilName').value='';}catch(err){toast(err.message,true)}};
    byId('schoolForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/school',{method:'POST',body:{name:byId('schoolName').value,motto:byId('schoolMotto').value,address:byId('schoolAddress').value,email:byId('schoolEmail').value}});toast('School details saved');await bootstrap()}catch(err){toast(err.message,true)}};
    byId('importCsv').onclick=()=>importCsvPupils();
    byId('backupBtn').onclick=async()=>{try{const x=await api('/api/admin/backup');const blob=new Blob([JSON.stringify(x,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`EduSend_Backup_${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);toast('Backup downloaded')}catch(e){toast(e.message,true)}};
    byId('restoreBackupBtn').onclick=async()=>{const f=byId('restoreBackupFile')?.files?.[0];if(!f){toast('Choose an EduSend JSON backup first',true);return}if(!confirm('Restore this backup into the school database? Current data will be replaced by the backup contents.'))return;const phrase=prompt('Type RESTORE BACKUP to continue:','');if(phrase!=='RESTORE BACKUP'){toast('Restore cancelled',true);return}try{const parsed=JSON.parse(await f.text());const r=await api('/api/admin/restore-backup',{method:'POST',body:{confirm:phrase,data:parsed}});actionPopup('Backup restored',`Database revision ${r.storage?.revision||''} saved successfully.`);await bootstrap()}catch(e){actionPopup('Restore failed',e.message,'error')}};
  }

  async function importCsvPupils(){const f=byId('csvFile').files?.[0];if(!f){toast('Choose a CSV file first',true);return}const text=await f.text();const lines=text.split(/\r?\n/).filter(Boolean);if(lines.length<2){toast('CSV has no pupil rows',true);return}const headers=lines[0].split(',').map(x=>x.trim());const rows=lines.slice(1).map(line=>{const vals=line.split(',').map(x=>x.trim().replace(/^"|"$/g,''));const o={};headers.forEach((h,i)=>o[h]=vals[i]||'');return o});try{const r=await api('/api/admin/pupils-bulk',{method:'POST',body:{classId:byId('csvClass').value,pupils:rows}});toast(`${r.count} pupils imported`)}catch(e){toast(e.message,true)}}

  async function renderSchoolProgress(content){
    if(!state.assessments.length){content.innerHTML='<div class="empty">No assessment.</div>';return;}
    content.innerHTML=`<div class="toolbar premium-toolbar"><select id="schoolAssess">${state.assessments.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select><button id="schoolRefresh" class="btn btn-secondary">Refresh</button></div><div id="schoolProgressBody"></div>`;
    const load=async(options={})=>{const silent=!!options.silent;const previousScroll=window.scrollY;const assessmentId=byId('schoolAssess')?.value;if(!assessmentId)return;const d=await api(`/api/school/progress?assessmentId=${encodeURIComponent(assessmentId)}`);const done=d.rows.filter(r=>['SUBMITTED','LOCKED','CORRECTION_REQUESTED'].includes(r.status)).length;const overdue=d.rows.filter(r=>r.deadline.code==='OVERDUE').length;const body=byId('schoolProgressBody');if(!body)return;body.innerHTML=`<div class="grid grid-3"><div class="card"><div class="stat">${done}/${d.rows.length}</div><div class="stat-label">School sheets received</div></div><div class="card"><div class="stat">${overdue}</div><div class="stat-label">Overdue</div></div><div class="card"><div class="stat">${d.classes.filter(c=>c.readiness.finalReady).length}/${d.classes.length}</div><div class="stat-label">Classes report-ready</div></div></div><div class="class-readiness-grid space-top">${d.classes.map(x=>`<div class="card"><b>${esc(x.class.name)}</b><div class="progressbar"><span style="width:${x.readiness.totalSubjects?Math.round(x.readiness.submittedSubjects/x.readiness.totalSubjects*100):0}%"></span></div><small>${x.readiness.submittedSubjects}/${x.readiness.totalSubjects} subjects • ${x.readiness.finalReady?'Ready':x.readiness.provisionalAllowed?'Provisional approved':'Waiting'}</small></div>`).join('')}</div><div class="table-wrap space-top"><table class="table"><thead><tr><th>Department</th><th>Class</th><th>Subject</th><th>Teacher</th><th>Status</th><th>Deadline</th><th></th></tr></thead><tbody>${d.rows.map(r=>{const visible=['SUBMITTED','LOCKED','CORRECTION_REQUESTED'].includes(r.status);return `<tr><td>${esc(r.departmentName)}</td><td>${esc(r.className)}</td><td><b>${esc(r.subjectName)}</b></td><td>${esc(r.teacherName)}</td><td>${statusPill(r.status,r.deadline)}</td><td>${fmtDate(r.deadline.dueAt)}</td><td>${visible?`<button class="action-link" data-view-admin="${r.id}">View marks</button>`:'—'}</td></tr>`}).join('')}</tbody></table></div>`;body.querySelectorAll('[data-view-admin]').forEach(b=>b.onclick=()=>openReadOnlyResults(b.dataset.viewAdmin,assessmentId));if(silent)requestAnimationFrame(()=>window.scrollTo({top:previousScroll,left:0,behavior:'auto'}));};
    byId('schoolAssess').onchange=()=>load();byId('schoolRefresh').onclick=()=>load();await load();
    state.backgroundRefresh=()=>load({silent:true});
  }


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
      const resultChanged=d.type==='RESULT_SHEET_UPDATED';
      const escalationChanged=d.type==='ESCALATION_UPDATED';
      if((resultChanged||escalationChanged) && typeof state.backgroundRefresh==='function') state.backgroundRefresh().catch?.(()=>{});
    });
    // Quiet safety refresh. It never shows a loading card, never changes page, and preserves scroll position.
    state.refreshTimer=setInterval(()=>{if(typeof state.backgroundRefresh==='function')state.backgroundRefresh().catch?.(()=>{})},90000);
    state.notificationTimer=setInterval(refreshNotifications,45000);
  }
  function disconnectEvents(){if(state.eventSource){state.eventSource.close();state.eventSource=null}if(state.refreshTimer){clearInterval(state.refreshTimer);state.refreshTimer=null}if(state.notificationTimer){clearInterval(state.notificationTimer);state.notificationTimer=null}}

  window.addEventListener('pagehide', syncActiveDraftOnHide);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')syncActiveDraftOnHide();});

  if(state.token) bootstrap(); else renderLogin();
})();
