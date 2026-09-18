'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const APP_VERSION = '2.3.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.EDUSEND_DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const DATA_BACKUP_FILE = path.join(DATA_DIR, 'data.json.bak');
const PUPIL_SEED_FILE = path.join(DATA_DIR, 'pupils12l.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'DEV_ONLY_CHANGE_ME_edusend_v2';
const TOKEN_TTL_SECONDS = 60 * 60 * 12;

fs.mkdirSync(DATA_DIR, { recursive: true });

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function nowIso() { return new Date().toISOString(); }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return expected.length === test.length && crypto.timingSafeEqual(expected, test);
  } catch { return false; }
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function issueToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ userId, iat: now, exp: now + TOKEN_TTL_SECONDS });
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  try {
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function safeUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

function hasRole(user, role) {
  return !!user && Array.isArray(user.roles) && user.roles.includes(role);
}

function belongsToDepartment(user, departmentId) {
  if (!user || !departmentId) return false;
  if (user.departmentId === departmentId) return true;
  return Array.isArray(user.departmentIds) && user.departmentIds.includes(departmentId);
}

function isAdminOrHead(user) { return hasRole(user, 'ADMIN') || hasRole(user, 'HEAD'); }

function loadPupilsSeed() {
  try {
    const raw = JSON.parse(fs.readFileSync(PUPIL_SEED_FILE, 'utf8'));
    return raw.map((p, idx) => ({
      id: p.id || `12l-${String(idx + 1).padStart(3, '0')}`,
      classId: 'class_12l',
      name: p.name || '',
      sex: p.sex || '',
      examNo: p.examNo || '',
      parentPrimary: p.parentWhatsapp || p.parentPhone || '',
      parentAltPhones: Array.from(new Set([
        ...(p.parentPhone && p.parentPhone !== p.parentWhatsapp ? [p.parentPhone] : []),
        ...(Array.isArray(p.parentAltPhones) ? p.parentAltPhones : [])
      ].filter(Boolean))),
      isRepeater: false,
      active: true,
      importedScores: p.scores || {}
    }));
  } catch { return []; }
}

function makePracticeSchoolData() {
  const users = [];
  const addUser = (fixedId, name, username, password, roles, departmentId = null, phone = '') => {
    const u = { id: fixedId, name, username: username.toLowerCase(), passwordHash: hashPassword(password), roles, departmentId, departmentIds: departmentId ? [departmentId] : [], phone, active: true };
    users.push(u); return u;
  };

  const departments = [
    { id: 'dept_languages', name: 'Languages', hodUserId: null },
    { id: 'dept_science', name: 'Mathematics & Natural Sciences', hodUserId: null },
    { id: 'dept_social', name: 'Social Sciences', hodUserId: null },
    { id: 'dept_business', name: 'Business & Technology', hodUserId: null },
    { id: 'dept_home', name: 'Home Economics & Creative Studies', hodUserId: null }
  ];
  const dept = Object.fromEntries(departments.map(d => [d.id, d]));

  const admin = addUser('usr_admin_demo', 'School Administrator', 'admin', 'admin123', ['ADMIN']);
  addUser('usr_head_demo', 'Mr B. Kasaro — Head Teacher', 'head', 'head123', ['HEAD']);
  addUser('usr_deputy_demo', 'Ms L. Musonda — Deputy Head Teacher', 'deputy', 'deputy123', ['HEAD']);

  const hodLanguages = addUser('usr_hod_languages', 'Ms R. Nyirenda — HOD Languages', 'hod.languages', 'hod123', ['HOD','TEACHER'], 'dept_languages');
  const hodScience = addUser('usr_hod_science', 'Mr J. Nkhoma — HOD Mathematics & Natural Sciences', 'hod.science', 'hod123', ['HOD','TEACHER'], 'dept_science');
  const hodSocial = addUser('usr_hod_social', 'Ms M. Mulenga — HOD Social Sciences', 'hod.social', 'hod123', ['HOD','TEACHER'], 'dept_social');
  const hodBusiness = addUser('usr_hod_business', 'Mr P. Mwansa — HOD Business & Technology', 'hod.business', 'hod123', ['HOD','TEACHER'], 'dept_business');
  const hodHome = addUser('usr_hod_home', 'Ms T. Chileshe — HOD Home Economics', 'hod.home', 'hod123', ['HOD','TEACHER'], 'dept_home');
  dept.dept_languages.hodUserId = hodLanguages.id;
  dept.dept_science.hodUserId = hodScience.id;
  dept.dept_social.hodUserId = hodSocial.id;
  dept.dept_business.hodUserId = hodBusiness.id;
  dept.dept_home.hodUserId = hodHome.id;

  // Expanded practice teacher roster. The same teacher may teach several classes,
  // but every class is deliberately given nine distinct teachers for orientation practice.
  const teacherRows = [
    ['usr_tembo_english','Ms Ruth Tembo','tembo.english','dept_languages'],
    ['usr_nyirenda_english','Mr James Nyirenda','nyirenda.english','dept_languages'],
    ['usr_chileshe_english','Ms Linda Chileshe','chileshe.english','dept_languages'],

    ['usr_phiri_math','Mr Daniel Phiri','phiri.math','dept_science'],
    ['usr_mwanza_math','Ms Ruth Mwanza','mwanza.math','dept_science'],
    ['usr_banda_math','Mr Kelvin Banda','banda.math','dept_science'],

    ['usr_sakala_ict','Ms Memory Sakala','sakala.ict','dept_business'],
    ['usr_mulenga_ict','Mr Simon Mulenga','mulenga.ict','dept_business'],
    ['usr_zulu_ict','Ms Brenda Zulu','zulu.ict','dept_business'],

    ['usr_mbewe_civic','Mr Joseph Mbewe','mbewe.civic','dept_social'],
    ['usr_chanda_civic','Ms Agnes Chanda','chanda.civic','dept_social'],
    ['usr_lungu_civic','Mr Victor Lungu','lungu.civic','dept_social'],

    ['usr_zulu_geo','Ms Patricia Zulu','zulu.geography','dept_social'],
    ['usr_musonda_geo','Mr Isaac Musonda','musonda.geography','dept_social'],
    ['usr_mwale_geo','Ms Grace Mwale','mwale.geography','dept_social'],

    ['usr_lungu_re','Mr Peter Lungu','lungu.re','dept_social'],
    ['usr_nkandu_re','Ms Theresa Nkandu','nkandu.re','dept_social'],
    ['usr_phiri_re','Mr Paul Phiri','phiri.re','dept_social'],

    ['usr_chanda_commerce','Ms Esther Chanda','chanda.commerce','dept_business'],
    ['usr_mwansa_commerce','Mr Brian Mwansa','mwansa.commerce','dept_business'],
    ['usr_kalaba_commerce','Ms Joyce Kalaba','kalaba.commerce','dept_business'],

    ['usr_mwale_accounts','Mr Kelvin Mwale','mwale.accounts','dept_business'],
    ['usr_daka_accounts','Ms Alice Daka','daka.accounts','dept_business'],
    ['usr_mwewa_accounts','Mr Nathan Mwewa','mwewa.accounts','dept_business'],

    ['usr_banda_biology','Ms Grace Banda','banda.biology','dept_science'],
    ['usr_njobvu_biology','Mr Moses Njobvu','njobvu.biology','dept_science'],
    ['usr_kunda_biology','Ms Faith Kunda','kunda.biology','dept_science'],

    ['usr_kamanga','Mr Kamanga P','kamanga','dept_science'],
    ['usr_mumba_physics','Mr Felix Mumba','mumba.physics','dept_science'],
    ['usr_chisala_physics','Ms Violet Chisala','chisala.physics','dept_science'],
    ['usr_siame_physics','Mr Andrew Siame','siame.physics','dept_science'],

    ['usr_mulenga_biohome','Ms Beatrice Mulenga','mulenga.biohome','dept_home',['dept_home','dept_science']],
    ['usr_chola_biohome','Mr Samuel Chola','chola.biohome','dept_home',['dept_home','dept_science']],
    ['usr_nkhoma_dtphysics','Mr Andrew Nkhoma','nkhoma.dtphysics','dept_business',['dept_business','dept_science']],
    ['usr_kabwe_dtphysics','Ms Wendy Kabwe','kabwe.dtphysics','dept_business',['dept_business','dept_science']]
  ];
  const teacherByUsername = {};
  for (const row of teacherRows) {
    const [uid,name,username,departmentId,departmentIds] = row;
    const u = addUser(uid,name,username,'teach123',['TEACHER'],departmentId, username==='kamanga'?'0973296462':'');
    if (Array.isArray(departmentIds)) u.departmentIds = [...new Set(departmentIds)];
    teacherByUsername[username] = u;
  }
  // Mr Kamanga is used for both D&T/Physics in 1L practice so the class still has nine distinct teachers.
  if (teacherByUsername.kamanga) teacherByUsername.kamanga.departmentIds = ['dept_science','dept_business'];

  // 16 practice classes. The repeated "11N" from the spoken example is treated as 11L for the fourth Grade 11 stream.
  const classDefs = [
    ['class_1l','1L','Form 1','CBC'], ['class_1m','1M','Form 1','CBC'],
    ['class_2l','2L','Form 2','CBC'], ['class_2m','2M','Form 2','CBC'],
    ['class_10n','10N','Grade 10','LEGACY'], ['class_10m','10M','Grade 10','LEGACY'], ['class_10p','10P','Grade 10','LEGACY'], ['class_10l','10L','Grade 10','LEGACY'],
    ['class_11m','11M','Grade 11','LEGACY'], ['class_11n','11N','Grade 11','LEGACY'], ['class_11p','11P','Grade 11','LEGACY'], ['class_11l','11L','Grade 11','LEGACY'],
    ['class_12m','12M','Grade 12','LEGACY'], ['class_12n','12N','Grade 12','LEGACY'], ['class_12p','12P','Grade 12','LEGACY'], ['class_12l','12L','Grade 12','LEGACY']
  ];
  const classes = classDefs.map(([idv,name,level,gradingSystem]) => ({ id:idv, name, level, gradingSystem, classTeacherUserId:null, active:true }));

  // Exactly nine different teachers act as class teachers across the 16 streams.
  const classTeacherMap = {
    '1L':'tembo.english','1M':'banda.biology','2L':'phiri.math','2M':'zulu.geography',
    '10N':'kamanga','10M':'mbewe.civic','10P':'lungu.re','10L':'chanda.commerce',
    '11M':'mwale.accounts','11N':'tembo.english','11P':'banda.biology','11L':'phiri.math',
    '12M':'zulu.geography','12N':'mbewe.civic','12P':'lungu.re','12L':'chanda.commerce'
  };
  for (const c of classes) c.classTeacherUserId = teacherByUsername[classTeacherMap[c.name]]?.id || null;

  const subjects = [
    {id:'sub_english',name:'English',departmentId:'dept_languages',active:true},
    {id:'sub_mathematics',name:'Mathematics',departmentId:'dept_science',active:true},
    {id:'sub_ict',name:'ICT',departmentId:'dept_business',active:true},
    {id:'sub_civic',name:'Civic Education',departmentId:'dept_social',active:true},
    {id:'sub_geography',name:'Geography',departmentId:'dept_social',active:true},
    {id:'sub_re',name:'Religious Education',departmentId:'dept_social',active:true},
    {id:'sub_commerce',name:'Commerce',departmentId:'dept_business',active:true},
    {id:'sub_biology',name:'Biology',departmentId:'dept_science',active:true},
    {id:'sub_home',name:'Home Economics',departmentId:'dept_home',active:true},
    {id:'sub_dt',name:'Design & Technology',departmentId:'dept_business',active:true},
    {id:'sub_physics',name:'Physics',departmentId:'dept_science',active:true},
    {id:'sub_accounts',name:'Accounts',departmentId:'dept_business',active:true}
  ];
  const subjectById = Object.fromEntries(subjects.map(s => [s.id,s]));

  // Form 1/2: 7 common subjects + one of two 2-subject pathways = 9 subjects per pupil.
  const lowerCommon = ['sub_english','sub_mathematics','sub_ict','sub_civic','sub_geography','sub_re','sub_commerce'];
  const bioTrack = ['sub_biology','sub_home'];
  const dtTrack = ['sub_dt','sub_physics'];
  // Grade 10–12: nine practice subjects per pupil.
  const upperNine = ['sub_english','sub_mathematics','sub_physics','sub_biology','sub_geography','sub_civic','sub_commerce','sub_accounts','sub_ict'];

  const firstMale = ['Aaron','Abel','Andrew','Brian','Chanda','Chisala','Dalitso','David','Emmanuel','Felix','Gift','Isaac','Jackson','Kelvin','Moses','Mumba','Mwansa','Mwewa','Nathan','Patrick','Paul','Peter','Richard','Samuel','Simon','Thabo','Victor','William','Wisdom','Yoram'];
  const firstFemale = ['Agness','Alice','Beatrice','Brenda','Bwalya','Chipo','Chisomo','Edina','Esther','Faith','Grace','Hope','Joyce','Loveness','Mary','Mercy','Memory','Natasha','Patricia','Precious','Racheal','Rejoice','Ruth','Sibongile','Thandiwe','Theresa','Violet','Wendy','Yvonne','Zodwa'];
  const surnames = ['Banda','Bwalya','Chanda','Chileshe','Chirwa','Daka','Hamaimbo','Kalaba','Kunda','Lungu','Mbewe','Miti','Mkandawire','Moyo','Mpundu','Mulenga','Mumba','Mundia','Mwanza','Mwale','Nasilele','Ngoma','Ngulube','Njobvu','Nkandu','Nkhoma','Phiri','Sakala','Tembo','Zimba','Zulu','Chisanga','Kabwe','Musonda','Siame','Zulu','Soko','Mwanza','Nyirenda','Chola'];

  const pupils = [];
  classes.forEach((cls, classIndex) => {
    const lower = cls.level.startsWith('Form');
    for (let i=0;i<5;i++) {
      const sex = i % 2 === 0 ? 'M' : 'F';
      const first = sex === 'M' ? firstMale[(i/2 + classIndex*3) % firstMale.length | 0] : firstFemale[((i-1)/2 + classIndex*3) % firstFemale.length | 0];
      const surname = surnames[(i*7 + classIndex*5) % surnames.length];
      const track = lower ? (i < 3 ? 'BIOLOGY + HOME ECONOMICS' : 'DESIGN & TECHNOLOGY + PHYSICS') : 'STANDARD NINE';
      const subjectIds = lower ? [...lowerCommon, ...(i < 3 ? bioTrack : dtTrack)] : [...upperNine];
      pupils.push({
        id:`pupil_${cls.name.toLowerCase()}_${String(i+1).padStart(3,'0')}`,
        classId:cls.id,
        name:`${first} ${surname}`.toUpperCase(), sex,
        examNo:`${cls.name}-${String(i+1).padStart(3,'0')}`,
        parentPrimary:'', parentAltPhones:[],
        isRepeater: i > 0 && (i+1) % 20 === 0,
        subjectTrack:track, subjectIds, active:true
      });
    }
  });

  const teacherPools = {
    sub_english:['tembo.english','nyirenda.english','chileshe.english'],
    sub_mathematics:['phiri.math','mwanza.math','banda.math'],
    sub_ict:['sakala.ict','mulenga.ict','zulu.ict'],
    sub_civic:['mbewe.civic','chanda.civic','lungu.civic'],
    sub_geography:['zulu.geography','musonda.geography','mwale.geography'],
    sub_re:['lungu.re','nkandu.re','phiri.re'],
    sub_commerce:['chanda.commerce','mwansa.commerce','kalaba.commerce'],
    sub_biology:['banda.biology','njobvu.biology','kunda.biology'],
    sub_accounts:['mwale.accounts','daka.accounts','mwewa.accounts'],
    sub_physics:['mumba.physics','chisala.physics','siame.physics','kamanga']
  };
  const bioHomePool = ['mulenga.biohome','chola.biohome'];
  const dtPhysicsPool = ['nkhoma.dtphysics','kabwe.dtphysics'];
  const kamangaPhysicsClasses = new Set(['1L','10P','12L','12M']);
  const teachingAssignments = [];
  classes.forEach((cls, classIndex) => {
    const lower = cls.level.startsWith('Form');
    const addAssignment = (subjectId, username) => {
      const teacher = teacherByUsername[username];
      if (!teacher) throw new Error(`Practice teacher missing: ${username}`);
      teachingAssignments.push({ id:`ta_${cls.name.toLowerCase()}_${subjectId.replace('sub_','')}`, classId:cls.id, subjectId, teacherUserId:teacher.id, active:true });
    };

    if (lower) {
      // Seven common subject teachers.
      for (const subjectId of lowerCommon) {
        const pool = teacherPools[subjectId];
        addAssignment(subjectId, pool[classIndex % pool.length]);
      }
      // One teacher handles Biology + Home Economics; one teacher handles D&T + Physics.
      // This gives nine distinct teachers in the class while preserving both pupil option pathways.
      const bioHomeTeacher = bioHomePool[classIndex % bioHomePool.length];
      let dtPhysicsTeacher = dtPhysicsPool[classIndex % dtPhysicsPool.length];
      if (cls.name === '1L') dtPhysicsTeacher = 'kamanga';
      addAssignment('sub_biology', bioHomeTeacher);
      addAssignment('sub_home', bioHomeTeacher);
      addAssignment('sub_dt', dtPhysicsTeacher);
      addAssignment('sub_physics', dtPhysicsTeacher);
    } else {
      for (const subjectId of upperNine) {
        let username;
        if (subjectId === 'sub_physics' && kamangaPhysicsClasses.has(cls.name)) username = 'kamanga';
        else {
          const pool = teacherPools[subjectId];
          username = pool[classIndex % pool.length];
        }
        addAssignment(subjectId, username);
      }
    }
  });

  // Guard the demo seed itself: every practice class must resolve to exactly nine distinct teachers.
  for (const cls of classes) {
    const distinctTeachers = new Set(teachingAssignments.filter(a => a.classId === cls.id).map(a => a.teacherUserId));
    if (distinctTeachers.size !== 9) throw new Error(`Practice seed error: ${cls.name} has ${distinctTeachers.size} distinct teachers instead of 9.`);
  }

  const assessment = { id:'assess_practice_t3_2026', name:'Term 3 Practice Assessment 2026', term:'Term 3', year:2026, dueAt:'2026-09-25T16:00:00+02:00', active:true };
  const resultSheets = [];
  const notifications = [];
  const demoSubmitted = new Set(['12L|sub_english','12L|sub_mathematics','1L|sub_english','1L|sub_mathematics']);
  const demoDraft = new Set(['1L|sub_biology']);

  const demoMark = (pupilIndex, subjectIndex) => 42 + ((pupilIndex*7 + subjectIndex*11) % 49); // 42–90
  teachingAssignments.forEach((a, ai) => {
    const cls = classes.find(c => c.id === a.classId);
    const classPupils = pupils.filter(p => p.classId === cls.id);
    const key = `${cls.name}|${a.subjectId}`;
    const status = demoSubmitted.has(key) ? 'SUBMITTED' : demoDraft.has(key) ? 'DRAFT' : 'NOT_STARTED';
    const marks = {}; const markStates = {};
    classPupils.forEach((p, pi) => {
      const takes = p.subjectIds.includes(a.subjectId);
      if (!takes) { markStates[p.id] = 'NOT_TAKING'; return; }
      if (status === 'SUBMITTED') { marks[p.id] = demoMark(pi, ai); markStates[p.id] = 'PRESENT'; }
      else if (status === 'DRAFT' && pi < 3) { marks[p.id] = demoMark(pi, ai); markStates[p.id] = 'PRESENT'; }
      else markStates[p.id] = 'PENDING';
    });
    resultSheets.push({
      id:`sheet_${a.id}_${assessment.id}`, assignmentId:a.id, assessmentId:assessment.id,
      status, marks, markStates, deadlineOverride:null,
      updatedAt:status==='NOT_STARTED'?null:'2026-09-17T19:30:00+02:00', submittedAt:status==='SUBMITTED'?'2026-09-17T19:30:00+02:00':null,
      enteredByUserId:a.teacherUserId, source:'EduSend Lumezi practice data'
    });
    if (status === 'SUBMITTED') {
      const ct = cls.classTeacherUserId;
      if (ct) notifications.push({
        id:`note_seed_${a.id}`, userId:ct, type:'RESULT_SUBMITTED', title:`${subjectById[a.subjectId].name} results received`,
        message:`${users.find(u=>u.id===a.teacherUserId)?.name || 'Teacher'} submitted ${subjectById[a.subjectId].name} results for ${cls.name}.`,
        meta:{classId:cls.id,assignmentId:a.id,assessmentId:assessment.id}, createdAt:'2026-09-17T19:31:00+02:00', readAt:null
      });
    }
  });

  return {
    version: 2,
    school: {
      id:'school_1', name:'Lumezi Boarding Secondary School', motto:'EDUCATION WITH INTEGRITY AND VIRTUE',
      address:'P.O. Box 1, Lumezi', email:'lumeziboarding@edu.zm', demoMode:true,
      demoNote:'Practice data only — 16 classes, 80 fictional pupils, nine distinct teachers per class, 9-subject pupil programmes.'
    },
    users, departments, classes, subjects, assessments:[assessment], teachingAssignments, pupils, resultSheets,
    notifications, escalations:[], reportReleaseApprovals:[], reportSendLog:[],
    auditLog:[{id:id('audit'),at:nowIso(),actorUserId:admin.id,action:'PRACTICE_SCHOOL_CREATED',detail:'Lumezi practice school: 16 classes, 80 fictional pupils, nine distinct teachers per class'}]
  };
}

function makeSeedData() {
  return makePracticeSchoolData();
}

function migrateData(raw) {
  const db = raw && typeof raw === 'object' ? raw : makeSeedData();
  db.version = 2;
  db.school ||= { id: 'school_1', name: 'Lumezi Boarding Secondary School' };
  db.school.motto ||= 'EDUCATION WITH INTEGRITY AND VIRTUE';
  db.school.address ||= 'P.O. Box 1, Lumezi';
  db.school.email ||= 'lumeziboarding@edu.zm';
  db.users ||= []; db.departments ||= []; db.classes ||= []; db.subjects ||= [];
  db.assessments ||= []; db.teachingAssignments ||= []; db.pupils ||= []; db.resultSheets ||= [];
  db.notifications ||= []; db.escalations ||= []; db.reportReleaseApprovals ||= []; db.reportSendLog ||= []; db.auditLog ||= [];
  db.users.forEach(u => { if (u.phone === undefined) u.phone = ''; if (u.active === undefined) u.active = true; });
  db.classes.forEach(c => { c.gradingSystem = c.gradingSystem === 'CBC' ? 'CBC' : 'LEGACY'; if (c.active === undefined) c.active = true; });
  db.pupils.forEach(p => { if (p.isRepeater === undefined) p.isRepeater = false; p.parentAltPhones ||= []; p.subjectIds ||= []; p.subjectTrack ||= ''; if (p.active === undefined) p.active = true; });
  db.resultSheets.forEach(s => {
    s.marks ||= {}; s.markStates ||= {};
    for (const pupilId of Object.keys(s.marks)) if (!s.markStates[pupilId]) s.markStates[pupilId] = 'PRESENT';
    if (s.deadlineOverride === undefined) s.deadlineOverride = null;
  });
  if (!db.subjects.some(s => String(s.name).toLowerCase() === 'physics')) {
    const dept = db.departments.find(d => /science|mathematics/i.test(d.name)) || db.departments[0];
    db.subjects.push({ id: 'sub_physics', name: 'Physics', departmentId: dept?.id || null, active: true });
  }
  return db;
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const seed = makeSeedData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const migrated = migrateData(raw);
    fs.writeFileSync(DATA_FILE, JSON.stringify(migrated, null, 2));
    return migrated;
  } catch (err) {
    console.error('Primary EduSend data file could not be read:', err.message);
    try {
      if (fs.existsSync(DATA_BACKUP_FILE)) {
        const raw = JSON.parse(fs.readFileSync(DATA_BACKUP_FILE, 'utf8'));
        const recovered = migrateData(raw);
        fs.writeFileSync(DATA_FILE, JSON.stringify(recovered, null, 2));
        console.warn('EduSend recovered data from data.json.bak');
        return recovered;
      }
    } catch (backupErr) {
      console.error('Backup data file could not be read:', backupErr.message);
    }
    throw err;
  }
}

let db = loadData();

function saveData() {
  db.storageMeta ||= { revision:0, lastSavedAt:null };
  db.storageMeta.revision = Number(db.storageMeta.revision || 0) + 1;
  db.storageMeta.lastSavedAt = nowIso();
  const tmp = `${DATA_FILE}.tmp`;
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, DATA_BACKUP_FILE); } catch (e) { console.warn('EduSend backup copy failed:', e.message); }
  }
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  return { revision:db.storageMeta.revision, lastSavedAt:db.storageMeta.lastSavedAt, dataFile:DATA_FILE };
}

function audit(actorUserId, action, detail = '') {
  db.auditLog.unshift({ id: id('audit'), at: nowIso(), actorUserId, action, detail });
  db.auditLog = db.auditLog.slice(0, 3000);
}

function getDepartmentForHod(user) {
  if (!hasRole(user, 'HOD')) return null;
  return db.departments.find(d => d.hodUserId === user.id) || (user.departmentId ? db.departments.find(d => d.id === user.departmentId) : null) || null;
}

function authFromReq(req, urlObj) {
  let token = '';
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) token = header.slice(7);
  if (!token) token = urlObj.searchParams.get('token') || '';
  const payload = readToken(token);
  if (!payload) return { token: '', user: null };
  const user = db.users.find(u => u.id === payload.userId && u.active !== false) || null;
  return { token, user };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function sendError(res, status, message) { return sendJson(res, status, { error: message }); }

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = ''; let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(reqPath, res) {
  let relative = reqPath === '/' ? '/index.html' : reqPath;
  try { relative = decodeURIComponent(relative); } catch {}
  const safe = path.normalize(relative).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'Forbidden');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const type = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'
  }[ext] || 'application/octet-stream';
  const noCache = ['.html', '.js', '.css', '.webmanifest'].includes(ext) || path.basename(filePath) === 'service-worker.js';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': noCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function findSheet(assignmentId, assessmentId) {
  return db.resultSheets.find(s => s.assignmentId === assignmentId && s.assessmentId === assessmentId) || null;
}

function ensureSheet(assignment, assessmentId, actorUserId) {
  let sheet = findSheet(assignment.id, assessmentId);
  if (!sheet) {
    sheet = {
      id: id('sheet'), assignmentId: assignment.id, assessmentId,
      status: 'NOT_STARTED', marks: {}, markStates: {}, deadlineOverride: null,
      updatedAt: null, submittedAt: null, enteredByUserId: actorUserId, source: 'Teacher entry'
    };
    db.resultSheets.push(sheet);
  }
  return sheet;
}

function effectiveDueAt(assessment, sheet) { return sheet?.deadlineOverride || assessment?.dueAt || null; }

function getDeadlineState(assessment, status, sheet = null) {
  const dueAt = effectiveDueAt(assessment, sheet);
  const due = dueAt ? new Date(dueAt).getTime() : NaN;
  const now = Date.now(); const ms = Number.isFinite(due) ? due - now : Number.POSITIVE_INFINITY;
  const done = ['SUBMITTED', 'LOCKED', 'CORRECTION_REQUESTED'].includes(status);
  if (done) return { code: 'DONE', text: status === 'LOCKED' ? 'Locked' : status === 'CORRECTION_REQUESTED' ? 'Correction requested' : 'Submitted', msRemaining: ms, dueAt };
  if (!Number.isFinite(due)) return { code: 'OPEN', text: 'No deadline', msRemaining: ms, dueAt };
  if (ms < 0) return { code: 'OVERDUE', text: 'Overdue', msRemaining: ms, dueAt };
  const days = ms / 86400000;
  if (days <= 1) return { code: 'DUE_SOON', text: 'Due within 24 hours', msRemaining: ms, dueAt };
  if (days <= 3) return { code: 'DUE_SOON', text: `Due in ${Math.ceil(days)} days`, msRemaining: ms, dueAt };
  if (days <= 7) return { code: 'UPCOMING', text: `Due in ${Math.ceil(days)} days`, msRemaining: ms, dueAt };
  return { code: 'OPEN', text: 'Open', msRemaining: ms, dueAt };
}

function assignmentView(a) {
  const cls = db.classes.find(c => c.id === a.classId);
  const subject = db.subjects.find(s => s.id === a.subjectId);
  const teacher = db.users.find(u => u.id === a.teacherUserId);
  const dept = db.departments.find(d => d.id === subject?.departmentId);
  return { ...a, className: cls?.name || '', classLevel: cls?.level || '', subjectName: subject?.name || '', teacherName: teacher?.name || '', departmentId: dept?.id || null, departmentName: dept?.name || '' };
}

function canViewClass(user, classId) {
  if (isAdminOrHead(user)) return true;
  return db.classes.some(c => c.id === classId && c.classTeacherUserId === user.id);
}

function normalizeMark(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return Math.round(n * 10) / 10;
}

function sheetIsVisible(sheet) { return !!sheet && ['SUBMITTED', 'LOCKED', 'CORRECTION_REQUESTED'].includes(sheet.status); }
function stateForPupil(sheet, pupilId) {
  if (sheet?.marks && sheet.marks[pupilId] !== undefined && sheet.marks[pupilId] !== null) return 'PRESENT';
  return sheet?.markStates?.[pupilId] || 'PENDING';
}

const sseClients = new Set();
function broadcastEvent(event, audience = null) {
  const payload = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of [...sseClients]) {
    if (Array.isArray(audience) && audience.length && !audience.includes(client.userId)) continue;
    try { client.res.write(payload); } catch { sseClients.delete(client); }
  }
}

function createNotification(userIds, type, title, message, meta = {}) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  const created = [];
  for (const userId of ids) {
    const n = { id: id('note'), userId, type, title, message, meta, createdAt: nowIso(), readAt: null };
    db.notifications.unshift(n); created.push(n);
  }
  db.notifications = db.notifications.slice(0, 5000);
  if (created.length) broadcastEvent({ type: 'NOTIFICATION', notification: created[0] }, ids);
  return created;
}

function escalationAudienceForAssignment(assignment) {
  const subject = db.subjects.find(s => s.id === assignment?.subjectId);
  const dept = db.departments.find(d => d.id === subject?.departmentId);
  const cls = db.classes.find(c => c.id === assignment?.classId);
  return [...new Set([
    dept?.hodUserId,
    cls?.classTeacherUserId,
    ...db.users.filter(u => hasRole(u, 'ADMIN')).map(u => u.id),
    ...db.users.filter(u => hasRole(u, 'HEAD')).map(u => u.id)
  ].filter(Boolean))];
}

function findRelease(classId, assessmentId) {
  return db.reportReleaseApprovals.find(r => r.classId === classId && r.assessmentId === assessmentId) || null;
}

function reportReadiness(classId, assessmentId) {
  const assignments = db.teachingAssignments.filter(a => a.classId === classId && a.active !== false);
  const missing = [];
  for (const a of assignments) {
    const sheet = findSheet(a.id, assessmentId);
    if (!sheetIsVisible(sheet)) missing.push(assignmentView(a));
  }
  const release = findRelease(classId, assessmentId);
  const finalReady = assignments.length > 0 && missing.length === 0;
  const provisionalAllowed = !!release?.provisionalAllowed;
  return {
    totalSubjects: assignments.length,
    submittedSubjects: assignments.length - missing.length,
    missingSubjects: missing,
    finalReady,
    provisionalAllowed,
    provisional: !finalReady && provisionalAllowed,
    canSend: finalReady || provisionalAllowed,
    approval: release || null
  };
}

function resultRowForPupil(sheet, pupilId) {
  if (!sheet || !sheetIsVisible(sheet)) return { mark: null, state: 'PENDING' };
  const mark = sheet.marks?.[pupilId] ?? null;
  return { mark, state: stateForPupil(sheet, pupilId) };
}

async function api(req, res, urlObj) {
  const pathname = urlObj.pathname;

  if (req.method === 'GET' && pathname === '/api/version') return sendJson(res, 200, { version: APP_VERSION, storageRevision: db.storageMeta?.revision || 0, lastSavedAt: db.storageMeta?.lastSavedAt || null });

  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = db.users.find(u => u.username === username && u.active !== false);
    if (!user || !verifyPassword(password, user.passwordHash)) return sendError(res, 401, 'Invalid username or password');
    audit(user.id, 'LOGIN', username); saveData();
    return sendJson(res, 200, { token: issueToken(user.id), user: safeUser(user), school: db.school });
  }

  const { user } = authFromReq(req, urlObj);
  if (!user) return sendError(res, 401, 'Authentication required');

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, userId: user.id, version: APP_VERSION })}\n\n`);
    const client = { res, userId: user.id }; sseClients.add(client);
    const heartbeat = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); } catch {} }, 25000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(client); });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const classTeacherClasses = db.classes.filter(c => c.classTeacherUserId === user.id && c.active !== false).map(c => ({ id: c.id, name: c.name, level: c.level, gradingSystem: c.gradingSystem }));
    return sendJson(res, 200, { user: safeUser(user), school: db.school, classTeacherClasses, hodDepartment: getDepartmentForHod(user) });
  }

  if (req.method === 'GET' && pathname === '/api/assessments') {
    return sendJson(res, 200, { assessments: db.assessments.filter(a => a.active !== false).sort((a, b) => new Date(b.dueAt) - new Date(a.dueAt)) });
  }

  if (req.method === 'GET' && pathname === '/api/notifications') {
    const notes = db.notifications.filter(n => n.userId === user.id).slice(0, 100);
    return sendJson(res, 200, { notifications: notes, unread: notes.filter(n => !n.readAt).length });
  }

  if (req.method === 'POST' && pathname === '/api/notifications/read') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
    db.notifications.forEach(n => { if (n.userId === user.id && !n.readAt && (!ids || ids.has(n.id))) n.readAt = nowIso(); });
    saveData(); return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/reminders') {
    const own = db.teachingAssignments.filter(a => a.active !== false && a.teacherUserId === user.id);
    const reminders = [];
    for (const assignment of own) {
      for (const assessment of db.assessments.filter(a => a.active !== false)) {
        const sheet = findSheet(assignment.id, assessment.id); const status = sheet?.status || 'NOT_STARTED';
        if (['SUBMITTED', 'LOCKED', 'CORRECTION_REQUESTED'].includes(status)) continue;
        reminders.push({ assignment: assignmentView(assignment), assessment, status, deadline: getDeadlineState(assessment, status, sheet) });
      }
    }
    reminders.sort((a, b) => new Date(a.deadline.dueAt || 0) - new Date(b.deadline.dueAt || 0));
    return sendJson(res, 200, { reminders });
  }

  if (req.method === 'GET' && pathname === '/api/teacher/assignments') {
    if (!hasRole(user, 'TEACHER')) return sendError(res, 403, 'Teacher access required');
    const assignments = db.teachingAssignments.filter(a => a.active !== false && a.teacherUserId === user.id).map(a => {
      const sheets = db.assessments.filter(x => x.active !== false).map(assessment => {
        const sheet = findSheet(a.id, assessment.id); const status = sheet?.status || 'NOT_STARTED';
        const pupilCount = db.pupils.filter(p => p.classId === a.classId && p.active !== false).length;
        const entered = sheet ? Object.keys(sheet.marks || {}).length : 0;
        return { assessment, status, updatedAt: sheet?.updatedAt || null, submittedAt: sheet?.submittedAt || null, deadline: getDeadlineState(assessment, status, sheet), pupilCount, entered };
      });
      return { ...assignmentView(a), sheets };
    });
    return sendJson(res, 200, { assignments });
  }

  if (req.method === 'GET' && pathname === '/api/teacher/sheet') {
    const assignmentId = urlObj.searchParams.get('assignmentId'); const assessmentId = urlObj.searchParams.get('assessmentId');
    const assignment = db.teachingAssignments.find(a => a.id === assignmentId && a.active !== false);
    if (!assignment || assignment.teacherUserId !== user.id) return sendError(res, 403, 'You can only open subjects assigned to you');
    const assessment = db.assessments.find(a => a.id === assessmentId && a.active !== false);
    if (!assessment) return sendError(res, 404, 'Assessment not found');
    const pupils = db.pupils.filter(p => p.classId === assignment.classId && p.active !== false).map(p => ({ id: p.id, name: p.name, sex: p.sex, examNo: p.examNo || '', isRepeater: !!p.isRepeater }));
    const sheet = ensureSheet(assignment, assessmentId, user.id);
    return sendJson(res, 200, {
      assignment: assignmentView(assignment), assessment,
      sheet: { id: sheet.id, status: sheet.status, marks: sheet.marks || {}, markStates: sheet.markStates || {}, updatedAt: sheet.updatedAt, submittedAt: sheet.submittedAt, deadline: getDeadlineState(assessment, sheet.status, sheet) },
      pupils
    });
  }

  if (req.method === 'PUT' && pathname === '/api/teacher/sheet') {
    const body = await readJson(req);
    const assignment = db.teachingAssignments.find(a => a.id === body.assignmentId && a.active !== false);
    if (!assignment || assignment.teacherUserId !== user.id) return sendError(res, 403, 'You may only edit your assigned subject');
    const assessment = db.assessments.find(a => a.id === body.assessmentId && a.active !== false);
    if (!assessment) return sendError(res, 404, 'Assessment not found');
    const sheet = ensureSheet(assignment, assessment.id, user.id);
    if (sheet.status === 'LOCKED') return sendError(res, 409, 'This result sheet has been locked by administration');
    if (sheet.status === 'SUBMITTED' && body.action !== 'submit') return sendError(res, 409, 'This sheet has already been submitted. Ask the class teacher/HOD for a correction request before editing.');

    const classPupils = db.pupils.filter(p => p.classId === assignment.classId && p.active !== false);
    const validIds = new Set(classPupils.map(p => p.id));
    const marks = {}; const markStates = {};
    const rows = Array.isArray(body.rows) ? body.rows : Array.isArray(body.marks) ? body.marks : [];
    for (const row of rows) {
      if (!validIds.has(row.pupilId)) continue;
      const mark = normalizeMark(row.mark);
      if (mark === undefined) return sendError(res, 400, `Invalid mark for pupil ${row.pupilId}. Marks must be 0–100 or blank.`);
      let state = String(row.state || '').toUpperCase();
      if (mark !== null) state = 'PRESENT';
      if (!['PRESENT', 'ABSENT', 'NOT_TAKING', 'PENDING'].includes(state)) state = mark !== null ? 'PRESENT' : 'PENDING';
      if (state === 'PRESENT' && mark === null) state = 'PENDING';
      if (mark !== null) marks[row.pupilId] = mark;
      markStates[row.pupilId] = state;
    }
    for (const p of classPupils) if (!markStates[p.id]) markStates[p.id] = sheet.markStates?.[p.id] || (sheet.marks?.[p.id] !== undefined ? 'PRESENT' : 'PENDING');

    sheet.marks = marks; sheet.markStates = markStates; sheet.updatedAt = nowIso(); sheet.enteredByUserId = user.id;
    const action = body.action === 'submit' ? 'submit' : 'draft';
    if (action === 'submit') {
      const pending = classPupils.filter(p => (markStates[p.id] || 'PENDING') === 'PENDING');
      if (pending.length) return sendError(res, 400, `${pending.length} pupil${pending.length === 1 ? '' : 's'} still marked Pending. Enter a mark or choose Absent / Not Taking before Finish & Submit.`);
      sheet.status = 'SUBMITTED'; sheet.submittedAt = nowIso();
      audit(user.id, 'RESULTS_SUBMITTED', `${assignment.classId}/${assignment.subjectId}/${assessment.id}`);
      const cls = db.classes.find(c => c.id === assignment.classId); const subject = db.subjects.find(s => s.id === assignment.subjectId);
      const dept = db.departments.find(d => d.id === subject?.departmentId);
      const recipients = [...new Set([cls?.classTeacherUserId, dept?.hodUserId, ...db.users.filter(u => hasRole(u, 'ADMIN')).map(u => u.id)].filter(Boolean))];
      createNotification(recipients, 'RESULTS_SUBMITTED', `${subject?.name || 'Subject'} results received`, `${user.name} submitted ${subject?.name || 'subject'} results for ${cls?.name || 'class'} (${classPupils.length} pupils).`, { classId: assignment.classId, subjectId: assignment.subjectId, assessmentId: assessment.id, assignmentId: assignment.id });
    } else {
      sheet.status = Object.keys(marks).length || Object.values(markStates).some(s => s !== 'PENDING') ? 'DRAFT' : 'NOT_STARTED';
      audit(user.id, 'RESULTS_DRAFT_SAVED', `${assignment.classId}/${assignment.subjectId}/${assessment.id}`);
    }
    const storage = saveData();
    broadcastEvent({ type: 'RESULT_SHEET_UPDATED', classId: assignment.classId, subjectId: assignment.subjectId, assessmentId: assessment.id, assignmentId: assignment.id, status: sheet.status, at: sheet.updatedAt }, escalationAudienceForAssignment(assignment));
    const cls = db.classes.find(c => c.id === assignment.classId);
    const subject = db.subjects.find(s => s.id === assignment.subjectId);
    const classTeacher = db.users.find(u => u.id === cls?.classTeacherUserId && u.active !== false);
    return sendJson(res, 200, {
      ok:true, status:sheet.status, updatedAt:sheet.updatedAt, submittedAt:sheet.submittedAt,
      className:cls?.name || '', subjectName:subject?.name || '',
      classTeacherName:classTeacher?.name || '', classTeacherAssigned:!!classTeacher,
      storageRevision:storage.revision, storageSavedAt:storage.lastSavedAt
    });
  }

  if (req.method === 'GET' && pathname === '/api/class-teacher/classes') {
    const classes = db.classes.filter(c => c.active !== false && (isAdminOrHead(user) || c.classTeacherUserId === user.id));
    return sendJson(res, 200, { classes });
  }

  if (req.method === 'GET' && pathname === '/api/class-teacher/overview') {
    const classId = urlObj.searchParams.get('classId'); const assessmentId = urlObj.searchParams.get('assessmentId');
    if (!canViewClass(user, classId)) return sendError(res, 403, 'You are not the class teacher for this class');
    const cls = db.classes.find(c => c.id === classId); const assessment = db.assessments.find(a => a.id === assessmentId);
    if (!cls || !assessment) return sendError(res, 404, 'Class or assessment not found');
    const assignments = db.teachingAssignments.filter(a => a.classId === classId && a.active !== false).map(assignmentView);
    const subjects = assignments.map(a => {
      const sheet = findSheet(a.id, assessmentId);
      const escalation = db.escalations.find(e => e.assignmentId === a.id && e.assessmentId === assessmentId && !['RESOLVED', 'CLOSED'].includes(e.status));
      return {
        assignmentId: a.id, subjectId: a.subjectId, subjectName: a.subjectName, teacherName: a.teacherName,
        status: sheet?.status || 'NOT_STARTED', updatedAt: sheet?.updatedAt || null, submittedAt: sheet?.submittedAt || null,
        deadline: getDeadlineState(assessment, sheet?.status || 'NOT_STARTED', sheet), escalation: escalation || null
      };
    });
    const pupils = db.pupils.filter(p => p.classId === classId && p.active !== false).map(p => {
      const results = {};
      for (const a of assignments) results[a.subjectId] = resultRowForPupil(findSheet(a.id, assessmentId), p.id);
      return { id: p.id, name: p.name, sex: p.sex, examNo: p.examNo || '', isRepeater: !!p.isRepeater, parentPrimary: p.parentPrimary || '', parentAltPhones: p.parentAltPhones || [], results };
    });
    const classTeacher = db.users.find(u => u.id === cls.classTeacherUserId);
    return sendJson(res, 200, { class: cls, assessment, subjects, pupils, classTeacher: safeUser(classTeacher), reportReadiness: reportReadiness(classId, assessmentId) });
  }

  if (req.method === 'POST' && pathname === '/api/class-teacher/request-correction') {
    const body = await readJson(req); const assignment = db.teachingAssignments.find(a => a.id === body.assignmentId && a.active !== false);
    if (!assignment || !canViewClass(user, assignment.classId)) return sendError(res, 403, 'Class teacher access required');
    const sheet = findSheet(assignment.id, body.assessmentId);
    if (!sheet || !sheetIsVisible(sheet)) return sendError(res, 404, 'Submitted result sheet not found');
    if (sheet.status === 'LOCKED') return sendError(res, 409, 'This sheet is locked by administration. Ask administration to unlock it before requesting a correction.');
    sheet.status = 'CORRECTION_REQUESTED'; sheet.updatedAt = nowIso();
    const note = String(body.note || '').trim();
    audit(user.id, 'CORRECTION_REQUESTED', `${assignment.id}/${body.assessmentId}: ${note}`);
    createNotification(assignment.teacherUserId, 'CORRECTION_REQUESTED', `Correction requested: ${assignmentView(assignment).subjectName}`, `${user.name} requested a correction for ${assignmentView(assignment).className} ${assignmentView(assignment).subjectName}.${note ? ` Note: ${note}` : ''}`, { assignmentId: assignment.id, assessmentId: body.assessmentId });
    saveData(); broadcastEvent({ type: 'RESULT_SHEET_UPDATED', classId: assignment.classId, assignmentId: assignment.id, assessmentId: body.assessmentId, status: sheet.status }, [assignment.teacherUserId, user.id]);
    return sendJson(res, 200, { ok: true, status: sheet.status });
  }

  if (req.method === 'POST' && pathname === '/api/class-teacher/report-sent') {
    const body = await readJson(req); const cls = db.classes.find(c => c.id === body.classId);
    if (!cls || !canViewClass(user, cls.id)) return sendError(res, 403, 'Class teacher access required');
    const pupil = db.pupils.find(p => p.id === body.pupilId && p.classId === cls.id);
    if (!pupil) return sendError(res, 404, 'Pupil not found');
    const readiness = reportReadiness(cls.id, body.assessmentId);
    if (!readiness.canSend) return sendError(res, 409, 'Reports are not ready and provisional release has not been authorized');
    const log = { id: id('send'), at: nowIso(), classId: cls.id, assessmentId: body.assessmentId, pupilId: pupil.id, sentByUserId: user.id, channel: String(body.channel || 'SHARE'), provisional: readiness.provisional, parentNumber: String(body.parentNumber || pupil.parentPrimary || '') };
    db.reportSendLog.unshift(log); db.reportSendLog = db.reportSendLog.slice(0, 5000);
    audit(user.id, 'REPORT_SENT', `${cls.name}/${pupil.name}/${body.assessmentId}${readiness.provisional ? ' PROVISIONAL' : ''}`);
    saveData(); return sendJson(res, 201, { log });
  }

  if (req.method === 'GET' && pathname === '/api/class-teacher/report-history') {
    const classId = urlObj.searchParams.get('classId'); const assessmentId = urlObj.searchParams.get('assessmentId');
    if (!canViewClass(user, classId)) return sendError(res, 403, 'Class teacher access required');
    return sendJson(res, 200, { rows: db.reportSendLog.filter(x => x.classId === classId && (!assessmentId || x.assessmentId === assessmentId)).slice(0, 500) });
  }

  if (req.method === 'POST' && pathname === '/api/escalations') {
    const body = await readJson(req); const assignment = db.teachingAssignments.find(a => a.id === body.assignmentId && a.active !== false);
    if (!assignment) return sendError(res, 404, 'Teaching assignment not found');
    const cls = db.classes.find(c => c.id === assignment.classId);
    if (!cls || !(isAdminOrHead(user) || cls.classTeacherUserId === user.id)) return sendError(res, 403, 'Only the class teacher or administration can escalate a missing result');
    const assessment = db.assessments.find(a => a.id === body.assessmentId);
    if (!assessment) return sendError(res, 404, 'Assessment not found');
    const sheet = findSheet(assignment.id, assessment.id);
    if (sheetIsVisible(sheet)) return sendError(res, 409, 'This result sheet is already submitted');
    let esc = db.escalations.find(e => e.assignmentId === assignment.id && e.assessmentId === assessment.id && !['RESOLVED', 'CLOSED'].includes(e.status));
    if (!esc) {
      esc = { id: id('esc'), assignmentId: assignment.id, assessmentId: assessment.id, classId: assignment.classId, createdByUserId: user.id, createdAt: nowIso(), status: 'OPEN', note: String(body.note || '').trim(), history: [] };
      db.escalations.unshift(esc);
    }
    esc.history ||= []; esc.history.unshift({ at: nowIso(), byUserId: user.id, action: 'ESCALATED', note: String(body.note || '').trim() });
    audit(user.id, 'RESULT_ESCALATED', `${assignment.id}/${assessment.id}`);
    const av = assignmentView(assignment); const recipients = escalationAudienceForAssignment(assignment).filter(uid => uid !== user.id);
    createNotification(recipients, 'ESCALATION', `Missing result escalated: ${av.subjectName}`, `${user.name} escalated ${av.className} ${av.subjectName} for ${assessment.name}.`, { escalationId: esc.id, assignmentId: assignment.id, assessmentId: assessment.id });
    saveData(); broadcastEvent({ type: 'ESCALATION_UPDATED', escalationId: esc.id, status: esc.status }, escalationAudienceForAssignment(assignment));
    return sendJson(res, 201, { escalation: esc });
  }

  if (req.method === 'GET' && pathname === '/api/escalations') {
    let rows = db.escalations.map(e => {
      const assignment = db.teachingAssignments.find(a => a.id === e.assignmentId);
      const assessment = db.assessments.find(a => a.id === e.assessmentId);
      return { ...e, assignment: assignment ? assignmentView(assignment) : null, assessment };
    });
    if (hasRole(user, 'ADMIN') || hasRole(user, 'HEAD')) {
      // all
    } else if (hasRole(user, 'HOD')) {
      const dept = getDepartmentForHod(user); rows = rows.filter(r => r.assignment?.departmentId === dept?.id);
    } else if (stateHasClassTeacher(user.id)) {
      const ids = new Set(db.classes.filter(c => c.classTeacherUserId === user.id).map(c => c.id)); rows = rows.filter(r => ids.has(r.classId));
    } else {
      rows = rows.filter(r => r.assignment?.teacherUserId === user.id);
    }
    return sendJson(res, 200, { escalations: rows.slice(0, 300) });
  }

  if (req.method === 'POST' && pathname === '/api/hod/escalation-action') {
    const dept = getDepartmentForHod(user); if (!dept) return sendError(res, 403, 'HOD access required');
    const body = await readJson(req); const esc = db.escalations.find(e => e.id === body.escalationId);
    if (!esc) return sendError(res, 404, 'Escalation not found');
    const assignment = db.teachingAssignments.find(a => a.id === esc.assignmentId); const av = assignmentView(assignment);
    if (av.departmentId !== dept.id) return sendError(res, 403, 'This escalation is outside your department');
    esc.status = 'HOD_FOLLOWUP'; esc.history ||= []; esc.history.unshift({ at: nowIso(), byUserId: user.id, action: 'HOD_FOLLOWUP', note: String(body.note || '').trim() });
    createNotification(assignment.teacherUserId, 'HOD_FOLLOWUP', `HOD follow-up: ${av.className} ${av.subjectName}`, `${user.name} is following up on this outstanding result.${body.note ? ` ${body.note}` : ''}`, { escalationId: esc.id });
    audit(user.id, 'ESCALATION_HOD_FOLLOWUP', esc.id); saveData();
    return sendJson(res, 200, { escalation: esc });
  }

  if (req.method === 'POST' && pathname === '/api/admin/escalation-action') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const esc = db.escalations.find(e => e.id === body.escalationId);
    if (!esc) return sendError(res, 404, 'Escalation not found');
    const assignment = db.teachingAssignments.find(a => a.id === esc.assignmentId); const assessment = db.assessments.find(a => a.id === esc.assessmentId); const av = assignmentView(assignment);
    const action = String(body.action || '').toUpperCase();
    esc.history ||= [];
    if (action === 'EXTEND_DEADLINE') {
      const dueAt = String(body.dueAt || ''); if (!dueAt || Number.isNaN(new Date(dueAt).getTime())) return sendError(res, 400, 'A valid new deadline is required');
      const sheet = ensureSheet(assignment, assessment.id, assignment.teacherUserId); sheet.deadlineOverride = dueAt;
      esc.status = 'DEADLINE_EXTENDED'; esc.history.unshift({ at: nowIso(), byUserId: user.id, action, note: dueAt });
      createNotification([assignment.teacherUserId, db.classes.find(c => c.id === assignment.classId)?.classTeacherUserId, db.departments.find(d => d.id === av.departmentId)?.hodUserId], 'DEADLINE_EXTENDED', `Deadline extended: ${av.className} ${av.subjectName}`, `Administration extended the result deadline to ${new Date(dueAt).toLocaleString('en-ZM')}.`, { escalationId: esc.id, dueAt });
    } else if (action === 'AUTHORIZE_PROVISIONAL') {
      let release = findRelease(assignment.classId, assessment.id);
      if (!release) { release = { id: id('release'), classId: assignment.classId, assessmentId: assessment.id }; db.reportReleaseApprovals.push(release); }
      release.provisionalAllowed = true; release.approvedAt = nowIso(); release.approvedByUserId = user.id; release.reason = String(body.note || 'Administration authorized provisional reports while results remain outstanding.');
      esc.status = 'PROVISIONAL_AUTHORIZED'; esc.history.unshift({ at: nowIso(), byUserId: user.id, action, note: release.reason });
      const cls = db.classes.find(c => c.id === assignment.classId);
      createNotification(cls?.classTeacherUserId, 'PROVISIONAL_AUTHORIZED', `Provisional reports authorized: ${cls?.name || ''}`, `Administration authorized provisional reports for ${assessment.name}. Missing subjects must appear as Pending, not zero.`, { classId: assignment.classId, assessmentId: assessment.id });
    } else if (action === 'REMIND_HOD') {
      esc.status = 'HOD_REVIEW'; esc.history.unshift({ at: nowIso(), byUserId: user.id, action, note: String(body.note || '') });
      const hodId = db.departments.find(d => d.id === av.departmentId)?.hodUserId;
      createNotification(hodId, 'ADMIN_HOD_REVIEW', `Administration follow-up: ${av.className} ${av.subjectName}`, `${user.name} asked you to follow up with the subject teacher.${body.note ? ` ${body.note}` : ''}`, { escalationId: esc.id });
    } else if (action === 'RESOLVE') {
      esc.status = 'RESOLVED'; esc.resolvedAt = nowIso(); esc.history.unshift({ at: nowIso(), byUserId: user.id, action, note: String(body.note || '') });
    } else return sendError(res, 400, 'Unsupported escalation action');
    audit(user.id, `ESCALATION_${action}`, esc.id); saveData(); broadcastEvent({ type: 'ESCALATION_UPDATED', escalationId: esc.id, status: esc.status }, escalationAudienceForAssignment(assignment));
    return sendJson(res, 200, { escalation: esc });
  }

  if (req.method === 'GET' && pathname === '/api/hod/assignments') {
    const dept = getDepartmentForHod(user); if (!dept) return sendError(res, 403, 'HOD access required');
    const subjects = db.subjects.filter(s => s.departmentId === dept.id && s.active !== false);
    const teachers = db.users.filter(u => u.active !== false && belongsToDepartment(u, dept.id) && hasRole(u, 'TEACHER')).map(safeUser);
    const assignments = db.teachingAssignments.filter(a => db.subjects.find(s => s.id === a.subjectId)?.departmentId === dept.id && a.active !== false).map(assignmentView);
    return sendJson(res, 200, { department: dept, subjects, teachers, classes: db.classes.filter(c => c.active !== false), assignments });
  }

  if (req.method === 'POST' && pathname === '/api/hod/assign') {
    const dept = getDepartmentForHod(user); if (!dept) return sendError(res, 403, 'HOD access required');
    const body = await readJson(req); const subject = db.subjects.find(s => s.id === body.subjectId && s.active !== false); const cls = db.classes.find(c => c.id === body.classId && c.active !== false); const teacher = db.users.find(u => u.id === body.teacherUserId && u.active !== false);
    if (!subject || subject.departmentId !== dept.id) return sendError(res, 403, 'You can only assign subjects in your department');
    if (!cls) return sendError(res, 404, 'Class not found');
    if (!teacher || !belongsToDepartment(teacher, dept.id) || !hasRole(teacher, 'TEACHER')) return sendError(res, 400, 'Teacher must belong to your department');
    let assignment = db.teachingAssignments.find(a => a.classId === cls.id && a.subjectId === subject.id && a.active !== false);
    if (assignment) assignment.teacherUserId = teacher.id;
    else { assignment = { id: id('ta'), classId: cls.id, subjectId: subject.id, teacherUserId: teacher.id, active: true }; db.teachingAssignments.push(assignment); }
    audit(user.id, 'TEACHING_ASSIGNMENT_SET', `${cls.name} / ${subject.name} -> ${teacher.name}`);
    createNotification(teacher.id, 'ASSIGNMENT', 'New teaching result assignment', `You are assigned ${subject.name} results for ${cls.name}.`, { assignmentId: assignment.id });
    saveData(); broadcastEvent({ type: 'ASSIGNMENT_UPDATED', classId: cls.id, subjectId: subject.id, teacherUserId: teacher.id }, [teacher.id, user.id]);
    return sendJson(res, 200, { assignment: assignmentView(assignment) });
  }

  if (req.method === 'GET' && pathname === '/api/hod/progress') {
    const dept = getDepartmentForHod(user); if (!dept) return sendError(res, 403, 'HOD access required');
    const assessmentId = urlObj.searchParams.get('assessmentId') || db.assessments.find(a => a.active !== false)?.id; const assessment = db.assessments.find(a => a.id === assessmentId);
    if (!assessment) return sendError(res, 404, 'Assessment not found');
    const rows = db.teachingAssignments.filter(a => a.active !== false && db.subjects.find(s => s.id === a.subjectId)?.departmentId === dept.id).map(a => {
      const sheet = findSheet(a.id, assessment.id); const status = sheet?.status || 'NOT_STARTED';
      return { ...assignmentView(a), status, updatedAt: sheet?.updatedAt || null, submittedAt: sheet?.submittedAt || null, deadline: getDeadlineState(assessment, status, sheet) };
    });
    return sendJson(res, 200, { department: dept, assessment, rows });
  }

  if (req.method === 'GET' && pathname === '/api/school/progress') {
    if (!isAdminOrHead(user)) return sendError(res, 403, 'Administrator or Head Teacher access required');
    const assessmentId = urlObj.searchParams.get('assessmentId') || db.assessments.find(a => a.active !== false)?.id; const assessment = db.assessments.find(a => a.id === assessmentId);
    if (!assessment) return sendError(res, 404, 'Assessment not found');
    const rows = db.teachingAssignments.filter(a => a.active !== false).map(a => {
      const sheet = findSheet(a.id, assessment.id); const status = sheet?.status || 'NOT_STARTED';
      return { ...assignmentView(a), status, updatedAt: sheet?.updatedAt || null, submittedAt: sheet?.submittedAt || null, deadline: getDeadlineState(assessment, status, sheet) };
    });
    const classes = db.classes.filter(c => c.active !== false).map(c => ({ class: c, readiness: reportReadiness(c.id, assessment.id) }));
    return sendJson(res, 200, { assessment, rows, classes });
  }

  if (req.method === 'POST' && pathname === '/api/admin/load-practice-demo') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req);
    if (String(body.confirm || '') !== 'LOAD LUMEZI PRACTICE') return sendError(res, 400, 'Confirmation phrase does not match');
    try {
      const backupName = `backup-before-practice-${Date.now()}.json`;
      fs.writeFileSync(path.join(DATA_DIR, backupName), JSON.stringify(db, null, 2));
    } catch (e) { console.warn('Could not create pre-demo backup:', e.message); }
    db = makePracticeSchoolData();
    const newAdmin = db.users.find(u => u.username === 'admin');
    audit(newAdmin.id, 'PRACTICE_DATA_LOADED', 'Lumezi practice school loaded by administrator');
    saveData();
    broadcastEvent({ type:'PRACTICE_DATA_LOADED', at:nowIso() });
    return sendJson(res, 200, {
      ok:true, token:issueToken(newAdmin.id),
      summary:{ classes:db.classes.length, pupils:db.pupils.length, staff:db.users.length, assignments:db.teachingAssignments.length, assessment:db.assessments[0]?.name }
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/setup') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    return sendJson(res, 200, { school: db.school, users: db.users.map(safeUser), departments: db.departments, classes: db.classes, subjects: db.subjects, assessments: db.assessments, teachingAssignments: db.teachingAssignments.map(assignmentView) });
  }

  if (req.method === 'POST' && pathname === '/api/admin/school') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req);
    for (const k of ['name', 'motto', 'address', 'email']) if (body[k] !== undefined) db.school[k] = String(body[k] || '').trim();
    audit(user.id, 'SCHOOL_DETAILS_UPDATED', db.school.name); saveData(); return sendJson(res, 200, { school: db.school });
  }

  if (req.method === 'POST' && pathname === '/api/admin/department') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const name = String(body.name || '').trim(); if (!name) return sendError(res, 400, 'Department name is required');
    if (db.departments.some(d => d.name.toLowerCase() === name.toLowerCase())) return sendError(res, 409, 'Department already exists');
    const dept = { id: id('dept'), name, hodUserId: null }; db.departments.push(dept); audit(user.id, 'DEPARTMENT_CREATED', name); saveData(); return sendJson(res, 201, { department: dept });
  }

  if (req.method === 'POST' && pathname === '/api/admin/subject') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const name = String(body.name || '').trim(); const dept = db.departments.find(d => d.id === body.departmentId);
    if (!name || !dept) return sendError(res, 400, 'Subject name and department are required');
    if (db.subjects.some(s => s.name.toLowerCase() === name.toLowerCase() && s.active !== false)) return sendError(res, 409, 'Subject already exists');
    const subject = { id: id('sub'), name, departmentId: dept.id, active: true }; db.subjects.push(subject); audit(user.id, 'SUBJECT_CREATED', `${name}/${dept.name}`); saveData(); return sendJson(res, 201, { subject });
  }

  if (req.method === 'POST' && pathname === '/api/admin/user') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const name = String(body.name || '').trim(); const username = String(body.username || '').trim().toLowerCase(); const password = String(body.password || '');
    const roles = Array.isArray(body.roles) ? body.roles.filter(r => ['ADMIN', 'HEAD', 'HOD', 'TEACHER'].includes(r)) : ['TEACHER'];
    if (!name || !username || password.length < 6) return sendError(res, 400, 'Name, username and password of at least 6 characters are required');
    if (db.users.some(u => u.username === username)) return sendError(res, 409, 'Username already exists');
    const newUser = { id: id('usr'), name, username, passwordHash: hashPassword(password), roles: roles.length ? roles : ['TEACHER'], departmentId: body.departmentId || null, departmentIds: body.departmentId ? [body.departmentId] : [], phone: String(body.phone || '').trim(), active: true };
    db.users.push(newUser);
    if (newUser.roles.includes('HOD') && newUser.departmentId) { const dept = db.departments.find(d => d.id === newUser.departmentId); if (dept) dept.hodUserId = newUser.id; }
    audit(user.id, 'USER_CREATED', `${name} (${username})`); saveData(); return sendJson(res, 201, { user: safeUser(newUser) });
  }

  if (req.method === 'POST' && pathname === '/api/admin/class-teacher') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req);
    const cls = db.classes.find(c => c.id === body.classId && c.active !== false);
    if (!cls) return sendError(res, 400, 'Valid class required');
    const oldTeacherId = cls.classTeacherUserId || null;
    let teacher = null;
    if (body.teacherUserId) {
      teacher = db.users.find(u => u.id === body.teacherUserId && u.active !== false);
      if (!teacher || !hasRole(teacher, 'TEACHER')) return sendError(res, 400, 'Valid teacher required');
      cls.classTeacherUserId = teacher.id;
      audit(user.id, 'CLASS_TEACHER_SET', `${cls.name} -> ${teacher.name}`);
      createNotification(teacher.id, 'CLASS_TEACHER', 'Class teacher assignment', `You are now the class teacher for ${cls.name}. Class Progress and Reports access are active automatically.`, { classId: cls.id });
    } else {
      cls.classTeacherUserId = null;
      audit(user.id, 'CLASS_TEACHER_CLEARED', cls.name);
    }
    if (oldTeacherId && oldTeacherId !== cls.classTeacherUserId) {
      createNotification(oldTeacherId, 'CLASS_TEACHER_CHANGED', 'Class teacher assignment changed', `You are no longer assigned as class teacher for ${cls.name}.`, { classId: cls.id });
    }
    const storage=saveData();
    const audience=[user.id,oldTeacherId,cls.classTeacherUserId].filter(Boolean);
    broadcastEvent({ type:'CLASS_TEACHER_UPDATED', classId:cls.id, teacherUserId:cls.classTeacherUserId, oldTeacherUserId:oldTeacherId }, audience);
    return sendJson(res, 200, { class:cls, classTeacherName:teacher?.name || '', storageRevision:storage.revision });
  }

  if (req.method === 'POST' && pathname === '/api/admin/class') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const name = String(body.name || '').trim(); if (!name) return sendError(res, 400, 'Class name is required');
    if (db.classes.some(c => c.name.toLowerCase() === name.toLowerCase() && c.active !== false)) return sendError(res, 409, 'Class already exists');
    const cls = { id: id('class'), name, level: String(body.level || '').trim(), gradingSystem: body.gradingSystem === 'CBC' ? 'CBC' : 'LEGACY', classTeacherUserId: null, active: true };
    db.classes.push(cls); audit(user.id, 'CLASS_CREATED', name); saveData(); return sendJson(res, 201, { class: cls });
  }

  if (req.method === 'POST' && pathname === '/api/admin/assessment') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const name = String(body.name || '').trim(); const dueAt = String(body.dueAt || '').trim();
    if (!name || !dueAt || Number.isNaN(new Date(dueAt).getTime())) return sendError(res, 400, 'Valid assessment name and deadline are required');
    const assessment = { id: id('assess'), name, term: String(body.term || '').trim(), year: Number(body.year || new Date().getFullYear()), dueAt, active: true };
    db.assessments.push(assessment); audit(user.id, 'ASSESSMENT_CREATED', `${name} due ${dueAt}`); saveData(); broadcastEvent({ type: 'ASSESSMENT_CREATED', assessmentId: assessment.id }); return sendJson(res, 201, { assessment });
  }

  if (req.method === 'POST' && pathname === '/api/admin/pupil') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const cls = db.classes.find(c => c.id === body.classId && c.active !== false); const name = String(body.name || '').trim();
    if (!cls || !name) return sendError(res, 400, 'Class and pupil name are required');
    const pupil = { id: id('pupil'), classId: cls.id, name, sex: String(body.sex || '').trim().toUpperCase().slice(0, 1), examNo: String(body.examNo || '').trim(), parentPrimary: String(body.parentPrimary || '').trim(), parentAltPhones: Array.isArray(body.parentAltPhones) ? body.parentAltPhones.map(String) : [], isRepeater: !!body.isRepeater, active: true };
    db.pupils.push(pupil); audit(user.id, 'PUPIL_CREATED', `${name} / ${cls.name}`); saveData(); return sendJson(res, 201, { pupil });
  }

  if (req.method === 'POST' && pathname === '/api/admin/pupils-bulk') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const cls = db.classes.find(c => c.id === body.classId && c.active !== false); if (!cls) return sendError(res, 404, 'Class not found');
    const rows = Array.isArray(body.pupils) ? body.pupils : []; if (!rows.length) return sendError(res, 400, 'No pupils supplied');
    const added = [];
    for (const row of rows.slice(0, 500)) {
      const name = String(row.name || '').trim(); if (!name) continue;
      const pupil = { id: id('pupil'), classId: cls.id, name, sex: String(row.sex || '').trim().toUpperCase().slice(0, 1), examNo: String(row.examNo || '').trim(), parentPrimary: String(row.parentPrimary || '').trim(), parentAltPhones: [], isRepeater: /^(1|true|yes|y)$/i.test(String(row.isRepeater || '')), active: true };
      db.pupils.push(pupil); added.push(pupil);
    }
    audit(user.id, 'PUPILS_BULK_IMPORTED', `${added.length} / ${cls.name}`); saveData(); return sendJson(res, 201, { count: added.length, pupils: added });
  }

  if (req.method === 'POST' && pathname === '/api/admin/lock-sheet') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const sheet = findSheet(body.assignmentId, body.assessmentId); if (!sheet) return sendError(res, 404, 'Result sheet not found');
    sheet.status = body.lock === false ? 'SUBMITTED' : 'LOCKED'; sheet.updatedAt = nowIso(); audit(user.id, sheet.status === 'LOCKED' ? 'RESULT_SHEET_LOCKED' : 'RESULT_SHEET_UNLOCKED', `${body.assignmentId}/${body.assessmentId}`); saveData(); broadcastEvent({ type: 'RESULT_SHEET_UPDATED', assignmentId: body.assignmentId, assessmentId: body.assessmentId, status: sheet.status }); return sendJson(res, 200, { status: sheet.status });
  }

  if (req.method === 'GET' && pathname === '/api/admin/audit') {
    if (!isAdminOrHead(user)) return sendError(res, 403, 'Administration access required');
    const rows = db.auditLog.slice(0, 500).map(r => ({ ...r, actorName: db.users.find(u => u.id === r.actorUserId)?.name || 'System' }));
    return sendJson(res, 200, { rows });
  }

  if (req.method === 'GET' && pathname === '/api/admin/backup') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    return sendJson(res, 200, { exportedAt: nowIso(), version: APP_VERSION, data: db });
  }

  return sendError(res, 404, 'API endpoint not found');
}

function stateHasClassTeacher(userId) { return db.classes.some(c => c.classTeacherUserId === userId && c.active !== false); }

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (urlObj.pathname.startsWith('/api/')) { await api(req, res, urlObj); return; }
    if (serveStatic(urlObj.pathname, res) === false) sendError(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendError(res, 500, err.message || 'Server error'); else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`EduSend V${APP_VERSION} running on http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  if (TOKEN_SECRET.includes('DEV_ONLY')) console.warn('WARNING: Set TOKEN_SECRET before public deployment.');
});
