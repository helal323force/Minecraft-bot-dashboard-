const $ = id => document.getElementById(id);
let me = null, profiles = [], logs = [], currentView = "overview", selectedPlayer = "", socket = null, registerMode = false, maintenance = false;
const api = async (url, options = {}) => {
  const res = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const type = res.headers.get("content-type") || "";
  if (!res.ok) { const data = type.includes("json") ? await res.json() : { error: await res.text() }; throw new Error(data.error || "Request failed"); }
  return type.includes("json") ? res.json() : res.text();
};
function notice(msg, error = false) { $("notice").textContent = msg; $("notice").classList.toggle("hidden", !msg); $("notice").classList.toggle("error", error); if (msg) setTimeout(() => $("notice").classList.add("hidden"), 5000); }
function statusClass(s) { return ["online","connecting","offline"].includes(s) ? s : "offline"; }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
async function init() {
  try { const data = await api("/api/me"); me = data.user; showApp(); await loadAll(); connectSocket(); }
  catch { $("auth").classList.remove("hidden"); $("app").classList.add("hidden"); }
}
function showApp() {
  $("auth").classList.add("hidden"); $("app").classList.remove("hidden");
  $("user-label").textContent = me.username; $("role-label").textContent = me.role;
  document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("hidden", me.role !== "admin"));
}
$("auth-form").addEventListener("submit", async e => {
  e.preventDefault(); $("auth-error").textContent = "";
  try {
    const user = $("auth-user").value.trim(), password = $("auth-pass").value;
    const result = await api(registerMode ? "/api/auth/register" : "/api/auth/login", { method:"POST", body: JSON.stringify({ username:user, password }) });
    me = result.user; showApp(); await loadAll(); connectSocket();
  } catch (err) { $("auth-error").textContent = err.message; }
});
$("auth-toggle").onclick = () => { registerMode = !registerMode; $("auth-title").textContent = registerMode ? "Create account" : "Welcome back"; $("auth-submit").textContent = registerMode ? "Register" : "Log in"; $("auth-toggle").textContent = registerMode ? "Already have an account? Log in" : "Need an account? Register"; $("auth-pass").autocomplete = registerMode ? "new-password" : "current-password"; };
$("logout").onclick = async () => { try { await api("/api/auth/logout", { method:"POST" }); } catch {} location.reload(); };
$("theme").onclick = () => { document.body.classList.toggle("light"); localStorage.setItem("mc-theme", document.body.classList.contains("light") ? "light" : "dark"); };
if (localStorage.getItem("mc-theme") === "light") document.body.classList.add("light");
document.querySelectorAll(".nav").forEach(b => b.onclick = () => showView(b.dataset.view));
document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => showView(b.dataset.go));
function showView(view) {
  currentView = view;
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $("view-" + view)?.classList.remove("hidden");
  document.querySelectorAll(".nav").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("page-title").textContent = ({overview:"Overview",profiles:"Server profiles",players:"Players & actions",inventory:"Live inventory",logs:"Logs & history",admin:"Admin controls"})[view] || view;
  if (view === "players") loadPlayers();
  if (view === "inventory") loadInventory();
  if (view === "logs") renderLogs();
  if (view === "admin") loadUsers();
}
async function loadAll() {
  profiles = await api("/api/profiles");
  logs = await api("/api/logs");
  renderProfiles(); renderLogs(); fillSelectors(); renderStats();
}
function renderStats() {
  $("stat-profiles").textContent = profiles.length;
  $("stat-online").textContent = profiles.filter(p => p.runtime?.status === "online").length;
  $("stat-reconnects").textContent = profiles.reduce((n,p)=>n+(p.runtime?.reconnects||0),0);
  $("stat-uptime").textContent = "Live";
}
function card(p) {
  const s = p.runtime || { status:"offline" };
  return `<article class="server-card"><div class="card-head"><div><h3>${escapeHtml(p.name)}</h3><div class="server-meta">${escapeHtml(p.host)}:${p.port} · ${p.edition.toUpperCase()}</div><div class="server-meta">Bot: ${escapeHtml(p.username)}</div></div><span class="status ${statusClass(s.status)}">${escapeHtml(s.status||"offline")}</span></div><p class="server-meta">Reconnects: ${s.reconnects||0}${s.lastError ? " · Last error: "+escapeHtml(s.lastError) : ""}</p><div class="card-actions"><button class="primary" data-connect="${p.id}">Connect</button><button data-disconnect="${p.id}" class="secondary">Stop</button><button data-chat="${p.id}" class="secondary">Chat / command</button><button data-edit="${p.id}" class="secondary">Edit</button><button data-delete="${p.id}" class="danger">Delete</button></div></article>`;
}
function renderProfiles() {
  const html = profiles.length ? profiles.map(card).join("") : '<div class="panel empty">No profiles yet. Add your first Minecraft server.</div>';
  $("profile-list").innerHTML = html; $("overview-profiles").innerHTML = html;
  document.querySelectorAll("[data-connect]").forEach(b => b.onclick = () => runProfile(b.dataset.connect,"connect"));
  document.querySelectorAll("[data-disconnect]").forEach(b => b.onclick = () => runProfile(b.dataset.disconnect,"disconnect"));
  document.querySelectorAll("[data-chat]").forEach(b => b.onclick = async () => { const msg = prompt("Enter a chat message or Minecraft command. Slash commands require admin permissions:"); if (msg === null || !msg.trim()) return; try { await api(`/api/profiles/${b.dataset.chat}/chat`,{method:"POST",body:JSON.stringify({message:msg})}); notice("Message sent."); } catch(e) { notice(e.message,true); } });
  document.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => editProfile(profiles.find(p=>p.id==b.dataset.edit)));
  document.querySelectorAll("[data-delete]").forEach(b => b.onclick = async () => { if (!confirm("Delete this profile?")) return; try { await api(`/api/profiles/${b.dataset.delete}`,{method:"DELETE"}); await loadAll(); notice("Profile deleted."); } catch(e){notice(e.message,true);} });
}
async function runProfile(id, action) { try { await api(`/api/profiles/${id}/${action}`,{method:"POST",body:"{}"}); notice(action==="connect"?"Connection requested.":"Bot stopped."); await loadAll(); } catch(e){notice(e.message,true);} }
$("add-profile").onclick = () => { $("profile-form").reset(); $("profile-id").value=""; $("profile-port").value="25565"; $("profile-retry").value="15"; $("profile-reconnect").checked=true; $("editor-title").textContent="Add server profile"; $("profile-editor").classList.remove("hidden"); };
$("cancel-editor").onclick = () => $("profile-editor").classList.add("hidden");
function editProfile(p) { if (!p) return; $("profile-id").value=p.id; $("profile-name").value=p.name; $("profile-edition").value=p.edition; $("profile-host").value=p.host; $("profile-port").value=p.port; $("profile-username").value=p.username; $("profile-retry").value=p.settings.retrySeconds||15; $("profile-reconnect").checked=p.settings.autoReconnect!==false; $("profile-eat").checked=p.settings.autoEat===true; $("editor-title").textContent="Edit profile"; $("profile-editor").classList.remove("hidden"); }
$("profile-form").onsubmit = async e => {
  e.preventDefault();
  const id=$("profile-id").value, body={name:$("profile-name").value,edition:$("profile-edition").value,host:$("profile-host").value,port:Number($("profile-port").value),username:$("profile-username").value,retrySeconds:Number($("profile-retry").value),autoReconnect:$("profile-reconnect").checked,autoEat:$("profile-eat").checked};
  try { await api(id?`/api/profiles/${id}`:"/api/profiles",{method:id?"PUT":"POST",body:JSON.stringify(body)}); $("profile-editor").classList.add("hidden"); await loadAll(); notice("Profile saved."); } catch(err){notice(err.message,true);}
};
function fillSelectors() {
  for (const id of ["player-profile","inventory-profile"]) {
    const old=$(id).value;
    $(id).innerHTML=profiles.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} (${p.edition})</option>`).join("");
    if (profiles.some(p=>String(p.id)===old)) $(id).value=old;
  }
}
$("player-profile").onchange=loadPlayers; $("inventory-profile").onchange=loadInventory;
async function loadPlayers() {
  const id=$("player-profile").value; if(!id){$("players-list").innerHTML='<div class="empty">Add a profile first.</div>';return;}
  try { const d=await api(`/api/profiles/${id}/players`); $("players-list").innerHTML=d.supported ? (d.players.length?d.players.map(p=>`<div class="panel player-row"><div><strong>${escapeHtml(p.username)}</strong><div class="muted">Ping: ${p.ping??"—"} ms</div></div><button class="secondary" data-player="${escapeHtml(p.username)}">Actions</button></div>`).join(""):'<div class="panel empty">No players visible to the bot.</div>') : `<div class="panel empty">${escapeHtml(d.message)}</div>`;
    document.querySelectorAll("[data-player]").forEach(b=>b.onclick=()=>{selectedPlayer=b.dataset.player;$("selected-player").textContent="Actions for "+selectedPlayer;$("player-actions").classList.remove("hidden");});
  } catch(e){notice(e.message,true);}
}
document.querySelectorAll("[data-action]").forEach(b=>b.onclick=async()=>{if(!selectedPlayer)return;try{await api(`/api/profiles/${$("player-profile").value}/action`,{method:"POST",body:JSON.stringify({action:b.dataset.action,player:selectedPlayer})});notice("Action requested: "+b.dataset.action);}catch(e){notice(e.message,true);}});
async function loadInventory() {
  const id=$("inventory-profile").value; if(!id)return;
  try { const d=await api(`/api/profiles/${id}/inventory`); $("inventory-status").innerHTML=d.supported?`<article class="stat"><span>Health</span><strong>${d.health??"—"}/20</strong></article><article class="stat"><span>Food</span><strong>${d.food??"—"}/20</strong></article><article class="stat"><span>Items</span><strong>${d.items.length}</strong></article>`:`<div class="panel empty">${escapeHtml(d.message)}</div>`;
    $("inventory-items").innerHTML=d.supported?d.items.map(i=>`<div class="item"><strong>${escapeHtml(i.displayName||i.name)}</strong><span>x${i.count} · slot ${i.slot}</span></div>`).join(""):'';
  }catch(e){notice(e.message,true);}
}
$("refresh-inventory").onclick=loadInventory;
$("eat-now").onclick=async()=>{const id=$("inventory-profile").value;if(!id)return;try{await api(`/api/profiles/${id}/action`,{method:"POST",body:JSON.stringify({action:"eat"})});notice("Eat action requested.");}catch(e){notice(e.message,true);}};
function renderLogs() {
  const q=($("log-filter")?.value||"").toLowerCase();
  const entries=logs.filter(l=>(l.message+" "+l.level).toLowerCase().includes(q)).slice(-500).reverse();
  const html=entries.map(l=>`<div class="log-entry"><span class="log-time">${escapeHtml(new Date(l.created_at).toLocaleString())}</span><span class="log-level ${escapeHtml(l.level)}">${escapeHtml(l.level)}</span><span class="log-message">${escapeHtml(l.message)}</span></div>`).join("");
  $("logs-list").innerHTML=html||'<div class="empty">No matching logs.</div>'; $("recent-logs").innerHTML=entries.slice(0,5).map(l=>`<div class="log-entry"><span class="log-time">${escapeHtml(new Date(l.created_at).toLocaleTimeString())}</span><span class="log-level ${escapeHtml(l.level)}">${escapeHtml(l.level)}</span><span class="log-message">${escapeHtml(l.message)}</span></div>`).join("")||'<div class="empty">No events yet.</div>';
}
$("log-filter").oninput=renderLogs;
$("export-logs").onclick=()=>location.href="/api/logs/export"; $("backup").onclick=()=>location.href="/api/backup";
async function loadUsers() { try { const users=await api("/api/admin/users"); $("users-list").innerHTML=users.map(u=>`<div class="user-row"><span><strong>${escapeHtml(u.username)}</strong><small> · ${escapeHtml(u.role)}</small></span><select data-role="${u.id}"><option ${u.role==="viewer"?"selected":""} value="viewer">Viewer</option><option ${u.role==="admin"?"selected":""} value="admin">Admin</option></select></div>`).join(""); document.querySelectorAll("[data-role]").forEach(s=>s.onchange=async()=>{try{await api(`/api/admin/users/${s.dataset.role}/role`,{method:"PATCH",body:JSON.stringify({role:s.value})});notice("Role updated.");}catch(e){notice(e.message,true);}}); }catch(e){notice(e.message,true);} }
$("maintenance-toggle").onclick=async()=>{maintenance=!maintenance;try{await api("/api/maintenance",{method:"POST",body:JSON.stringify({enabled:maintenance})});$("maintenance-toggle").textContent=maintenance?"Disable maintenance":"Enable maintenance";notice("Maintenance "+(maintenance?"enabled":"disabled"));}catch(e){maintenance=!maintenance;notice(e.message,true);}};
function connectSocket() {
  if(socket)socket.disconnect();
  socket=io();
  socket.on("bot-state", data=>{const p=profiles.find(p=>p.id===data.profileId);if(p)p.runtime=data;renderProfiles();renderStats();});
  socket.on("bot-log", data=>{logs.push({profile_id:data.profileId,level:data.level,message:data.message,created_at:data.createdAt});if(logs.length>500)logs=logs.slice(-500);if(currentView==="logs")renderLogs();else renderLogs();});
  socket.on("maintenance",d=>{maintenance=d.enabled;});
}
init();
