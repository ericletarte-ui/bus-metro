(function(){
"use strict";

/* ---------- Réglages ---------- */
var CFG=window.BM_CONFIG||{};
var DEFAULT={name:"Mont-Royal / du Parc",lat:45.51672,lon:-73.58925};
var DEFAULT_FAVS=["80","480","129"];
var EXPRESS=/^4\d\d$/;
var METRO={1:{n:"Verte",c:"l1"},2:{n:"Orange",c:"l2"},4:{n:"Jaune",c:"l4"},5:{n:"Bleue",c:"l5"}};
var MTL={lat:45.53,lon:-73.65};
var WALK=80; // mètres par minute à pied

/* ---------- Petit stockage sur le téléphone ---------- */
function store(k,v){try{if(v===undefined){var x=localStorage.getItem(k);return x?JSON.parse(x):null}localStorage.setItem(k,JSON.stringify(v))}catch(e){return null}}

var state={
  place:DEFAULT, gps:true, view:"autour", radius:400,
  favs:DEFAULT_FAVS.slice(), favDir:{}, lastFix:0
};
(function restore(){
  var p=store("bm_place"); if(p&&typeof p.lat==="number")state.place=p;
  var g=store("bm_gps"); if(g===false)state.gps=false;
  var v=store("bm_view"); if(v==="lignes")state.view=v;
  var r=store("bm_radius"); if(r)state.radius=r;
  var f=store("bm_favs"); if(Array.isArray(f))state.favs=f;
  var d=store("bm_favdir")||store("pp_favdir"); if(d&&typeof d==="object")state.favDir=d;
})();

/* Mode essai : ?date=AAAAMMJJ&heure=HH:MM pour regarder un autre moment */
var Q=new URLSearchParams(location.search);
var SIM=null;
if(/^\d{8}$/.test(Q.get("date")||"")){
  var hm=(Q.get("heure")||"08:00").split(":");
  SIM={date:Q.get("date"),min:(+hm[0])*60+(+hm[1]||0)};
}

/* ---------- Outils ---------- */
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function norm(s){return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9 ]/g," ")}
function dist(a,b,c,d){var x=(d-b)*Math.cos((a+c)/2*Math.PI/180),y=c-a;return Math.sqrt(x*x+y*y)*111195}
function fmtDist(m){var w=Math.max(1,Math.round(m/WALK));return (m<1000?Math.round(m/10)*10+" m":(m/1000).toFixed(1).replace(".",",")+" km")+" · "+w+" min à pied"}
function hhmm(m){m=((m%1440)+1440)%1440;return String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0")}
function dirKey(h){return String(h).split(" ")[0]}
function ymd(d){return d.getUTCFullYear()+String(d.getUTCMonth()+1).padStart(2,"0")+String(d.getUTCDate()).padStart(2,"0")}
function prevDate(s){var d=new Date(Date.UTC(+s.slice(0,4),+s.slice(4,6)-1,+s.slice(6,8)));d.setUTCDate(d.getUTCDate()-1);return ymd(d)}
var FMT=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Montreal",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});

/* Heure de Montréal : date AAAAMMJJ et minutes depuis minuit (avec secondes en fraction) */
function now(){
  if(SIM)return {date:SIM.date,min:SIM.min,sim:true};
  var o={};FMT.formatToParts(new Date()).forEach(function(x){o[x.type]=x.value});
  return {date:o.year+o.month+o.day,min:(+o.hour)*60+(+o.minute)+(+o.second)/60};
}

/* ---------- Données ---------- */
var R=null, JOURS={}, GRIDS={}, MERGED={date:null,cache:{}};

function getJSON(url){return fetch(url,{cache:"no-cache"}).then(function(r){if(!r.ok)throw new Error(url+" "+r.status);return r.json()})}

function loadGrid(date){
  var key=JOURS[date];
  if(!key)return Promise.resolve(null);
  if(GRIDS[key])return Promise.resolve(GRIDS[key]);
  return getJSON("donnees/passages-"+key+".json").then(function(a){
    GRIDS[key]=a.map(function(lst){return lst.map(function(e){var t=[],acc=0;for(var i=1;i<e.length;i++){acc+=e[i];t.push(acc)}return{l:e[0],t:t}})});
    return GRIDS[key];
  });
}
function ready(t){
  return Promise.all([loadGrid(t.date),loadGrid(prevDate(t.date))]).then(function(g){
    if(MERGED.date!==t.date)MERGED={date:t.date,cache:{},today:g[0],yday:g[1]};
    return !!(g[0]||g[1]);
  });
}
/* Passages d'un arrêt pour aujourd'hui, y compris les voyages de nuit d'hier (après minuit) */
function stopEvents(i){
  var c=MERGED.cache[i]; if(c)return c;
  var by={};
  if(MERGED.yday)(MERGED.yday[i]||[]).forEach(function(e){var t=e.t.filter(function(m){return m>=1440}).map(function(m){return m-1440});if(t.length)by[e.l]=t});
  if(MERGED.today)(MERGED.today[i]||[]).forEach(function(e){by[e.l]=(by[e.l]||[]).concat(e.t)});
  c=Object.keys(by).map(function(l){return{l:+l,t:by[l].sort(function(a,b){return a-b})}});
  MERGED.cache[i]=c; return c;
}

/* ---------- Temps réel (branché plus tard par le relais) ---------- */
var RT={at:0,data:{},ok:false};
function rtFor(stopCode,lineNum){return RT.ok?RT.data[stopCode+"|"+lineNum]:null}
function fetchRealtime(codes){
  if(!CFG.relaisTempsReel||!codes.length||document.hidden||SIM)return;
  var url=CFG.relaisTempsReel.replace(/\/$/,"")+"/passages?arrets="+encodeURIComponent(codes.slice(0,40).join(","));
  fetch(url).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){
    RT={at:Date.now(),data:d.passages||{},ok:true};paint();
  }).catch(function(){RT.ok=false;paint()});
}

/* ---------- Calculs ---------- */
function isFav(num){return state.favs.indexOf(num)>=0}
function badgeCls(num){return isFav(num)?"badge fav":EXPRESS.test(num)?"badge exp":"badge"}
function nearStops(lat,lon,radius){
  var res=[];for(var i=0;i<R.stops.length;i++){var s=R.stops[i];var d=dist(lat,lon,s[2],s[3]);if(d<=radius)res.push({i:i,d:d})}
  return res.sort(function(a,b){return a.d-b.d});
}
/* Prochains départs à un arrêt pour une ligne donnée, en minutes depuis minuit, temps réel si disponible */
function upcoming(stopIdx,e,min,line){
  var s=R.stops[stopIdx],rt=rtFor(s[0],line[0]);
  if(rt&&rt.length){
    var nowMs=Date.now(),list=rt.filter(function(x){return x.h===undefined||dirKey(x.h)===dirKey(line[1])}).map(function(x){return{m:min+(x.t*1000-nowMs)/60000,live:true,h:line[1]}}).filter(function(x){return x.m>=min-0.5});
    if(list.length)return list;
  }
  return e.t.filter(function(m){return m>=Math.floor(min)}).map(function(m){return{m:m,h:line[1]}});
}

function routeGroups(t,radius){
  var ns=nearStops(state.place.lat,state.place.lon,radius),g={};
  ns.forEach(function(n){
    stopEvents(n.i).forEach(function(e){
      var L=R.lines[e.l],num=L[0],k=dirKey(L[1]);
      g[num]=g[num]||{num:num,name:L[2],dirs:{}};
      var d=g[num].dirs[k];
      if(!d)d=g[num].dirs[k]={stop:n.i,d:n.d,ev:[]};
      if(d.stop!==n.i)return;
      var up=upcoming(n.i,e,t.min,L);
      if(up.length&&up[0].live){if(d.rt)return;d.rt=true}
      d.ev=d.ev.concat(up);
    });
  });
  var out=Object.keys(g).map(function(num){
    var r=g[num],keys=Object.keys(r.dirs).sort();
    keys.forEach(function(k){r.dirs[k].ev.sort(function(a,b){return a.m-b.m})});
    var cur=state.favDir[num];if(keys.indexOf(cur)<0)cur=keys[0];
    r.keys=keys;r.cur=cur;r.sel=r.dirs[cur];return r;
  });
  out.sort(function(a,b){
    var fa=isFav(a.num)?0:1,fb=isFav(b.num)?0:1;
    if(fa!==fb)return fa-fb;
    var rank=function(r){var e=r.sel.ev[0];return !e?2:(e.m-t.min<60?0:1)};var ea=rank(a),eb=rank(b);if(ea!==eb)return ea-eb;
    return a.sel.d-b.sel.d||((a.sel.ev[0]||{m:1e9}).m-(b.sel.ev[0]||{m:1e9}).m);
  });
  return {groups:out,stops:ns};
}

/* ---------- Affichage ---------- */
var STAR='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>';
function waitLbl(x,min){var d=Math.round(x.m-min);return (x.live?'<span class="live" aria-label="en direct"></span>':'')+(d<60?d+" min":hhmm(Math.round(x.m)))}
function bigMins(ev,min){
  if(!ev.length)return '<div class="big none">Plus de passage aujourd\'hui</div>';
  var w=Math.round(ev[0].m-min),h='<div class="big">'+(ev[0].live?'<span class="live" title="Temps réel"></span>':'');
  if(w<=0)h+='<span class="n soon">Là</span>';
  else if(w<60)h+='<span class="n'+(w<=5?' soon':'')+'">'+w+'</span><span class="u">min</span>';
  else h+='<span class="n">'+hhmm(Math.round(ev[0].m))+'</span>';
  h+='</div>';
  if(ev.length>1)h+='<div class="next">puis '+ev.slice(1,3).map(function(x){return waitLbl(x,min)}).join(" · ")+'</div>';
  return h;
}
function vers(h){return "vers "+String(h).replace(/^(Nord|Sud|Est|Ouest)\b/,function(x){return x.toLowerCase()})}
function dirLabel(k){var x=String(k).toLowerCase();return x==="nord"||x==="sud"?"Vers le "+x:x==="est"||x==="ouest"?"Vers l'"+x:"Vers "+k}
function walkMin(d){return Math.max(1,Math.round(d/WALK))+" min à pied"}
function shortWait(x,min){var d=Math.round(x.m-min);return d<60?String(Math.max(0,d)):hhmm(Math.round(x.m))}
function swapBtn(r){
  if(r.keys.length<2)return "";
  var nk=r.keys[(r.keys.indexOf(r.cur)+1)%r.keys.length];
  return '<button class="swap" type="button" data-fd="'+esc(r.num)+'|'+esc(nk)+'" aria-label="Afficher la ligne '+esc(r.num)+' '+esc(dirLabel(nk).toLowerCase())+'">⇅ '+esc(dirLabel(nk).replace(/^Vers /,"Voir "))+'</button>';
}
function isSoon(r,min){var e=r.sel.ev[0];return !!e&&e.m-min<60}
function rowHTML(r,min){
  var s=R.stops[r.sel.stop],ev=r.sel.ev,soon=isSoon(r,min);
  var h='<div class="r'+(soon?'':' lt')+'" role="button" tabindex="0" data-line="'+esc(r.num)+'"><div class="'+badgeCls(r.num)+'">'+esc(r.num)+'</div><div class="who"><b>'+esc(dirLabel(r.cur))+(EXPRESS.test(r.num)?' · express':'')+'</b>';
  if(soon)h+='<span>'+walkMin(r.sel.d)+' · '+esc(s[1])+'</span>'+swapBtn(r);
  h+='</div><div class="t">';
  if(!ev.length)h+='<span class="fini">Terminé</span>';
  else if(!soon)h+=hhmm(Math.round(ev[0].m));
  else{
    var w=Math.round(ev[0].m-min);
    h+=(ev[0].live?'<span class="live" title="En direct"></span>':'');
    h+=w<=0?'<span class="n soon">Là</span>':'<span class="n'+(w<=5?' soon':'')+'">'+w+'</span><span class="u">min</span>';
    if(ev.length>1)h+='<small>puis '+ev.slice(1,3).map(function(x){return shortWait(x,min)}).join(", ")+(Math.round(ev[Math.min(2,ev.length-1)].m-min)<60?' min':'')+'</small>';
  }
  return h+'</div></div>';
}

function nearestStations(n){
  return R.metro.map(function(m){return{m:m,d:dist(state.place.lat,state.place.lon,m[1],m[2])}}).sort(function(a,b){return a.d-b.d}).slice(0,n);
}
function weekday(date){return new Date(Date.UTC(+date.slice(0,4),+date.slice(4,6)-1,+date.slice(6,8))).getUTCDay()}
function freqText(t){
  var m=t.min,wd=weekday(t.date),sem=wd>0&&wd<6;
  if(m>=60&&m<330)return"fermé, ouvre vers 5 h 30";
  if(sem&&((m>=420&&m<570)||(m>=960&&m<1110)))return"toutes les 3 à 5 min";
  if(m>=1260||m<60)return"toutes les 8 à 12 min";
  return"toutes les 5 à 8 min";
}
function stationRow(x,t){
  var m=x.m;
  return '<div class="r st1"><div class="dots">'+m[3].map(function(l){var L=METRO[l]||{n:l,c:""};return '<span class="dot '+L.c+'" title="Ligne '+L.n+'">'+l+'</span>'}).join("")+'</div><div class="who"><b>'+esc(m[0])+'</b><span>'+walkMin(x.d)+' · '+freqText(t)+'</span></div><div></div></div>';
}

var GROUPS={};
function renderAutour(t){
  var res=routeGroups(t,state.radius),gs=res.groups;
  GROUPS={};gs.forEach(function(r){GROUPS[r.num]=r});
  var soon=gs.filter(function(r){return isSoon(r,t.min)}),later=gs.filter(function(r){return !isSoon(r,t.min)});
  soon.sort(function(a,b){var fa=isFav(a.num)?0:1,fb=isFav(b.num)?0:1;return fa-fb||a.sel.ev[0].m-b.sel.ev[0].m});
  var h='';
  h+='<section><h2>Prochains départs</h2>';
  if(!gs.length)h+='<div class="card none">Aucune ligne à moins de '+state.radius+' m. Touche « Changer » pour agrandir le rayon ou choisir un autre lieu.</div>';
  else if(!soon.length)h+='<div class="card none">Aucun bus dans l\'heure tout près d\'ici.</div>';
  else h+='<div class="rows">'+soon.map(function(r){return rowHTML(r,t.min)}).join("")+'</div>';
  h+='</section>';
  if(later.length)h+='<section><h2>Plus tard</h2><div class="rows later">'+later.map(function(r){return rowHTML(r,t.min)}).join("")+'</div></section>';
  h+='<section><h2>Métro</h2><div class="rows">'+nearestStations(2).map(function(x){return stationRow(x,t)}).join("")+'</div>';
  h+='<p class="foot" style="margin-top:8px"><a href="https://www.stm.info/fr/infos/etat-du-service" target="_blank" rel="noopener">État du service du métro</a> · fréquences approximatives : la licence de la STM ne permet pas d\'afficher les heures exactes du métro.</p></section>';
  h+='<p class="foot">Touche une ligne pour voir tous ses passages, changer de sens ou l\'ajouter à tes lignes.</p>';
  return {html:h,codes:res.stops.slice(0,25).map(function(n){return R.stops[n.i][0]})};
}

/* Une ligne favorite, à l'arrêt le plus proche dans chaque sens, où qu'il soit */
function favGroup(num,t){
  var dirs={},name="";R.lines.forEach(function(l,i){if(l[0]===num){dirs[i]=1;name=name||l[2]}});
  var g={num:num,name:name,dirs:{}};
  for(var i=0;i<R.stops.length;i++){
    var lst=stopEvents(i);
    for(var k=0;k<lst.length;k++){var l=lst[k].l;if(!dirs[l])continue;var s=R.stops[i];var d=dist(state.place.lat,state.place.lon,s[2],s[3]);
      var key=dirKey(R.lines[l][1]);if(!g.dirs[key]||d<g.dirs[key].d)g.dirs[key]={stop:i,d:d}}
  }
  Object.keys(g.dirs).forEach(function(key){
    var d=g.dirs[key],ev=[],rt=false;
    stopEvents(d.stop).forEach(function(e){var L=R.lines[e.l];if(L[0]!==num||dirKey(L[1])!==key)return;var up=upcoming(d.stop,e,t.min,L);if(up.length&&up[0].live){if(rt)return;rt=true}ev=ev.concat(up)});
    d.ev=ev.sort(function(a,b){return a.m-b.m});
  });
  g.keys=Object.keys(g.dirs).sort();
  g.cur=state.favDir[num];if(g.keys.indexOf(g.cur)<0)g.cur=g.keys[0];
  g.sel=g.dirs[g.cur];
  return g;
}
function renderLignes(t){
  var codes=[],h='<section><h2>Mes lignes</h2>';
  var gs=state.favs.map(function(n){return favGroup(n,t)});
  gs.forEach(function(g){if(!GROUPS[g.num])GROUPS[g.num]=g});
  if(!state.favs.length)h+='<div class="card none">Aucune ligne favorite. Touche une ligne dans « Autour de moi », puis « Ajouter à mes lignes ».</div>';
  else{
    h+='<div class="rows">';
    gs.forEach(function(g){
      if(!g.sel){h+='<div class="r lt" data-line="'+esc(g.num)+'" role="button" tabindex="0"><div class="'+badgeCls(g.num)+'">'+esc(g.num)+'</div><div class="who"><b>'+esc(g.name)+'</b></div><div class="t"><span class="fini">Pas de service</span></div></div>';return}
      codes.push(R.stops[g.sel.stop][0]);
      var r=rowHTML(g,t.min);
      if(!isSoon(g,t.min))r=r.replace('</b>','</b><span>'+walkMin(g.sel.d)+' · '+esc(R.stops[g.sel.stop][1])+'</span>'+swapBtn(g));
      h+=r;
    });
    h+='</div>';
  }
  h+='</section><p class="foot">Le sens choisi est retenu sur ton téléphone. Pour ajouter ou retirer une ligne, touche-la.</p>';
  return {html:h,codes:codes};
}

function lineSheet(num){
  var t=now(),g=(state.view==="lignes"||!GROUPS[num])?favGroup(num,t):GROUPS[num];
  if(state.view!=="lignes"&&GROUPS[num]){var fresh=routeGroups(t,state.radius).groups.filter(function(x){return x.num===num})[0];if(fresh)g=fresh}
  var h='<h3>Ligne '+esc(num)+(g.name?' · '+esc(g.name):'')+'</h3>';
  h+='<button class="favbtn" type="button" data-fav="'+esc(num)+'" aria-pressed="'+isFav(num)+'">'+STAR+(isFav(num)?' Dans mes lignes (retirer)':' Ajouter à mes lignes')+'</button>';
  if(g.keys&&g.keys.length>1)h+='<div class="seg" role="group" aria-label="Sens">'+g.keys.map(function(k){return '<button type="button" data-fd="'+esc(num)+'|'+esc(k)+'" aria-pressed="'+(k===g.cur)+'">'+esc(dirLabel(k))+'</button>'}).join("")+'</div>';
  if(!g.sel){h+='<div class="none">Pas de service aujourd\'hui selon l\'horaire.</div>';openSheet(h,num);return}
  var s=R.stops[g.sel.stop],ev=g.sel.ev;
  h+='<div class="dist">Arrêt '+esc(s[1])+' ('+esc(s[0])+') · '+fmtDist(g.sel.d)+'</div>';
  h+='<div class="times">'+(ev.length?ev.slice(0,40).map(function(x,j){return '<span'+(j===0?' class="first"':'')+'>'+(x.live?'● ':'')+hhmm(Math.round(x.m))+'</span>'}).join(""):'<span>Plus de passage aujourd\'hui</span>')+'</div>';
  if(ev.some(function(x){return x.live}))h+='<p class="foot">● : heure en direct de la STM. Les autres sont les heures prévues.</p>';
  h+='<button class="ibtn" style="color:var(--accent);border-color:var(--line);align-self:flex-start" type="button" data-stop="'+g.sel.stop+'">Tous les bus à cet arrêt</button>';
  openSheet(h,num);
}

var lastCodes=[];
function paint(){
  var t=now();
  renderClock(t);
  document.querySelectorAll("nav.tabs button").forEach(function(b){b.setAttribute("aria-selected",b.dataset.v===state.view?"true":"false")});
  document.getElementById("placeLabel").textContent=state.gps&&state.place.gps?"Autour de moi":"Autour de";
  document.getElementById("placeName").textContent=state.place.name;
  if(!R)return;
  var v=document.getElementById("view");
  ready(t).then(function(ok){
    var out=state.view==="lignes"?renderLignes(t):renderAutour(t);
    var pre=ok?"":'<div class="card none">Les horaires d\'aujourd\'hui ne sont pas encore chargés. Ils se mettent à jour chaque nuit ; réessaie un peu plus tard.</div>';
    v.innerHTML=pre+out.html+'<p class="foot">Horaires : STM (données ouvertes, CC BY 4.0)'+(R.feed?', version '+esc(R.feed.slice(0,8)):'')+'.</p>';
    lastCodes=out.codes;
  }).catch(function(){v.innerHTML='<div class="card none">Impossible de charger les horaires. Vérifie ta connexion et rouvre l\'app.</div>'});
}
function renderClock(t){
  var live=RT.ok&&Date.now()-RT.at<120000;
  document.getElementById("liveDot").hidden=!live;
  document.getElementById("clockTxt").textContent=(t.sim?"Essai · ":"")+(live?"En direct":"Horaires prévus")+" · "+hhmm(Math.floor(t.min));
  document.getElementById("netTxt").textContent=navigator.onLine?"":"· hors ligne";
}

/* ---------- Feuilles (fenêtres du bas) ---------- */
var SHEET_LINE=null;
function openSheet(html,line){SHEET_LINE=line||null;var p=document.getElementById("panel");p.innerHTML='<button class="close" type="button" data-close="1">Fermer</button>'+html;document.getElementById("sheet").hidden=false}
function closeSheet(){document.getElementById("sheet").hidden=true}

function stopSheet(i){
  var t=now(),s=R.stops[i];
  var h='<h3>'+esc(s[1])+'</h3><div class="dist">Arrêt '+esc(s[0])+' · '+fmtDist(dist(state.place.lat,state.place.lon,s[2],s[3]))+'</div>';
  var rows=stopEvents(i).map(function(e){var L=R.lines[e.l];return{L:L,e:e,up:upcoming(i,e,t.min,L)}});
  rows.sort(function(a,b){return((a.up[0]||{m:1e9}).m)-((b.up[0]||{m:1e9}).m)});
  if(!rows.length)h+='<div class="none">Aucun passage prévu aujourd\'hui.</div>';
  rows.forEach(function(x){
    var rest=x.e.t.filter(function(m){return m>=Math.floor(t.min)});
    h+='<div class="card">'+depRow(x.L,x.up,t.min)+'<div class="times">'+(rest.length?rest.map(function(m,j){return '<span'+(j===0?' class="first"':'')+'>'+hhmm(m)+'</span>'}).join(""):'<span>Aucun</span>')+'</div></div>';
  });
  h+='<button class="ibtn" style="color:var(--ink);border-color:var(--line);align-self:flex-start" type="button" data-setplace="'+i+'">Centrer la recherche sur cet arrêt</button>';
  openSheet(h);
}

function placeSheet(){
  openSheet('<h3>Choisir un lieu</h3><input type="search" id="q" placeholder="Rue, arrêt ou station (ex. Laurier, Jean-Talon)" autocomplete="off" enterkeyhint="search"><div class="res" id="res"><button type="button" data-gps="1">Ma position <span>GPS</span></button><button type="button" data-default="1">Mont-Royal / du Parc <span>par défaut</span></button></div><h2 style="margin:6px 0 0">Distance de recherche</h2><div class="seg" role="group" aria-label="Rayon">'+[250,400,700].map(function(r){return '<button type="button" data-r="'+r+'" aria-pressed="'+(state.radius===r)+'">'+r+' m</button>'}).join("")+'</div>');
  var q=document.getElementById("q");
  q.addEventListener("input",function(){
    var v=norm(q.value).trim();if(v.length<2)return;
    var words=v.split(/\s+/),out=[],seen={};
    R.metro.forEach(function(m,j){var n=norm(m[0]);if(words.every(function(w){return n.indexOf(w)>=0}))out.push('<button type="button" data-metro="'+j+'">Station '+esc(m[0])+' <span>métro</span></button>')});
    for(var i=0;i<R.stops.length&&out.length<30;i++){var s=R.stops[i],n=norm(s[1]);if(seen[n])continue;if(words.every(function(w){return n.indexOf(w)>=0})){seen[n]=1;out.push('<button type="button" data-setplace="'+i+'">'+esc(s[1])+' <span>arrêt</span></button>')}}
    document.getElementById("res").innerHTML=out.join("")||'<div class="none">Rien trouvé. Essaie un nom de rue.</div>';
  });
}

function toast(msg){var el=document.getElementById("toast");el.textContent=msg;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(function(){el.hidden=true},4500)}
function setPlace(p,gps){
  state.place=p;state.gps=!!gps;store("bm_place",p);store("bm_gps",state.gps);
  closeSheet();paint();window.scrollTo(0,0);setTimeout(refreshRealtime,50);
}

/* ---------- GPS ---------- */
function nearestStopName(lat,lon){
  var best=null,bd=1e9;for(var i=0;i<R.stops.length;i++){var s=R.stops[i],d=dist(lat,lon,s[2],s[3]);if(d<bd){bd=d;best=s}}
  return best?best[1]:"Ma position";
}
function locate(manual){
  var btn=document.getElementById("btnPlace");
  if(!navigator.geolocation){if(manual)toast("Le GPS n'est pas disponible sur cet appareil.");return}
  btn.classList.add("busy");
  navigator.geolocation.getCurrentPosition(function(p){
    btn.classList.remove("busy");
    var lat=p.coords.latitude,lon=p.coords.longitude;
    state.lastFix=Date.now();
    if(dist(lat,lon,MTL.lat,MTL.lon)>40000){if(manual)toast("Tu sembles hors de Montréal. On garde le lieu actuel.");return}
    var moved=!state.place.gps||dist(lat,lon,state.place.lat,state.place.lon)>30;
    if(!moved&&state.gps)return;
    setPlace({name:R?nearestStopName(lat,lon):"Ma position",lat:lat,lon:lon,gps:true},true);
  },function(err){
    btn.classList.remove("busy");
    if(manual||err.code===1){
      if(err.code===1){state.gps=false;store("bm_gps",false)}
      toast(err.code===1?"Localisation refusée. Tu peux l'autoriser dans les réglages de Chrome, ou choisir un lieu avec « Changer ».":"Position introuvable pour l'instant. Réessaie dehors ou choisis un lieu.");
      paint();
    }
  },{enableHighAccuracy:true,timeout:12000,maximumAge:30000});
}

/* ---------- Événements ---------- */
document.addEventListener("click",function(e){
  var b;
  if((b=e.target.closest("[data-close]"))||e.target.id==="sheet"){closeSheet();return}
  if((b=e.target.closest("[data-setplace]"))){var s=R.stops[+b.dataset.setplace];setPlace({name:s[1],lat:s[2],lon:s[3]});return}
  if((b=e.target.closest("[data-metro]"))){var m=R.metro[+b.dataset.metro];setPlace({name:"Station "+m[0],lat:m[1],lon:m[2]});return}
  if((b=e.target.closest("[data-default]"))){setPlace(DEFAULT);return}
  if((b=e.target.closest("[data-gps]"))){closeSheet();state.gps=true;store("bm_gps",true);state.place.gps=false;locate(true);return}
  if((b=e.target.closest("[data-stop]"))){stopSheet(+b.dataset.stop);return}
  if((b=e.target.closest("[data-fav]"))){
    var n=b.dataset.fav,i=state.favs.indexOf(n);
    if(i>=0){state.favs.splice(i,1);toast("Ligne "+n+" retirée de tes lignes.")}else{state.favs.push(n);toast("Ligne "+n+" ajoutée à tes lignes.")}
    store("bm_favs",state.favs);paint();if(SHEET_LINE&&!document.getElementById("sheet").hidden)lineSheet(SHEET_LINE);return;
  }
  if((b=e.target.closest("[data-fd]"))){var f=b.dataset.fd.split("|");state.favDir[f[0]]=f[1];store("bm_favdir",state.favDir);paint();if(SHEET_LINE===f[0]&&!document.getElementById("sheet").hidden)lineSheet(f[0]);return}
  if((b=e.target.closest("[data-line]"))){lineSheet(b.dataset.line);return}
  if((b=e.target.closest("[data-r]"))){state.radius=+b.dataset.r;store("bm_radius",state.radius);b.parentNode.querySelectorAll("button").forEach(function(x){x.setAttribute("aria-pressed",x===b)});paint();refreshRealtime();return}
  if((b=e.target.closest("nav.tabs [data-v]"))){state.view=b.dataset.v;store("bm_view",state.view);paint();window.scrollTo(0,0);setTimeout(refreshRealtime,50);return}
  if((b=e.target.closest("[data-install]"))){if(installEvt){installEvt.prompt();installEvt=null;document.getElementById("banner").innerHTML=""}return}
});
document.addEventListener("keydown",function(e){if(e.key==="Escape")closeSheet();var r=e.target.closest&&e.target.closest("[data-line]");if(r&&(e.key==="Enter"||e.key===" ")){e.preventDefault();lineSheet(r.dataset.line)}});
document.getElementById("btnPlace").onclick=placeSheet;
window.addEventListener("online",paint);window.addEventListener("offline",paint);

function refreshRealtime(){fetchRealtime(lastCodes)}
document.addEventListener("visibilitychange",function(){
  if(document.hidden)return;
  paint();
  if(state.gps&&Date.now()-state.lastFix>60000)locate(false);
  refreshRealtime();
});
setInterval(function(){if(!document.hidden&&document.getElementById("sheet").hidden)paint()},20000);
setInterval(function(){if(!document.hidden)refreshRealtime()},30000);
setInterval(function(){if(!document.hidden&&state.gps)locate(false)},120000);

/* Installer l'app (Chrome Android) */
var installEvt=null;
window.addEventListener("beforeinstallprompt",function(e){
  e.preventDefault();installEvt=e;
  document.getElementById("banner").innerHTML='<div class="banner"><span>Installe l\'app sur ton écran d\'accueil.</span><button type="button" data-install="1">Installer</button></div>';
});
window.addEventListener("appinstalled",function(){document.getElementById("banner").innerHTML=""});

/* Mode hors ligne et mises à jour */
if("serviceWorker" in navigator&&location.protocol!=="file:"){
  var hadController=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").catch(function(){});
  navigator.serviceWorker.addEventListener("controllerchange",function(){if(hadController&&!reloading){reloading=true;location.reload()}});
}
var reloading=false;

/* ---------- Démarrage ---------- */
paint();
Promise.all([getJSON("donnees/reseau.json"),getJSON("donnees/jours.json")]).then(function(d){
  R=d[0];JOURS=d[1];paint();
  if(state.gps)locate(false);
  setTimeout(refreshRealtime,300);
}).catch(function(){document.getElementById("view").innerHTML='<div class="card none">Impossible de charger le réseau. Vérifie ta connexion et rouvre l\'app.</div>'});
})();
