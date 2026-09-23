'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const APP_VERSION = '3.0.1';
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
const DATABASE_URL = process.env.DATABASE_URL || '';
const DATABASE_SSL = String(process.env.DATABASE_SSL || '').toLowerCase() === 'true';
const STORAGE_BACKEND = DATABASE_URL ? 'postgresql' : 'local-file';
let pgPool = null;
let saveQueue = Promise.resolve();

function getPgPool() {
  if (!DATABASE_URL) return null;
  if (!pgPool) {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    pgPool.on('error', err => console.error('PostgreSQL pool error:', err.message));
  }
  return pgPool;
}

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
    const u = { id: fixedId, name, username: username.toLowerCase(), passwordHash: hashPassword(password), roles, departmentId, departmentIds: departmentId ? [departmentId] : [], phone, active: true, profileSetupComplete: false };
    users.push(u); return u;
  };

  const departments = [
    { id: 'dept_languages', name: 'Languages', hodUserId: null },
    { id: 'dept_science', name: 'Mathematics & Natural Sciences', hodUserId: null },
    { id: 'dept_social', name: 'Social Sciences', hodUserId: null },
    { id: 'dept_business', name: 'Business & Technology', hodUserId: null }
  ];
  const dept = Object.fromEntries(departments.map(d => [d.id, d]));

  // Ten staff only for training. All practice accounts use PIN 1234.
  const admin = addUser('usr_admin_demo', 'School Administrator', 'admin', '1234', ['ADMIN']);
  const head = addUser('usr_head_demo', 'Mr B. Kasaro — Head Teacher', 'head', '1234', ['HEAD']);
  const hodScience = addUser('usr_hod_science', 'Mr J. Nkhoma — HOD Science', 'hod.science', '1234', ['HOD','TEACHER'], 'dept_science');
  dept.dept_science.hodUserId = hodScience.id;

  const tembo = addUser('usr_tembo_english','Ms Ruth Tembo','tembo','1234',['TEACHER'],'dept_languages');
  const phiri = addUser('usr_phiri_math','Mr Daniel Phiri','phiri','1234',['TEACHER'],'dept_science');
  const kamanga = addUser('usr_kamanga','Mr Kamanga P','kamanga','1234',['TEACHER'],'dept_science','0973296462');
  const banda = addUser('usr_banda_science','Ms Grace Banda','banda','1234',['TEACHER'],'dept_science');
  const mbewe = addUser('usr_mbewe_social','Mr Joseph Mbewe','mbewe','1234',['TEACHER'],'dept_social');
  const sakala = addUser('usr_sakala_business','Ms Memory Sakala','sakala','1234',['TEACHER'],'dept_business');
  // Intentionally unassigned so first-login profile setup remains testable.
  const chanda = addUser('usr_chanda_new','Ms Esther Chanda','chanda','1234',['TEACHER'],'dept_science');

  const classes = [
    { id:'class_10l', name:'10L', level:'Grade 10', gradingSystem:'LEGACY', classTeacherUserId:sakala.id, active:true },
    { id:'class_11n', name:'11N', level:'Grade 11', gradingSystem:'LEGACY', classTeacherUserId:tembo.id, active:true }
  ];

  const subjects = [
    {id:'sub_english',name:'English',departmentId:'dept_languages',active:true},
    {id:'sub_mathematics',name:'Mathematics',departmentId:'dept_science',active:true},
    {id:'sub_geography',name:'Geography',departmentId:'dept_social',active:true},
    {id:'sub_science',name:'Science',departmentId:'dept_science',active:true},
    {id:'sub_commerce',name:'Commerce',departmentId:'dept_business',active:true},
    {id:'sub_civic',name:'Civic Education',departmentId:'dept_social',active:true},
    {id:'sub_chemistry',name:'Chemistry',departmentId:'dept_science',active:true},
    {id:'sub_physics',name:'Physics',departmentId:'dept_science',active:true},
    {id:'sub_biology',name:'Biology',departmentId:'dept_science',active:true}
  ];
  const subjectById = Object.fromEntries(subjects.map(x=>[x.id,x]));

  // The practice subset is deliberately small. Marks are transcribed from the uploaded
  // Lumezi Boarding Secondary School 2026 schedules, while pupil names are anonymized for safe testing.
  const classSubjects = {
    class_10l:['sub_english','sub_mathematics','sub_geography','sub_science','sub_commerce','sub_civic'],
    class_11n:['sub_english','sub_mathematics','sub_chemistry','sub_physics','sub_biology','sub_civic']
  };

  const pupilRows = {
    class_10l:[
      ['Aaron Banda','M','10L-001'],
      ['Brenda Chanda','F','10L-002'],
      ['Chisomo Daka','F','10L-003'],
      ['David Lungu','M','10L-004'],
      ['Esther Mbewe','F','10L-005']
    ],
    class_11n:[
      ['Brian Mwale','M','11N-001'],
      ['Grace Phiri','F','11N-002'],
      ['Kelvin Sakala','M','11N-003'],
      ['Mary Tembo','F','11N-004'],
      ['Victor Zulu','M','11N-005']
    ]
  };
  const pupils=[];
  for (const cls of classes) {
    (pupilRows[cls.id]||[]).forEach((row,i)=>pupils.push({
      id:`p_${cls.id}_${i+1}`, classId:cls.id, name:row[0], sex:row[1], examNo:row[2],
      parentPrimary:'', parentAltPhones:[], isRepeater:false, active:true, subjectIds:[...classSubjects[cls.id]]
    }));
  }

  const assignmentsSpec = [
    ['class_10l','sub_english',tembo], ['class_10l','sub_mathematics',hodScience], ['class_10l','sub_geography',mbewe], ['class_10l','sub_science',banda], ['class_10l','sub_commerce',sakala], ['class_10l','sub_civic',mbewe],
    ['class_11n','sub_english',tembo], ['class_11n','sub_mathematics',phiri], ['class_11n','sub_chemistry',banda], ['class_11n','sub_physics',kamanga], ['class_11n','sub_biology',hodScience], ['class_11n','sub_civic',mbewe]
  ];
  const teachingAssignments = assignmentsSpec.map(([classId,subjectId,teacher],i)=>({ id:`ta_demo_${i+1}`, classId, subjectId, teacherUserId:teacher.id, active:true }));
  for (const u of users) u.profileSetupComplete = teachingAssignments.some(a=>a.teacherUserId===u.id) || classes.some(c=>c.classTeacherUserId===u.id) || !u.roles.includes('TEACHER');
  chanda.profileSetupComplete = false;

  const assessment = {
    id:'assess_practice_2026', name:'Term 2 Mark Schedule Practice 2026', term:'Term 2', year:2026,
    dueAt:'2026-09-30T16:00:00+02:00', active:true, classIds:classes.map(c=>c.id), passMark:50, minPassSubjects:5
  };

  // Exact practice subset transcribed from the uploaded schedules. null = no mark visible on source.
  const sourceMarks = {
    class_10l: {
      sub_english:[50,68,62,50,70],
      sub_mathematics:[80,4,82,92,24],
      sub_geography:[39,42,52,52,32],
      sub_science:[61,45,70,40,51],
      sub_commerce:[71,58,72,68,69],
      sub_civic:[56,50,66,58,60]
    },
    class_11n: {
      sub_english:[43,50,40,65,36],
      sub_mathematics:[53,80,55,86,88],
      sub_chemistry:[68,64,45,75,76],
      sub_physics:[null,61,59,73,57],
      sub_biology:[63,87,68,90,72],
      sub_civic:[60,70,40,67,64]
    }
  };

  const resultSheets=[]; const notifications=[];
  teachingAssignments.forEach((a,ai)=>{
    const isPhysicsDraft = a.classId==='class_11n' && a.subjectId==='sub_physics';
    const status = isPhysicsDraft ? 'DRAFT' : 'SUBMITTED';
    const marks={}; const markStates={}; const markNotes={};
    const values = sourceMarks[a.classId]?.[a.subjectId] || [];
    pupils.filter(p=>p.classId===a.classId).forEach((p,pi)=>{
      const v = values[pi];
      if (v === null || v === undefined) {
        markStates[p.id]='PENDING';
        markNotes[p.id]='No mark is shown on the uploaded source mark schedule.';
      } else {
        marks[p.id]=v; markStates[p.id]='PRESENT';
      }
    });
    resultSheets.push({
      id:`sheet_${a.id}_${assessment.id}`,assignmentId:a.id,assessmentId:assessment.id,status,marks,markStates,markNotes,
      deadlineOverride:null,revision:1,updatedAt:'2026-09-23T10:00:00+02:00',submittedAt:status==='SUBMITTED'?'2026-09-23T10:00:00+02:00':null,
      enteredByUserId:a.teacherUserId,source:'Uploaded Lumezi 2026 mark schedule training subset'
    });
    if(status==='SUBMITTED'){
      const cls=classes.find(c=>c.id===a.classId); const teacher=users.find(u=>u.id===a.teacherUserId); const sub=subjectById[a.subjectId];
      if(cls?.classTeacherUserId) notifications.push({id:`note_${a.id}`,userId:cls.classTeacherUserId,type:'RESULT_SUBMITTED',title:`${sub.name} results received`,message:`${teacher.name} submitted ${sub.name} results for ${cls.name}.`,meta:{classId:cls.id,assignmentId:a.id,assessmentId:assessment.id},createdAt:'2026-09-23T10:01:00+02:00',readAt:null});
    }
  });

  return {
    version:2,
    school:{
      id:'school_1',name:'Lumezi Boarding Secondary School',motto:'EDUCATION WITH INTEGRITY AND VIRTUE',address:'P.O. Box 1, Lumezi',email:'lumeziboarding@edu.zm',demoMode:true,
      demoNote:'Privacy-safe training subset based on uploaded 2026 Lumezi mark schedules — marks/pending patterns preserved, pupil names anonymized.',repeatPolicy:{passMark:50,minPassSubjects:5}
    },
    users, departments, classes, subjects, assessments:[assessment], teachingAssignments, pupils, resultSheets,
    notifications, escalations:[], reportReleaseApprovals:[], reportSendLog:[], teachingClaims:[], resultMessages:[],
    auditLog:[{id:id('audit'),at:nowIso(),actorUserId:admin.id,action:'PRACTICE_SCHOOL_CREATED',detail:'Privacy-safe source-schedule training subset created: 10L and 11N, 10 anonymized pupils, 10 staff, six subjects per class'}]
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
  db.notifications ||= []; db.escalations ||= []; db.reportReleaseApprovals ||= []; db.reportSendLog ||= []; db.teachingClaims ||= []; db.resultMessages ||= []; db.auditLog ||= [];
  db.school.repeatPolicy ||= { passMark:50, minPassSubjects:5 };
  db.users.forEach(u => { if (u.phone === undefined) u.phone = ''; if (u.active === undefined) u.active = true; u.profileSetupComplete = !!u.profileSetupComplete || db.teachingAssignments.some(a=>a.teacherUserId===u.id); });
  db.classes.forEach(c => { c.gradingSystem = c.gradingSystem === 'CBC' ? 'CBC' : 'LEGACY'; if (c.active === undefined) c.active = true; });
  db.assessments.forEach(a => { a.classIds ||= []; if (a.passMark == null) a.passMark = Number(db.school.repeatPolicy.passMark || 50); if (a.minPassSubjects == null) a.minPassSubjects = Number(db.school.repeatPolicy.minPassSubjects || 5); });
  db.pupils.forEach(p => { if (p.isRepeater === undefined) p.isRepeater = false; p.parentAltPhones ||= []; p.subjectIds ||= []; p.subjectTrack ||= ''; if (p.active === undefined) p.active = true; });
  db.resultSheets.forEach(s => {
    s.marks ||= {}; s.markStates ||= {}; s.markNotes ||= {}; s.revision = Number(s.revision || 0);
    for (const pupilId of Object.keys(s.marks)) if (!s.markStates[pupilId]) s.markStates[pupilId] = 'PRESENT';
    if (s.deadlineOverride === undefined) s.deadlineOverride = null;
  });
  if (!db.subjects.some(s => String(s.name).toLowerCase() === 'physics')) {
    const dept = db.departments.find(d => /science|mathematics/i.test(d.name)) || db.departments[0];
    db.subjects.push({ id: 'sub_physics', name: 'Physics', departmentId: dept?.id || null, active: true });
  }
  return db;
}

const ENTITY_COLLECTIONS = [
  'users','departments','classes','subjects','assessments','teachingAssignments','pupils','resultSheets',
  'notifications','escalations','reportReleaseApprovals','reportSendLog','teachingClaims','resultMessages','auditLog'
];
let persistedFingerprints = new Map();

function entityKey(collection, entityId) { return `${collection}:${entityId}`; }
function stableFingerprint(value, sortIndex = 0) {
  return crypto.createHash('sha256').update(`${sortIndex}:`).update(JSON.stringify(value)).digest('hex');
}

async function initPostgres() {
  const pool = getPgPool();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS edusend_meta (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS edusend_entities (
      collection TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      sort_index INTEGER NOT NULL DEFAULT 0,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (collection, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_edusend_entities_collection_order ON edusend_entities(collection, sort_index);
    CREATE TABLE IF NOT EXISTS edusend_recovery_snapshots (
      id BIGSERIAL PRIMARY KEY,
      revision BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      data JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edusend_recovery_revision ON edusend_recovery_snapshots(revision DESC);
  `);
}

function loadLocalData() {
  if (!fs.existsSync(DATA_FILE)) return makeSeedData();
  try {
    return migrateData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (err) {
    console.error('Primary EduSend data file could not be read:', err.message);
    if (fs.existsSync(DATA_BACKUP_FILE)) {
      const recovered = migrateData(JSON.parse(fs.readFileSync(DATA_BACKUP_FILE, 'utf8')));
      console.warn('EduSend recovered data from data.json.bak');
      return recovered;
    }
    throw err;
  }
}

function capturePersistedFingerprints(state) {
  const next = new Map();
  for (const collection of ENTITY_COLLECTIONS) {
    const rows = Array.isArray(state[collection]) ? state[collection] : [];
    rows.forEach((entity, index) => {
      const entityId = String(entity?.id || `${collection}-${index}`);
      next.set(entityKey(collection, entityId), stableFingerprint(entity, index));
    });
  }
  persistedFingerprints = next;
}

async function writeFullPostgresState(state) {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const root = {
      version: Number(state.version || 2),
      school: state.school || {},
      storageMeta: state.storageMeta || {}
    };
    await client.query(
      `INSERT INTO edusend_meta (key, value, updated_at) VALUES ('root', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [JSON.stringify(root)]
    );
    await client.query('DELETE FROM edusend_entities');
    for (const collection of ENTITY_COLLECTIONS) {
      const rows = Array.isArray(state[collection]) ? state[collection] : [];
      for (let index = 0; index < rows.length; index++) {
        const entity = rows[index];
        const entityId = String(entity?.id || `${collection}-${index}`);
        await client.query(
          'INSERT INTO edusend_entities (collection, entity_id, sort_index, data, updated_at) VALUES ($1,$2,$3,$4::jsonb,NOW())',
          [collection, entityId, index, JSON.stringify(entity)]
        );
      }
    }
    await client.query('COMMIT');
    capturePersistedFingerprints(state);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally { client.release(); }
}

async function loadData() {
  if (!DATABASE_URL) {
    const local = loadLocalData();
    local.storageMeta ||= { revision:0, lastSavedAt:null, backend:'local-file' };
    local.storageMeta.backend = 'local-file';
    fs.writeFileSync(DATA_FILE, JSON.stringify(local, null, 2));
    return local;
  }

  await initPostgres();
  const pool = getPgPool();
  const metaResult = await pool.query("SELECT value, updated_at FROM edusend_meta WHERE key='root'");
  if (metaResult.rows.length) {
    const root = metaResult.rows[0].value || {};
    const state = { version:Number(root.version || 2), school:root.school || {} };
    for (const collection of ENTITY_COLLECTIONS) state[collection] = [];
    const entities = await pool.query('SELECT collection, entity_id, sort_index, data FROM edusend_entities ORDER BY collection, sort_index, entity_id');
    for (const row of entities.rows) {
      if (!ENTITY_COLLECTIONS.includes(row.collection)) continue;
      state[row.collection].push(row.data);
    }
    const loaded = migrateData(state);
    loaded.storageMeta = root.storageMeta || {};
    loaded.storageMeta.revision = Number(loaded.storageMeta.revision || 0);
    loaded.storageMeta.lastSavedAt = loaded.storageMeta.lastSavedAt || (metaResult.rows[0].updated_at ? new Date(metaResult.rows[0].updated_at).toISOString() : null);
    loaded.storageMeta.backend = 'postgresql';
    capturePersistedFingerprints(loaded);
    return loaded;
  }

  // First database connection: import existing local/repository data if available, otherwise seed.
  let initial;
  try { initial = loadLocalData(); } catch { initial = makeSeedData(); }
  initial = migrateData(initial);
  initial.storageMeta ||= { revision:0, lastSavedAt:null };
  initial.storageMeta.backend = 'postgresql';
  await writeFullPostgresState(initial);
  return initial;
}

function saveLocalSnapshot(snapshotText) {
  const tmp = `${DATA_FILE}.tmp`;
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, DATA_BACKUP_FILE); } catch (e) { console.warn('EduSend backup copy failed:', e.message); }
  }
  fs.writeFileSync(tmp, snapshotText);
  fs.renameSync(tmp, DATA_FILE);
}

async function persistPostgresEntities(state, revision, savedAt) {
  const pool = getPgPool();
  if (!pool) throw new Error('PostgreSQL is not configured');
  const client = await pool.connect();
  const nextFingerprints = new Map();
  try {
    await client.query('BEGIN');
    const root = { version:Number(state.version || 2), school:state.school || {}, storageMeta:state.storageMeta || {} };
    await client.query(
      `INSERT INTO edusend_meta (key, value, updated_at) VALUES ('root', $1::jsonb, $2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`,
      [JSON.stringify(root), savedAt]
    );

    for (const collection of ENTITY_COLLECTIONS) {
      const rows = Array.isArray(state[collection]) ? state[collection] : [];
      const currentIds = [];
      for (let index = 0; index < rows.length; index++) {
        const entity = rows[index];
        const entityId = String(entity?.id || `${collection}-${index}`);
        currentIds.push(entityId);
        const key = entityKey(collection, entityId);
        const fp = stableFingerprint(entity, index);
        nextFingerprints.set(key, fp);
        if (persistedFingerprints.get(key) === fp) continue;
        await client.query(
          `INSERT INTO edusend_entities (collection, entity_id, sort_index, data, updated_at)
           VALUES ($1,$2,$3,$4::jsonb,$5)
           ON CONFLICT (collection, entity_id) DO UPDATE SET sort_index=EXCLUDED.sort_index, data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
          [collection, entityId, index, JSON.stringify(entity), savedAt]
        );
      }
      if (currentIds.length) {
        await client.query('DELETE FROM edusend_entities WHERE collection=$1 AND NOT (entity_id = ANY($2::text[]))', [collection, currentIds]);
      } else {
        await client.query('DELETE FROM edusend_entities WHERE collection=$1', [collection]);
      }
    }

    // Extra in-database recovery checkpoint every 100 saves. Provider backups remain the primary recovery layer.
    if (revision === 1 || revision % 100 === 0) {
      await client.query('INSERT INTO edusend_recovery_snapshots (revision, created_at, data) VALUES ($1,$2,$3::jsonb)', [revision, savedAt, JSON.stringify(state)]);
      await client.query('DELETE FROM edusend_recovery_snapshots WHERE id NOT IN (SELECT id FROM edusend_recovery_snapshots ORDER BY revision DESC LIMIT 12)');
    }
    await client.query('COMMIT');
    persistedFingerprints = nextFingerprints;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally { client.release(); }
}

async function saveData() {
  db.storageMeta ||= { revision:0, lastSavedAt:null };
  db.storageMeta.revision = Number(db.storageMeta.revision || 0) + 1;
  db.storageMeta.lastSavedAt = nowIso();
  db.storageMeta.backend = STORAGE_BACKEND;
  const revision = db.storageMeta.revision;
  const savedAt = db.storageMeta.lastSavedAt;
  // Capture the exact state for this save before another request can mutate the live object.
  const snapshot = JSON.parse(JSON.stringify(db));
  const snapshotText = JSON.stringify(snapshot);

  const task = async () => {
    if (DATABASE_URL) await persistPostgresEntities(snapshot, revision, savedAt);
    else saveLocalSnapshot(snapshotText);
    return { revision, lastSavedAt:savedAt, backend:STORAGE_BACKEND };
  };
  saveQueue = saveQueue.then(task, task);
  return saveQueue;
}

let db = null;

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
      status: 'NOT_STARTED', marks: {}, markStates: {}, markNotes: {}, revision:0, deadlineOverride: null,
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


function assessmentAppliesToClass(assessment, classId) {
  if (!assessment || assessment.active === false) return false;
  const ids = Array.isArray(assessment.classIds) ? assessment.classIds : [];
  return ids.length === 0 || ids.includes(classId);
}

function pupilTakesSubject(pupil, subjectId) {
  const ids = Array.isArray(pupil?.subjectIds) ? pupil.subjectIds : [];
  return ids.length === 0 || ids.includes(subjectId);
}

function requiredSubjectIdsForPupil(pupil) {
  if (Array.isArray(pupil?.subjectIds) && pupil.subjectIds.length) return [...new Set(pupil.subjectIds)];
  return [...new Set(db.teachingAssignments.filter(a => a.classId === pupil.classId && a.active !== false).map(a => a.subjectId))];
}

function pupilReportReadiness(pupil, assessmentId) {
  const requiredSubjectIds = requiredSubjectIdsForPupil(pupil);
  const missing = [];
  let received = 0;
  for (const subjectId of requiredSubjectIds) {
    const subjectName = db.subjects.find(s=>s.id===subjectId)?.name || subjectId;
    const assignment = db.teachingAssignments.find(a => a.classId === pupil.classId && a.subjectId === subjectId && a.active !== false);
    if (!assignment) { missing.push({subjectId, subjectName, reason:'No teacher assigned'}); continue; }
    const sheet = findSheet(assignment.id, assessmentId);
    if (!sheetIsVisible(sheet)) { missing.push({...assignmentView(assignment), reason:'Subject sheet not submitted'}); continue; }
    const state = stateForPupil(sheet, pupil.id);
    if (state === 'PENDING') {
      missing.push({...assignmentView(assignment), reason:String(sheet.markNotes?.[pupil.id] || 'Result pending')});
      continue;
    }
    received++;
  }
  const release = findRelease(pupil.classId, assessmentId);
  const finalReady = requiredSubjectIds.length > 0 && missing.length === 0;
  const provisionalAllowed = !!release?.provisionalAllowed;
  return { totalSubjects:requiredSubjectIds.length, submittedSubjects:received, missingSubjects:missing, finalReady, provisionalAllowed, provisional:!finalReady && provisionalAllowed, canSend:finalReady || provisionalAllowed, approval:release || null };
}

function repeatPolicyForAssessment(assessment) {
  const base = db.school?.repeatPolicy || { passMark:50, minPassSubjects:5 };
  return {
    passMark:Number(assessment?.passMark ?? base.passMark ?? 50),
    minPassSubjects:Number(assessment?.minPassSubjects ?? base.minPassSubjects ?? 5)
  };
}

function analyzeRepeatPolicy(assessment) {
  const policy = repeatPolicyForAssessment(assessment);
  const applicableClassIds = new Set((Array.isArray(assessment?.classIds) && assessment.classIds.length) ? assessment.classIds : db.classes.filter(c=>c.active!==false).map(c=>c.id));
  const rows = [];
  for (const pupil of db.pupils.filter(p=>p.active!==false && applicableClassIds.has(p.classId))) {
    const cls = db.classes.find(c=>c.id===pupil.classId);
    const required = requiredSubjectIdsForPupil(pupil);
    let passed=0, failed=0, pending=0, absent=0;
    const below=[]; const missing=[];
    for (const subjectId of required) {
      const subject = db.subjects.find(s=>s.id===subjectId);
      const assignment = db.teachingAssignments.find(a=>a.classId===pupil.classId && a.subjectId===subjectId && a.active!==false);
      if (!assignment) { pending++; missing.push(subject?.name || subjectId); continue; }
      const sheet=findSheet(assignment.id, assessment.id);
      if (!sheetIsVisible(sheet)) { pending++; missing.push(subject?.name || subjectId); continue; }
      const state=stateForPupil(sheet,pupil.id); const mark=sheet.marks?.[pupil.id];
      if (state==='PRESENT' && Number.isFinite(Number(mark))) {
        if (Number(mark) >= policy.passMark) passed++; else { failed++; below.push({subjectId,subjectName:subject?.name||subjectId,mark:Number(mark)}); }
      } else if (state==='ABSENT') { absent++; failed++; }
      else if (state==='NOT_TAKING') { /* not required in authoritative enrolment, ignore defensive mismatch */ }
      else { pending++; missing.push(subject?.name || subjectId); }
    }
    let repeatStatus='PENDING';
    if (passed >= policy.minPassSubjects) repeatStatus='CLEAR';
    else if (passed + pending < policy.minPassSubjects) repeatStatus='REVIEW';
    else if (pending===0) repeatStatus='REVIEW';
    rows.push({ pupilId:pupil.id, pupilName:pupil.name, classId:pupil.classId, className:cls?.name||'', passedSubjects:passed, failedSubjects:failed, absentSubjects:absent, pendingSubjects:pending, requiredSubjects:required.length, belowPassMark:below, missingSubjects:missing, repeatStatus, isRepeater:!!pupil.isRepeater });
  }
  const rank={REVIEW:0,PENDING:1,CLEAR:2};
  rows.sort((a,b)=>rank[a.repeatStatus]-rank[b.repeatStatus] || a.className.localeCompare(b.className) || a.pupilName.localeCompare(b.pupilName));
  return { policy, rows, counts:{ review:rows.filter(r=>r.repeatStatus==='REVIEW').length, pending:rows.filter(r=>r.repeatStatus==='PENDING').length, clear:rows.filter(r=>r.repeatStatus==='CLEAR').length, subjectWarnings:rows.filter(r=>r.belowPassMark.length).length } };
}

function canAccessResultConversation(user, assignment) {
  return canReadSubmittedAssignment(user, assignment) || assignment?.teacherUserId === user?.id;
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
  const classPupils = db.pupils.filter(p=>p.classId===classId && p.active!==false);
  const assignments = db.teachingAssignments.filter(a => a.classId === classId && a.active !== false && classPupils.some(p=>pupilTakesSubject(p,a.subjectId)));
  const missing = [];
  let submittedSheets = 0;
  let pendingPupilResults = 0;
  for (const a of assignments) {
    const sheet = findSheet(a.id, assessmentId);
    if (!sheetIsVisible(sheet)) { missing.push({...assignmentView(a), reason:'Subject sheet not submitted'}); continue; }
    submittedSheets++;
    const pending = classPupils.filter(p=>pupilTakesSubject(p,a.subjectId) && stateForPupil(sheet,p.id)==='PENDING');
    if (pending.length) {
      pendingPupilResults += pending.length;
      missing.push({...assignmentView(a), reason:`${pending.length} pupil result${pending.length===1?'':'s'} pending`, pendingPupilCount:pending.length, pendingPupilNames:pending.map(p=>p.name)});
    }
  }
  const release = findRelease(classId, assessmentId);
  const finalReady = assignments.length > 0 && missing.length === 0;
  const provisionalAllowed = !!release?.provisionalAllowed;
  return {
    totalSubjects: assignments.length,
    submittedSubjects: submittedSheets,
    pendingPupilResults,
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

function canReadSubmittedAssignment(user, assignment) {
  if (!user || !assignment) return false;
  if (assignment.teacherUserId === user.id) return true;
  if (isAdminOrHead(user)) return true;
  const cls = db.classes.find(c => c.id === assignment.classId && c.active !== false);
  if (cls?.classTeacherUserId === user.id) return true;
  const subject = db.subjects.find(s => s.id === assignment.subjectId && s.active !== false);
  const dept = db.departments.find(d => d.id === subject?.departmentId);
  if (hasRole(user, 'HOD') && (dept?.hodUserId === user.id || belongsToDepartment(user, subject?.departmentId))) return true;
  return false;
}

function practiceMark(assignmentIndex, pupilIndex) {
  return 45 + ((assignmentIndex * 13 + pupilIndex * 7) % 48); // 45–92
}

function setPracticeSheetData(assignment, assessment, assignmentIndex, mode) {
  const sheet = ensureSheet(assignment, assessment.id, assignment.teacherUserId);
  const pupils = db.pupils.filter(p => p.classId === assignment.classId && p.active !== false);
  const marks = {}; const markStates = {};
  if (mode === 'NOT_STARTED') {
    sheet.status = 'NOT_STARTED'; sheet.marks = {}; sheet.markStates = {}; sheet.updatedAt = null; sheet.submittedAt = null;
    sheet.enteredByUserId = assignment.teacherUserId; sheet.source = 'Practice simulator';
    return sheet;
  }
  pupils.forEach((p, pi) => {
    const takes = Array.isArray(p.subjectIds) ? p.subjectIds.includes(assignment.subjectId) : true;
    if (!takes) { markStates[p.id] = 'NOT_TAKING'; return; }
    if (mode === 'DRAFT' && pi >= 2) { markStates[p.id] = 'PENDING'; return; }
    marks[p.id] = practiceMark(assignmentIndex, pi);
    markStates[p.id] = 'PRESENT';
  });
  sheet.marks = marks; sheet.markStates = markStates; sheet.updatedAt = nowIso(); sheet.enteredByUserId = assignment.teacherUserId; sheet.source = 'Practice simulator';
  if (mode === 'SUBMITTED') { sheet.status = 'SUBMITTED'; sheet.submittedAt = nowIso(); }
  else { sheet.status = 'DRAFT'; sheet.submittedAt = null; }
  return sheet;
}

async function api(req, res, urlObj) {
  const pathname = urlObj.pathname;

  if (req.method === 'GET' && pathname === '/api/version') return sendJson(res, 200, { version: APP_VERSION, storageRevision: db.storageMeta?.revision || 0, lastSavedAt: db.storageMeta?.lastSavedAt || null, storageBackend: STORAGE_BACKEND, databaseConnected: !!DATABASE_URL });

  // Practice-only name suggestions for the simple training login. No password is exposed by this endpoint.
  if (req.method === 'GET' && pathname === '/api/demo-accounts') {
    if (!db.school?.demoMode) return sendJson(res, 200, { demoMode:false, accounts:[] });
    const accounts = db.users.filter(u=>u.active!==false).map(u=>({id:u.id,name:u.name,username:u.username,roles:u.roles||[]}));
    return sendJson(res,200,{demoMode:true,accounts});
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(req);
    const identifier = String(body.identifier || body.username || body.name || '').trim().toLowerCase();
    const password = String(body.password || body.pin || '');
    let matches = db.users.filter(u => u.active !== false && (u.username === identifier || String(u.name||'').toLowerCase() === identifier));
    if (!matches.length && identifier.length >= 3) matches = db.users.filter(u => u.active !== false && String(u.name||'').toLowerCase().includes(identifier));
    if (matches.length > 1) return sendError(res, 400, 'More than one staff member matches that name. Enter your staff ID instead.');
    const user = matches[0];
    if (!user || !verifyPassword(password, user.passwordHash)) return sendError(res, 401, 'Name/staff ID or PIN is incorrect');
    audit(user.id, 'LOGIN', identifier); await saveData();
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


  if (req.method === 'GET' && pathname === '/api/profile/options') {
    const assignments = db.teachingAssignments.filter(a=>a.active!==false && a.teacherUserId===user.id).map(assignmentView);
    const classTeacherClasses = db.classes.filter(c=>c.active!==false && c.classTeacherUserId===user.id).map(c=>({id:c.id,name:c.name,level:c.level}));
    const claims = db.teachingClaims.filter(c=>c.userId===user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    return sendJson(res,200,{ user:safeUser(user), classes:db.classes.filter(c=>c.active!==false), subjects:db.subjects.filter(s=>s.active!==false), assignments, classTeacherClasses, claims });
  }

  if (req.method === 'POST' && pathname === '/api/profile/phone') {
    const body=await readJson(req); user.phone=String(body.phone||'').trim().slice(0,40); user.profileSetupComplete=true;
    audit(user.id,'STAFF_PHONE_UPDATED',user.phone?'Phone saved':'Phone cleared'); await saveData();
    return sendJson(res,200,{user:safeUser(user)});
  }

  if (req.method === 'POST' && pathname === '/api/profile/claims') {
    if (!hasRole(user,'TEACHER')) return sendError(res,403,'Teacher access required');
    const body=await readJson(req); const requested=[];
    user.phone=String(body.phone ?? user.phone ?? '').trim().slice(0,40); user.profileSetupComplete=true;
    const rows=Array.isArray(body.assignments)?body.assignments:[];
    for (const row of rows.slice(0,40)) {
      const cls=db.classes.find(c=>c.id===row.classId&&c.active!==false); const subject=db.subjects.find(s=>s.id===row.subjectId&&s.active!==false);
      if (!cls||!subject) continue;
      const existingApproved=db.teachingAssignments.find(a=>a.classId===cls.id&&a.subjectId===subject.id&&a.active!==false&&a.teacherUserId===user.id);
      if (existingApproved) continue;
      const existing=db.teachingClaims.find(c=>c.userId===user.id&&c.type==='SUBJECT'&&c.classId===cls.id&&c.subjectId===subject.id&&c.status==='PENDING');
      if (existing) { requested.push(existing); continue; }
      const claim={id:id('claim'),userId:user.id,type:'SUBJECT',classId:cls.id,subjectId:subject.id,status:'PENDING',createdAt:nowIso(),decidedAt:null,decidedByUserId:null,note:''}; db.teachingClaims.unshift(claim); requested.push(claim);
      const dept=db.departments.find(d=>d.id===subject.departmentId); createNotification(dept?.hodUserId,'TEACHING_CLAIM',`Teaching claim: ${cls.name} ${subject.name}`,`${user.name} says they teach ${subject.name} in ${cls.name}. Approve or decline the claim.`,{claimId:claim.id});
    }
    if (body.classTeacherClassId) {
      const cls=db.classes.find(c=>c.id===body.classTeacherClassId&&c.active!==false);
      if (cls && cls.classTeacherUserId!==user.id && !db.teachingClaims.some(c=>c.userId===user.id&&c.type==='CLASS_TEACHER'&&c.classId===cls.id&&c.status==='PENDING')) {
        const claim={id:id('claim'),userId:user.id,type:'CLASS_TEACHER',classId:cls.id,subjectId:null,status:'PENDING',createdAt:nowIso(),decidedAt:null,decidedByUserId:null,note:''}; db.teachingClaims.unshift(claim); requested.push(claim);
        createNotification(db.users.filter(u=>hasRole(u,'ADMIN')||hasRole(u,'HEAD')).map(u=>u.id),'CLASS_TEACHER_CLAIM',`Class teacher claim: ${cls.name}`,`${user.name} says they are the class teacher for ${cls.name}.`,{claimId:claim.id});
      }
    }
    audit(user.id,'TEACHING_PROFILE_SUBMITTED',`${requested.length} claim(s)`); await saveData();
    return sendJson(res,201,{claims:requested,user:safeUser(user)});
  }

  if (req.method === 'GET' && pathname === '/api/hod/claims') {
    const dept=getDepartmentForHod(user); if(!dept) return sendError(res,403,'HOD access required');
    const rows=db.teachingClaims.filter(c=>c.type==='SUBJECT').map(c=>{
      const subject=db.subjects.find(s=>s.id===c.subjectId); if(subject?.departmentId!==dept.id) return null;
      const cls=db.classes.find(x=>x.id===c.classId); const claimant=db.users.find(x=>x.id===c.userId);
      return {...c,className:cls?.name||'',subjectName:subject?.name||'',teacherName:claimant?.name||'',teacherPhone:claimant?.phone||''};
    }).filter(Boolean).sort((a,b)=>(a.status==='PENDING'?0:1)-(b.status==='PENDING'?0:1)||new Date(b.createdAt)-new Date(a.createdAt));
    return sendJson(res,200,{department:dept,claims:rows});
  }

  if (req.method === 'POST' && pathname === '/api/hod/claim-decision') {
    const dept=getDepartmentForHod(user); if(!dept) return sendError(res,403,'HOD access required');
    const body=await readJson(req); const claim=db.teachingClaims.find(c=>c.id===body.claimId&&c.type==='SUBJECT');
    if(!claim) return sendError(res,404,'Teaching claim not found'); const subject=db.subjects.find(s=>s.id===claim.subjectId);
    if(subject?.departmentId!==dept.id) return sendError(res,403,'This claim is outside your department');
    if(claim.status!=='PENDING') return sendError(res,409,'This claim has already been decided');
    const approve=!!body.approve; claim.status=approve?'APPROVED':'DECLINED'; claim.decidedAt=nowIso(); claim.decidedByUserId=user.id; claim.note=String(body.note||'').trim();
    if(approve){
      const conflict=db.teachingAssignments.find(a=>a.classId===claim.classId&&a.subjectId===claim.subjectId&&a.active!==false&&a.teacherUserId!==claim.userId);
      if(conflict){ claim.status='PENDING'; claim.decidedAt=null; claim.decidedByUserId=null; return sendError(res,409,`This class/subject is already assigned to ${assignmentView(conflict).teacherName}. Resolve that assignment first.`); }
      let a=db.teachingAssignments.find(a=>a.classId===claim.classId&&a.subjectId===claim.subjectId&&a.active!==false);
      if(a) a.teacherUserId=claim.userId; else { a={id:id('ta'),classId:claim.classId,subjectId:claim.subjectId,teacherUserId:claim.userId,active:true}; db.teachingAssignments.push(a); }
    }
    const teacher=db.users.find(u=>u.id===claim.userId); const cls=db.classes.find(c=>c.id===claim.classId);
    createNotification(claim.userId,'TEACHING_CLAIM_DECISION',approve?'Teaching claim approved':'Teaching claim declined',`${subject?.name||'Subject'} • ${cls?.name||'Class'}${claim.note?` — ${claim.note}`:''}`,{claimId:claim.id});
    audit(user.id,approve?'TEACHING_CLAIM_APPROVED':'TEACHING_CLAIM_DECLINED',claim.id); await saveData();
    return sendJson(res,200,{claim,teacher:safeUser(teacher)});
  }

  if (req.method === 'GET' && pathname === '/api/admin/class-teacher-claims') {
    if(!isAdminOrHead(user)) return sendError(res,403,'Administration access required');
    const rows=db.teachingClaims.filter(c=>c.type==='CLASS_TEACHER').map(c=>({...c,className:db.classes.find(x=>x.id===c.classId)?.name||'',teacherName:db.users.find(x=>x.id===c.userId)?.name||'',teacherPhone:db.users.find(x=>x.id===c.userId)?.phone||''})).sort((a,b)=>(a.status==='PENDING'?0:1)-(b.status==='PENDING'?0:1)||new Date(b.createdAt)-new Date(a.createdAt));
    return sendJson(res,200,{claims:rows});
  }

  if (req.method === 'POST' && pathname === '/api/admin/class-teacher-claim-decision') {
    if(!isAdminOrHead(user)) return sendError(res,403,'Administration access required');
    const body=await readJson(req); const claim=db.teachingClaims.find(c=>c.id===body.claimId&&c.type==='CLASS_TEACHER'); if(!claim) return sendError(res,404,'Class teacher claim not found');
    if(claim.status!=='PENDING') return sendError(res,409,'This claim has already been decided'); const approve=!!body.approve; const cls=db.classes.find(c=>c.id===claim.classId);
    claim.status=approve?'APPROVED':'DECLINED'; claim.decidedAt=nowIso(); claim.decidedByUserId=user.id; claim.note=String(body.note||'').trim();
    if(approve && cls){ const old=cls.classTeacherUserId; cls.classTeacherUserId=claim.userId; if(old&&old!==claim.userId) createNotification(old,'CLASS_TEACHER_CHANGED','Class teacher assignment changed',`You are no longer the class teacher for ${cls.name}.`,{classId:cls.id}); }
    createNotification(claim.userId,'CLASS_TEACHER_CLAIM_DECISION',approve?'Class teacher claim approved':'Class teacher claim declined',`${cls?.name||'Class'}${claim.note?` — ${claim.note}`:''}`,{claimId:claim.id});
    audit(user.id,approve?'CLASS_TEACHER_CLAIM_APPROVED':'CLASS_TEACHER_CLAIM_DECLINED',claim.id); await saveData(); broadcastEvent({type:'CLASS_TEACHER_UPDATED',classId:claim.classId,teacherUserId:approve?claim.userId:null},[claim.userId]);
    return sendJson(res,200,{claim});
  }

  if (req.method === 'GET' && pathname === '/api/result-messages') {
    const assignmentId=urlObj.searchParams.get('assignmentId'); const assessmentId=urlObj.searchParams.get('assessmentId'); const assignment=db.teachingAssignments.find(a=>a.id===assignmentId&&a.active!==false);
    if(!assignment||!canAccessResultConversation(user,assignment)) return sendError(res,403,'You do not have access to this result conversation');
    const pupilId=urlObj.searchParams.get('pupilId')||'';
    const rows=db.resultMessages.filter(m=>m.assignmentId===assignmentId&&m.assessmentId===assessmentId&&(!pupilId||m.pupilId===pupilId)).map(m=>({...m,fromName:db.users.find(u=>u.id===m.fromUserId)?.name||'Staff'})).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
    return sendJson(res,200,{messages:rows});
  }

  if (req.method === 'POST' && pathname === '/api/result-messages') {
    const body=await readJson(req); const assignment=db.teachingAssignments.find(a=>a.id===body.assignmentId&&a.active!==false); if(!assignment||!canAccessResultConversation(user,assignment)) return sendError(res,403,'You do not have access to this result conversation');
    const text=String(body.text||'').trim().slice(0,1000); if(!text) return sendError(res,400,'Write a short message first'); const pupilId=String(body.pupilId||'');
    const msg={id:id('msg'),assignmentId:assignment.id,assessmentId:String(body.assessmentId||''),pupilId,fromUserId:user.id,text,createdAt:nowIso(),resolved:false}; db.resultMessages.push(msg);
    const cls=db.classes.find(c=>c.id===assignment.classId); const recipientIds=[assignment.teacherUserId,cls?.classTeacherUserId].filter(uid=>uid&&uid!==user.id);
    createNotification(recipientIds,'RESULT_MESSAGE',`Result question: ${assignmentView(assignment).className} ${assignmentView(assignment).subjectName}`,`${user.name}: ${text}`,{assignmentId:assignment.id,assessmentId:msg.assessmentId,pupilId});
    audit(user.id,'RESULT_MESSAGE_SENT',assignment.id); await saveData(); return sendJson(res,201,{message:{...msg,fromName:user.name}});
  }

  if (req.method === 'POST' && pathname === '/api/report-release/request') {
    const body=await readJson(req); const cls=db.classes.find(c=>c.id===body.classId&&c.active!==false); if(!cls||cls.classTeacherUserId!==user.id) return sendError(res,403,'Only the class teacher can request incomplete-report release');
    const assessment=db.assessments.find(a=>a.id===body.assessmentId&&a.active!==false); if(!assessment) return sendError(res,404,'Assessment not found');
    const readiness=reportReadiness(cls.id,assessment.id); if(readiness.finalReady) return sendError(res,409,'All subjects are already complete; approval is not required');
    let release=findRelease(cls.id,assessment.id); if(!release){release={id:id('release'),classId:cls.id,assessmentId:assessment.id};db.reportReleaseApprovals.push(release);} release.status='REQUESTED'; release.provisionalAllowed=false; release.requestedAt=nowIso(); release.requestedByUserId=user.id; release.requestReason=String(body.reason||'').trim(); release.missingSnapshot=readiness.missingSubjects.map(x=>x.subjectName);
    createNotification(db.users.filter(u=>hasRole(u,'ADMIN')||hasRole(u,'HEAD')).map(u=>u.id),'REPORT_RELEASE_REQUEST',`Incomplete report approval: ${cls.name}`,`${user.name} requests permission to send ${assessment.name} reports with ${readiness.submittedSubjects}/${readiness.totalSubjects} subjects received.`,{releaseId:release.id,classId:cls.id,assessmentId:assessment.id});
    audit(user.id,'REPORT_RELEASE_REQUESTED',`${cls.name}/${assessment.name}`); await saveData(); return sendJson(res,201,{release});
  }

  if (req.method === 'GET' && pathname === '/api/report-release/requests') {
    if(!isAdminOrHead(user)) return sendError(res,403,'Administration access required');
    const rows=db.reportReleaseApprovals.map(r=>({...r,className:db.classes.find(c=>c.id===r.classId)?.name||'',assessmentName:db.assessments.find(a=>a.id===r.assessmentId)?.name||'',requestedByName:db.users.find(u=>u.id===r.requestedByUserId)?.name||'',approvedByName:db.users.find(u=>u.id===r.approvedByUserId)?.name||''})).sort((a,b)=>(a.status==='REQUESTED'?0:1)-(b.status==='REQUESTED'?0:1)||new Date(b.requestedAt||b.approvedAt||0)-new Date(a.requestedAt||a.approvedAt||0));
    return sendJson(res,200,{requests:rows});
  }

  if (req.method === 'POST' && pathname === '/api/report-release/decision') {
    if(!isAdminOrHead(user)) return sendError(res,403,'Administration access required'); const body=await readJson(req); const release=db.reportReleaseApprovals.find(r=>r.id===body.releaseId); if(!release) return sendError(res,404,'Release request not found');
    const approve=!!body.approve; release.status=approve?'APPROVED':'DECLINED'; release.provisionalAllowed=approve; release.approvedAt=nowIso(); release.approvedByUserId=user.id; release.reason=String(body.reason||'').trim(); const cls=db.classes.find(c=>c.id===release.classId); const assessment=db.assessments.find(a=>a.id===release.assessmentId);
    createNotification(cls?.classTeacherUserId,'REPORT_RELEASE_DECISION',approve?'Incomplete reports approved':'Incomplete reports not approved',`${assessment?.name||'Assessment'} • ${cls?.name||'Class'}${release.reason?` — ${release.reason}`:''}`,{releaseId:release.id}); audit(user.id,approve?'REPORT_RELEASE_APPROVED':'REPORT_RELEASE_DECLINED',release.id); await saveData(); return sendJson(res,200,{release});
  }

  if (req.method === 'GET' && pathname === '/api/admin/repeat-policy') {
    if(!isAdminOrHead(user)) return sendError(res,403,'Administration access required'); const assessmentId=urlObj.searchParams.get('assessmentId')||db.assessments.find(a=>a.active!==false)?.id; const assessment=db.assessments.find(a=>a.id===assessmentId&&a.active!==false); if(!assessment) return sendError(res,404,'Assessment not found');
    return sendJson(res,200,{assessment,...analyzeRepeatPolicy(assessment)});
  }

  if (req.method === 'POST' && pathname === '/api/admin/repeat-policy') {
    if(!isAdminOrHead(user)) return sendError(res,403,'Administration access required'); const body=await readJson(req); const assessment=db.assessments.find(a=>a.id===body.assessmentId&&a.active!==false); if(!assessment) return sendError(res,404,'Assessment not found'); const passMark=Number(body.passMark), minPassSubjects=Number(body.minPassSubjects); if(!Number.isFinite(passMark)||passMark<0||passMark>100||!Number.isInteger(minPassSubjects)||minPassSubjects<1||minPassSubjects>20) return sendError(res,400,'Enter a valid pass mark and minimum number of subjects'); assessment.passMark=passMark; assessment.minPassSubjects=minPassSubjects; db.school.repeatPolicy={passMark,minPassSubjects}; audit(user.id,'REPEAT_POLICY_UPDATED',`${assessment.name}: ${passMark}% in ${minPassSubjects} subjects`); await saveData(); return sendJson(res,200,{assessment,policy:repeatPolicyForAssessment(assessment)});
  }

  if (req.method === 'GET' && pathname === '/api/assessments') {
    let assessments=db.assessments.filter(a=>a.active!==false);
    if(!isAdminOrHead(user) && !hasRole(user,'HOD')){
      const classIds=new Set([
        ...db.teachingAssignments.filter(a=>a.active!==false&&a.teacherUserId===user.id).map(a=>a.classId),
        ...db.classes.filter(c=>c.active!==false&&c.classTeacherUserId===user.id).map(c=>c.id)
      ]);
      assessments=assessments.filter(a=>{const ids=Array.isArray(a.classIds)?a.classIds:[];return ids.length===0||ids.some(id=>classIds.has(id));});
    }
    return sendJson(res, 200, { assessments: assessments.sort((a, b) => new Date(b.dueAt) - new Date(a.dueAt)) });
  }

  if (req.method === 'GET' && pathname === '/api/notifications') {
    const notes = db.notifications.filter(n => n.userId === user.id).slice(0, 100);
    return sendJson(res, 200, { notifications: notes, unread: notes.filter(n => !n.readAt).length });
  }

  if (req.method === 'POST' && pathname === '/api/notifications/read') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
    db.notifications.forEach(n => { if (n.userId === user.id && !n.readAt && (!ids || ids.has(n.id))) n.readAt = nowIso(); });
    await saveData(); return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/reminders') {
    const own = db.teachingAssignments.filter(a => a.active !== false && a.teacherUserId === user.id);
    const reminders = [];
    for (const assignment of own) {
      for (const assessment of db.assessments.filter(a => a.active !== false && assessmentAppliesToClass(a, assignment.classId))) {
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
      const sheets = db.assessments.filter(x => x.active !== false && assessmentAppliesToClass(x, a.classId)).map(assessment => {
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
    if (!assessmentAppliesToClass(assessment, assignment.classId)) return sendError(res, 403, 'This assessment is not assigned to this class');
    const pupils = db.pupils.filter(p => p.classId === assignment.classId && p.active !== false).map(p => ({ id: p.id, name: p.name, sex: p.sex, examNo: p.examNo || '', isRepeater: !!p.isRepeater, takesSubject:pupilTakesSubject(p, assignment.subjectId) }));
    const sheet = ensureSheet(assignment, assessmentId, user.id);
    return sendJson(res, 200, {
      assignment: assignmentView(assignment), assessment,
      sheet: { id: sheet.id, status: sheet.status, marks: sheet.marks || {}, markStates: sheet.markStates || {}, markNotes:sheet.markNotes || {}, revision:Number(sheet.revision||0), updatedAt: sheet.updatedAt, submittedAt: sheet.submittedAt, deadline: getDeadlineState(assessment, sheet.status, sheet) },
      pupils
    });
  }

  if (req.method === 'PUT' && pathname === '/api/teacher/sheet') {
    const body = await readJson(req);
    const assignment = db.teachingAssignments.find(a => a.id === body.assignmentId && a.active !== false);
    if (!assignment || assignment.teacherUserId !== user.id) return sendError(res, 403, 'You may only edit your approved subject');
    const assessment = db.assessments.find(a => a.id === body.assessmentId && a.active !== false);
    if (!assessment) return sendError(res, 404, 'Assessment not found');
    if (!assessmentAppliesToClass(assessment, assignment.classId)) return sendError(res, 403, 'This assessment is not assigned to this class');
    const sheet = ensureSheet(assignment, assessment.id, user.id);
    if (sheet.status === 'LOCKED') return sendError(res, 409, 'This result sheet has been locked by administration');
    const requestedAction = String(body.action || 'draft').toLowerCase();
    const correctionMode = requestedAction === 'correct' || (sheet.status === 'CORRECTION_REQUESTED' && requestedAction === 'submit');
    if (sheet.status === 'SUBMITTED' && !correctionMode) return sendError(res, 409, 'This sheet is already submitted. Use Correct a Mistake to change your own subject results.');
    if (sheet.status === 'CORRECTION_REQUESTED' && !correctionMode) return sendError(res, 409, 'A correction is pending. Open the sheet and save the correction.');
    if (requestedAction === 'correct' && !['SUBMITTED','CORRECTION_REQUESTED'].includes(sheet.status)) return sendError(res, 409, 'Corrections are only used after a result sheet has been submitted.');
    const previous = {
      status: sheet.status,
      marks: { ...(sheet.marks || {}) },
      markStates: { ...(sheet.markStates || {}) },
      markNotes: { ...(sheet.markNotes || {}) },
      submittedAt: sheet.submittedAt || null
    };
    const expectedRevision = body.expectedRevision;
    if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== Number(sheet.revision || 0)) {
      return sendError(res, 409, `A newer version of this result sheet exists (server revision ${sheet.revision || 0}). Reopen the sheet before saving.`);
    }

    const classPupils = db.pupils.filter(p => p.classId === assignment.classId && p.active !== false);
    const validIds = new Set(classPupils.map(p => p.id));
    const rows = Array.isArray(body.rows) ? body.rows : Array.isArray(body.marks) ? body.marks : [];
    const rowMap = new Map(rows.filter(r=>validIds.has(r.pupilId)).map(r=>[r.pupilId,r]));
    const marks = {}; const markStates = {}; const markNotes = {};
    for (const p of classPupils) {
      if (!pupilTakesSubject(p, assignment.subjectId)) {
        markStates[p.id] = 'NOT_TAKING';
        continue;
      }
      const row = rowMap.get(p.id) || {};
      const mark = normalizeMark(row.mark);
      if (mark === undefined) return sendError(res, 400, `Invalid mark for ${p.name}. Marks must be 0–100 or blank.`);
      let state = String(row.state || '').toUpperCase();
      if (state === 'NOT_TAKING') return sendError(res, 400, `${p.name} is registered for ${assignmentView(assignment).subjectName}. Only school enrolment can mark a subject as Not Taking.`);
      if (mark !== null) state = 'PRESENT';
      if (!['PRESENT','ABSENT','PENDING'].includes(state)) state = mark !== null ? 'PRESENT' : 'PENDING';
      if (state === 'PRESENT' && mark === null) state = 'PENDING';
      if (mark !== null) marks[p.id] = mark;
      markStates[p.id] = state;
      const note = String(row.note || '').trim().slice(0,300);
      if (note) markNotes[p.id] = note;
    }

    const action = correctionMode ? 'correct' : requestedAction === 'submit' ? 'submit' : 'draft';
    const pending = classPupils.filter(p => pupilTakesSubject(p, assignment.subjectId) && (markStates[p.id] || 'PENDING') === 'PENDING' && !String(markNotes[p.id] || '').trim());
    if ((action === 'submit' || action === 'correct') && pending.length) return sendError(res, 400, `${pending.length} pupil${pending.length === 1 ? '' : 's'} still have a missing result with no explanation. Enter a mark or choose a reason first.`);

    let correctionInfo = null;
    if (action === 'correct') {
      let correctionReason = String(body.correctionReason || '').trim().slice(0, 300);
      if (!correctionReason && previous.status === 'CORRECTION_REQUESTED') correctionReason = 'Correction requested by class teacher';
      if (correctionReason.length < 3) return sendError(res, 400, 'Give a short reason for the correction.');
      const changes = [];
      for (const p of classPupils) {
        if (!pupilTakesSubject(p, assignment.subjectId)) continue;
        const oldMark = Object.prototype.hasOwnProperty.call(previous.marks, p.id) ? previous.marks[p.id] : null;
        const newMark = Object.prototype.hasOwnProperty.call(marks, p.id) ? marks[p.id] : null;
        const oldState = previous.markStates[p.id] || (oldMark !== null ? 'PRESENT' : 'PENDING');
        const newState = markStates[p.id] || (newMark !== null ? 'PRESENT' : 'PENDING');
        const oldNote = previous.markNotes[p.id] || '';
        const newNote = markNotes[p.id] || '';
        if (oldMark !== newMark || oldState !== newState || oldNote !== newNote) changes.push({ pupilId:p.id, pupilName:p.name, oldMark, newMark, oldState, newState, oldNote, newNote });
      }
      if (!changes.length) return sendError(res, 400, 'No result changes were detected.');
      sheet.marks = marks; sheet.markStates = markStates; sheet.markNotes = markNotes; sheet.updatedAt = nowIso(); sheet.enteredByUserId = user.id;
      sheet.status = 'SUBMITTED'; sheet.submittedAt = nowIso(); sheet.correctedAt = sheet.updatedAt;
      sheet.corrections ||= [];
      const correction = { id:id('corr'), at:sheet.correctedAt, byUserId:user.id, reason:correctionReason, previousSubmittedAt:previous.submittedAt, changes };
      sheet.corrections.unshift(correction); sheet.corrections = sheet.corrections.slice(0, 100);
      const affectedPupilIds = new Set(changes.map(x=>x.pupilId));
      const affectedSentPupilIds = new Set(db.reportSendLog.filter(x => x.classId === assignment.classId && x.assessmentId === assessment.id && affectedPupilIds.has(x.pupilId) && ['SHARED','CONFIRMED_SENT'].includes(String(x.stage||'').toUpperCase())).map(x=>x.pupilId));
      const cls = db.classes.find(c => c.id === assignment.classId); const subject = db.subjects.find(s => s.id === assignment.subjectId);
      const dept = db.departments.find(d => d.id === subject?.departmentId);
      const recipients = [...new Set([cls?.classTeacherUserId, dept?.hodUserId, ...db.users.filter(u => hasRole(u, 'ADMIN') || hasRole(u,'HEAD')).map(u => u.id)].filter(Boolean))];
      const resendText = affectedSentPupilIds.size ? ` ${affectedSentPupilIds.size} affected pupil report${affectedSentPupilIds.size===1?' has':'s have'} already been shared/sent and may need to be resent.` : '';
      createNotification(recipients, 'RESULTS_CORRECTED', `${subject?.name || 'Subject'} results corrected`, `${user.name} corrected ${changes.length} result${changes.length===1?'':'s'} for ${cls?.name || 'class'}. Reason: ${correctionReason}.${resendText}`, { classId:assignment.classId, subjectId:assignment.subjectId, assessmentId:assessment.id, assignmentId:assignment.id, changedPupilIds:[...affectedPupilIds], affectedSentReports:affectedSentPupilIds.size });
      audit(user.id, 'RESULTS_CORRECTED', `${assignment.classId}/${assignment.subjectId}/${assessment.id} • ${changes.length} change(s) • ${correctionReason}`);
      correctionInfo = { changedCount:changes.length, affectedSentReports:affectedSentPupilIds.size, reason:correctionReason };
    } else {
      sheet.marks = marks; sheet.markStates = markStates; sheet.markNotes = markNotes; sheet.updatedAt = nowIso(); sheet.enteredByUserId = user.id;
      if (action === 'submit') {
        sheet.status = 'SUBMITTED'; sheet.submittedAt = nowIso();
        audit(user.id, 'RESULTS_SUBMITTED', `${assignment.classId}/${assignment.subjectId}/${assessment.id}`);
        const cls = db.classes.find(c => c.id === assignment.classId); const subject = db.subjects.find(s => s.id === assignment.subjectId);
        const dept = db.departments.find(d => d.id === subject?.departmentId);
        const recipients = [...new Set([cls?.classTeacherUserId, dept?.hodUserId, ...db.users.filter(u => hasRole(u, 'ADMIN') || hasRole(u,'HEAD')).map(u => u.id)].filter(Boolean))];
        createNotification(recipients, 'RESULTS_SUBMITTED', `${subject?.name || 'Subject'} results received`, `${user.name} submitted ${subject?.name || 'subject'} results for ${cls?.name || 'class'} (${classPupils.filter(p=>pupilTakesSubject(p,assignment.subjectId)).length} pupils taking the subject).`, { classId: assignment.classId, subjectId: assignment.subjectId, assessmentId: assessment.id, assignmentId: assignment.id });
      } else {
        sheet.status = Object.keys(marks).length || Object.values(markStates).some(s => !['PENDING','NOT_TAKING'].includes(s)) ? 'DRAFT' : 'NOT_STARTED';
        audit(user.id, 'RESULTS_DRAFT_AUTOSAVED', `${assignment.classId}/${assignment.subjectId}/${assessment.id}`);
      }
    }
    sheet.revision = Number(sheet.revision || 0) + 1;
    const storage = await saveData();
    broadcastEvent({ type: 'RESULT_SHEET_UPDATED', classId: assignment.classId, subjectId: assignment.subjectId, assessmentId: assessment.id, assignmentId: assignment.id, status: sheet.status, revision:sheet.revision, at: sheet.updatedAt }, escalationAudienceForAssignment(assignment));
    const cls = db.classes.find(c => c.id === assignment.classId);
    const subject = db.subjects.find(s => s.id === assignment.subjectId);
    const classTeacher = db.users.find(u => u.id === cls?.classTeacherUserId && u.active !== false);
    return sendJson(res, 200, {
      ok:true, status:sheet.status, revision:sheet.revision, updatedAt:sheet.updatedAt, submittedAt:sheet.submittedAt,
      className:cls?.name || '', subjectName:subject?.name || '',
      classTeacherName:classTeacher?.name || '', classTeacherAssigned:!!classTeacher,
      correction: correctionInfo,
      storageRevision:storage.revision, storageSavedAt:storage.lastSavedAt
    });
  }

  if (req.method === 'GET' && pathname === '/api/results/read-only') {
    const assignmentId = urlObj.searchParams.get('assignmentId');
    const assessmentId = urlObj.searchParams.get('assessmentId');
    const assignment = db.teachingAssignments.find(a => a.id === assignmentId && a.active !== false);
    if (!assignment || !canReadSubmittedAssignment(user, assignment)) return sendError(res, 403, 'You do not have permission to view this result sheet');
    const assessment = db.assessments.find(a => a.id === assessmentId && a.active !== false);
    if (!assessment) return sendError(res, 404, 'Assessment not found');
    const sheet = findSheet(assignment.id, assessment.id);
    if (!sheet || !sheetIsVisible(sheet)) return sendError(res, 409, 'Marks become visible to class teachers, HODs and administration only after the subject teacher submits them');
    const pupils = db.pupils.filter(p => p.classId === assignment.classId && p.active !== false).map(p => {
      const r = resultRowForPupil(sheet, p.id);
      return { id:p.id, name:p.name, examNo:p.examNo || '', isRepeater:!!p.isRepeater, mark:r.mark, state:r.state, note:sheet.markNotes?.[p.id] || '' };
    });
    const teacher = db.users.find(u=>u.id===assignment.teacherUserId);
    return sendJson(res, 200, { readOnly:true, assignment:assignmentView(assignment), assessment, status:sheet.status, submittedAt:sheet.submittedAt, updatedAt:sheet.updatedAt, teacherPhone:teacher?.phone || '', pupils });
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
    if (!assessmentAppliesToClass(assessment, classId)) return sendError(res, 403, 'This assessment is not assigned to this class');
    const assignments = db.teachingAssignments.filter(a => a.classId === classId && a.active !== false).map(assignmentView);
    const subjects = assignments.map(a => {
      const sheet = findSheet(a.id, assessmentId);
      const escalation = db.escalations.find(e => e.assignmentId === a.id && e.assessmentId === assessmentId && !['RESOLVED', 'CLOSED'].includes(e.status));
      return {
        assignmentId: a.id, subjectId: a.subjectId, subjectName: a.subjectName, teacherName: a.teacherName, teacherPhone: db.users.find(u=>u.id===a.teacherUserId)?.phone || '',
        status: sheet?.status || 'NOT_STARTED', updatedAt: sheet?.updatedAt || null, submittedAt: sheet?.submittedAt || null,
        deadline: getDeadlineState(assessment, sheet?.status || 'NOT_STARTED', sheet), escalation: escalation || null
      };
    });
    const pupils = db.pupils.filter(p => p.classId === classId && p.active !== false).map(p => {
      const results = {};
      for (const a of assignments) { const sh=findSheet(a.id, assessmentId); const rr=resultRowForPupil(sh,p.id); results[a.subjectId] = {...rr, note:sh?.markNotes?.[p.id] || ''}; }
      return { id: p.id, name: p.name, sex: p.sex, examNo: p.examNo || '', isRepeater: !!p.isRepeater, parentPrimary: p.parentPrimary || '', parentAltPhones: p.parentAltPhones || [], results, reportReadiness:pupilReportReadiness(p,assessmentId) };
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
    await saveData(); broadcastEvent({ type: 'RESULT_SHEET_UPDATED', classId: assignment.classId, assignmentId: assignment.id, assessmentId: body.assessmentId, status: sheet.status }, [assignment.teacherUserId, user.id]);
    return sendJson(res, 200, { ok: true, status: sheet.status });
  }

  if (req.method === 'POST' && pathname === '/api/class-teacher/report-sent') {
    const body = await readJson(req); const cls = db.classes.find(c => c.id === body.classId);
    if (!cls || !canViewClass(user, cls.id)) return sendError(res, 403, 'Class teacher access required');
    const pupil = db.pupils.find(p => p.id === body.pupilId && p.classId === cls.id);
    if (!pupil) return sendError(res, 404, 'Pupil not found');
    const readiness = pupilReportReadiness(pupil, body.assessmentId);
    if (!readiness.canSend) return sendError(res, 409, 'This pupil report is incomplete and provisional release has not been approved');
    const stage = ['GENERATED','SHARED','CONFIRMED_SENT'].includes(String(body.stage||'').toUpperCase()) ? String(body.stage).toUpperCase() : (String(body.channel||'').toUpperCase()==='SHARE'?'SHARED':'GENERATED');
    const log = { id: id('send'), at: nowIso(), classId: cls.id, assessmentId: body.assessmentId, pupilId: pupil.id, sentByUserId: user.id, channel: String(body.channel || 'SHARE'), stage, provisional: readiness.provisional, parentNumber: String(body.parentNumber || pupil.parentPrimary || '') };
    db.reportSendLog.unshift(log); db.reportSendLog = db.reportSendLog.slice(0, 5000);
    audit(user.id, 'REPORT_SENT', `${cls.name}/${pupil.name}/${body.assessmentId}${readiness.provisional ? ' PROVISIONAL' : ''}`);
    await saveData(); return sendJson(res, 201, { log });
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
    await saveData(); broadcastEvent({ type: 'ESCALATION_UPDATED', escalationId: esc.id, status: esc.status }, escalationAudienceForAssignment(assignment));
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
    audit(user.id, 'ESCALATION_HOD_FOLLOWUP', esc.id); await saveData();
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
    audit(user.id, `ESCALATION_${action}`, esc.id); await saveData(); broadcastEvent({ type: 'ESCALATION_UPDATED', escalationId: esc.id, status: esc.status }, escalationAudienceForAssignment(assignment));
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
    await saveData(); broadcastEvent({ type: 'ASSIGNMENT_UPDATED', classId: cls.id, subjectId: subject.id, teacherUserId: teacher.id }, [teacher.id, user.id]);
    return sendJson(res, 200, { assignment: assignmentView(assignment) });
  }

  if (req.method === 'GET' && pathname === '/api/hod/progress') {
    const dept = getDepartmentForHod(user); if (!dept) return sendError(res, 403, 'HOD access required');
    const assessmentId = urlObj.searchParams.get('assessmentId') || db.assessments.find(a => a.active !== false)?.id; const assessment = db.assessments.find(a => a.id === assessmentId);
    if (!assessment) return sendError(res, 404, 'Assessment not found');
    const rows = db.teachingAssignments.filter(a => a.active !== false && assessmentAppliesToClass(assessment,a.classId) && db.subjects.find(s => s.id === a.subjectId)?.departmentId === dept.id).map(a => {
      const sheet = findSheet(a.id, assessment.id); const status = sheet?.status || 'NOT_STARTED';
      return { ...assignmentView(a), status, updatedAt: sheet?.updatedAt || null, submittedAt: sheet?.submittedAt || null, deadline: getDeadlineState(assessment, status, sheet) };
    });
    return sendJson(res, 200, { department: dept, assessment, rows });
  }

  if (req.method === 'GET' && pathname === '/api/school/progress') {
    if (!isAdminOrHead(user)) return sendError(res, 403, 'Administrator or Head Teacher access required');
    const assessmentId = urlObj.searchParams.get('assessmentId') || db.assessments.find(a => a.active !== false)?.id; const assessment = db.assessments.find(a => a.id === assessmentId);
    if (!assessment) return sendError(res, 404, 'Assessment not found');
    const rows = db.teachingAssignments.filter(a => a.active !== false && assessmentAppliesToClass(assessment,a.classId)).map(a => {
      const sheet = findSheet(a.id, assessment.id); const status = sheet?.status || 'NOT_STARTED';
      return { ...assignmentView(a), status, updatedAt: sheet?.updatedAt || null, submittedAt: sheet?.submittedAt || null, deadline: getDeadlineState(assessment, status, sheet) };
    });
    const classes = db.classes.filter(c => c.active !== false && assessmentAppliesToClass(assessment,c.id)).map(c => ({ class: c, readiness: reportReadiness(c.id, assessment.id) }));
    return sendJson(res, 200, { assessment, rows, classes });
  }

  if (req.method === 'POST' && pathname === '/api/admin/load-practice-demo') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req);
    if (String(body.confirm || '') !== 'LOAD SOURCE PRACTICE') return sendError(res, 400, 'Confirmation phrase does not match');
    try {
      const backupName = `backup-before-practice-${Date.now()}.json`;
      fs.writeFileSync(path.join(DATA_DIR, backupName), JSON.stringify(db, null, 2));
    } catch (e) { console.warn('Could not create pre-demo backup:', e.message); }
    db = makePracticeSchoolData();
    const newAdmin = db.users.find(u => u.username === 'admin');
    audit(newAdmin.id, 'PRACTICE_DATA_LOADED', 'Realistic source-schedule practice school loaded by administrator');
    await saveData();
    broadcastEvent({ type:'PRACTICE_DATA_LOADED', at:nowIso() });
    return sendJson(res, 200, {
      ok:true, token:issueToken(newAdmin.id),
      summary:{ classes:db.classes.length, pupils:db.pupils.length, staff:db.users.length, assignments:db.teachingAssignments.length, assessment:db.assessments[0]?.name }
    });
  }

  if (req.method === 'POST' && pathname === '/api/admin/practice-results') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    if (!db.school?.demoMode) return sendError(res, 409, 'Practice result tools are available only while the practice school is loaded');
    const body = await readJson(req);
    const action = String(body.action || '').toUpperCase();
    const assessment = db.assessments.find(a => a.id === (body.assessmentId || db.assessments.find(x => x.active !== false)?.id) && a.active !== false);
    if (!assessment) return sendError(res, 404, 'Practice assessment not found');
    const assignments = db.teachingAssignments.filter(a => a.active !== false);

    if (action === 'CLEAR') {
      db.resultSheets = db.resultSheets.filter(s => s.assessmentId !== assessment.id);
      db.escalations = db.escalations.filter(e => e.assessmentId !== assessment.id);
      db.reportReleaseApprovals = db.reportReleaseApprovals.filter(r => r.assessmentId !== assessment.id);
      db.reportSendLog = db.reportSendLog.filter(r => r.assessmentId !== assessment.id);
      db.notifications = db.notifications.filter(n => n.meta?.assessmentId !== assessment.id && n.type !== 'RESULTS_SUBMITTED');
      audit(user.id, 'PRACTICE_RESULTS_CLEARED', assessment.name);
      const storage = await saveData();
      broadcastEvent({ type:'PRACTICE_RESULTS_UPDATED', action:'CLEAR', assessmentId:assessment.id, at:nowIso() });
      return sendJson(res, 200, { ok:true, action, submitted:0, draft:0, notStarted:assignments.length, storageRevision:storage.revision });
    }

    if (!['SUBMIT_ALL','MIXED'].includes(action)) return sendError(res, 400, 'Choose SUBMIT_ALL, MIXED or CLEAR');
    let submitted = 0, draft = 0, notStarted = 0;
    assignments.forEach((assignment, i) => {
      let mode = 'SUBMITTED';
      if (action === 'MIXED') {
        const bucket = i % 7;
        mode = bucket <= 4 ? 'SUBMITTED' : bucket === 5 ? 'DRAFT' : 'NOT_STARTED';
      }
      setPracticeSheetData(assignment, assessment, i, mode);
      if (mode === 'SUBMITTED') submitted++; else if (mode === 'DRAFT') draft++; else notStarted++;
    });
    db.classes.filter(c => c.active !== false && c.classTeacherUserId).forEach(cls => {
      const classAssignments = assignments.filter(a => a.classId === cls.id);
      const done = classAssignments.filter(a => sheetIsVisible(findSheet(a.id, assessment.id))).length;
      createNotification(cls.classTeacherUserId, 'PRACTICE_RESULTS_READY', `Practice results updated: ${cls.name}`, `${done}/${classAssignments.length} subject result sheets are now submitted for ${assessment.name}. Submitted marks are available in Class Progress as read-only results.`, { classId:cls.id, assessmentId:assessment.id });
    });
    audit(user.id, action === 'SUBMIT_ALL' ? 'PRACTICE_RESULTS_SUBMITTED_ALL' : 'PRACTICE_RESULTS_MIXED_SCENARIO', `${assessment.name}: ${submitted} submitted, ${draft} draft, ${notStarted} not started`);
    const storage = await saveData();
    broadcastEvent({ type:'PRACTICE_RESULTS_UPDATED', action, assessmentId:assessment.id, submitted, draft, notStarted, at:nowIso() });
    return sendJson(res, 200, { ok:true, action, submitted, draft, notStarted, total:assignments.length, storageRevision:storage.revision });
  }

  if (req.method === 'GET' && pathname === '/api/admin/setup') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    return sendJson(res, 200, { school: db.school, users: db.users.map(safeUser), departments: db.departments, classes: db.classes, subjects: db.subjects, assessments: db.assessments, teachingAssignments: db.teachingAssignments.map(assignmentView) });
  }

  if (req.method === 'POST' && pathname === '/api/admin/school') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req);
    for (const k of ['name', 'motto', 'address', 'email']) if (body[k] !== undefined) db.school[k] = String(body[k] || '').trim();
    audit(user.id, 'SCHOOL_DETAILS_UPDATED', db.school.name); await saveData(); return sendJson(res, 200, { school: db.school });
  }

  if (req.method === 'POST' && pathname === '/api/admin/department') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const name = String(body.name || '').trim(); if (!name) return sendError(res, 400, 'Department name is required');
    if (db.departments.some(d => d.name.toLowerCase() === name.toLowerCase())) return sendError(res, 409, 'Department already exists');
    const dept = { id: id('dept'), name, hodUserId: null }; db.departments.push(dept); audit(user.id, 'DEPARTMENT_CREATED', name); await saveData(); return sendJson(res, 201, { department: dept });
  }

  if (req.method === 'POST' && pathname === '/api/admin/subject') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const name = String(body.name || '').trim(); const dept = db.departments.find(d => d.id === body.departmentId);
    if (!name || !dept) return sendError(res, 400, 'Subject name and department are required');
    if (db.subjects.some(s => s.name.toLowerCase() === name.toLowerCase() && s.active !== false)) return sendError(res, 409, 'Subject already exists');
    const subject = { id: id('sub'), name, departmentId: dept.id, active: true }; db.subjects.push(subject); audit(user.id, 'SUBJECT_CREATED', `${name}/${dept.name}`); await saveData(); return sendJson(res, 201, { subject });
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
    audit(user.id, 'USER_CREATED', `${name} (${username})`); await saveData(); return sendJson(res, 201, { user: safeUser(newUser) });
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
    const storage=await saveData();
    const audience=[user.id,oldTeacherId,cls.classTeacherUserId].filter(Boolean);
    broadcastEvent({ type:'CLASS_TEACHER_UPDATED', classId:cls.id, teacherUserId:cls.classTeacherUserId, oldTeacherUserId:oldTeacherId }, audience);
    return sendJson(res, 200, { class:cls, classTeacherName:teacher?.name || '', storageRevision:storage.revision });
  }

  if (req.method === 'POST' && pathname === '/api/admin/class') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const name = String(body.name || '').trim(); if (!name) return sendError(res, 400, 'Class name is required');
    if (db.classes.some(c => c.name.toLowerCase() === name.toLowerCase() && c.active !== false)) return sendError(res, 409, 'Class already exists');
    const cls = { id: id('class'), name, level: String(body.level || '').trim(), gradingSystem: body.gradingSystem === 'CBC' ? 'CBC' : 'LEGACY', classTeacherUserId: null, active: true };
    db.classes.push(cls); audit(user.id, 'CLASS_CREATED', name); await saveData(); return sendJson(res, 201, { class: cls });
  }

  if (req.method === 'POST' && pathname === '/api/admin/assessment') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const name = String(body.name || '').trim(); const dueAt = String(body.dueAt || '').trim();
    if (!name || !dueAt || Number.isNaN(new Date(dueAt).getTime())) return sendError(res, 400, 'Valid assessment name and deadline are required');
    const classIds = Array.isArray(body.classIds) ? body.classIds.filter(cid=>db.classes.some(c=>c.id===cid&&c.active!==false)) : [];
    const basePolicy = db.school.repeatPolicy || {passMark:50,minPassSubjects:5};
    const assessment = { id: id('assess'), name, term: String(body.term || '').trim(), year: Number(body.year || new Date().getFullYear()), dueAt, active: true, classIds, passMark:Number(body.passMark ?? basePolicy.passMark ?? 50), minPassSubjects:Number(body.minPassSubjects ?? basePolicy.minPassSubjects ?? 5) };
    db.assessments.push(assessment); audit(user.id, 'ASSESSMENT_CREATED', `${name} due ${dueAt}`); await saveData(); broadcastEvent({ type: 'ASSESSMENT_CREATED', assessmentId: assessment.id }); return sendJson(res, 201, { assessment });
  }

  if (req.method === 'POST' && pathname === '/api/admin/pupil') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const cls = db.classes.find(c => c.id === body.classId && c.active !== false); const name = String(body.name || '').trim();
    if (!cls || !name) return sendError(res, 400, 'Class and pupil name are required');
    const subjectIds = Array.isArray(body.subjectIds) ? body.subjectIds.filter(sid=>db.subjects.some(s=>s.id===sid&&s.active!==false)) : [];
    const pupil = { id: id('pupil'), classId: cls.id, name, sex: String(body.sex || '').trim().toUpperCase().slice(0, 1), examNo: String(body.examNo || '').trim(), parentPrimary: String(body.parentPrimary || '').trim(), parentAltPhones: Array.isArray(body.parentAltPhones) ? body.parentAltPhones.map(String) : [], isRepeater: !!body.isRepeater, subjectIds, active: true };
    db.pupils.push(pupil); audit(user.id, 'PUPIL_CREATED', `${name} / ${cls.name}`); await saveData(); return sendJson(res, 201, { pupil });
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
    audit(user.id, 'PUPILS_BULK_IMPORTED', `${added.length} / ${cls.name}`); await saveData(); return sendJson(res, 201, { count: added.length, pupils: added });
  }

  if (req.method === 'POST' && pathname === '/api/admin/lock-sheet') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req); const sheet = findSheet(body.assignmentId, body.assessmentId); if (!sheet) return sendError(res, 404, 'Result sheet not found');
    sheet.status = body.lock === false ? 'SUBMITTED' : 'LOCKED'; sheet.updatedAt = nowIso(); audit(user.id, sheet.status === 'LOCKED' ? 'RESULT_SHEET_LOCKED' : 'RESULT_SHEET_UNLOCKED', `${body.assignmentId}/${body.assessmentId}`); await saveData(); broadcastEvent({ type: 'RESULT_SHEET_UPDATED', assignmentId: body.assignmentId, assessmentId: body.assessmentId, status: sheet.status }); return sendJson(res, 200, { status: sheet.status });
  }

  if (req.method === 'GET' && pathname === '/api/admin/audit') {
    if (!isAdminOrHead(user)) return sendError(res, 403, 'Administration access required');
    const rows = db.auditLog.slice(0, 500).map(r => ({ ...r, actorName: db.users.find(u => u.id === r.actorUserId)?.name || 'System' }));
    return sendJson(res, 200, { rows });
  }

  if (req.method === 'GET' && pathname === '/api/admin/storage-status') {
    if (!isAdminOrHead(user)) return sendError(res, 403, 'Administration access required');
    let databaseHealthy = false;
    let snapshotCount = 0;
    let entityCount = 0;
    if (DATABASE_URL) {
      try {
        const pool = getPgPool();
        await pool.query('SELECT 1');
        databaseHealthy = true;
        const c = await pool.query('SELECT COUNT(*)::int AS count FROM edusend_recovery_snapshots');
        snapshotCount = Number(c.rows[0]?.count || 0);
        const e = await pool.query('SELECT COUNT(*)::int AS count FROM edusend_entities');
        entityCount = Number(e.rows[0]?.count || 0);
      } catch (e) { databaseHealthy = false; }
    }
    return sendJson(res, 200, {
      backend: STORAGE_BACKEND,
      databaseConfigured: !!DATABASE_URL,
      databaseHealthy,
      revision: db.storageMeta?.revision || 0,
      lastSavedAt: db.storageMeta?.lastSavedAt || null,
      snapshotCount,
      entityCount,
      productionReady: !!DATABASE_URL && databaseHealthy
    });
  }

  if (req.method === 'POST' && pathname === '/api/admin/restore-backup') {
    if (!hasRole(user, 'ADMIN')) return sendError(res, 403, 'Administrator access required');
    const body = await readJson(req, 50 * 1024 * 1024);
    if (body.confirm !== 'RESTORE BACKUP') return sendError(res, 400, 'Type RESTORE BACKUP to confirm');
    const candidate = body.data?.data || body.data;
    if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.users) || !Array.isArray(candidate.classes)) return sendError(res, 400, 'This does not look like an EduSend backup');
    const previous = db;
    try {
      db = migrateData(candidate);
      db.storageMeta ||= {};
      db.storageMeta.revision = Number(previous?.storageMeta?.revision || 0);
      db.storageMeta.lastSavedAt = previous?.storageMeta?.lastSavedAt || null;
      db.storageMeta.backend = STORAGE_BACKEND;
      audit(user.id, 'BACKUP_RESTORED', `Backup restored into ${STORAGE_BACKEND}`);
      const storage = await saveData();
      return sendJson(res, 200, { ok:true, storage });
    } catch (err) {
      db = previous;
      throw err;
    }
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

async function start() {
  db = await loadData();
  server.listen(PORT, HOST, () => {
    console.log(`EduSend V${APP_VERSION} running on http://${HOST}:${PORT}`);
    console.log(`Storage backend: ${STORAGE_BACKEND}`);
    if (!DATABASE_URL) console.warn('WARNING: DATABASE_URL is not set. Local-file storage is for testing only and can be lost on redeploy.');
    if (TOKEN_SECRET.includes('DEV_ONLY')) console.warn('WARNING: Set TOKEN_SECRET before public deployment.');
  });
}

start().catch(err => {
  console.error('EduSend failed to start:', err);
  process.exit(1);
});
