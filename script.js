/* ---------------- storage helpers ---------------- */
async function storeGet(key, shared){
  try{ const r = await window.storage.get(key, shared); return r ? JSON.parse(r.value) : null; }
  catch(e){ return null; }
}
async function storeSet(key, value, shared){
  try{ await window.storage.set(key, JSON.stringify(value), shared); }
  catch(e){ console.error('storage set failed', e); }
}

/* ---------------- state ---------------- */
let DB = { students: [], jobs: [] };
let session = null;   // {role:'student'|'admin', email, name}
let theme = 'light';
let tab = 'profile';
let editingStudentId = null;

const BRANCHES = ['CSE','IT','ECE','EE','ME','CE','Civil','Chemical'];

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function splitList(s){ return String(s||'').split(',').map(x=>x.trim()).filter(Boolean); }

/* ---------------- eligibility engine ---------------- */
function checkEligibility(student, job){
  const reasons = [];
  if (Number(student.cgpa) < Number(job.minCGPA)) reasons.push(`CGPA ${student.cgpa} is below the required ${job.minCGPA}`);
  if (job.eligibleBranches.length && !job.eligibleBranches.map(b=>b.toLowerCase()).includes((student.branch||'').toLowerCase())) reasons.push(`Branch (${student.branch||'—'}) not in ${job.eligibleBranches.join(', ')}`);
  const studentSkills = (student.skills||[]).map(s=>s.toLowerCase());
  const missing = (job.requiredSkills||[]).filter(rs => !studentSkills.some(ss => ss.includes(rs.toLowerCase()) || rs.toLowerCase().includes(ss)));
  if (missing.length) reasons.push(`Missing skills: ${missing.join(', ')}`);
  return { eligible: reasons.length === 0, reasons };
}

/* ---------------- analytics ---------------- */
function computeAnalytics(){
  const total = DB.students.length;
  const placed = DB.students.filter(s=>s.placed);
  const pct = total ? (placed.length/total*100).toFixed(1) : '0.0';
  const packages = placed.map(s=>Number(s.placedPackage)).filter(n=>!isNaN(n));
  const highest = packages.length ? Math.max(...packages) : 0;
  const avg = packages.length ? (packages.reduce((a,b)=>a+b,0)/packages.length) : 0;
  const skillCount = {};
  DB.students.forEach(s => (s.skills||[]).forEach(sk => {
    const key = sk.trim(); if(!key) return;
    skillCount[key] = (skillCount[key]||0) + 1;
  }));
  const topSkills = Object.entries(skillCount).sort((a,b)=>b[1]-a[1]).slice(0,6);
  return { total, placedCount: placed.length, pct, highest, avg, topSkills };
}

/* ---------------- persistence ---------------- */
async function loadAll(){
  const s = await storeGet('students-v1', true);
  const j = await storeGet('jobs-v1', true);
  const sess = await storeGet('session-v1', false);
  const th = await storeGet('theme-v1', false);
  DB.students = s || [];
  DB.jobs = j || [];
  session = sess || null;
  theme = th || 'light';
  applyTheme();
}
async function saveStudents(){ await storeSet('students-v1', DB.students, true); }
async function saveJobs(){ await storeSet('jobs-v1', DB.jobs, true); }
async function saveSession(){ await storeSet('session-v1', session, false); }
async function saveTheme(){ await storeSet('theme-v1', theme, false); }

function applyTheme(){
  document.documentElement.classList.toggle('dark', theme === 'dark');
}
async function toggleTheme(){
  theme = theme === 'dark' ? 'light' : 'dark';
  applyTheme(); await saveTheme();
}

/* ---------------- auth ---------------- */
let loginRole = 'student';
function setLoginRole(r){ loginRole = r; render(); }

async function studentLogin(){
  const name = document.getElementById('li-name').value.trim();
  const email = document.getElementById('li-email').value.trim().toLowerCase();
  const branch = document.getElementById('li-branch').value;
  if(!name || !email){ alert('Please enter your name and email.'); return; }
  let existing = DB.students.find(s => s.email === email);
  if(!existing){
    existing = { id: 'S'+Date.now(), name, email, branch, cgpa:'', tenth:'', twelfth:'', skills:[], projects:'', certifications:'', resume:'', placed:false, placedCompany:'', placedPackage:'' };
    DB.students.push(existing);
    await saveStudents();
  } else {
    existing.name = name; existing.branch = branch || existing.branch;
    await saveStudents();
  }
  session = { role:'student', email, name: existing.name };
  await saveSession();
  tab = 'profile';
  render();
}
async function adminLogin(){
  const name = document.getElementById('li-admin-name').value.trim();
  if(!name){ alert('Please enter your name.'); return; }
  session = { role:'admin', name };
  await saveSession();
  tab = 'jobs-manage';
  render();
}
async function logout(){ session = null; await saveSession(); render(); }

function currentStudent(){ return DB.students.find(s => s.email === session.email); }

/* ---------------- student actions ---------------- */
async function saveProfile(e){
  e.preventDefault();
  const st = currentStudent();
  st.cgpa = parseFloat(document.getElementById('p-cgpa').value) || 0;
  st.tenth = parseFloat(document.getElementById('p-tenth').value) || 0;
  st.twelfth = parseFloat(document.getElementById('p-twelfth').value) || 0;
  st.branch = document.getElementById('p-branch').value;
  st.skills = splitList(document.getElementById('p-skills').value);
  st.projects = document.getElementById('p-projects').value.trim();
  st.certifications = document.getElementById('p-certs').value.trim();
  st.resume = document.getElementById('p-resume').value.trim();
  await saveStudents();
  tab = 'jobs-board';
  render();
}

/* ---------------- admin: job management ---------------- */
let editingJobId = null;
function openJobForm(id){ editingJobId = id || null; render(); renderJobModal(); }
function closeModal(){ const m=document.getElementById('modal-root'); if(m) m.innerHTML=''; }

async function submitJobForm(e){
  e.preventDefault();
  const job = {
    id: editingJobId || 'J'+Date.now(),
    company: document.getElementById('j-company').value.trim(),
    role: document.getElementById('j-role').value.trim(),
    package: parseFloat(document.getElementById('j-package').value) || 0,
    minCGPA: parseFloat(document.getElementById('j-cgpa').value) || 0,
    requiredSkills: splitList(document.getElementById('j-skills').value),
    eligibleBranches: splitList(document.getElementById('j-branches').value)
  };
  if(!job.company || !job.role){ alert('Company and Role are required.'); return; }
  const idx = DB.jobs.findIndex(j=>j.id===editingJobId);
  if(idx>=0) DB.jobs[idx] = job; else DB.jobs.push(job);
  await saveJobs();
  closeModal(); editingJobId=null;
  render();
}
async function deleteJob(id){
  if(!confirm('Delete this job posting?')) return;
  DB.jobs = DB.jobs.filter(j=>j.id!==id);
  await saveJobs(); render();
}

/* ---------------- admin: placement editing ---------------- */
function openPlacementForm(id){ editingStudentId = id; render(); renderPlacementModal(); }
async function submitPlacementForm(e){
  e.preventDefault();
  const st = DB.students.find(s=>s.id===editingStudentId);
  st.placed = document.getElementById('pl-placed').checked;
  st.placedCompany = document.getElementById('pl-company').value.trim();
  st.placedPackage = parseFloat(document.getElementById('pl-package').value) || 0;
  await saveStudents();
  closeModal(); editingStudentId=null;
  render();
}
async function deleteStudent(id){
  if(!confirm('Remove this student record?')) return;
  DB.students = DB.students.filter(s=>s.id!==id);
  await saveStudents(); render();
}

/* ---------------- render: shell ---------------- */
function render(){
  const app = document.getElementById('app');
  if(!session){ app.innerHTML = renderLogin(); return; }
  const navItems = session.role === 'student'
    ? [['profile','Profile'],['jobs-board','Job Board'],['analytics','Analytics']]
    : [['jobs-manage','Manage Jobs'],['students-all','All Students'],['analytics','Analytics']];

  app.innerHTML = `
    <div class="topbar">
      <div class="brand">
        <div class="mark">PP</div>
        <div class="brand-text"><div class="t1">Placement Portal</div><div class="t2">Campus Recruitment Cell</div></div>
      </div>
      <div class="topbar-right">
        <span class="who">${session.role==='student'?'Student':'TPO / Admin'} — <b>${esc(session.name)}</b></span>
        <button class="icon-btn" onclick="toggleTheme()" title="Toggle dark mode">${theme==='dark'?'☀️':'🌙'}</button>
        <button class="btn btn-ghost" onclick="logout()">Sign out</button>
      </div>
    </div>
    <div class="layout">
      <div class="sidebar">
        ${navItems.map(([id,label]) => `<div class="navitem ${tab===id?'active':''}" onclick="tab='${id}'; render()">${label}</div>`).join('')}
      </div>
      <div class="content"><div class="content-inner" id="page"></div></div>
    </div>
    <div id="modal-root"></div>
  `;
  renderPage();
}

function renderLogin(){
  return `
  <div class="login-wrap">
    <div class="card login-card fade-in">
      <div class="mark" style="width:44px;height:44px;font-size:19px;margin-bottom:14px;">PP</div>
      <h2 style="margin-bottom:4px;">Placement Portal</h2>
      <p style="color:var(--text-soft); font-size:13.5px; margin:0 0 20px;">Sign in to continue</p>
      <div class="role-toggle">
        <button class="${loginRole==='student'?'active':''}" onclick="setLoginRole('student')">I'm a Student</button>
        <button class="${loginRole==='admin'?'active':''}" onclick="setLoginRole('admin')">Placement Cell (TPO)</button>
      </div>
      ${loginRole==='student' ? `
        <div class="field"><label>Full name</label><input id="li-name" placeholder="e.g. Priya Sharma"/></div>
        <div class="field"><label>Email (used as your ID)</label><input id="li-email" type="email" placeholder="you@college.edu"/></div>
        <div class="field"><label>Branch</label>
          <select id="li-branch">${BRANCHES.map(b=>`<option>${b}</option>`).join('')}</select>
        </div>
        <button class="btn btn-primary" style="width:100%;" onclick="studentLogin()">Continue as Student</button>
      ` : `
        <div class="field"><label>Your name</label><input id="li-admin-name" placeholder="e.g. Placement Officer"/></div>
        <button class="btn btn-primary" style="width:100%;" onclick="adminLogin()">Continue as TPO / Admin</button>
      `}
      <div class="banner" style="margin-top:18px;">This is a shared demo portal — student and job data you enter here is visible to anyone using this app.</div>
    </div>
  </div>`;
}

/* ---------------- render: pages ---------------- */
function renderPage(){
  const el = document.getElementById('page');
  if(!el) return;
  let html = '';
  if(tab==='profile') html = renderProfile();
  else if(tab==='jobs-board') html = renderJobsBoard();
  else if(tab==='jobs-manage') html = renderJobsManage();
  else if(tab==='students-all') html = renderStudentsAll();
  else if(tab==='analytics') html = renderAnalytics();
  el.innerHTML = `<div class="fade-in">${html}</div>`;
}

function renderProfile(){
  const st = currentStudent();
  return `
    <div class="page-head"><h2>My Profile</h2><p>Keep this updated — it's what companies' eligibility checks run against.</p></div>
    <form class="card" onsubmit="saveProfile(event)">
      <div class="grid3">
        <div class="field"><label>CGPA (out of 10)</label><input id="p-cgpa" type="number" step="0.01" min="0" max="10" value="${esc(st.cgpa)}" required/></div>
        <div class="field"><label>10th %</label><input id="p-tenth" type="number" step="0.01" min="0" max="100" value="${esc(st.tenth)}"/></div>
        <div class="field"><label>12th %</label><input id="p-twelfth" type="number" step="0.01" min="0" max="100" value="${esc(st.twelfth)}"/></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Branch</label>
          <select id="p-branch">${BRANCHES.map(b=>`<option ${st.branch===b?'selected':''}>${b}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Resume link</label><input id="p-resume" placeholder="Drive / Dropbox link to your resume" value="${esc(st.resume)}"/></div>
      </div>
      <div class="field"><label>Skills (comma separated)</label><input id="p-skills" placeholder="Java, SQL, HTML, CSS" value="${esc((st.skills||[]).join(', '))}"/></div>
      <div class="field"><label>Projects</label><textarea id="p-projects" rows="3" placeholder="Brief description of key projects">${esc(st.projects)}</textarea></div>
      <div class="field"><label>Certifications</label><textarea id="p-certs" rows="2" placeholder="Relevant certifications">${esc(st.certifications)}</textarea></div>
      ${st.placed ? `<div class="banner" style="border-color:var(--success); color:var(--success);">🎉 Placed at <b>${esc(st.placedCompany)}</b> — ₹${esc(st.placedPackage)} LPA</div>` : ''}
      <div class="row-end"><button class="btn btn-primary" type="submit">Save profile</button></div>
    </form>
  `;
}

function renderJobsBoard(){
  const st = currentStudent();
  const incomplete = !st.cgpa;
  if(incomplete){
    return `<div class="page-head"><h2>Job Board</h2></div><div class="empty">Complete your profile (CGPA, branch, skills) first so we can check your eligibility.</div>`;
  }
  if(!DB.jobs.length) return `<div class="page-head"><h2>Job Board</h2></div><div class="empty">No job postings yet. Check back soon.</div>`;
  return `
    <div class="page-head"><h2>Job Board</h2><p>Eligibility is checked automatically against your saved profile.</p></div>
    ${DB.jobs.map(job => {
      const res = checkEligibility(st, job);
      return `
      <div class="job-card">
        <div class="job-card-top">
          <div>
            <div class="job-role">${esc(job.role)}</div>
            <div class="job-company">${esc(job.company)}</div>
          </div>
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="job-package">₹${esc(job.package)} LPA</div>
            <div class="stamp ${res.eligible?'eligible':'not'}">${res.eligible?'✓ Eligible':'✗ Not Eligible'}</div>
          </div>
        </div>
        <div class="job-meta">Min CGPA ${esc(job.minCGPA)} · Branches: ${job.eligibleBranches.length?esc(job.eligibleBranches.join(', ')):'All'} · Skills: ${job.requiredSkills.map(s=>`<span class="tag">${esc(s)}</span>`).join('')}</div>
        ${!res.eligible ? `<div class="reasons">${res.reasons.map(r=>'• '+esc(r)).join('<br/>')}</div>` : ''}
      </div>`;
    }).join('')}
  `;
}

function renderJobsManage(){
  return `
    <div class="page-head" style="display:flex; justify-content:space-between; align-items:flex-end;">
      <div><h2>Manage Jobs</h2><p>Post openings and set eligibility criteria.</p></div>
      <button class="btn btn-accent" onclick="openJobForm()">+ Post a job</button>
    </div>
    ${!DB.jobs.length ? `<div class="empty">No jobs posted yet. Click "Post a job" to add one.</div>` : DB.jobs.map(job => `
      <div class="job-card">
        <div class="job-card-top">
          <div>
            <div class="job-role">${esc(job.role)}</div>
            <div class="job-company">${esc(job.company)}</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <div class="job-package">₹${esc(job.package)} LPA</div>
            <button class="btn btn-ghost" onclick="openJobForm('${job.id}')">Edit</button>
            <button class="btn btn-danger" onclick="deleteJob('${job.id}')">Delete</button>
          </div>
        </div>
        <div class="job-meta">Min CGPA ${esc(job.minCGPA)} · Branches: ${job.eligibleBranches.length?esc(job.eligibleBranches.join(', ')):'All'} · Skills: ${job.requiredSkills.map(s=>`<span class="tag">${esc(s)}</span>`).join('')}</div>
      </div>
    `).join('')}
  `;
}

function renderStudentsAll(){
  if(!DB.students.length) return `<div class="page-head"><h2>All Students</h2></div><div class="empty">No students have registered yet.</div>`;
  return `
    <div class="page-head"><h2>All Students</h2><p>${DB.students.length} registered · click a row to update placement status.</p></div>
    <div class="card" style="padding:0; overflow-x:auto;">
      <table>
        <thead><tr><th>Name</th><th>Branch</th><th>CGPA</th><th>Skills</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${DB.students.map(s => `
            <tr>
              <td><b>${esc(s.name)}</b><br/><span style="color:var(--text-soft); font-size:12px;">${esc(s.email)}</span></td>
              <td>${esc(s.branch||'—')}</td>
              <td class="mono">${esc(s.cgpa||'—')}</td>
              <td>${(s.skills||[]).slice(0,4).map(sk=>`<span class="tag">${esc(sk)}</span>`).join('')}</td>
              <td>${s.placed ? `<span class="stamp eligible" style="transform:none; padding:4px 9px; font-size:11px;">Placed</span>` : `<span style="color:var(--text-soft); font-size:12.5px;">Not placed</span>`}</td>
              <td style="white-space:nowrap;">
                <button class="btn btn-ghost" onclick="openPlacementForm('${s.id}')">Update</button>
                <button class="btn btn-danger" onclick="deleteStudent('${s.id}')">Remove</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderAnalytics(){
  const a = computeAnalytics();
  const maxCount = a.topSkills.length ? a.topSkills[0][1] : 1;
  return `
    <div class="page-head"><h2>Placement Analytics</h2><p>Live figures computed from registered student and placement data.</p></div>
    <div class="grid3" style="margin-bottom:14px;">
      <div class="stat"><div class="label">Total Students</div><div class="value">${a.total}</div></div>
      <div class="stat"><div class="label">Placed</div><div class="value">${a.placedCount}</div><div class="sub">${a.pct}% placement rate</div></div>
      <div class="stat"><div class="label">Placement %</div><div class="value">${a.pct}%</div></div>
    </div>
    <div class="grid2" style="margin-bottom:14px;">
      <div class="stat"><div class="label">Highest Package</div><div class="value">₹${a.highest} LPA</div></div>
      <div class="stat"><div class="label">Average Package</div><div class="value">₹${a.avg.toFixed(2)} LPA</div></div>
    </div>
    <div class="card">
      <h3 style="font-size:16px; margin-bottom:14px;">Top Skills Across Students</h3>
      ${a.topSkills.length ? a.topSkills.map(([name,count]) => `
        <div class="barrow">
          <div class="name">${esc(name)}</div>
          <div class="track"><div class="fill" style="width:${(count/maxCount*100).toFixed(0)}%"></div></div>
          <div class="count">${count}</div>
        </div>
      `).join('') : `<div class="empty">No skill data yet.</div>`}
    </div>
  `;
}

/* ---------------- modals ---------------- */
function renderJobModal(){
  const job = DB.jobs.find(j=>j.id===editingJobId) || {company:'',role:'',package:'',minCGPA:'',requiredSkills:[],eligibleBranches:[]};
  document.getElementById('modal-root').innerHTML = `
    <div class="modal-bg" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h3 style="margin-bottom:16px;">${editingJobId?'Edit job':'Post a job'}</h3>
        <form onsubmit="submitJobForm(event)">
          <div class="field"><label>Company</label><input id="j-company" value="${esc(job.company)}" required/></div>
          <div class="field"><label>Role</label><input id="j-role" value="${esc(job.role)}" required/></div>
          <div class="field"><label>Package (LPA)</label><input id="j-package" type="number" step="0.1" value="${esc(job.package)}"/></div>
          <div class="field"><label>Minimum CGPA</label><input id="j-cgpa" type="number" step="0.01" value="${esc(job.minCGPA)}"/></div>
          <div class="field"><label>Required skills (comma separated)</label><input id="j-skills" value="${esc((job.requiredSkills||[]).join(', '))}" placeholder="Java, SQL"/></div>
          <div class="field"><label>Eligible branches (comma separated, blank = all)</label><input id="j-branches" value="${esc((job.eligibleBranches||[]).join(', '))}" placeholder="CSE, IT"/></div>
          <div class="row-end">
            <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Save job</button>
          </div>
        </form>
      </div>
    </div>`;
}

function renderPlacementModal(){
  const st = DB.students.find(s=>s.id===editingStudentId);
  document.getElementById('modal-root').innerHTML = `
    <div class="modal-bg" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h3 style="margin-bottom:4px;">${esc(st.name)}</h3>
        <p style="color:var(--text-soft); font-size:13px; margin:0 0 16px;">Update placement status</p>
        <form onsubmit="submitPlacementForm(event)">
          <div class="field"><label class="switch"><input type="checkbox" id="pl-placed" ${st.placed?'checked':''}/> Mark as placed</label></div>
          <div class="field"><label>Company</label><input id="pl-company" value="${esc(st.placedCompany)}"/></div>
          <div class="field"><label>Package (LPA)</label><input id="pl-package" type="number" step="0.1" value="${esc(st.placedPackage)}"/></div>
          <div class="row-end">
            <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>`;
}

/* ---------------- boot ---------------- */
(async function boot(){
  await loadAll();
  render();
})();
