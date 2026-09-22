/* ============================================================
   NOTELYLOG — app.js
   Single-page study dashboard: state, rendering, PDF book reader,
   optional Google Sign-In + Firestore cloud sync (PDFs stay device-local).
   ============================================================ */
(function(){
"use strict";

/* ============================================================
   NOTELYLOG — single-file study dashboard app
   ============================================================ */
(function(){
"use strict";

/* ---------- storage ---------- */
const STORE_KEY = "notelylog_v1";
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function todayStr(){ return new Date().toISOString().slice(0,10); }

function defaultState(){
  const semId = uid();
  return {
    settings:{ theme:"system", reminderDays:3 },
    activeSemesterId: semId,
    semesters:[{id:semId, name:"Semester 1", totalWeeks:17, currentWeek:1, archived:false, createdAt:Date.now()}],
    subjects:[], notes:[], pdfs:[], assignments:[], revisionTopics:[],
    timetable:[], goals:[], quickNotes:[], bookmarksList:[], trash:[],
    stats:{ streak:0, lastActiveDate:null }
  };
}
let state;
try{
  const raw = localStorage.getItem(STORE_KEY);
  state = raw ? JSON.parse(raw) : defaultState();
  // fill any missing keys for forward-compat
  const d = defaultState();
  for(const k in d){ if(!(k in state)) state[k]=d[k]; }
}catch(e){ state = defaultState(); }

let saveTimer=null;
function save(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    const ind=document.getElementById("save-indicator");
    ind.classList.add("show");
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>ind.classList.remove("show"),1400);
    queueCloudSave();
  }catch(e){ toast("Couldn't save — storage may be full"); }
}
function touchStreak(){
  const t=todayStr();
  if(state.stats.lastActiveDate===t) return;
  const y=new Date(Date.now()-86400000).toISOString().slice(0,10);
  state.stats.streak = state.stats.lastActiveDate===y ? state.stats.streak+1 : 1;
  state.stats.lastActiveDate=t;
  save();
}
touchStreak();

function activeSemester(){ return state.semesters.find(s=>s.id===state.activeSemesterId) || state.semesters[0]; }
function inActiveSem(x){ return x.semesterId===state.activeSemesterId; }

/* ---------- theme ---------- */
function applyTheme(){
  const t=state.settings.theme;
  const root=document.documentElement;
  if(t==="light"){ root.setAttribute("data-theme","light"); }
  else if(t==="dark"){ root.setAttribute("data-theme","dark"); }
  else { root.removeAttribute("data-theme"); }
}
applyTheme();

/* ---------- toast ---------- */
let toastTimer=null;
function toast(msg){
  const el=document.getElementById("toast");
  el.textContent=msg; el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove("show"),2200);
}

/* ---------- modal ---------- */
function openModal(html, wide){
  const backdrop=document.getElementById("modal-backdrop");
  document.getElementById("modal-inner").innerHTML = `<div class="modal ${wide?'wide':''}">${html}</div>`;
  backdrop.classList.add("open");
}
function closeModal(){ document.getElementById("modal-backdrop").classList.remove("open"); }
document.getElementById("modal-backdrop").addEventListener("click", e=>{ if(e.target.id==="modal-backdrop") closeModal(); });

/* ============================================================
   GOOGLE SIGN-IN + CLOUD SYNC (optional — degrades gracefully
   if firebase-config.js hasn't been filled in with a real project)
   ============================================================ */
const FIREBASE_READY = (typeof firebase!=="undefined")
  && (typeof FIREBASE_CONFIG!=="undefined")
  && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey!=="YOUR_API_KEY";

let fbAuth=null, fbDb=null, fbUser=null, cloudSaveTimer=null, cloudSynced=false;

function googleGIcon(){
  return `<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
    <path fill="#4285F4" d="M19.6 10.23c0-.68-.06-1.36-.18-2H10v3.78h5.4a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.9-1.75 2.97-4.32 2.97-7.3z"/>
    <path fill="#34A853" d="M10 20c2.7 0 4.96-.89 6.62-2.42l-3.23-2.5c-.9.6-2.05.95-3.4.95-2.6 0-4.8-1.76-5.59-4.12H1.06v2.59A10 10 0 0 0 10 20z"/>
    <path fill="#FBBC05" d="M4.41 11.9a6 6 0 0 1 0-3.8V5.5H1.06a10 10 0 0 0 0 9l3.35-2.6z"/>
    <path fill="#EA4335" d="M10 3.98c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.6 9.6 0 0 0 10 0 10 10 0 0 0 1.06 5.5l3.35 2.6C5.2 5.74 7.4 3.98 10 3.98z"/>
  </svg>`;
}

if(FIREBASE_READY){
  try{
    firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();
    try{ fbDb.enablePersistence({synchronizeTabs:true}); }catch(e){ /* multiple tabs open, fine */ }
    fbAuth.onAuthStateChanged(handleAuthChange);
  }catch(err){ console.warn("Firebase init failed:", err); }
}

function cloudDocRef(uid){ return fbDb.collection("notelylog_users").doc(uid); }

/* PDFs are stored as base64 and can be large — Firestore caps a document at
   1MB, and previously PDFs would silently fail to sync, then get wiped out
   on the next cloud pull. Fix: PDFs (and any trashed PDF) are device-local
   only and are stripped out of every cloud read/write, so the cloud copy
   can never overwrite or delete them. */
function sanitizeForCloud(fullState){
  const clone = Object.assign({}, fullState);
  clone.pdfs = [];
  clone.trash = fullState.trash.filter(t=>t.type!=="pdf");
  return clone;
}

async function handleAuthChange(user){
  fbUser = user || null;
  renderAccountWidget();
  if(!fbUser){ cloudSynced=false; return; }
  try{
    const snap = await cloudDocRef(fbUser.uid).get();
    if(snap.exists && snap.data() && snap.data().state){
      const localPdfs = state.pdfs;
      const localPdfTrash = state.trash.filter(t=>t.type==="pdf");
      const merged = mergeWithDefaults(snap.data().state);
      merged.pdfs = localPdfs;
      merged.trash = merged.trash.filter(t=>t.type!=="pdf").concat(localPdfTrash);
      state = merged;
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      cloudSynced = true;
      toast("Synced from your account");
      renderView();
    } else {
      await cloudDocRef(fbUser.uid).set({ state: sanitizeForCloud(state), updatedAt: Date.now() });
      cloudSynced = true;
      toast("Signed in — your data is now backed up to this account");
    }
  }catch(err){
    console.warn("Cloud sync error:", err);
    toast("Signed in, but couldn't reach cloud sync — working offline");
  }
}
function mergeWithDefaults(cloudState){
  const d=defaultState();
  const merged=Object.assign({}, d, cloudState);
  for(const k in d){ if(!(k in merged)) merged[k]=d[k]; }
  return merged;
}
function queueCloudSave(){
  if(!fbUser || !fbDb) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer=setTimeout(()=>{
    cloudDocRef(fbUser.uid).set({state:sanitizeForCloud(state), updatedAt:Date.now()}).catch(()=>{ toast("Sync failed — check your connection"); });
  }, 900);
}
function signInWithGoogle(){
  if(!FIREBASE_READY){ toast("Google Sign-In isn't set up yet — see firebase-config.js"); return; }
  const provider = new firebase.auth.GoogleAuthProvider();
  fbAuth.signInWithPopup(provider).catch(err=>{
    if(err.code!=="auth/popup-closed-by-user") toast("Sign-in failed — try again");
  });
}
function signOutGoogle(){
  fbAuth.signOut().then(()=>{ closeModal(); toast("Signed out — this device now keeps its own local copy"); });
}
function renderAccountWidget(){
  const box=document.getElementById("account-widget");
  if(!box) return;
  if(!FIREBASE_READY){ box.style.display="none"; return; }
  box.style.display="flex";
  if(fbUser){
    const name = fbUser.displayName || fbUser.email || "Account";
    const initial = name.trim()[0].toUpperCase();
    box.innerHTML = `<button class="account-avatar" id="account-open" aria-label="Account: ${escapeHtml(name)}" title="${escapeHtml(name)}">
      ${fbUser.photoURL?`<img src="${fbUser.photoURL}" alt="">`:`<span>${initial}</span>`}
    </button>`;
    document.getElementById("account-open").addEventListener("click", openAccountModal);
  } else {
    box.innerHTML = `<button class="btn secondary small" id="account-signin">${googleGIcon()}<span>Sign in</span></button>`;
    document.getElementById("account-signin").addEventListener("click", signInWithGoogle);
  }
}
function openAccountModal(){
  if(!fbUser) return;
  const name = fbUser.displayName || "";
  openModal(`
    <div class="modal-head"><h3>Account</h3><button class="icon-btn" data-action="close-modal">${icon('close')}</button></div>
    <div style="display:flex; align-items:center; gap:13px; margin-bottom:18px;">
      ${fbUser.photoURL?`<img src="${fbUser.photoURL}" alt="" style="width:48px;height:48px;border-radius:50%;">`:`<div class="account-avatar-lg">${escapeHtml((name||fbUser.email||"?").trim()[0].toUpperCase())}</div>`}
      <div><strong style="font-size:0.95rem;">${escapeHtml(name)}</strong><div style="font-size:0.82rem; color:var(--text-soft);">${escapeHtml(fbUser.email||"")}</div></div>
    </div>
    <p style="font-size:0.85rem; color:var(--text-soft); line-height:1.5; margin-bottom:20px;">
      ${cloudSynced ? "Your subjects, notes and progress are synced to this account and available on any device you sign in on." : "Signed in, but the last sync attempt failed — your changes are still safe in this browser."}
    </p>
    <div class="modal-actions"><button class="btn danger" id="account-signout">Sign out</button></div>
  `);
  document.getElementById("account-signout").addEventListener("click", signOutGoogle);
}

/* ---------- icons ---------- */
const ICONS = {
  dashboard:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  subjects:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  planner:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  notes:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 13h6M9 17h6"/></svg>',
  assignments:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  revision:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  progress:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>',
  timetable:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>',
  edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16z"/></svg>',
  pin:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 3l5 5-4 2-4 4 1 4-3 3-3-5-5-3 3-3 4 1 4-4z"/></svg>',
  pinOutline:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5M8 13l-3 3h14l-3-3M12 3l3 5-1 5H10l-1-5z"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>',
  bookmark:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  upload:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/></svg>',
  pdf:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/></svg>',
  chevL:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18l-6-6 6-6"/></svg>',
  chevR:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 18l6-6-6-6"/></svg>',
  close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  zoomIn:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/></svg>',
  zoomOut:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/></svg>',
  fullscreen:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3"/></svg>',
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  grid:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  more:'<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  flame:'🔥'
};
function icon(name){ return ICONS[name]||""; }

/* ---------- nav ---------- */
const NAV_ITEMS = [
  {id:"dashboard", label:"Dashboard"},
  {id:"subjects", label:"Subjects"},
  {id:"planner", label:"Study Planner"},
  {id:"notes", label:"Notes"},
  {id:"assignments", label:"Assignments"},
  {id:"revision", label:"Revision"},
  {id:"progress", label:"Semester Progress"},
  {id:"timetable", label:"Timetable"},
  {id:"settings", label:"Settings"}
];
let currentView="dashboard", currentParams={};

function renderNav(){
  document.getElementById("nav").innerHTML = NAV_ITEMS.map(n=>`
    <button class="nav-item ${currentView===n.id?'active':''}" data-nav="${n.id}">${icon(n.id)}<span>${n.label}</span></button>
  `).join("");
  document.getElementById("sidebar-foot").innerHTML = `
    <div class="streak-pill">${icon('flame')} <span>${state.stats.streak} day streak</span></div>
  `;
  const mobileMain = NAV_ITEMS.slice(0,4);
  document.getElementById("bottom-nav").innerHTML = mobileMain.map(n=>`
    <button class="bn-item ${currentView===n.id?'active':''}" data-nav="${n.id}">${icon(n.id)}<span>${n.label.split(' ')[0]}</span></button>
  `).join("") + `<button class="bn-item more ${['assignments','revision','progress','timetable','settings'].includes(currentView)?'active':''}" data-nav="settings">${icon('more')}<span>More</span></button>`;
  renderAccountWidget();
}

function navigate(view, params={}){
  currentView=view; currentParams=params;
  window.scrollTo(0,0);
  renderNav();
  renderView();
}

document.addEventListener("click", e=>{
  const navBtn = e.target.closest("[data-nav]");
  if(navBtn){ navigate(navBtn.dataset.nav); }
});

/* ---------- helpers ---------- */
function subjectById(id){ return state.subjects.find(s=>s.id===id); }
function subjectOptions(selectedId){
  return state.subjects.filter(inActiveSem).map(s=>`<option value="${s.id}" ${s.id===selectedId?'selected':''}>${escapeHtml(s.name)}</option>`).join("");
}
function escapeHtml(str){ return (str||"").replace(/[&<>"']/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m])); }
function fmtDate(d){ if(!d) return ""; const dt=new Date(d+"T00:00:00"); return dt.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
function daysUntil(d){ if(!d) return null; const dt=new Date(d+"T00:00:00"); const now=new Date(); now.setHours(0,0,0,0); return Math.round((dt-now)/86400000); }
function dueLabel(d){
  const n=daysUntil(d); if(n===null) return "";
  if(n<0) return `Overdue ${Math.abs(n)}d`;
  if(n===0) return "Due today";
  if(n===1) return "Due tomorrow";
  if(n<=7) return `Due in ${n} days`;
  return `Due ${fmtDate(d)}`;
}
function urgencyClass(d,status){
  if(status==="completed"||status==="Completed"||status==="done") return "done";
  const n=daysUntil(d); if(n===null) return "";
  if(n<0 || n<=1) return "urgent";
  if(n<=3) return "doing";
  return "";
}
function softDelete(collection, id, type){
  const idx = state[collection].findIndex(x=>x.id===id);
  if(idx<0) return;
  const item = state[collection][idx];
  state[collection].splice(idx,1);
  state.trash.push({id:uid(), type, collection, data:item, deletedAt:Date.now()});
  save(); toast("Moved to Trash");
}
function restoreTrash(trashId){
  const idx = state.trash.findIndex(t=>t.id===trashId);
  if(idx<0) return;
  const t = state.trash[idx];
  state[t.collection].push(t.data);
  state.trash.splice(idx,1);
  save(); toast("Restored"); renderView();
}
function purgeTrash(trashId){
  state.trash = state.trash.filter(t=>t.id!==trashId);
  save(); renderView();
}

/* ============================================================
   VIEW: DASHBOARD
   ============================================================ */
function renderDashboard(){
  const sem = activeSemester();
  const subs = state.subjects.filter(inActiveSem);
  const upcoming = state.assignments.filter(inActiveSem).filter(a=>a.status!=="completed")
    .sort((a,b)=>(a.dueDate||"9999").localeCompare(b.dueDate||"9999")).slice(0,3);
  const goals = state.goals.filter(inActiveSem);
  const sticky = state.quickNotes.slice().sort((a,b)=>b.pinned-a.pinned || b.createdAt-a.createdAt).slice(0,5);
  const todayDow = new Date().getDay();
  const dowMap=[6,0,1,2,3,4,5]; // convert JS sun=0 to Mon-first idx
  const todayClasses = state.timetable.filter(inActiveSem).filter(t=>t.day===dowMap[todayDow]).sort((a,b)=>a.start.localeCompare(b.start));
  const todayTasks = []; // planner tasks due today handled below if any exist

  const pct = sem.totalWeeks ? Math.min(100, Math.round((sem.currentWeek/sem.totalWeeks)*100)) : 0;

  document.getElementById("view").innerHTML = `
    <div class="hero-greet">
      <svg class="hero-deco" viewBox="0 0 160 160" fill="none" aria-hidden="true">
        <path d="M80 145c0-48 10-74 36-101" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M80 145c0-48 -10-74 -36-101" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M80 103c19-8 32-23 36-42" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M80 70c-15-6-25-19-28-36" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="118" cy="44" r="4" fill="currentColor"/>
        <circle cx="50" cy="34" r="3" fill="currentColor"/>
      </svg>
      <div class="eyebrow-row"><span class="date-chip">${todayLong()}</span></div>
      <h1>Good ${greetPart()}!</h1>
      <p>Ready for another study day?</p>
      <div class="hero-streak">${icon('flame')}<span>${state.stats.streak} day streak</span></div>
    </div>

    <div class="grid cols-2" style="margin-bottom:16px;">
      <div class="card">
        <div class="section-title"><h3>Today</h3></div>
        ${todayClasses.length ? `<div class="today-list">${todayClasses.map(c=>{
          const s=subjectById(c.subjectId);
          return `<div class="today-item"><span class="time">${c.start}</span><span class="txt">${escapeHtml(s?s.name:'Class')} · ${escapeHtml(c.location||'')}</span></div>`;
        }).join("")}</div>` : `<div class="empty" style="padding:18px;">No classes scheduled today.</div>`}
      </div>
      <div class="card">
        <div class="section-title"><h3>Upcoming Assignments</h3><button class="link" data-nav="assignments">View all</button></div>
        ${upcoming.length ? upcoming.map(a=>{
          const s=subjectById(a.subjectId);
          return `<div class="assign-row" style="padding:9px 0;">
            <div class="info"><h4>${escapeHtml(a.name)}</h4>
              <div class="meta-line"><span class="badge ${urgencyClass(a.dueDate,a.status)}">${dueLabel(a.dueDate)}</span>${s?`<span class="subject-chip"><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.name)}</span>`:''}</div>
            </div>
            <div class="progress-wrap"><div class="progress-track"><div class="progress-fill" style="width:${a.progress||0}%"></div></div><span>${a.progress||0}%</span></div>
          </div>`;
        }).join("") : `<div class="empty" style="padding:18px;">No assignments yet.</div>`}
      </div>
    </div>

    <div class="section-title"><h3>My Subjects</h3><button class="link" data-nav="subjects">View All Subjects</button></div>
    ${subs.length? `<div class="grid cols-3" style="margin-bottom:20px;">${subs.slice(0,3).map(subjectCardHtml).join("")}</div>`
      : `<div class="empty" style="margin-bottom:20px;">${icon('subjects')}<span>No subjects yet. Add your first subject.</span><button class="btn small" data-action="add-subject">${icon('plus')}Add Subject</button></div>`}

    <div class="grid cols-2">
      <div class="card">
        <div class="section-title"><h3>Semester Progress</h3></div>
        <p style="font-size:0.9rem; color:var(--text-soft); margin-bottom:8px;">${escapeHtml(sem.name)} · Week ${sem.currentWeek} / ${sem.totalWeeks}</p>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="card">
        <div class="section-title"><h3>Semester Goals</h3><button class="link" data-action="add-goal">${icon('plus')} Add</button></div>
        ${goals.length? `<div>${goals.map(goalRowHtml).join("")}</div>` : `<div class="empty" style="padding:14px;">No goals set yet.</div>`}
      </div>
    </div>

    <div class="section-title" style="margin-top:20px;"><h3>Quick Notes</h3></div>
    <div class="corkboard">
      ${sticky.map(stickyHtml).join("")}
      <button class="add-sticky" data-action="add-sticky">${icon('plus')} New note</button>
    </div>
  `;
}
function greetPart(){ const h=new Date().getHours(); return h<12?"morning":h<18?"afternoon":"evening"; }
function todayLong(){ return new Date().toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'}); }
function subjectCardHtml(s){
  const notesCount = state.notes.filter(n=>n.subjectId===s.id).length + state.pdfs.filter(p=>p.subjectId===s.id).length;
  const assignCount = state.assignments.filter(a=>a.subjectId===s.id).length;
  const topics = state.revisionTopics.filter(t=>t.subjectId===s.id);
  const mastered = topics.filter(t=>t.status==="mastered").length;
  const pct = topics.length? Math.round((mastered/topics.length)*100) : 0;
  return `<div class="subject-card" data-open-subject="${s.id}" role="button" tabindex="0" aria-label="Open ${escapeHtml(s.name)}">
    ${s.pinned?`<span class="pin-flag">${icon('pin')}</span>`:''}
    <div class="bar" style="background:${s.color}"></div>
    <h4>${escapeHtml(s.name)}</h4>
    <div class="code">${escapeHtml(s.code||'')}</div>
    <div class="meta"><span>${notesCount} Notes · ${assignCount} Assignments</span></div>
    <div style="margin-top:8px;" class="progress-track"><div class="progress-fill" style="width:${pct}%; background:${s.color}"></div></div>
    <div class="meta" style="margin-top:6px;"><span>${pct}% Complete</span></div>
  </div>`;
}
function goalRowHtml(g){
  return `<div class="goal-row ${g.done?'done':''}">
    <button class="goal-check ${g.done?'on':''}" data-action="toggle-goal" data-id="${g.id}" aria-label="${g.done?'Mark goal not done':'Mark goal done'}" aria-pressed="${g.done}">${g.done?icon('check'):''}</button>
    <span class="txt" style="flex:1; font-size:0.88rem;">${escapeHtml(g.text)}</span>
    <button class="icon-btn tiny" data-action="del-goal" data-id="${g.id}" aria-label="Delete goal" style="border:none; background:none;">${icon('close')}</button>
  </div>`;
}
function stickyHtml(n){
  return `<div class="sticky">
    <button class="del" data-action="del-sticky" data-id="${n.id}" aria-label="Delete quick note">✕</button>
    <div contenteditable="true" role="textbox" aria-label="Quick note text" data-action="edit-sticky" data-id="${n.id}" style="outline:none; min-height:50px;">${escapeHtml(n.text)}</div>
  </div>`;
}

/* ============================================================
   VIEW: SUBJECTS
   ============================================================ */
function renderSubjects(){
  const subs = state.subjects.filter(inActiveSem).slice().sort((a,b)=> (b.pinned-a.pinned) || (a.order-b.order));
  document.getElementById("view").innerHTML = `
    <div class="page-head">
      <div><h1>Subjects</h1><p class="sub">Everything you're studying this semester.</p></div>
      <button class="btn" data-action="add-subject">${icon('plus')}Add Subject</button>
    </div>
    ${subs.length? `<div class="grid cols-3">${subs.map(subjectCardFull).join("")}</div>` :
      `<div class="empty">${icon('subjects')}<span>No subjects yet. Add your first subject.</span><button class="btn small" data-action="add-subject">${icon('plus')}Add Subject</button></div>`}
  `;
}
function subjectCardFull(s){
  return `<div class="subject-card hover-row">
    <div style="display:flex; justify-content:space-between; align-items:flex-start;" data-open-subject="${s.id}" role="button" tabindex="0" aria-label="Open ${escapeHtml(s.name)}">
      <div class="bar" style="background:${s.color}; flex:1;"></div>
    </div>
    <div data-open-subject="${s.id}">
      <h4>${escapeHtml(s.name)}</h4>
      <div class="code">${escapeHtml(s.code||'')}${s.lecturer?' · '+escapeHtml(s.lecturer):''}</div>
    </div>
    <div class="row-actions" style="position:absolute; top:14px; right:14px;">
      <button class="icon-btn tiny" data-action="pin-subject" data-id="${s.id}" title="Pin" aria-label="${s.pinned?'Unpin subject':'Pin subject'}">${s.pinned?icon('pin'):icon('pinOutline')}</button>
      <button class="icon-btn tiny" data-action="edit-subject" data-id="${s.id}" title="Edit" aria-label="Edit subject">${icon('edit')}</button>
      <button class="icon-btn tiny" data-action="del-subject" data-id="${s.id}" title="Delete" aria-label="Delete subject">${icon('trash')}</button>
    </div>
  </div>`;
}
function subjectFormHtml(s){
  s = s||{name:'',code:'',lecturer:'',group:'',credits:'',color:'#A8BFA3',icon:'📘'};
  return `
    <div class="modal-head"><h3>${s.id?'Edit Subject':'Add Subject'}</h3><button class="icon-btn" data-action="close-modal">${icon('close')}</button></div>
    <form id="subject-form">
      <div class="field"><label>Subject name</label><input required name="name" value="${escapeHtml(s.name)}" placeholder="Food Chemistry"></div>
      <div class="field-row">
        <div class="field"><label>Subject code</label><input name="code" value="${escapeHtml(s.code)}" placeholder="FST101"></div>
        <div class="field"><label>Credit hours</label><input name="credits" value="${escapeHtml(s.credits||'')}" placeholder="3"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Lecturer (optional)</label><input name="lecturer" value="${escapeHtml(s.lecturer||'')}"></div>
        <div class="field"><label>Class/group (optional)</label><input name="group" value="${escapeHtml(s.group||'')}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Icon (emoji)</label><input name="icon" value="${escapeHtml(s.icon||'📘')}" maxlength="2"></div>
        <div class="field"><label>Accent colour</label><input type="color" name="color" value="${s.color}" style="height:40px; padding:2px;"></div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn secondary" data-action="close-modal">Cancel</button>
        <button type="submit" class="btn">${s.id?'Save Changes':'Add Subject'}</button>
      </div>
    </form>
  `;
}

/* ============================================================
   VIEW: SUBJECT DETAIL
   ============================================================ */
let subjectDetailTab = "notes";
function renderSubjectDetail(id){
  const s = subjectById(id);
  if(!s){ navigate("subjects"); return; }
  const tabs = [["notes","Lecture Notes"],["assignments","Assignments"],["tutorials","Tutorials"],["labs","Labs"],["resources","Resources"],["personal","Personal Notes"]];
  const notes = state.notes.filter(n=>n.subjectId===id);
  const pdfs = state.pdfs.filter(p=>p.subjectId===id);
  const assigns = state.assignments.filter(a=>a.subjectId===id);

  document.getElementById("view").innerHTML = `
    <button class="btn ghost" data-nav="subjects" style="margin-bottom:10px;">${icon('chevL')} Subjects</button>
    <div class="page-head">
      <div style="display:flex; align-items:center; gap:12px;">
        <span style="font-size:2rem;">${s.icon||'📘'}</span>
        <div><h1>${escapeHtml(s.name)}</h1><p class="sub">${escapeHtml(s.code||'')}${s.lecturer?' · '+escapeHtml(s.lecturer):''}</p></div>
      </div>
      <button class="btn secondary" data-action="edit-subject" data-id="${s.id}">${icon('edit')}Edit</button>
    </div>
    <div class="tabs">${tabs.map(t=>`<button class="tab ${subjectDetailTab===t[0]?'active':''}" data-subtab="${t[0]}">${t[1]}</button>`).join("")}</div>
    <div id="subtab-content"></div>
  `;
  document.querySelectorAll("[data-subtab]").forEach(b=>b.addEventListener("click",()=>{ subjectDetailTab=b.dataset.subtab; renderSubjectDetail(id); }));
  renderSubjectTab(s, subjectDetailTab, {notes,pdfs,assigns});
}
function renderSubjectTab(s, tab, data){
  const box = document.getElementById("subtab-content");
  if(tab==="assignments"){
    box.innerHTML = data.assigns.length ? `<div class="card">${data.assigns.map(assignRowHtml).join("")}</div>` :
      emptyBlock("No assignments yet.", "add-assignment", s.id);
    return;
  }
  if(tab==="personal" || tab==="notes"){
    const filtered = data.notes.filter(n => tab==="personal" ? true : true); // both share personal note list for simplicity
    box.innerHTML = `
      <div style="display:flex; justify-content:flex-end; margin-bottom:12px; gap:8px;">
        ${tab==="notes"?`<button class="btn secondary small" data-action="upload-pdf" data-subject="${s.id}">${icon('upload')}Upload PDF</button>`:''}
        <button class="btn small" data-action="add-note" data-subject="${s.id}">${icon('plus')}Add Note</button>
      </div>
      ${tab==="notes" ? `<div class="grid cols-3" style="margin-bottom:16px;">${data.pdfs.map(pdfCardHtml).join("")}</div>` : ''}
      ${filtered.length? `<div class="grid cols-3">${filtered.map(noteCardHtml).join("")}</div>` :
        (data.pdfs.length? '' : emptyBlock("No notes uploaded yet.", "add-note", s.id))}
    `;
    return;
  }
  // tutorials/labs/resources -> generic personal notes filtered by chapter tag
  const filtered = data.notes.filter(n=> (n.chapter||"").toLowerCase()===tab);
  box.innerHTML = `
    <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
      <button class="btn small" data-action="add-note" data-subject="${s.id}" data-chapter="${tab}">${icon('plus')}Add ${tab[0].toUpperCase()+tab.slice(1,-1)}</button>
    </div>
    ${filtered.length? `<div class="grid cols-3">${filtered.map(noteCardHtml).join("")}</div>` : emptyBlock(`No ${tab} added yet.`, "add-note", s.id)}
  `;
}
function emptyBlock(msg, action, subjectId){
  return `<div class="empty"><span>${msg}</span><button class="btn small" data-action="${action}" data-subject="${subjectId||''}">${icon('plus')}Add</button></div>`;
}
function assignRowHtml(a){
  const s=subjectById(a.subjectId);
  return `<div class="assign-row hover-row">
    <div class="info" data-action="edit-assignment" data-id="${a.id}" role="button" tabindex="0" aria-label="Edit ${escapeHtml(a.name)}">
      <h4>${escapeHtml(a.name)}</h4>
      <div class="meta-line">
        <span class="badge ${urgencyClass(a.dueDate,a.status)}">${dueLabel(a.dueDate)}</span>
        <span class="badge ${a.status}">${statusLabel(a.status)}</span>
        ${s?`<span class="subject-chip"><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.name)}</span>`:''}
      </div>
    </div>
    <div class="progress-wrap"><div class="progress-track"><div class="progress-fill" style="width:${a.progress||0}%"></div></div><span>${a.progress||0}%</span></div>
    <div class="row-actions"><button class="icon-btn tiny" data-action="del-assignment" data-id="${a.id}" aria-label="Delete ${escapeHtml(a.name)}">${icon('trash')}</button></div>
  </div>`;
}
function statusLabel(st){ return {todo:"To Do","in-progress":"In Progress",completed:"Completed"}[st]||st; }
function noteCardHtml(n){
  return `<div class="note-card hover-row" data-open-note="${n.id}" role="button" tabindex="0" aria-label="Open note ${escapeHtml(n.title)}">
    <div style="display:flex; justify-content:space-between;"><h4>${escapeHtml(n.title)}</h4>
      <div class="row-actions"><button class="icon-btn tiny" data-action="del-note" data-id="${n.id}" aria-label="Delete note">${icon('trash')}</button></div>
    </div>
    <div class="preview">${escapeHtml((n.content||'').slice(0,120))}</div>
    <div class="meta-line">Updated ${new Date(n.updatedAt).toLocaleDateString()}</div>
  </div>`;
}
function pdfCardHtml(p){
  return `<div class="pdf-card hover-row" data-open-pdf="${p.id}" role="button" tabindex="0" aria-label="Open ${escapeHtml(p.filename)} in book reader">
    <div class="pdf-thumb">${icon('pdf')}</div>
    <div style="flex:1; min-width:0;"><h4 style="font-size:0.88rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(p.filename)}</h4>
      <div class="meta-line">${p.numPages||'?'} pages</div>
    </div>
    <div class="row-actions"><button class="icon-btn tiny" data-action="del-pdf" data-id="${p.id}" aria-label="Delete PDF">${icon('trash')}</button></div>
  </div>`;
}

/* ============================================================
   VIEW: NOTES VAULT (global)
   ============================================================ */
let notesTab = "vault";
function renderNotes(){
  const tabs=[["vault","All Notes & PDFs"],["bookmarks","Bookmarks"]];
  document.getElementById("view").innerHTML = `
    <div class="page-head"><div><h1>Notes Vault</h1><p class="sub">Lecture PDFs and your personal notes, organised by subject.</p></div>
      <div style="display:flex; gap:8px;">
        <button class="btn secondary" data-action="upload-pdf">${icon('upload')}Upload PDF</button>
        <button class="btn" data-action="add-note">${icon('plus')}Add Note</button>
      </div>
    </div>
    <div class="tabs">${tabs.map(t=>`<button class="tab ${notesTab===t[0]?'active':''}" data-notestab="${t[0]}">${t[1]}</button>`).join("")}</div>
    <div id="notes-tab-content"></div>
  `;
  document.querySelectorAll("[data-notestab]").forEach(b=>b.addEventListener("click",()=>{notesTab=b.dataset.notestab; renderNotes();}));
  const box = document.getElementById("notes-tab-content");
  if(notesTab==="bookmarks"){
    const bms = state.bookmarksList;
    box.innerHTML = bms.length ? `<div class="card">${bms.map(bookmarkRowHtml).join("")}</div>` : `<div class="empty">${icon('bookmark')}<span>No bookmarks yet.</span></div>`;
    return;
  }
  const subs = state.subjects.filter(inActiveSem);
  if(!subs.length && !state.notes.length && !state.pdfs.length){
    box.innerHTML = `<div class="empty">${icon('notes')}<span>No notes uploaded yet.</span><button class="btn small" data-action="add-subject">Add a subject first</button></div>`;
    return;
  }
  box.innerHTML = subs.map(s=>{
    const notes=state.notes.filter(n=>n.subjectId===s.id);
    const pdfs=state.pdfs.filter(p=>p.subjectId===s.id);
    if(!notes.length && !pdfs.length) return "";
    return `<div style="margin-bottom:24px;">
      <div class="section-title"><h3><span class="swatch" style="background:${s.color}; display:inline-block; margin-right:6px;"></span>${escapeHtml(s.name)}</h3></div>
      <div class="grid cols-3">${pdfs.map(pdfCardHtml).join("")}${notes.map(noteCardHtml).join("")}</div>
    </div>`;
  }).join("") || `<div class="empty">${icon('notes')}<span>No notes uploaded yet.</span></div>`;
}
function bookmarkRowHtml(b){
  let label=b.label, sub="";
  if(b.type==="pdf"){ const p=state.pdfs.find(x=>x.id===b.refId); sub = p? `${p.filename} · page ${b.page}` : "PDF removed"; }
  else if(b.type==="note"){ const n=state.notes.find(x=>x.id===b.refId); sub = n? "Personal note" : "Note removed"; }
  return `<div class="assign-row hover-row">
    <div class="info" data-action="open-bookmark" data-id="${b.id}" role="button" tabindex="0" aria-label="Open bookmark ${escapeHtml(label)}"><h4>${escapeHtml(label)}</h4><div class="meta-line">${escapeHtml(sub)}</div></div>
    <div class="row-actions"><button class="icon-btn tiny" data-action="del-bookmark" data-id="${b.id}" aria-label="Delete bookmark">${icon('trash')}</button></div>
  </div>`;
}

/* ============================================================
   VIEW: PLANNER
   ============================================================ */
let plannerFilter="all";
function renderPlanner(){
  const tasks = state.assignments.filter(inActiveSem); // reuse assignments+timetable as schedule source
  const sessions = []; // (kept simple: planner surfaces assignments by date + timetable classes)
  const allDated = state.assignments.filter(inActiveSem).filter(a=>a.dueDate)
    .sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const grouped = {};
  allDated.forEach(a=>{ (grouped[a.dueDate]=grouped[a.dueDate]||[]).push(a); });
  const dates = Object.keys(grouped).sort();

  document.getElementById("view").innerHTML = `
    <div class="page-head"><div><h1>Study Planner</h1><p class="sub">Your study tasks and deadlines, in order.</p></div>
      <button class="btn" data-action="add-assignment">${icon('plus')}Add Task</button>
    </div>
    ${dates.length? dates.map(d=>`
      <div style="margin-bottom:18px;">
        <div class="section-title"><h3>${fmtDate(d)} <span style="color:var(--text-faint); font-weight:500; font-size:0.8rem;">${dueLabel(d)}</span></h3></div>
        <div class="card">${grouped[d].map(assignRowHtml).join("")}</div>
      </div>`).join("") :
      `<div class="empty">${icon('planner')}<span>Nothing scheduled yet.</span><button class="btn small" data-action="add-assignment">${icon('plus')}Add Task</button></div>`}
  `;
}

/* ============================================================
   VIEW: ASSIGNMENTS
   ============================================================ */
let assignFilter="all", assignSort="due";
function renderAssignments(){
  let list = state.assignments.filter(inActiveSem);
  if(assignFilter!=="all") list = list.filter(a=>a.status===assignFilter);
  list = list.slice().sort((a,b)=>{
    if(assignSort==="due") return (a.dueDate||"9999").localeCompare(b.dueDate||"9999");
    const order={high:0,medium:1,low:2}; return (order[a.priority]??3)-(order[b.priority]??3);
  });
  document.getElementById("view").innerHTML = `
    <div class="page-head"><div><h1>Assignments</h1><p class="sub">Track every deadline in one place.</p></div>
      <button class="btn" data-action="add-assignment">${icon('plus')}Add Assignment</button>
    </div>
    <div class="filter-pills">
      ${["all","todo","in-progress","completed"].map(f=>`<button class="pill ${assignFilter===f?'active':''}" data-assignfilter="${f}">${f==="all"?"All":statusLabel(f)}</button>`).join("")}
      <span style="flex:1"></span>
      <select id="sort-select" style="padding:6px 12px; border-radius:999px; border:1px solid var(--border); background:var(--bg-elevated); font-size:0.8rem;">
        <option value="due" ${assignSort==="due"?"selected":""}>Sort: Due date</option>
        <option value="priority" ${assignSort==="priority"?"selected":""}>Sort: Priority</option>
      </select>
    </div>
    ${list.length? `<div class="card">${list.map(assignRowHtml).join("")}</div>` :
      `<div class="empty">${icon('assignments')}<span>No assignments yet.</span><button class="btn small" data-action="add-assignment">${icon('plus')}Add Assignment</button></div>`}
  `;
  document.querySelectorAll("[data-assignfilter]").forEach(b=>b.addEventListener("click",()=>{assignFilter=b.dataset.assignfilter; renderAssignments();}));
  const sel=document.getElementById("sort-select");
  if(sel) sel.addEventListener("change",()=>{assignSort=sel.value; renderAssignments();});
}
function assignmentFormHtml(a){
  a = a||{name:'',subjectId:'',description:'',dueDate:'',progress:0,priority:'medium',status:'todo'};
  return `
    <div class="modal-head"><h3>${a.id?'Edit Assignment':'Add Assignment'}</h3><button class="icon-btn" data-action="close-modal">${icon('close')}</button></div>
    <form id="assignment-form">
      <div class="field"><label>Assignment name</label><input required name="name" value="${escapeHtml(a.name)}"></div>
      <div class="field"><label>Subject</label><select name="subjectId"><option value="">— none —</option>${subjectOptions(a.subjectId)}</select></div>
      <div class="field"><label>Description</label><textarea name="description">${escapeHtml(a.description||'')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>Due date</label><input type="date" name="dueDate" value="${a.dueDate||''}"></div>
        <div class="field"><label>Priority</label><select name="priority">
          ${["low","medium","high"].map(p=>`<option value="${p}" ${a.priority===p?'selected':''}>${p[0].toUpperCase()+p.slice(1)}</option>`).join("")}
        </select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Status</label><select name="status">
          ${[["todo","To Do"],["in-progress","In Progress"],["completed","Completed"]].map(s=>`<option value="${s[0]}" ${a.status===s[0]?'selected':''}>${s[1]}</option>`).join("")}
        </select></div>
        <div class="field"><label>Progress (%)</label><input type="number" min="0" max="100" name="progress" value="${a.progress||0}"></div>
      </div>
      <div class="modal-actions"><button type="button" class="btn secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn">${a.id?'Save Changes':'Add Assignment'}</button></div>
    </form>
  `;
}

/* ============================================================
   VIEW: REVISION
   ============================================================ */
function renderRevision(){
  const subs = state.subjects.filter(inActiveSem);
  document.getElementById("view").innerHTML = `
    <div class="page-head"><div><h1>Revision Tracker</h1><p class="sub">Track how well you know each topic.</p></div></div>
    ${subs.length? subs.map(s=>{
      const topics = state.revisionTopics.filter(t=>t.subjectId===s.id);
      const mastered = topics.filter(t=>t.status==="mastered").length;
      const pct = topics.length? Math.round(mastered/topics.length*100):0;
      return `<div class="card" style="margin-bottom:16px;">
        <div class="section-title">
          <h3><span class="swatch" style="background:${s.color}; display:inline-block; margin-right:6px;"></span>${escapeHtml(s.name)}</h3>
          <button class="link" data-action="add-topic" data-subject="${s.id}">${icon('plus')} Add topic</button>
        </div>
        <div class="progress-track" style="margin-bottom:12px;"><div class="progress-fill" style="width:${pct}%; background:${s.color}"></div></div>
        ${topics.length? topics.map(topicRowHtml).join("") : `<div class="empty" style="padding:14px;">No topics added yet.</div>`}
      </div>`;
    }).join("") : `<div class="empty">${icon('revision')}<span>Add a subject first to start tracking revision.</span></div>`}
  `;
}
function topicRowHtml(t){
  const labels={"not-started":"Not Started",studied:"Studied","need-revision":"Need Revision",mastered:"Mastered"};
  return `<div class="topic-row hover-row">
    <span style="font-size:0.88rem;">${escapeHtml(t.chapter)}</span>
    <div style="display:flex; align-items:center; gap:8px;">
      <select class="status-select" data-action="topic-status" data-id="${t.id}">
        ${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${t.status===k?'selected':''}>${v}</option>`).join("")}
      </select>
      <button class="icon-btn tiny" data-action="del-topic" data-id="${t.id}" style="border:none; background:none;">${icon('trash')}</button>
    </div>
  </div>`;
}

/* ============================================================
   VIEW: SEMESTER PROGRESS
   ============================================================ */
function renderProgress(){
  const sem = activeSemester();
  const subs = state.subjects.filter(inActiveSem);
  const assigns = state.assignments.filter(inActiveSem);
  const completedAssigns = assigns.filter(a=>a.status==="completed").length;
  const topics = state.revisionTopics.filter(t=>subs.some(s=>s.id===t.subjectId));
  const mastered = topics.filter(t=>t.status==="mastered").length;
  const notesUploaded = state.notes.filter(inActiveSem).length + state.pdfs.filter(inActiveSem).length;
  const classesTotal = state.timetable.filter(inActiveSem).length;
  const pct = sem.totalWeeks? Math.min(100,Math.round(sem.currentWeek/sem.totalWeeks*100)):0;

  document.getElementById("view").innerHTML = `
    <div class="page-head"><div><h1>Semester Progress</h1><p class="sub">${escapeHtml(sem.name)} — Week ${sem.currentWeek} of ${sem.totalWeeks}</p></div>
      <button class="btn secondary" data-action="edit-semester">${icon('edit')}Edit Semester</button>
    </div>
    <div class="card" style="margin-bottom:18px;">
      <div class="progress-track" style="height:10px;"><div class="progress-fill" style="width:${pct}%"></div></div>
      <p style="margin-top:8px; font-size:0.82rem; color:var(--text-soft);">${pct}% through the semester</p>
    </div>
    <div class="grid cols-3">
      ${statCard("Assignments completed", `${completedAssigns}/${assigns.length||0}`)}
      ${statCard("Topics mastered", `${mastered}/${topics.length||0}`)}
      ${statCard("Notes uploaded", `${notesUploaded}`)}
      ${statCard("Subjects", `${subs.length}`)}
      ${statCard("Classes this week", `${classesTotal}`)}
      ${statCard("Study streak", `${state.stats.streak} days`)}
    </div>
  `;
}
function statCard(label,val){
  return `<div class="stat-card"><p>${label}</p><h2>${val}</h2></div>`;
}

/* ============================================================
   VIEW: TIMETABLE
   ============================================================ */
const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
function renderTimetable(){
  const entries = state.timetable.filter(inActiveSem);
  const startHour=7, endHour=20;
  document.getElementById("view").innerHTML = `
    <div class="page-head"><div><h1>Class Timetable</h1><p class="sub">Your weekly schedule at a glance.</p></div>
      <button class="btn" data-action="add-timetable">${icon('plus')}Add Class</button>
    </div>
    ${entries.length ? `<div class="ttable-scroll"><div class="ttable">
      <div></div>${DOW.map(d=>`<div class="tt-head">${d}</div>`).join("")}
      ${Array.from({length:endHour-startHour},(_,i)=>startHour+i).map(h=>`
        <div class="tt-hour">${h}:00</div>
        ${DOW.map((d,di)=>`<div class="tt-cell" data-hourcell="${di}-${h}"></div>`).join("")}
      `).join("")}
    </div></div>
    <div style="margin-top:18px;" class="card">${entries.sort((a,b)=>a.day-b.day || a.start.localeCompare(b.start)).map(timetableRowHtml).join("")}</div>
    ` : `<div class="empty">${icon('timetable')}<span>No classes scheduled yet.</span><button class="btn small" data-action="add-timetable">${icon('plus')}Add Class</button></div>`}
  `;
  // position blocks
  entries.forEach(e=>{
    const startH=parseInt(e.start.split(":")[0]), startM=parseInt(e.start.split(":")[1]||0);
    const endH=parseInt(e.end.split(":")[0]), endM=parseInt(e.end.split(":")[1]||0);
    const s=subjectById(e.subjectId);
    for(let h=startH; h<endH || (h===startH && endH<=startH); h++){
      const cell=document.querySelector(`[data-hourcell="${e.day}-${h}"]`);
      if(!cell) continue;
      if(h===startH){
        const block=document.createElement("div");
        block.className="tt-block";
        block.style.background = s? s.color : "var(--sage-deep)";
        block.style.top = (startM/60*100)+"%";
        const durH = (endH+endM/60)-(startH+startM/60);
        block.style.height = Math.max(28, durH*54)+"px";
        block.textContent = (s?s.name:"Class");
        block.title = `${e.start}–${e.end} · ${e.location||''}`;
        block.dataset.action="edit-timetable"; block.dataset.id=e.id;
        cell.appendChild(block);
      }
    }
  });
}
function timetableRowHtml(e){
  const s=subjectById(e.subjectId);
  return `<div class="assign-row hover-row">
    <div class="info" data-action="edit-timetable" data-id="${e.id}" role="button" tabindex="0" aria-label="Edit class ${s?escapeHtml(s.name):''}"><h4>${s?escapeHtml(s.name):'Class'}</h4>
      <div class="meta-line">${DOW[e.day]} · ${e.start}–${e.end}${e.location?' · '+escapeHtml(e.location):''}</div>
    </div>
    <div class="row-actions"><button class="icon-btn tiny" data-action="del-timetable" data-id="${e.id}" aria-label="Delete class">${icon('trash')}</button></div>
  </div>`;
}

/* ============================================================
   VIEW: SETTINGS
   ============================================================ */
let settingsTab="appearance";
function renderSettings(){
  const tabs=[["appearance","Appearance"],["account","Account"],["semester","Semesters"],["reminders","Reminders"],["data","Data & Trash"],["about","About"]];
  document.getElementById("view").innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <div class="tabs">${tabs.map(t=>`<button class="tab ${settingsTab===t[0]?'active':''}" data-settab="${t[0]}">${t[1]}</button>`).join("")}</div>
    <div id="settings-content"></div>
  `;
  document.querySelectorAll("[data-settab]").forEach(b=>b.addEventListener("click",()=>{settingsTab=b.dataset.settab; renderSettings();}));
  const box=document.getElementById("settings-content");
  if(settingsTab==="appearance"){
    box.innerHTML = `<div class="card" style="max-width:420px;">
      <div class="field"><label>Theme</label>
        <div style="display:flex; gap:8px;">
          ${[["light","☀️ Light"],["dark","🌙 Dark"],["system","🌓 System"]].map(([v,l])=>`
            <button class="pill ${state.settings.theme===v?'active':''}" data-theme-set="${v}" style="flex:1;">${l}</button>`).join("")}
        </div>
      </div>
    </div>`;
    box.querySelectorAll("[data-theme-set]").forEach(b=>b.addEventListener("click",()=>{
      state.settings.theme=b.dataset.themeSet; applyTheme(); save(); renderSettings();
    }));
    return;
  }
  if(settingsTab==="account"){
    if(!FIREBASE_READY){
      box.innerHTML = `<div class="card" style="max-width:460px;">
        <p style="font-size:0.9rem; color:var(--text-soft); line-height:1.6;">Google Sign-In hasn't been configured for this deployment yet — data stays in this browser only. Add your Firebase project's config to <code>firebase-config.js</code> to enable syncing across devices.</p>
      </div>`;
      return;
    }
    if(fbUser){
      box.innerHTML = `<div class="card" style="max-width:460px;">
        <div style="display:flex; align-items:center; gap:13px; margin-bottom:16px;">
          ${fbUser.photoURL?`<img src="${fbUser.photoURL}" alt="" style="width:44px;height:44px;border-radius:50%;">`:`<div class="account-avatar-lg">${escapeHtml((fbUser.displayName||fbUser.email||"?").trim()[0].toUpperCase())}</div>`}
          <div><strong style="font-size:0.92rem;">${escapeHtml(fbUser.displayName||"")}</strong><div style="font-size:0.8rem; color:var(--text-soft);">${escapeHtml(fbUser.email||"")}</div></div>
        </div>
        <p style="font-size:0.85rem; color:var(--text-soft); margin-bottom:16px;">${cloudSynced?"Synced — your data follows you to any device you sign in on.":"Signed in, but the last sync attempt failed."}</p>
        <button class="btn danger small" id="settings-signout">Sign out</button>
      </div>`;
      document.getElementById("settings-signout").addEventListener("click", signOutGoogle);
    } else {
      box.innerHTML = `<div class="card" style="max-width:460px;">
        <p style="font-size:0.9rem; color:var(--text-soft); margin-bottom:16px;">Sign in with Google to back up your data and pick up right where you left off on any device.</p>
        <button class="btn secondary" id="settings-signin">${googleGIcon()}<span>Sign in with Google</span></button>
      </div>`;
      document.getElementById("settings-signin").addEventListener("click", signInWithGoogle);
    }
    return;
  }
  if(settingsTab==="semester"){
    const active=state.semesters.filter(s=>!s.archived), archived=state.semesters.filter(s=>s.archived);
    box.innerHTML = `
      <div class="section-title"><h3>Active</h3><button class="link" data-action="new-semester">${icon('plus')} New Semester</button></div>
      <div class="card" style="margin-bottom:18px;">${active.map(s=>`
        <div class="topic-row"><span>${escapeHtml(s.name)} — Week ${s.currentWeek}/${s.totalWeeks} ${s.id===state.activeSemesterId?'<span class="badge done">Current</span>':''}</span>
          <div style="display:flex; gap:8px;">
            ${s.id!==state.activeSemesterId?`<button class="btn small secondary" data-action="switch-semester" data-id="${s.id}">Switch</button>`:''}
            <button class="btn small secondary" data-action="edit-semester" data-id="${s.id}">Edit</button>
            <button class="btn small danger" data-action="archive-semester" data-id="${s.id}">Archive</button>
          </div>
        </div>`).join("")}</div>
      <div class="section-title"><h3>Archived</h3></div>
      ${archived.length? `<div class="card">${archived.map(s=>`<div class="topic-row"><span>${escapeHtml(s.name)}</span><span class="badge">Archived</span></div>`).join("")}</div>` : `<div class="empty" style="padding:16px;">No archived semesters yet.</div>`}
    `;
    return;
  }
  if(settingsTab==="reminders"){
    box.innerHTML = `<div class="card" style="max-width:420px;">
      <div class="field"><label>Remind me about deadlines this many days ahead</label>
        <input type="number" min="1" max="14" id="reminder-days" value="${state.settings.reminderDays}">
      </div>
      <button class="btn small" id="save-reminder">Save</button>
    </div>`;
    document.getElementById("save-reminder").addEventListener("click",()=>{
      state.settings.reminderDays = parseInt(document.getElementById("reminder-days").value)||3;
      save(); toast("Reminder setting saved");
    });
    return;
  }
  if(settingsTab==="data"){
    box.innerHTML = `
      <div class="section-title"><h3>Trash</h3></div>
      ${state.trash.length? `<div class="card">${state.trash.map(t=>`
        <div class="topic-row"><span>${escapeHtml(trashLabel(t))}</span>
          <div style="display:flex; gap:8px;">
            <button class="btn small secondary" data-action="restore-trash" data-id="${t.id}">Restore</button>
            <button class="btn small danger" data-action="purge-trash" data-id="${t.id}">Delete forever</button>
          </div>
        </div>`).join("")}</div>` : `<div class="empty" style="padding:16px;">Trash is empty.</div>`}
      <div class="section-title" style="margin-top:20px;"><h3>Storage</h3></div>
      <div class="card"><p style="font-size:0.85rem; color:var(--text-soft);">${fbUser? "Your data is backed up to your Google account and cached in this browser's local storage for offline use." : "Notelylog saves everything to this browser's local storage. Sign in with Google (in Settings → Account) to back it up and sync it across devices."} Uploaded PDFs are always kept on this device only and are never backed up or synced, even when signed in.</p></div>
    `;
    return;
  }
  if(settingsTab==="about"){
    box.innerHTML = `<div class="card" style="max-width:480px;"><h3 style="margin-bottom:8px;">About notelylog</h3>
      <p style="font-size:0.88rem; color:var(--text-soft); line-height:1.6;">A calm study desk for keeping subjects, notes, PDFs, assignments and revision all in one place — built to feel like a study journal, not a corporate LMS.</p></div>`;
    return;
  }
}
function trashLabel(t){
  const d=t.data;
  return d.name || d.title || d.filename || d.text || d.chapter || "Item";
}

/* ============================================================
   MODALS / FORMS — subjects, notes, assignments, topics, timetable, goals
   ============================================================ */
document.addEventListener("submit", e=>{
  if(e.target.id==="subject-form"){
    e.preventDefault();
    const f=new FormData(e.target);
    const id = e.target.dataset.editId;
    if(id){
      const s=subjectById(id);
      Object.assign(s,{name:f.get("name"),code:f.get("code"),lecturer:f.get("lecturer"),group:f.get("group"),credits:f.get("credits"),icon:f.get("icon"),color:f.get("color")});
    } else {
      state.subjects.push({id:uid(), semesterId:state.activeSemesterId, name:f.get("name"), code:f.get("code"), lecturer:f.get("lecturer"), group:f.get("group"), credits:f.get("credits"), icon:f.get("icon")||"📘", color:f.get("color")||"#A8BFA3", pinned:false, order:state.subjects.length, createdAt:Date.now()});
    }
    save(); closeModal(); renderView(); toast(id?"Subject updated":"Subject added");
  }
  if(e.target.id==="assignment-form"){
    e.preventDefault();
    const f=new FormData(e.target);
    const id=e.target.dataset.editId;
    const payload={name:f.get("name"), subjectId:f.get("subjectId")||null, description:f.get("description"), dueDate:f.get("dueDate")||null, priority:f.get("priority"), status:f.get("status"), progress:Math.max(0,Math.min(100,parseInt(f.get("progress"))||0))};
    if(id){ Object.assign(state.assignments.find(a=>a.id===id), payload); }
    else { state.assignments.push({id:uid(), semesterId:state.activeSemesterId, createdAt:Date.now(), ...payload}); }
    save(); closeModal(); renderView(); toast(id?"Assignment updated":"Assignment added");
  }
  if(e.target.id==="note-form"){
    e.preventDefault();
    const f=new FormData(e.target);
    const id=e.target.dataset.editId;
    const payload={title:f.get("title"), subjectId:f.get("subjectId")||null, chapter:f.get("chapter")||"", content:f.get("content")||""};
    if(id){ const n=state.notes.find(x=>x.id===id); Object.assign(n,payload); n.updatedAt=Date.now(); }
    else { state.notes.push({id:uid(), semesterId:state.activeSemesterId, createdAt:Date.now(), updatedAt:Date.now(), ...payload}); }
    save(); closeModal(); renderView(); toast(id?"Note saved":"Note added");
  }
  if(e.target.id==="topic-form"){
    e.preventDefault();
    const f=new FormData(e.target);
    state.revisionTopics.push({id:uid(), semesterId:state.activeSemesterId, subjectId:e.target.dataset.subject, chapter:f.get("chapter"), status:"not-started"});
    save(); closeModal(); renderView(); toast("Topic added");
  }
  if(e.target.id==="timetable-form"){
    e.preventDefault();
    const f=new FormData(e.target);
    const id=e.target.dataset.editId;
    const payload={subjectId:f.get("subjectId"), day:parseInt(f.get("day")), start:f.get("start"), end:f.get("end"), location:f.get("location"), lecturer:f.get("lecturer")};
    if(id){ Object.assign(state.timetable.find(t=>t.id===id), payload); }
    else { state.timetable.push({id:uid(), semesterId:state.activeSemesterId, ...payload}); }
    save(); closeModal(); renderView(); toast(id?"Class updated":"Class added");
  }
  if(e.target.id==="goal-form"){
    e.preventDefault();
    const f=new FormData(e.target);
    state.goals.push({id:uid(), semesterId:state.activeSemesterId, text:f.get("text"), done:false, createdAt:Date.now()});
    save(); closeModal(); renderView(); toast("Goal added");
  }
  if(e.target.id==="semester-form"){
    e.preventDefault();
    const f=new FormData(e.target);
    const id=e.target.dataset.editId;
    if(id){ const s=state.semesters.find(x=>x.id===id); s.name=f.get("name"); s.totalWeeks=parseInt(f.get("totalWeeks"))||17; s.currentWeek=parseInt(f.get("currentWeek"))||1; }
    save(); closeModal(); renderView(); toast("Semester saved");
  }
});

/* ---------- delegated action clicks ---------- */
document.addEventListener("click", e=>{
  const t = e.target.closest("[data-action],[data-open-subject],[data-open-note],[data-open-pdf]");
  if(!t) return;

  if(t.dataset.openSubject){ navigate("subject-detail", {id:t.dataset.openSubject}); renderSubjectDetail(t.dataset.openSubject); return; }
  if(t.dataset.openNote){ openNoteModal(state.notes.find(n=>n.id===t.dataset.openNote)); return; }
  if(t.dataset.openPdf){ openReader(t.dataset.openPdf); return; }

  const a = t.dataset.action;
  if(!a) return;

  if(a==="close-modal"){ closeModal(); return; }
  if(a==="add-subject"){ openModal(subjectFormHtml()); document.getElementById("subject-form").addEventListener("submit",()=>{}); return; }
  if(a==="edit-subject"){ openModal(subjectFormHtml(subjectById(t.dataset.id))); const f=document.getElementById("subject-form"); f.dataset.editId=t.dataset.id; return; }
  if(a==="pin-subject"){ const s=subjectById(t.dataset.id); s.pinned=!s.pinned; save(); renderView(); return; }
  if(a==="del-subject"){ if(confirm("Move this subject to Trash?")) softDelete("subjects", t.dataset.id, "subject"); renderView(); return; }

  if(a==="add-assignment"){ openModal(assignmentFormHtml()); return; }
  if(a==="edit-assignment"){ openModal(assignmentFormHtml(state.assignments.find(x=>x.id===t.dataset.id))); document.getElementById("assignment-form").dataset.editId=t.dataset.id; return; }
  if(a==="del-assignment"){ softDelete("assignments", t.dataset.id, "assignment"); renderView(); return; }

  if(a==="add-note"){ openModal(noteFormHtml(null, t.dataset.subject, t.dataset.chapter)); return; }
  if(a==="del-note"){ softDelete("notes", t.dataset.id, "note"); renderView(); return; }
  if(a==="del-pdf"){ softDelete("pdfs", t.dataset.id, "pdf"); renderView(); return; }
  if(a==="upload-pdf"){ triggerPdfUpload(t.dataset.subject); return; }

  if(a==="add-topic"){ openModal(topicFormHtml(t.dataset.subject)); return; }
  if(a==="topic-status"){ /* handled by change listener */ return; }
  if(a==="del-topic"){ softDelete("revisionTopics", t.dataset.id, "topic"); renderView(); return; }

  if(a==="add-timetable"){ openModal(timetableFormHtml()); return; }
  if(a==="edit-timetable"){ openModal(timetableFormHtml(state.timetable.find(x=>x.id===t.dataset.id))); document.getElementById("timetable-form").dataset.editId=t.dataset.id; return; }
  if(a==="del-timetable"){ softDelete("timetable", t.dataset.id, "class"); renderView(); return; }

  if(a==="add-goal"){ openModal(`<div class="modal-head"><h3>Add Goal</h3><button class="icon-btn" data-action="close-modal">${icon('close')}</button></div>
    <form id="goal-form"><div class="field"><label>Goal</label><input required name="text" placeholder="Finish all lecture notes"></div>
    <div class="modal-actions"><button type="button" class="btn secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn">Add Goal</button></div></form>`); return; }
  if(a==="toggle-goal"){ const g=state.goals.find(x=>x.id===t.dataset.id); g.done=!g.done; save(); renderView(); return; }
  if(a==="del-goal"){ state.goals=state.goals.filter(x=>x.id!==t.dataset.id); save(); renderView(); return; }

  if(a==="add-sticky"){ state.quickNotes.push({id:uid(), text:"", pinned:false, createdAt:Date.now()}); save(); renderView(); return; }
  if(a==="del-sticky"){ state.quickNotes=state.quickNotes.filter(x=>x.id!==t.dataset.id); save(); renderView(); return; }

  if(a==="new-semester"){ openModal(semesterFormHtml()); return; }
  if(a==="edit-semester"){ const s=state.semesters.find(x=>x.id===t.dataset.id)||activeSemester(); openModal(semesterFormHtml(s)); document.getElementById("semester-form").dataset.editId=s.id; return; }
  if(a==="switch-semester"){ state.activeSemesterId=t.dataset.id; save(); renderView(); toast("Switched semester"); return; }
  if(a==="archive-semester"){
    if(confirm("Archive this semester? It stays accessible but won't clutter your active dashboard.")){
      const s=state.semesters.find(x=>x.id===t.dataset.id); s.archived=true;
      const remaining = state.semesters.filter(x=>!x.archived);
      if(remaining.length){ state.activeSemesterId=remaining[0].id; }
      else { const ns={id:uid(), name:"New Semester", totalWeeks:17, currentWeek:1, archived:false, createdAt:Date.now()}; state.semesters.push(ns); state.activeSemesterId=ns.id; }
      save(); renderView(); toast("Semester archived");
    }
    return;
  }
  if(a==="restore-trash"){ restoreTrash(t.dataset.id); return; }
  if(a==="purge-trash"){ if(confirm("Permanently delete this item?")) purgeTrash(t.dataset.id); return; }

  if(a==="open-bookmark"){
    const b=state.bookmarksList.find(x=>x.id===t.dataset.id);
    if(!b) return;
    if(b.type==="pdf" && state.pdfs.some(p=>p.id===b.refId)){ openReader(b.refId); }
    else if(b.type==="note"){ const n=state.notes.find(x=>x.id===b.refId); if(n) openNoteModal(n); else toast("That note was removed"); }
    return;
  }
  if(a==="del-bookmark"){ state.bookmarksList=state.bookmarksList.filter(x=>x.id!==t.dataset.id); save(); renderView(); return; }
});

/* keyboard activation for card-like elements marked role="button" */
document.addEventListener("keydown", e=>{
  if((e.key==="Enter" || e.key===" ") && e.target.matches('[role="button"]')){
    e.preventDefault();
    e.target.click();
  }
});

document.addEventListener("change", e=>{
  if(e.target.dataset && e.target.dataset.action==="topic-status"){
    const topic = state.revisionTopics.find(x=>x.id===e.target.dataset.id);
    topic.status = e.target.value; save(); renderView();
  }
});
document.addEventListener("blur", e=>{
  if(e.target.dataset && e.target.dataset.action==="edit-sticky"){
    const n=state.quickNotes.find(x=>x.id===e.target.dataset.id);
    if(n){ n.text = e.target.textContent; save(); }
  }
}, true);

function noteFormHtml(n, subjectId, chapter){
  n = n || {title:'', subjectId:subjectId||'', chapter:chapter||'', content:''};
  return `
    <div class="modal-head"><h3>${n.id?'Edit Note':'Add Note'}</h3><button class="icon-btn" data-action="close-modal">${icon('close')}</button></div>
    <form id="note-form">
      <div class="field"><label>Title</label><input required name="title" value="${escapeHtml(n.title)}"></div>
      <div class="field-row">
        <div class="field"><label>Subject</label><select name="subjectId"><option value="">— none —</option>${subjectOptions(n.subjectId)}</select></div>
        <div class="field"><label>Chapter/topic</label><input name="chapter" value="${escapeHtml(n.chapter||'')}"></div>
      </div>
      <div class="field"><label>Content</label><textarea name="content" rows="6">${escapeHtml(n.content||'')}</textarea></div>
      <div class="modal-actions"><button type="button" class="btn secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn">${n.id?'Save':'Add Note'}</button></div>
    </form>
  `;
}
function openNoteModal(n){
  openModal(noteFormHtml(n));
  if(n) document.getElementById("note-form").dataset.editId=n.id;
}
function topicFormHtml(subjectId){
  return `<div class="modal-head"><h3>Add Topic</h3><button class="icon-btn" data-action="close-modal">${icon('close')}</button></div>
  <form id="topic-form" data-subject="${subjectId}">
    <div class="field"><label>Chapter/topic name</label><input required name="chapter" placeholder="Chapter 3"></div>
    <div class="modal-actions"><button type="button" class="btn secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn">Add</button></div>
  </form>`;
}
function timetableFormHtml(e){
  e = e||{subjectId:'',day:0,start:'09:00',end:'10:00',location:'',lecturer:''};
  return `<div class="modal-head"><h3>${e.id?'Edit Class':'Add Class'}</h3><button class="icon-btn" data-action="close-modal">${icon('close')}</button></div>
  <form id="timetable-form">
    <div class="field"><label>Subject</label><select required name="subjectId">${subjectOptions(e.subjectId)}</select></div>
    <div class="field-row">
      <div class="field"><label>Day</label><select name="day">${DOW.map((d,i)=>`<option value="${i}" ${e.day===i?'selected':''}>${d}</option>`).join("")}</select></div>
      <div class="field"><label>Location</label><input name="location" value="${escapeHtml(e.location||'')}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Start time</label><input type="time" name="start" value="${e.start}"></div>
      <div class="field"><label>End time</label><input type="time" name="end" value="${e.end}"></div>
    </div>
    <div class="field"><label>Lecturer (optional)</label><input name="lecturer" value="${escapeHtml(e.lecturer||'')}"></div>
    <div class="modal-actions"><button type="button" class="btn secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn">${e.id?'Save':'Add Class'}</button></div>
  </form>`;
}
function semesterFormHtml(s){
  s = s || {name:'', totalWeeks:17, currentWeek:1};
  return `<div class="modal-head"><h3>${s.id?'Edit Semester':'New Semester'}</h3><button class="icon-btn" data-action="close-modal">${icon('close')}</button></div>
  <form id="semester-form">
    <div class="field"><label>Semester name</label><input required name="name" value="${escapeHtml(s.name)}" placeholder="Semester 2"></div>
    <div class="field-row">
      <div class="field"><label>Total weeks</label><input type="number" min="1" name="totalWeeks" value="${s.totalWeeks}"></div>
      <div class="field"><label>Current week</label><input type="number" min="1" name="currentWeek" value="${s.currentWeek}"></div>
    </div>
    <div class="modal-actions"><button type="button" class="btn secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn">Save</button></div>
  </form>`;
}
document.addEventListener("submit", e=>{
  if(e.target.id==="semester-form" && !e.target.dataset.editId){
    // new semester (only when opened via "new-semester")
  }
});
// handle new-semester create (separate because same form id used for edit)
document.getElementById("modal-backdrop").addEventListener("submit", e=>{
  if(e.target.id==="semester-form" && !e.target.dataset.editId){
    e.preventDefault();
    const f=new FormData(e.target);
    const ns={id:uid(), name:f.get("name"), totalWeeks:parseInt(f.get("totalWeeks"))||17, currentWeek:parseInt(f.get("currentWeek"))||1, archived:false, createdAt:Date.now()};
    state.semesters.push(ns); state.activeSemesterId=ns.id;
    save(); closeModal(); renderView(); toast("New semester created");
  }
}, true);

/* ============================================================
   PDF UPLOAD + BOOK READER
   ============================================================ */
if(window.pdfjsLib){
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
function triggerPdfUpload(subjectId){
  const input=document.createElement("input");
  input.type="file"; input.accept="application/pdf";
  input.onchange = async ()=>{
    const file=input.files[0]; if(!file) return;
    if(file.size > 18*1024*1024){ toast("PDF is quite large — this may slow things down"); }
    const reader=new FileReader();
    reader.onload = async ()=>{
      const dataUrl = reader.result;
      let numPages=null;
      try{
        const doc = await pdfjsLib.getDocument({url:dataUrl}).promise;
        numPages = doc.numPages;
      }catch(err){}
      const sid = subjectId || (currentView==="subject-detail" ? currentParams.id : (state.subjects.filter(inActiveSem)[0]||{}).id);
      state.pdfs.push({id:uid(), semesterId:state.activeSemesterId, subjectId:sid||null, filename:file.name, data:dataUrl, numPages, uploadedAt:Date.now(), bookmarks:[]});
      save(); renderView(); toast("PDF uploaded");
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

/* ---- reader state ---- */
let reader = { pdfId:null, doc:null, spread:0, scale:1, isMobile:false, fullscreen:false };
function isMobileView(){ return window.matchMedia("(max-width:760px)").matches; }

async function openReader(pdfId){
  const rec = state.pdfs.find(p=>p.id===pdfId);
  if(!rec) return;
  reader = { pdfId, doc:null, spread:0, scale:1, isMobile:isMobileView() };
  document.getElementById("reader-root").innerHTML = readerShellHtml(rec);
  document.getElementById("reader-root").style.display="block";
  try{
    reader.doc = await pdfjsLib.getDocument({url:rec.data}).promise;
    rec.numPages = reader.doc.numPages;
    save();
  }catch(err){
    toast("Couldn't open this PDF"); closeReader(); return;
  }
  await renderThumbs(rec);
  await renderSpread();
  bindReaderEvents(rec);
}
function closeReader(){
  document.getElementById("reader-root").innerHTML="";
  document.getElementById("reader-root").style.display="none";
  document.removeEventListener("keydown", readerKeyHandler);
}
function readerShellHtml(rec){
  return `
  <div id="reader-view">
    <div class="reader-toolbar" role="toolbar" aria-label="Book reader controls">
      <button data-r="close" title="Close" aria-label="Close reader">${icon('close')}</button>
      <span class="title">${escapeHtml(rec.filename)}</span>
      <button data-r="prev" title="Previous page" aria-label="Previous page">${icon('chevL')}</button>
      <span class="pageno" id="reader-pageno" aria-live="polite">–</span>
      <button data-r="next" title="Next page" aria-label="Next page">${icon('chevR')}</button>
      <div class="grow"></div>
      <button data-r="bookmark" title="Bookmark this page" aria-label="Bookmark this page">${icon('bookmark')}</button>
      <button data-r="zoomout" title="Zoom out" aria-label="Zoom out">${icon('zoomOut')}</button>
      <button data-r="zoomin" title="Zoom in" aria-label="Zoom in">${icon('zoomIn')}</button>
      <button data-r="fullscreen" title="Fullscreen" aria-label="Toggle fullscreen">${icon('fullscreen')}</button>
    </div>
    <div class="book-stage" id="book-stage"></div>
    <div class="thumb-strip" id="thumb-strip"></div>
  </div>`;
}
async function renderThumbs(rec){
  const strip=document.getElementById("thumb-strip");
  if(!strip) return;
  strip.innerHTML="";
  const n=reader.doc.numPages;
  for(let i=1;i<=n;i++){
    const ph=document.createElement("div");
    ph.className="thumb-ph"; ph.dataset.page=i;
    ph.style.background="var(--bg-sunken)";
    ph.addEventListener("click",()=>{ reader.spread = reader.isMobile? i-1 : spreadForPage(i); renderSpread(); });
    strip.appendChild(ph);
  }
}
function spreadForPage(p){ return p<=1?0:Math.ceil((p-1)/2); }
function pagesForSpread(idx){
  if(reader.isMobile) return [idx+1];
  if(idx===0) return [1];
  const left=idx*2, right=left+1;
  return [left, right].filter(p=>p>=1 && p<=reader.doc.numPages);
}
async function renderPageToCanvas(pageNum, canvas){
  const page = await reader.doc.getPage(pageNum);
  const viewport = page.getViewport({scale: 1.35 * reader.scale});
  canvas.width = viewport.width; canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({canvasContext:ctx, viewport}).promise;
}
async function renderSpread(dir){
  const stage=document.getElementById("book-stage");
  if(!stage || !reader.doc) return;
  reader.isMobile = isMobileView();
  const pages = pagesForSpread(reader.spread);
  const wrap=document.createElement("div");
  wrap.className="book-spread" + (dir==="next"?" turning-next":dir==="prev"?" turning-prev":"");
  if(pages.length===1){
    const pageDiv=document.createElement("div"); pageDiv.className="book-page single";
    const c=document.createElement("canvas"); pageDiv.appendChild(c); wrap.appendChild(pageDiv);
    await renderPageToCanvas(pages[0], c);
  } else {
    const l=document.createElement("div"); l.className="book-page left";
    const cl=document.createElement("canvas"); l.appendChild(cl);
    const spine=document.createElement("div"); spine.className="book-spine";
    const r=document.createElement("div"); r.className="book-page right";
    const cr=document.createElement("canvas"); r.appendChild(cr);
    wrap.appendChild(l); wrap.appendChild(spine); wrap.appendChild(r);
    await renderPageToCanvas(pages[0], cl);
    if(pages[1]) await renderPageToCanvas(pages[1], cr);
  }
  const tapL=document.createElement("div"); tapL.className="reader-tap-l"; tapL.addEventListener("click",()=>turn("prev"));
  const tapR=document.createElement("div"); tapR.className="reader-tap-r"; tapR.addEventListener("click",()=>turn("next"));
  wrap.appendChild(tapL); wrap.appendChild(tapR);
  stage.innerHTML=""; stage.appendChild(wrap);
  requestAnimationFrame(()=>wrap.classList.remove("turning-next","turning-prev"));

  const label = pages.length===1? `Page ${pages[0]} of ${reader.doc.numPages}` : `Pages ${pages[0]}–${pages[1]||pages[0]} of ${reader.doc.numPages}`;
  const pn=document.getElementById("reader-pageno"); if(pn) pn.textContent=label;
  document.querySelectorAll(".thumb-ph").forEach(el=>el.classList.toggle("active", pages.includes(parseInt(el.dataset.page))));
  const activeThumb = document.querySelector(".thumb-ph.active");
  if(activeThumb) activeThumb.scrollIntoView({inline:"center", block:"nearest"});
}
function maxSpread(){
  if(!reader.doc) return 0;
  return reader.isMobile ? reader.doc.numPages-1 : spreadForPage(reader.doc.numPages);
}
function turn(dir){
  if(!reader.doc) return;
  if(dir==="next" && reader.spread < maxSpread()){ reader.spread++; renderSpread("next"); }
  else if(dir==="prev" && reader.spread>0){ reader.spread--; renderSpread("prev"); }
}
function readerKeyHandler(e){
  if(e.key==="ArrowLeft") turn("prev");
  if(e.key==="ArrowRight") turn("next");
  if(e.key==="Escape") closeReader();
}
function bindReaderEvents(rec){
  document.addEventListener("keydown", readerKeyHandler);
  const root=document.getElementById("reader-root");
  root.querySelector('[data-r="close"]').addEventListener("click", closeReader);
  root.querySelector('[data-r="prev"]').addEventListener("click", ()=>turn("prev"));
  root.querySelector('[data-r="next"]').addEventListener("click", ()=>turn("next"));
  root.querySelector('[data-r="zoomin"]').addEventListener("click", ()=>{ reader.scale=Math.min(2.2, reader.scale+0.15); renderSpread(); });
  root.querySelector('[data-r="zoomout"]').addEventListener("click", ()=>{ reader.scale=Math.max(0.6, reader.scale-0.15); renderSpread(); });
  root.querySelector('[data-r="fullscreen"]').addEventListener("click", ()=>{
    const el=document.getElementById("reader-view");
    if(!document.fullscreenElement){ el.requestFullscreen?.(); } else { document.exitFullscreen?.(); }
  });
  root.querySelector('[data-r="bookmark"]').addEventListener("click", ()=>{
    const page = pagesForSpread(reader.spread)[0];
    const rec2 = state.pdfs.find(p=>p.id===reader.pdfId);
    rec2.bookmarks = rec2.bookmarks||[];
    rec2.bookmarks.push({page, createdAt:Date.now()});
    state.bookmarksList.push({id:uid(), type:"pdf", refId:rec2.id, label:`${rec2.filename} · p.${page}`, page, createdAt:Date.now()});
    save(); toast("Page bookmarked");
  });
  window.addEventListener("resize", onReaderResize);
}
function onReaderResize(){
  if(!reader.doc) return;
  const wasMobile=reader.isMobile;
  reader.isMobile=isMobileView();
  if(wasMobile!==reader.isMobile){
    const curPage = pagesForSpread(reader.spread)[0];
    reader.spread = reader.isMobile ? curPage-1 : spreadForPage(curPage);
  }
  renderSpread();
}

/* ============================================================
   GLOBAL SEARCH
   ============================================================ */
document.getElementById("open-search").addEventListener("click", ()=>{
  openModal(`
    <div class="modal-head"><h3>Search</h3><button class="icon-btn" data-action="close-modal">${icon('close')}</button></div>
    <input id="global-search-input" placeholder="Search subjects, notes, PDFs, assignments…" style="width:100%; padding:11px 14px; border-radius:var(--radius-s); border:1px solid var(--border); background:var(--bg); font-size:0.9rem; margin-bottom:14px;">
    <div id="search-results" style="max-height:50vh; overflow-y:auto;"></div>
  `, true);
  const input=document.getElementById("global-search-input");
  input.focus();
  input.addEventListener("input", ()=>runSearch(input.value));
});
function runSearch(q){
  const box=document.getElementById("search-results");
  q=q.trim().toLowerCase();
  if(!q){ box.innerHTML=""; return; }
  const results=[];
  state.subjects.filter(inActiveSem).forEach(s=>{ if((s.name+" "+(s.code||"")).toLowerCase().includes(q)) results.push({label:s.name, sub:"Subject", act:()=>{closeModal(); navigate("subject-detail",{id:s.id}); renderSubjectDetail(s.id);}}); });
  state.notes.forEach(n=>{ if((n.title+" "+(n.content||"")).toLowerCase().includes(q)) results.push({label:n.title, sub:"Note", act:()=>{closeModal(); openNoteModal(n);}}); });
  state.pdfs.forEach(p=>{ if(p.filename.toLowerCase().includes(q)) results.push({label:p.filename, sub:"PDF", act:()=>{closeModal(); openReader(p.id);}}); });
  state.assignments.forEach(a=>{ if(a.name.toLowerCase().includes(q)) results.push({label:a.name, sub:"Assignment", act:()=>{closeModal(); navigate("assignments"); openModal(assignmentFormHtml(a)); document.getElementById("assignment-form").dataset.editId=a.id;}}); });
  state.revisionTopics.forEach(t=>{ if(t.chapter.toLowerCase().includes(q)) results.push({label:t.chapter, sub:"Revision topic", act:()=>{closeModal(); navigate("revision");}}); });
  box.innerHTML = results.length? results.slice(0,20).map((r,i)=>`<div class="topic-row" data-res="${i}" style="cursor:pointer;"><span>${escapeHtml(r.label)}</span><span class="badge todo">${r.sub}</span></div>`).join("") : `<div class="empty" style="padding:16px;">No results.</div>`;
  results.slice(0,20).forEach((r,i)=>{ box.querySelector(`[data-res="${i}"]`).addEventListener("click", r.act); });
}

/* ============================================================
   THEME TOGGLE (quick button cycles light/dark)
   ============================================================ */
document.getElementById("theme-toggle").addEventListener("click", ()=>{
  const cur=state.settings.theme;
  state.settings.theme = cur==="dark" ? "light" : cur==="light" ? "system" : "dark";
  applyTheme(); save();
  toast(`Theme: ${state.settings.theme}`);
});

/* ============================================================
   ROUTER
   ============================================================ */
function renderView(){
  renderNav();
  if(currentView==="dashboard") renderDashboard();
  else if(currentView==="subjects") renderSubjects();
  else if(currentView==="subject-detail") renderSubjectDetail(currentParams.id);
  else if(currentView==="notes") renderNotes();
  else if(currentView==="planner") renderPlanner();
  else if(currentView==="assignments") renderAssignments();
  else if(currentView==="revision") renderRevision();
  else if(currentView==="progress") renderProgress();
  else if(currentView==="timetable") renderTimetable();
  else if(currentView==="settings") renderSettings();
  else renderDashboard();
}

/* ---------- init ---------- */
renderView();

})();

})();
