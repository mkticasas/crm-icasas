import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

function getNestedValue(obj: any, path: string): string {
  if (!path) return ''
  try {
    return path.split('.').reduce((acc, key) => {
      const arrMatch = key.match(/^(\w+)\[(\d+)\]$/)
      if (arrMatch) return acc?.[arrMatch[1]]?.[parseInt(arrMatch[2])]
      return acc?.[key]
    }, obj) ?? ''
  } catch { return '' }
}

// Registra falha/aviso na aba Logs (e dispara aviso no celular dos admins pelo gatilho do banco)
async function registrar(status: 'erro' | 'aviso', motivo: string, extra: Record<string, unknown> = {}) {
  try {
    await supabase.from('webhook_logs').insert([{ status, motivo, ...extra }])
  } catch (e) { console.error('falha ao registrar log', e) }
}

Deno.serve(async (req) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  try {

  const url = new URL(req.url)
  const token = url.searchParams.get('token')
  if (!token) {
    await registrar('erro', 'Envio sem token na URL — confira a URL do webhook no Zapier')
    return new Response(JSON.stringify({ error: 'Token ausente' }), { status: 400, headers })
  }

  // Parse body com segurança
  let body: any = {}
  let texto = ''
  try {
    texto = await req.text()
    if (texto && texto.trim()) body = JSON.parse(texto)
  } catch {
    await registrar('erro', 'Dados chegaram em formato inválido (não é JSON) — no Zapier, use Payload Type = Json', { webhook_token: token, payload: { bruto: texto.slice(0, 2000) } })
    return new Response(JSON.stringify({ error: 'Payload JSON inválido' }), { status: 400, headers })
  }

  const { data: wh } = await supabase.from('webhooks').select('*').eq('token', token).maybeSingle()
  if (!wh) {
    await registrar('erro', 'URL de webhook que não existe (excluído ou token errado) — lead NÃO entrou', { webhook_token: token, payload: body })
    return new Response(JSON.stringify({ error: 'Webhook não encontrado ou inativo' }), { status: 404, headers })
  }
  const ctx = { webhook_id: wh.id, webhook_token: token, webhook_nome: wh.name }
  if (!wh.active) {
    await registrar('erro', 'Webhook DESATIVADO recebeu um lead — lead NÃO entrou. Reative o webhook ou desligue o Zap', { ...ctx, payload: body })
    return new Response(JSON.stringify({ error: 'Webhook não encontrado ou inativo' }), { status: 404, headers })
  }

  const map = wh.field_map || {}
  const nameRaw  = String(getNestedValue(body, map.name || 'name') || getNestedValue(body, 'full_name') || '').trim()
  const phone    = getNestedValue(body, map.phone    || 'phone') || getNestedValue(body, 'phone_number') || ''
  const email    = getNestedValue(body, map.email    || 'email') || ''
  const notes    = map.notes    ? getNestedValue(body, map.notes)    : ''
  const campaign = map.campaign ? getNestedValue(body, map.campaign) : ''

  if (!nameRaw) {
    await registrar('erro', 'Lead sem nome — no Zapier, confira o campo "name" do passo do webhook. Lead NÃO entrou', { ...ctx, payload: body })
    return new Response(JSON.stringify({ error: 'Nome não encontrado no payload. Verifique o mapeamento.' }), { status: 400, headers })
  }

  // Campanha = campo "formulario"/"form" do Zapier, senão o nome do webhook.
  // Texto depois de "|" no nome NÃO é campanha (muita gente usa "Nome | Profissão" no Facebook):
  // o nome fica limpo e o complemento vai para as respostas.
  let name = nameRaw
  let complementoNome = ''
  const mPipe = nameRaw.match(/^([^|]*?)\s*\|\s*(.*)$/)
  if (mPipe && mPipe[1].trim()) { name = mPipe[1].trim(); complementoNome = mPipe[2].replace(/\s*\|\s*/g, ' · ').trim() }
  const formulario = String(body.formulario || body.form || body.form_name || '').trim() || wh.name || null

  // Respostas do formulário: todo campo extra que o Zapier mandar vira pergunta → resposta (na ordem enviada)
  const usados = new Set(['name', 'full_name', 'phone', 'phone_number', 'email', 'notes', 'campaign',
    'formulario', 'form', 'form_name', map.name, map.phone, map.email, map.notes, map.campaign].filter(Boolean))
  const respostas = Object.entries(body)
    .filter(([k, v]) => !usados.has(k) && v !== null && v !== undefined && String(v).trim() !== '' && typeof v !== 'object')
    .map(([k, v]) => ({ p: k.replace(/_/g, ' ').trim(), r: String(v).trim() }))
  if (complementoNome) respostas.unshift({ p: 'Complemento do nome no Facebook', r: complementoNome })

  // empresa do lead = empresa do webhook que o recebeu
  // (webhook sem empresa cadastrada cai em 'automacao', pra não quebrar os antigos)
  const empresaLead = wh.empresa || 'automacao'

  // round-robin geral: só entre vendedores ativos DA MESMA EMPRESA do webhook,
  // excluindo quem não vende de verdade (cargo Engenharia/Financeiro, ou
  // marcado manualmente como oculto_filtro_vendedor — ex.: quem só usa a Documentação)
  async function rodizioGeral() {
    const { data: sellers } = await supabase
      .from('sellers').select('id, last_lead_at')
      .eq('status', 'active')
      .eq('empresa', empresaLead)
      .not('role', 'in', '(Engenharia,Financeiro)')
      .not('oculto_filtro_vendedor', 'is', true)
      .order('last_lead_at', { ascending: true, nullsFirst: true })
      .limit(1)
    return sellers?.length ? sellers[0].id : null
  }

  let seller_id = null
  let distribuicao = wh.distribution
  if (wh.distribution === 'fixed' && wh.fixed_seller_id) {
    seller_id = wh.fixed_seller_id
  } else if (wh.distribution === 'group' && Array.isArray(wh.group_seller_ids) && wh.group_seller_ids.length) {
    // rodízio só entre os vendedores escolhidos no webhook (quem está ativo);
    // quem recebeu lead há mais tempo é o próximo
    const { data: grupo } = await supabase
      .from('sellers').select('id, last_lead_at')
      .in('id', wh.group_seller_ids)
      .eq('status', 'active')
      .order('last_lead_at', { ascending: true, nullsFirst: true })
      .limit(1)
    if (grupo?.length) seller_id = grupo[0].id
    else { seller_id = await rodizioGeral(); distribuicao = 'group->roundrobin (ninguém do grupo ativo)' }
  } else {
    seller_id = await rodizioGeral()
  }

  const notesFinal = [notes, campaign ? `Campanha: ${campaign}` : ''].filter(Boolean).join(' | ')

  const { data: lead, error: leadErr } = await supabase
    .from('leads').insert([{
      name, phone, email,
      notes: notesFinal || null,
      origin: wh.origin,
      seller_id,
      stage: 'new',
      temperature: 'hot',
      webhook_token: token,
      empresa: empresaLead,
      formulario,
      respostas
    }]).select().single()

  if (leadErr) {
    await registrar('erro', 'Erro ao salvar o lead no CRM: ' + leadErr.message, { ...ctx, payload: body })
    return new Response(JSON.stringify({ error: leadErr.message }), { status: 500, headers })
  }
  if (!String(phone || '').replace(/\D/g, '')) {
    await registrar('aviso', 'Lead entrou SEM TELEFONE — no Zapier, confira o campo "phone"', { ...ctx, lead_id: lead.id, payload: body })
  }

  await supabase.from('webhooks').update({ leads_count: (wh.leads_count || 0) + 1 }).eq('id', wh.id)
  if (seller_id) await supabase.from('sellers').update({ last_lead_at: new Date().toISOString() }).eq('id', seller_id)

  return new Response(JSON.stringify({ success: true, lead_id: lead.id, empresa: empresaLead, seller_id, distribuicao, formulario, respostas: respostas.length }), { status: 200, headers })
  } catch (e) {
    console.error(e)
    await registrar('erro', 'Erro inesperado no CRM: ' + ((e as Error)?.message || String(e)))
    return new Response(JSON.stringify({ error: 'Erro interno' }), { status: 500, headers })
  }
})
