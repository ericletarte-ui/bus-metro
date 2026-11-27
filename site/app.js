(function(){
"use strict";

/* ---------- Réglages ---------- */
var CFG=window.BM_CONFIG||{};
/* Les villes : chacune a son dossier de données. On choisit la plus proche du GPS. */
var VILLES={
  stm:{nom:"Montréal",reseau:"STM",dir:"donnees/",centre:{lat:45.53,lon:-73.65},rayon:40000,
    lieu:{name:"Mont-Royal / du Parc",lat:45.51672,lon:-73.58925},favs:["80","480","129"],direct:true,rayons:[250,400,700],rayonDefaut:400,express:/^4\d\d$/,vert:/^$/},
  rtc:{nom:"Québec",reseau:"RTC",dir:"donnees/rtc/",centre:{lat:46.81,lon:-71.25},rayon:35000,
    lieu:{name:"Château Frontenac",lat:46.81181,lon:-71.20526},favs:["800","801"],direct:false,rayons:[300,550,800],rayonDefaut:550,express:/^$/,vert:/^80\d$/}
};
var METRO={1:{n:"Verte",c:"l1"},2:{n:"Orange",c:"l2"},4:{n:"Jaune",c:"l4"},5:{n:"Bleue",c:"l5"}};
var WALK=80; // mètres par minute à pied

/* ---------- Petit stockage sur le téléphone ---------- */
function store(k,v){try{if(v===undefined){var x=localStorage.getItem(k);return x?JSON.parse(x):null}localStorage.setItem(k,JSON.stringify(v))}catch(e){return null}}

var VILLE="stm",V=VILLES.stm;
var state={
  place:V.lieu, gps:true, view:"autour", radius:400,
  favs:V.favs.slice(), favDir:{}, lastFix:0
};
/* Le lieu, les lignes favorites et les sens sont retenus séparément pour chaque ville */
function cle(k){return VILLE==="stm"?k:k+"_"+VILLE}
function restoreVille(){
  var p=store(cle("bm_place"));state.place=p&&typeof p.lat==="number"?p:V.lieu;
  var f=store(cle("bm_favs"));state.favs=Array.isArray(f)?f:V.favs.slice();
  /* Une seule fois : ajouter 800 et 801 aux lignes de Québec déjà enregistrées (demande d'Éric, 27 nov. 2026) */
  if(VILLE==="rtc"&&Array.isArray(f)&&!store("bm_ajout_rtc1")){["800","801"].forEach(function(n){if(state.favs.indexOf(n)<0)state.favs.push(n)});store(cle("bm_favs"),state.favs);store("bm_ajout_rtc1",true)}
  var r=store(cle("bm_radius"));state.radius=V.rayons.indexOf(r)>=0?r:V.rayonDefaut;
  var d=store(cle("bm_favdir"))||(VILLE==="stm"&&store("pp_favdir"));state.favDir=d&&typeof d==="object"?d:{};
}
(function restore(){
  var c=store("bm_ville");if(VILLES[c]){VILLE=c;V=VILLES[c]}
  restoreVille();
  var g=store("bm_gps"); if(g===false)state.gps=false;
  var v=store("bm_view"); if(v==="lignes")state.view=v;
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
  return getJSON(V.dir+"passages-"+key+".json").then(function(a){
    GRIDS[key]=a.map(function(lst){return lst.map(function(e){var t=[],acc=0;for(var i=1;i<e.length;i++){acc+=e[i];t.push(acc)}return{l:e[0],t:t}})});
    return GRIDS[key];
  });
}
function ready(t){
  var v=VILLE;
  return Promise.all([loadGrid(t.date),loadGrid(prevDate(t.date))]).then(function(g){
    if(v!==VILLE)throw "ville";
    if(MERGED.date!==t.date||MERGED.v!==v)MERGED={date:t.date,v:v,cache:{},today:g[0],yday:g[1]};
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
  if(!CFG.relaisTempsReel||!V.direct||!codes.length||document.hidden||SIM)return;
  var url=CFG.relaisTempsReel.replace(/\/$/,"")+"/passages?arrets="+encodeURIComponent(codes.slice(0,40).join(","));
  fetch(url).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){
    RT={at:Date.now(),data:d.passages||{},ok:true};paint();
  }).catch(function(){RT.ok=false;paint()});
}

/* ---------- Calculs ---------- */
function isFav(num){return state.favs.indexOf(num)>=0}
function badgeCls(num){return V.vert.test(num)?"badge mb":isFav(num)?"badge fav":V.express.test(num)?"badge exp":"badge"}
function nearStops(lat,lon,radius){
  var res=[];for(var i=0;i<R.stops.length;i++){var s=R.stops[i];var d=dist(lat,lon,s[2],s[3]);if(d<=radius)res.push({i:i,d:d})}
  return res.sort(function(a,b){return a.d-b.d});
}
/* Prochains départs à un arrêt pour une ligne donnée, en minutes depuis minuit, temps réel si disponible */
function upcoming(stopIdx,e,min,line){
  var s=R.stops[stopIdx],rt=rtFor(s[0],line[0]);
  if(rt&&rt.length){
    var nowMs=Date.now(),list=rt.filter(function(x){return x.h===undefined||dirKey(x.h)===dirKey(line[1])}).map(function(x){return{m:min+(x.t*1000-nowMs)/60000,live:true,h:line[1],l:e.l,t:x.t}}).filter(function(x){return x.m>=min-0.5});
    if(list.length)return list;
  }
  return e.t.filter(function(m){return m>=Math.floor(min)}).map(function(m){return{m:m,h:line[1],l:e.l}});
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
  return '<span class="swap" aria-hidden="true">⇆ glisse '+esc(dirLabel(nk).replace(/^Vers /,"pour "))+'</span>';
}
function isSoon(r,min){var e=r.sel.ev[0];return !!e&&e.m-min<60}
function nextKey(r){return r.keys.length<2?"":r.keys[(r.keys.indexOf(r.cur)+1)%r.keys.length]}
function rowHTML(r,min){
  var s=R.stops[r.sel.stop],ev=r.sel.ev,soon=isSoon(r,min),nk=nextKey(r);
  var h='<div class="r'+(soon?'':' lt')+'" role="button" tabindex="0" data-line="'+esc(r.num)+'"'+(nk?' data-sw="'+esc(r.num)+'|'+esc(nk)+'"':'')+'><div class="'+badgeCls(r.num)+'">'+esc(r.num)+'</div><div class="who"><b>'+esc(dirLabel(r.cur))+(V.express.test(r.num)?' · express':V.vert.test(r.num)?' · Métrobus':'')+'</b>';
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
  /* On cherche aussi un peu plus loin (jusqu'à 2 fois le rayon) pour ne pas rater une grande ligne à quelques rues */
  var loin=Math.min(state.radius*2,900),res=routeGroups(t,loin),tous=res.groups;
  var proche=function(r){return Object.keys(r.dirs).some(function(k){return r.dirs[k].d<=state.radius})};
  var gs=tous.filter(proche);
  var plusLoin=tous.filter(function(r){return !proche(r)&&isSoon(r,t.min)}).sort(function(a,b){return a.sel.d-b.sel.d}).slice(0,4);
  GROUPS={};tous.forEach(function(r){GROUPS[r.num]=r});
  var soon=gs.filter(function(r){return isSoon(r,t.min)}),later=gs.filter(function(r){return !isSoon(r,t.min)});
  soon.sort(function(a,b){var fa=isFav(a.num)?0:1,fb=isFav(b.num)?0:1;return fa-fb||a.sel.ev[0].m-b.sel.ev[0].m});
  var h='';
  h+='<section><h2>Prochains départs</h2>';
  if(!gs.length&&!plusLoin.length)h+='<div class="card none">Aucune ligne à moins de '+state.radius+' m. Touche « Changer » pour agrandir le rayon ou choisir un autre lieu.</div>';
  else if(!soon.length)h+='<div class="card none">Aucun bus dans l\'heure tout près d\'ici.</div>';
  else h+='<div class="rows">'+soon.map(function(r){return rowHTML(r,t.min)}).join("")+'</div>';
  h+='</section>';
  if(plusLoin.length)h+='<section><h2>Un peu plus loin</h2><div class="rows">'+plusLoin.map(function(r){return rowHTML(r,t.min)}).join("")+'</div></section>';
  if(later.length)h+='<section><h2>Plus tard</h2><div class="rows later">'+later.map(function(r){return rowHTML(r,t.min)}).join("")+'</div></section>';
  if(R.metro.length){h+='<section><h2>Métro</h2><div class="rows">'+nearestStations(2).map(function(x){return stationRow(x,t)}).join("")+'</div>';
  h+='<p class="foot" style="margin-top:8px"><a href="https://www.stm.info/fr/infos/etat-du-service" target="_blank" rel="noopener">État du service du métro</a> · fréquences approximatives : la licence de la STM ne permet pas d\'afficher les heures exactes du métro.</p></section>';}
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

var SHEET_EV=null,SHEET_STOP=null;
function lineSheet(num,pick){
  var t=now(),g=(state.view==="lignes"||!GROUPS[num])?favGroup(num,t):GROUPS[num];
  if(state.view!=="lignes"&&GROUPS[num]){var fresh=routeGroups(t,Math.min(state.radius*2,900)).groups.filter(function(x){return x.num===num})[0];if(fresh)g=fresh}
  var h='<h3>Ligne '+esc(num)+(g.name?' · '+esc(g.name):'')+'</h3>';
  h+='<button class="favbtn" type="button" data-fav="'+esc(num)+'" aria-pressed="'+isFav(num)+'">'+STAR+(isFav(num)?' Dans mes lignes (retirer)':' Ajouter à mes lignes')+'</button>';
  if(g.keys&&g.keys.length>1)h+='<div class="seg" role="group" aria-label="Sens">'+g.keys.map(function(k){return '<button type="button" data-fd="'+esc(num)+'|'+esc(k)+'" aria-pressed="'+(k===g.cur)+'">'+esc(dirLabel(k))+'</button>'}).join("")+'</div>';
  if(!g.sel){h+='<div class="none">Pas de service aujourd\'hui selon l\'horaire.</div>';openSheet(h,num);return}
  var s=R.stops[g.sel.stop],ev=g.sel.ev,j0=Math.min(pick||0,Math.max(0,ev.length-1));
  SHEET_EV=ev;SHEET_STOP=g.sel.stop;
  var nks=g.keys&&g.keys.length>1?g.keys[(g.keys.indexOf(g.cur)+1)%g.keys.length]:"";
  h+='<div class="swz"'+(nks?' data-sw="'+esc(num)+'|'+esc(nks)+'"':'')+'>';
  h+='<div class="dist">Arrêt '+esc(s[1])+' ('+esc(s[0])+') · '+fmtDist(g.sel.d)+'</div>';
  h+='<div class="times" role="group" aria-label="Passages, touche une heure pour voir le trajet">'+(ev.length?ev.slice(0,8).map(function(x,j){return '<button type="button" data-trip="'+j+'"'+(j===j0?' class="first" aria-pressed="true"':' aria-pressed="false"')+'>'+(x.live?'● ':'')+hhmm(Math.round(x.m))+'</button>'}).join(""):'<span>Plus de passage aujourd\'hui</span>')+'</div>';
  if(ev.some(function(x){return x.live}))h+='<p class="foot">● : heure en direct de la '+V.reseau+'. Les autres sont les heures prévues. Touche une heure pour voir le trajet de ce bus.</p>';
  else if(ev.length)h+='<p class="foot">Touche une heure pour voir le trajet de ce bus.</p>';
  if(ev.length)h+='<div id="trajet" class="trajet"><div class="none">Chargement du trajet…</div></div>';
  h+='</div>';
  h+='<button class="ibtn" style="color:var(--accent);border-color:var(--line);align-self:flex-start" type="button" data-stop="'+g.sel.stop+'">Toute la journée à cet arrêt</button>';
  openSheet(h,num);
  if(ev.length)showTrip(j0);
}

/* ---------- Trajet d'un bus : les arrêts suivants ---------- */
var PARC=null,CODE=null;
function loadParcours(){
  if(PARC)return Promise.resolve(PARC);
  return getJSON(V.dir+"parcours.json").then(function(p){PARC=p;return p});
}
function codeIndex(c){
  if(!CODE){CODE={};R.stops.forEach(function(s,i){CODE[s[0]]=i})}
  return CODE[c];
}
/* Arrêts suivants selon l'horaire prévu : le parcours le plus courant qui passe par cet arrêt */
function staticTrip(stopIdx,lineIdx,depMin){
  var best=null;
  (PARC[lineIdx]||[]).forEach(function(p){var k=p[0].indexOf(stopIdx);if(k>=0&&k<p[0].length-1&&(!best||p[2]>best.p[2]))best={p:p,k:k}});
  if(!best)return null;
  var seq=best.p[0],off=best.p[1],k=best.k;
  return seq.slice(k).map(function(si,j){return{i:si,m:depMin+off[k+j]-off[k]}});
}
function showTrip(j){
  var box=document.getElementById("trajet"),x=SHEET_EV&&SHEET_EV[j];if(!box||!x)return;
  document.querySelectorAll("[data-trip]").forEach(function(b){var on=+b.dataset.trip===j;b.classList.toggle("first",on);b.setAttribute("aria-pressed",on)});
  var stop=SHEET_STOP,line=R.lines[x.l],t=now();
  var render=function(list,live){
    if(document.getElementById("trajet")!==box)return;
    if(!list||!list.length){box.innerHTML='<div class="none">Trajet indisponible pour ce bus.</div>';return}
    var h='<h2>Trajet du bus de '+hhmm(Math.round(x.m))+(live?' · en direct':' · horaire prévu')+'</h2><ol class="arrets">';
    list.forEach(function(a,n){
      var s=R.stops[a.i];if(!s)return;
      var metro=/^Station /.test(s[1]);
      h+='<li class="'+(n===0?'ici':'')+(n===list.length-1?' fin':'')+'"><span class="h">'+hhmm(Math.round(a.m))+'</span><span class="pt" aria-hidden="true"></span><span class="nm">'+(metro?'<b>':'')+esc(s[1])+(metro?'</b>':'')+(n===0?' <small>(ton arrêt)</small>':'')+(n===list.length-1?' <small>(terminus)</small>':'')+'</span></li>';
    });
    box.innerHTML=h+'</ol>';
  };
  box.innerHTML='<div class="none">Chargement du trajet…</div>';
  var fallback=function(){loadParcours().then(function(){render(staticTrip(stop,x.l,Math.round(x.m)),false)}).catch(function(){render(null)})};
  if(x.live&&CFG.relaisTempsReel&&V.direct){
    var url=CFG.relaisTempsReel.replace(/\/$/,"")+"/voyage?arret="+encodeURIComponent(R.stops[stop][0])+"&ligne="+encodeURIComponent(line[0])+"&t="+x.t;
    fetch(url).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){
      if(!d.arrets||!d.arrets.length)throw 0;
      var nowMs=Date.now(),list=d.arrets.map(function(a){return{i:codeIndex(a[0]),m:t.min+(a[1]*1000-nowMs)/60000}}).filter(function(a){return a.i!==undefined});
      render(list,true);
    }).catch(fallback);
  }else fallback();
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
    v.innerHTML=pre+out.html+'<p class="foot">'+credit()+'</p>';
    lastCodes=out.codes;
  }).catch(function(e){if(e==="ville")return;if(window.console)console.error(e);v.innerHTML='<div class="card none">Impossible de charger les horaires. Vérifie ta connexion et rouvre l\'app.</div>'});
}
function dateFeed(){var f=String(R.feed||"");return /^\d{8}/.test(f)?f.slice(6,8).replace(/^0/,"")+" "+["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"][+f.slice(4,6)-1]+" "+f.slice(0,4):f}
function credit(){
  if(VILLE==="rtc")return "Application intégrant de l'information publique du Réseau de transport de la Capitale, mise à jour le "+esc(dateFeed())+".";
  return "Horaires : STM (données ouvertes, CC BY 4.0)"+(R.feed?", version "+esc(String(R.feed).slice(0,8)):"")+".";
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
  openSheet('<h3>Choisir un lieu</h3><input type="search" id="q" placeholder="Rue, arrêt ou station (ex. Laurier, Jean-Talon)" autocomplete="off" enterkeyhint="search"><div class="res" id="res"><button type="button" data-gps="1">Ma position <span>GPS</span></button><button type="button" data-default="1">'+esc(V.lieu.name)+' <span>par défaut</span></button></div><h2 style="margin:6px 0 0">Ville</h2><div class="seg" role="group" aria-label="Ville">'+Object.keys(VILLES).map(function(k){return '<button type="button" data-ville="'+k+'" aria-pressed="'+(k===VILLE)+'">'+VILLES[k].nom+' ('+VILLES[k].reseau+')</button>'}).join("")+'</div><h2 style="margin:6px 0 0">Distance de recherche</h2><div class="seg" role="group" aria-label="Rayon">'+V.rayons.map(function(r){return '<button type="button" data-r="'+r+'" aria-pressed="'+(state.radius===r)+'">'+r+' m</button>'}).join("")+'</div>');
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
  state.place=p;state.gps=!!gps;store(cle("bm_place"),p);store("bm_gps",state.gps);
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
    var vk=villeDe(lat,lon);
    if(!vk){if(manual)toast("Tu sembles hors de Montréal et de Québec. On garde le lieu actuel.");return}
    if(vk!==VILLE){changerVille(vk).then(function(){if(VILLE!==vk){paint();return}toast("Bienvenue à "+V.nom+" : horaires du "+V.reseau+".");setPlace({name:nearestStopName(lat,lon),lat:lat,lon:lon,gps:true},true)});return}
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
function choisirSens(num,k){
  state.favDir[num]=k;store(cle("bm_favdir"),state.favDir);paint();
  if(SHEET_LINE===num&&!document.getElementById("sheet").hidden)lineSheet(num);
}
/* Glisser le doigt de côté sur une ligne (ou dans son détail) pour changer de sens */
var SW=null,SW_BLOCK=0;
document.addEventListener("touchstart",function(e){
  var el=e.target.closest&&e.target.closest("[data-sw]");
  SW=el&&e.touches.length===1?{el:el,x:e.touches[0].clientX,y:e.touches[0].clientY,h:null}:null;
},{passive:true});
document.addEventListener("touchmove",function(e){
  if(!SW)return;var dx=e.touches[0].clientX-SW.x,dy=e.touches[0].clientY-SW.y;
  if(SW.h===null&&(Math.abs(dx)>10||Math.abs(dy)>10))SW.h=Math.abs(dx)>Math.abs(dy)*1.3;
  if(SW.h){e.preventDefault();SW.el.style.transform="translateX("+Math.max(-90,Math.min(90,dx*0.6))+"px)";SW.el.style.opacity=String(1-Math.min(Math.abs(dx),150)/400)}
},{passive:false});
document.addEventListener("touchend",function(e){
  if(!SW)return;var s=SW;SW=null;
  s.el.style.transition="transform .15s, opacity .15s";s.el.style.transform="";s.el.style.opacity="";
  setTimeout(function(){s.el.style.transition=""},200);
  if(!s.h)return;
  SW_BLOCK=Date.now();
  var dx=(e.changedTouches[0]||{}).clientX-s.x;
  if(Math.abs(dx)>=60){var f=s.el.dataset.sw.split("|");if(navigator.vibrate)try{navigator.vibrate(12)}catch(_){}choisirSens(f[0],f[1])}
});
document.addEventListener("click",function(e){if(Date.now()-SW_BLOCK<400){e.stopPropagation();e.preventDefault()}},true);
document.addEventListener("click",function(e){
  var b;
  if((b=e.target.closest("[data-close]"))||e.target.id==="sheet"){closeSheet();return}
  if((b=e.target.closest("[data-setplace]"))){var s=R.stops[+b.dataset.setplace];setPlace({name:s[1],lat:s[2],lon:s[3]});return}
  if((b=e.target.closest("[data-metro]"))){var m=R.metro[+b.dataset.metro];setPlace({name:"Station "+m[0],lat:m[1],lon:m[2]});return}
  if((b=e.target.closest("[data-default]"))){setPlace(V.lieu);return}
  if((b=e.target.closest("[data-ville]"))){var vk=b.dataset.ville;if(vk!==VILLE){closeSheet();state.gps=false;store("bm_gps",false);changerVille(vk).then(function(){if(VILLE===vk)setPlace(V.lieu);else paint()})}else closeSheet();return}
  if((b=e.target.closest("[data-gps]"))){closeSheet();state.gps=true;store("bm_gps",true);state.place.gps=false;locate(true);return}
  if((b=e.target.closest("[data-stop]"))){stopSheet(+b.dataset.stop);return}
  if((b=e.target.closest("[data-fav]"))){
    var n=b.dataset.fav,i=state.favs.indexOf(n);
    if(i>=0){state.favs.splice(i,1);toast("Ligne "+n+" retirée de tes lignes.")}else{state.favs.push(n);toast("Ligne "+n+" ajoutée à tes lignes.")}
    store(cle("bm_favs"),state.favs);paint();if(SHEET_LINE&&!document.getElementById("sheet").hidden)lineSheet(SHEET_LINE);return;
  }
  if((b=e.target.closest("[data-fd]"))){var f=b.dataset.fd.split("|");choisirSens(f[0],f[1]);return}
  if((b=e.target.closest("[data-line]"))){lineSheet(b.dataset.line);return}
  if((b=e.target.closest("[data-trip]"))){showTrip(+b.dataset.trip);return}
  if((b=e.target.closest("[data-r]"))){state.radius=+b.dataset.r;store(cle("bm_radius"),state.radius);b.parentNode.querySelectorAll("button").forEach(function(x){x.setAttribute("aria-pressed",x===b)});paint();refreshRealtime();return}
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

/* ---------- Villes ---------- */
function villeDe(lat,lon){
  var best=null,bd=1e12;
  Object.keys(VILLES).forEach(function(k){var c=VILLES[k],d=dist(lat,lon,c.centre.lat,c.centre.lon);if(d<=c.rayon&&d<bd){bd=d;best=k}});
  return best;
}
function chargerVille(){
  return Promise.all([getJSON(V.dir+"reseau.json"),getJSON(V.dir+"jours.json")]).then(function(d){R=d[0];JOURS=d[1]});
}
function changerVille(k){
  var avant=VILLE;
  return basculer(k).catch(function(){toast("Les horaires de "+VILLES[k].nom+" ne sont pas disponibles pour l'instant.");return basculer(avant)});
}
function basculer(k){
  VILLE=k;V=VILLES[k];store("bm_ville",k);
  R=null;JOURS={};GRIDS={};MERGED={date:null,cache:{}};PARC=null;CODE=null;GROUPS={};RT={at:0,data:{},ok:false};lastCodes=[];
  var gps=state.gps;restoreVille();state.gps=gps;
  document.getElementById("view").innerHTML='<div class="card none">Chargement des horaires de '+V.nom+'…</div>';
  return chargerVille();
}

/* ---------- Démarrage ---------- */
paint();
chargerVille().catch(function(e){if(VILLE==="stm")throw e;return basculer("stm")}).then(function(){
  paint();
  if(state.gps)locate(false);
  setTimeout(refreshRealtime,300);
}).catch(function(){document.getElementById("view").innerHTML='<div class="card none">Impossible de charger le réseau. Vérifie ta connexion et rouvre l\'app.</div>'});
})();
