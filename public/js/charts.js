/**
 * charts.js — Graphiques SGTM
 */
let kpiDonutChart=null, blocChart=null;

// Blocs SGTM vs TGCC
const SGTM_BLOCS = new Set(['1','2','3']);
const TGCC_BLOCS = new Set(['4']);

function initCharts(stats) {
  initKpiDonut(stats);
  initBlocChart(stats);
  updateKPIs(stats);
  updateEnterprise(stats);
}

function updateCharts(stats) {
  if (!stats) return;
  updateKPIs(stats);
  updateKpiDonut(stats);
  if (!blocChart) initBlocChart(stats); else updateBlocChartData(stats);
  updateEnterprise(stats);
}

// ── KPI Donut ──────────────────────────────────────────────────────────────
function initKpiDonut(stats) {
  const ctx = document.getElementById('kpiDonut');
  if (!ctx) return;
  if (kpiDonutChart) { kpiDonutChart.destroy(); kpiDonutChart=null; }
  const pct = stats.pctGlobal||0;
  kpiDonutChart = new Chart(ctx, {
    type:'doughnut',
    data:{ datasets:[{ data:[pct,100-pct], backgroundColor:['#C9A84C','#E5E2DC'], borderWidth:0 }] },
    options:{ responsive:true, cutout:'80%', animation:{duration:700}, plugins:{legend:{display:false},tooltip:{enabled:false}} },
  });
}
function updateKpiDonut(stats) {
  if (!kpiDonutChart) return;
  const pct=stats.pctGlobal||0;
  kpiDonutChart.data.datasets[0].data=[pct,100-pct];
  kpiDonutChart.update();
}

// ── KPI Values ──────────────────────────────────────────────────────────────
function updateKPIs(stats) {
  const { total, byStatut, pctGlobal } = stats;
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  set('kpiPct',        `${pctGlobal}%`);
  set('kpiTotal',       total.toLocaleString('fr-FR'));
  set('kpiRealise',    (byStatut.realise||0).toLocaleString('fr-FR'));
  set('kpiRealiseText',`${(byStatut.realise||0).toLocaleString('fr-FR')} / ${total.toLocaleString('fr-FR')}`);
  set('kpiRestant',    (total-(byStatut.realise||0)).toLocaleString('fr-FR'));
}

// ── Enterprise ──────────────────────────────────────────────────────────────
function updateEnterprise(stats) {
  let sgtmReal=0, sgtmTot=0, tgccReal=0, tgccTot=0;
  for (const [bloc, d] of Object.entries(stats.byBloc||{})) {
    if (SGTM_BLOCS.has(bloc)) { sgtmReal+=d.realise||0; sgtmTot+=d.total||0; }
    if (TGCC_BLOCS.has(bloc)) { tgccReal+=d.realise||0; tgccTot+=d.total||0; }
  }
  const sgtmPct = sgtmTot>0 ? Math.round(sgtmReal/sgtmTot*100) : 0;
  const tgccPct = tgccTot>0 ? Math.round(tgccReal/tgccTot*100) : 0;
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  const setW=(id,v)=>{ const el=document.getElementById(id); if(el) el.style.width=v+'%'; };
  set('sgtmPct',`${sgtmPct}%`); setW('sgtmBar',sgtmPct);
  set('tgccPct',`${tgccPct}%`); setW('tgccBar',tgccPct);
}

// ── Bloc Chart ──────────────────────────────────────────────────────────────
function initBlocChart(stats) {
  const ctx = document.getElementById('blocChart');
  if (!ctx) return;
  if (blocChart) { blocChart.destroy(); blocChart=null; }
  if (!stats.byBloc || !Object.keys(stats.byBloc).length) return;
  const metric = document.getElementById('blocMetric')?.value||'pct';
  const blocs  = Object.keys(stats.byBloc).sort();
  const {labels,datasets} = getBlocData(stats,blocs,metric);
  blocChart = new Chart(ctx, { type:'bar', data:{labels,datasets}, options:getBlocOptions(metric) });
}

function getBlocData(stats,blocs,metric) {
  const labels=blocs.map(b=>`Bloc ${b}`);
  if (metric==='pct') {
    return {
      labels,
      datasets:[
        { label:'Réalisé', data:blocs.map(b=>stats.byBloc[b]?.realise||0),
          backgroundColor:'#C9A84C', borderRadius:4, borderSkipped:false },
        { label:'Total', data:blocs.map(b=>stats.byBloc[b]?.total||0),
          backgroundColor:'#16213e', borderRadius:4, borderSkipped:false },
      ]
    };
  }
  return {
    labels,
    datasets:[
      { label:'Réalisé',     data:blocs.map(b=>stats.byBloc[b]?.realise||0),      backgroundColor:'#22b07d', borderRadius:4, stack:'s' },
    ]
  };
}

function getBlocOptions(metric) {
  return {
    responsive:true, maintainAspectRatio:false, animation:{duration:400},
    onClick:(evt,els)=>{ if(els.length&&window.onBlocClick) window.onBlocClick(blocChart.data.labels[els[0].index].replace('Bloc ','')); },
    plugins:{
      legend:{ display:true, position:'bottom', labels:{font:{size:10},boxWidth:10,padding:6,color:'#6B6B6B'} },
      tooltip:{ callbacks:{ label:ctx=> ` ${ctx.parsed.y.toLocaleString('fr-FR')} levées` } },
    },
    scales:{
      x:{ grid:{display:false}, ticks:{font:{size:10},color:'#888'}, stacked:metric==='abs' },
      y:{ grid:{color:'#F0EFED'}, ticks:{font:{size:10},color:'#AAA'}, stacked:metric==='abs' },
    },
  };
}

window.updateBlocChart = function() {
  const stats=AppState.filteredStats||AppState.stats;
  if (!stats) return;
  if (blocChart) { blocChart.destroy(); blocChart=null; }
  initBlocChart(stats);
};

function updateBlocChartData(stats) {
  if (!stats?.byBloc||!Object.keys(stats.byBloc).length) return;
  if (!blocChart) { initBlocChart(stats); return; }
  const metric=document.getElementById('blocMetric')?.value||'pct';
  const blocs=Object.keys(stats.byBloc).sort();
  const {labels,datasets}=getBlocData(stats,blocs,metric);
  blocChart.data.labels=labels;
  blocChart.data.datasets=datasets;
  blocChart.options=getBlocOptions(metric);
  blocChart.update();
}

// ── Table Chambord ───────────────────────────────────────────────────────────
function renderChambordTable(stats, filterText='') {
  const tbody=document.getElementById('chambordBody');
  const footer=document.getElementById('tableFooter');
  if (!tbody) return;

  const rows=Object.entries(stats.byChambord||{})
    .filter(([name])=>name.toLowerCase().includes(filterText.toLowerCase()))
    .sort(([a],[b])=>(parseInt(a.replace(/\D/g,''))||0)-(parseInt(b.replace(/\D/g,''))||0)||a.localeCompare(b));

  tbody.innerHTML=rows.map(([name,d])=>{
    const pct=d.total>0?Math.round(d.realise/d.total*100):0;
    const barCol=pct>=70?'#22b07d':pct>=40?'#C9A84C':'#D93025';
    return `<tr data-chambord="${name}" onclick="if(window.onChambordRowClick)window.onChambordRowClick('${name}',this)">
      <td><strong>${name}</strong></td>
      <td>${d.total}</td>
      <td style="color:#22b07d;font-weight:600">${d.realise||0}</td>
      <td>
        <div class="progress-bar-cell">
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;background:${barCol}"></div></div>
          <span class="progress-pct" style="color:${barCol}">${pct}%</span>
        </div>
      </td>
    </tr>`;
  }).join('');

  if (footer) footer.textContent=`Affichage de 1 à ${rows.length} sur ${Object.keys(stats.byChambord||{}).length} chambords`;
}

window.filterChambordTable=function(){
  const ft=document.getElementById('chambordSearch')?.value||'';
  const stats=AppState.filteredStats||AppState.stats;
  if(stats) renderChambordTable(stats,ft);
};