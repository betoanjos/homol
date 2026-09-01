const API = '/api/contracts';
const fieldIds = [
  'parceiroId','estacaoId','razaoSocial','nomeFantasia','cnpj','inscricaoEstadual','enderecoParceiro',
  'representanteNome','representanteCpf','representanteEmail','representanteTelefone','enderecoEstacao',
  'cidadeForo','fabricante','modelo','potenciaKw','potenciaOperacionalKw','conectores','quantidadeSaidas',
  'quantidadeVagas','tensaoV','disjuntorA','internetMbps','operacao24h','prazoMeses','avisoPrevioDias',
  'investimento','custoEnergia','precoKwh','taxaOperacionalPct','comissaoPct','recargasMensais',
  'consumoMedioKwh','dataContrato','observacoes'
];
const numericFields = new Set(['potenciaKw','potenciaOperacionalKw','quantidadeSaidas','quantidadeVagas','tensaoV','disjuntorA','internetMbps','prazoMeses','avisoPrevioDias','investimento','custoEnergia','precoKwh','taxaOperacionalPct','comissaoPct','recargasMensais','consumoMedioKwh']);
let meta = { parceiros: [], estacoes: [], assinatura: { mode: 'simulator' }, integrador: {} };
let current = null;
let user = null;

const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const money = v => Number(v || 0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const dateTime = v => v ? new Date(v).toLocaleString('pt-BR') : '—';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

async function api(path='', options={}) {
  const res = await fetch(API + path, { ...options, headers: { 'Content-Type':'application/json', ...(options.headers||{}) } });
  if (res.status === 401) { location.href='/login'; throw new Error('Sessão expirada.'); }
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || `Erro HTTP ${res.status}`);
  return data;
}

function toast(message,type='ok') {
  const el=document.getElementById('toast'); el.textContent=message; el.className=`toast ${type}`; el.style.display='block';
  clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.style.display='none',4500);
}

function statusLabel(status) {
  return ({rascunho:'Rascunho',em_revisao:'Em revisão',aprovado:'Aprovado',aguardando_assinaturas:'Aguardando assinaturas',parcialmente_assinado:'Parcialmente assinado',concluido:'Concluído',cancelado:'Cancelado',recusado:'Recusado',expirado:'Expirado'})[status] || status;
}
function statusClass(status) {
  if(status==='concluido')return 'badge-green'; if(status==='aguardando_assinaturas'||status==='parcialmente_assinado'||status==='aprovado')return 'badge-blue'; if(status==='em_revisao'||status==='rascunho')return 'badge-yellow'; return 'badge-red';
}

async function init() {
  try {
    const [me,m] = await Promise.all([fetch('/api/me').then(r=>r.json()),api('/meta')]);
    user=me.user; meta=m;
    if(user?.role==='leitura') document.querySelectorAll('.admin-action').forEach(el=>el.style.display='none');
    fillPartnerOptions();
    document.getElementById('dataContrato').value=today();
    fieldIds.forEach(id=>document.getElementById(id)?.addEventListener('input',renderFinancialSummary));
    await loadContracts();
    const parceiroInicial=new URLSearchParams(location.search).get('parceiroId');
    if(parceiroInicial&&meta.parceiros.some(p=>p.id===parceiroInicial)&&user?.role==='admin'){
      newContract();setValue('parceiroId',parceiroInicial);partnerChanged();
    }
  } catch(err){toast(err.message,'error');}
}

function fillPartnerOptions() {
  const ps=document.getElementById('parceiroId');
  ps.innerHTML='<option value="">Selecione</option>'+meta.parceiros.map(p=>`<option value="${esc(p.id)}">${esc(p.nome)} · ${esc(p.doc||'')}</option>`).join('');
  fillStationOptions('');
}
function fillStationOptions(partnerId, selected='') {
  const ss=document.getElementById('estacaoId');
  let list=meta.estacoes;
  if(partnerId) list=list.filter(e=>!e.parceiroId||e.parceiroId===partnerId);
  ss.innerHTML='<option value="">Selecione</option>'+list.map(e=>`<option value="${esc(e.id)}">${esc(e.nome)}${e.potencia?' · '+esc(e.potencia)+' kW':''}</option>`).join('');
  if(selected)ss.value=selected;
}

function partnerChanged() {
  const id=document.getElementById('parceiroId').value;
  const p=meta.parceiros.find(x=>x.id===id); fillStationOptions(id);
  if(!p)return;
  setValue('razaoSocial',p.razaoSocial||p.nome||''); setValue('nomeFantasia',p.nome||''); setValue('cnpj',p.doc||'');
  setValue('enderecoParceiro',p.endereco||''); setValue('representanteNome',p.contato||''); setValue('representanteTelefone',p.telefone||'');
  if(Number(p.custoEnergia)>=0)setValue('custoEnergia',p.custoEnergia);
  if(Number(p.comissao)>=0)setValue('comissaoPct',p.comissao);
  if(Number(p.taxaOperacional)>=0)setValue('taxaOperacionalPct',p.taxaOperacional);
  renderFinancialSummary();
}
function stationChanged() {
  const e=meta.estacoes.find(x=>x.id===document.getElementById('estacaoId').value); if(!e)return;
  setValue('enderecoEstacao',e.endereco||''); if(e.potencia){setValue('potenciaKw',e.potencia);setValue('potenciaOperacionalKw',e.potencia);} if(e.conector)setValue('conectores',e.conector); if(e.investimento)setValue('investimento',e.investimento);
}
function setValue(id,value){const el=document.getElementById(id);if(el)el.value=value??'';}

function collectData() {
  const out={}; fieldIds.forEach(id=>{const el=document.getElementById(id);if(!el)return;out[id]=numericFields.has(id)?Number(el.value||0):(id==='operacao24h'?el.value==='true':el.value.trim());}); return out;
}
function calc(data=collectData()) {
  const energiaMensalKwh=Number(data.recargasMensais||0)*Number(data.consumoMedioKwh||0);
  const receitaBruta=energiaMensalKwh*Number(data.precoKwh||0); const custoEnergiaMensal=energiaMensalKwh*Number(data.custoEnergia||0);
  const taxaOperacional=receitaBruta*(Number(data.taxaOperacionalPct||0)/100); const receitaLiquida=receitaBruta-custoEnergiaMensal-taxaOperacional;
  const comissao=Math.max(0,receitaLiquida)*(Number(data.comissaoPct||0)/100); return {energiaMensalKwh,receitaBruta,custoEnergiaMensal,taxaOperacional,receitaLiquida,comissao,repasseTotal:custoEnergiaMensal+comissao};
}
function renderFinancialSummary() {
  const c=calc(); const items=[['Energia estimada',`${c.energiaMensalKwh.toLocaleString('pt-BR')} kWh`],['Receita bruta',money(c.receitaBruta)],['Custo energia',money(c.custoEnergiaMensal)],['Taxa operacional',money(c.taxaOperacional)],['Receita líquida',money(c.receitaLiquida)],['Repasse total',money(c.repasseTotal)]];
  document.getElementById('financial-summary').innerHTML=items.map(([l,v])=>`<div class="metric"><span>${l}</span><b>${v}</b></div>`).join('');
}

async function loadContracts() {
  const status=document.getElementById('filter-status').value; const data=await api(status?`?status=${encodeURIComponent(status)}`:''); const rows=data.contratos||[];
  document.getElementById('contracts-empty').style.display=rows.length?'none':'block';
  document.getElementById('contracts-body').innerHTML=rows.map(c=>`<tr><td><b>${esc(c.numero)}</b></td><td>${esc(c.parceiro_nome||'')}</td><td><span class="badge ${statusClass(c.status)}">${esc(statusLabel(c.status))}</span></td><td>${dateTime(c.criado_em)}</td><td>${c.pdf_assinado_hash?'✓ Assinado':c.pdf_original_hash?'PDF gerado':'—'}</td><td><button class="btn btn-sm" onclick="openContract('${c.id}')">Abrir</button>${c.pdf_original_hash?` <button class="btn btn-sm" onclick="downloadFile('${c.id}','original')">PDF</button>`:''}${c.pdf_assinado_hash?` <button class="btn btn-sm" onclick="downloadFile('${c.id}','signed')">Assinado</button>`:''}</td></tr>`).join('');
}

function newContract() {
  current=null; document.getElementById('contract-form').reset(); fillPartnerOptions();
  const defaults={fabricante:'WEG',modelo:'WEMOB Station',potenciaKw:40,potenciaOperacionalKw:40,conectores:'CCS2',quantidadeSaidas:1,quantidadeVagas:1,tensaoV:380,internetMbps:20,operacao24h:'true',prazoMeses:48,avisoPrevioDias:90,custoEnergia:.94,precoKwh:1.99,taxaOperacionalPct:22,comissaoPct:12,recargasMensais:160,consumoMedioKwh:25,dataContrato:today(),cidadeForo:'São Bento do Sul - SC'};
  Object.entries(defaults).forEach(([k,v])=>setValue(k,v)); showEditor(); updateActions(); renderFinancialSummary();
}
function showEditor(){document.getElementById('list-view').classList.add('hidden');document.getElementById('editor-view').classList.add('open');window.scrollTo(0,0);}
function closeEditor(){document.getElementById('editor-view').classList.remove('open');document.getElementById('list-view').classList.remove('hidden');current=null;loadContracts().catch(e=>toast(e.message,'error'));}

async function openContract(id) {
  try{const data=await api('/'+id);current=data.contract;fillPartnerOptions();fieldIds.forEach(k=>setValue(k,current.dados?.[k]??''));fillStationOptions(current.dados.parceiroId,current.dados.estacaoId);showEditor();updateActions();renderFinancialSummary();renderAudit(data.eventos||[]);}catch(e){toast(e.message,'error');}
}
function renderAudit(events){const card=document.getElementById('audit-card');card.style.display=events.length?'block':'none';document.getElementById('audit-list').innerHTML=events.map(e=>`<div class="audit-item"><b>${esc(e.tipo.replaceAll('_',' '))}</b> · ${dateTime(e.criado_em)} · ${esc(e.usuario_nome||'sistema')}</div>`).join('');}

function updateActions() {
  const status=current?.status||'novo'; const canEdit=!current||['rascunho','em_revisao'].includes(status); const isAdmin=user?.role==='admin';
  document.getElementById('editor-title').textContent=current?`${current.numero} · ${current.dados.razaoSocial}`:'Novo contrato';
  const pendencias=[];
  if(!meta.integrador.emailConfigurado)pendencias.push('configure EVPARKING_SIGNER_EMAIL');
  if(!meta.assinatura.configured)pendencias.push('configure ZAPSIGN_API_TOKEN');
  document.getElementById('contract-status').innerHTML=`Status: <span class="badge ${statusClass(status)}">${status==='novo'?'Novo rascunho':statusLabel(status)}</span>${current?.pdf_original_hash?` · SHA-256 ${esc(current.pdf_original_hash.slice(0,16))}…`:''} · Assinatura: ${esc(meta.assinatura.mode==='simulator'?'simulador de homologação':'ZapSign')}${pendencias.length?` · <span style="color:var(--yellow)">${esc(pendencias.join(' e '))}</span>`:''}`;
  document.getElementById('btn-save').disabled=!isAdmin||!canEdit; document.getElementById('btn-pdf').disabled=!isAdmin||!current||!canEdit;
  document.getElementById('btn-approve').disabled=!isAdmin||status!=='em_revisao'; document.getElementById('btn-send').disabled=!isAdmin||status!=='aprovado'||!meta.assinatura.configured||!meta.integrador.emailConfigurado;
  const sim=document.getElementById('btn-simulate');sim.style.display=isAdmin&&meta.assinatura.mode==='simulator'&&status==='aguardando_assinaturas'?'inline-block':'none';
  document.querySelectorAll('#contract-form input,#contract-form select,#contract-form textarea').forEach(el=>el.disabled=!isAdmin||!canEdit);
}

async function saveContract() {
  try{const payload={dados:collectData()};let result;if(current)result=await api('/'+current.id,{method:'PUT',body:JSON.stringify(payload)});else result=await api('',{method:'POST',body:JSON.stringify(payload)});
    toast(current?'Rascunho atualizado.':'Contrato criado.');await openContract(current?.id||result.id);
  }catch(e){toast(e.message,'error');}
}

function buildPdf(data,calculations,number) {
  const {jsPDF}=window.jspdf; const doc=new jsPDF({unit:'pt',format:'a4'}); const W=doc.internal.pageSize.getWidth(),H=doc.internal.pageSize.getHeight(),m=54,maxW=W-2*m; let y=58;
  const addPage=()=>{doc.addPage();y=58;}; const ensure=h=>{if(y+h>H-58)addPage();};
  const writeLines=(text,{size=10,bold=false,align='justify',space=7}={})=>{doc.setFont('helvetica',bold?'bold':'normal');doc.setFontSize(size);const lines=doc.splitTextToSize(String(text),maxW);const lh=size*1.35;ensure(lines.length*lh+space);doc.text(lines,m,y,{align,maxWidth:maxW,lineHeightFactor:1.35});y+=lines.length*lh+space;};
  const content=window.EVContratoTemplate.gerarConteudoContrato(data,calculations,meta);
  content.forEach(item=>{
    if(item.type==='title'){ensure(80);doc.setFont('helvetica','bold');doc.setFontSize(14);const lines=doc.splitTextToSize(item.text,maxW);doc.text(lines,W/2,y,{align:'center',lineHeightFactor:1.25});y+=lines.length*18+24;}
    else if(item.type==='h1'){ensure(34);y+=8;writeLines(item.text,{size:10,bold:true,align:'left',space:8});}
    else if(item.type==='p')writeLines(item.text);
    else if(item.type==='signature'){ensure(120);y+=30;doc.setDrawColor(120);doc.line(m,y,m+205,y);doc.line(W-m-205,y,W-m,y);doc.setFontSize(9);doc.setFont('helvetica','normal');doc.text(item.left.split('\n'),m+102,y+14,{align:'center',lineHeightFactor:1.25});doc.text(item.right.split('\n'),W-m-102,y+14,{align:'center',lineHeightFactor:1.25});y+=75;}
  });
  const pages=doc.getNumberOfPages();for(let p=1;p<=pages;p++){doc.setPage(p);doc.setFont('helvetica','normal');doc.setFontSize(8);doc.setTextColor(100);doc.text(`${number||'RASCUNHO'} · Modelo v${meta.modelo?.versao||1}`,m,H-24);doc.text(`Página ${p} de ${pages}`,W-m,H-24,{align:'right'});doc.setTextColor(0);}
  return doc;
}

async function generateAndUploadPdf() {
  if(!current)return; try{
    // Salva primeiro para garantir que o PDF e o registro imutável usem
    // exatamente os mesmos dados, inclusive se o formulário foi alterado.
    const salvo=await api(`/${current.id}`,{method:'PUT',body:JSON.stringify({dados:collectData()})});
    const doc=buildPdf(salvo.dados,salvo.calculos,current.numero);const base64=doc.output('datauristring');
    const result=await api(`/${current.id}/pdf`,{method:'POST',body:JSON.stringify({base64})});
    toast(`PDF gerado e bloqueado por hash (${Math.round(result.tamanho/1024)} KB).`);await openContract(current.id);
  }catch(e){toast(e.message,'error');}
}
async function approveContract(){if(!current||!confirm('Aprovar esta versão? Após a aprovação, os dados e o PDF ficarão bloqueados.'))return;try{await api(`/${current.id}/approve`,{method:'POST',body:'{}'});toast('Contrato aprovado.');await openContract(current.id);}catch(e){toast(e.message,'error');}}
async function sendContract(){if(!current||!confirm(`Enviar ${current.numero} para assinatura pela ZapSign?`))return;try{const r=await api(`/${current.id}/send`,{method:'POST',body:'{}'});toast(r.simulated?'Envio registrado no simulador de homologação.':'Contrato enviado à ZapSign.');await openContract(current.id);}catch(e){toast(e.message,'error');}}
async function simulateComplete(){if(!current||!confirm('Simular a conclusão das duas assinaturas?'))return;try{await api(`/${current.id}/simulate-complete`,{method:'POST',body:'{}'});toast('Assinaturas simuladas e contrato concluído.');await openContract(current.id);}catch(e){toast(e.message,'error');}}
function downloadFile(id,type){location.href=`${API}/${encodeURIComponent(id)}/download/${type}`;}

init();
