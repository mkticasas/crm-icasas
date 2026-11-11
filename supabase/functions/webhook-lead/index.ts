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

Deno.serve(async (req) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers })

  const url = new URL(req.url)
  const token = url.searchParams.get('token')
  if (!token) return new Response(JSON.stringify({ error: 'Token ausente' }), { status: 400, headers })

  // Parse body com segurança
  let body: any = {}
  try {
    const text = await req.text()
    if (text && text.trim()) body = JSON.parse(text)
  } catch {
    return new Response(JSON.stringify({ error: 'Payload JSON inválido' }), { status: 400, headers })
  }

  const { data: wh, error: whErr } = await supabase
    .from('webhooks').select('*').eq('token', token).eq('active', true).single()
  if (whErr || !wh) return new Response(JSON.stringify({ error: 'Webhook não encontrado ou inativo' }), { status: 404, headers })

  const map = wh.field_map || {}
  const nameRaw  = String(getNestedValue(body, map.name || 'name') || getNestedValue(body, 'full_name') || '').trim()
  const phone    = getNestedValue(body, map.phone    || 'phone') || getNestedValue(body, 'phone_number') || ''
  const email    = getNestedValue(body, map.email    || 'email') || ''
  const notes    = map.notes    ? getNestedValue(body, map.notes)    : ''
  const campaign = map.campaign ? getNestedValue(body, map.campaign) : ''

  if (!nameRaw) return new Response(JSON.stringify({ error: 'Nome não encontrado no payload. Verifique o mapeamento.' }), { status: 400, headers })

  // Formulário: campo "formulario"/"form" do Zapier > texto depois da "|" no nome (formato antigo) > nome do webhook
  let name = nameRaw
  let formDoNome = ''
  const mPipe = nameRaw.match(/^(.*?)\s*\|\s*([^|]*)$/)
  if (mPipe) { name = mPipe[1].trim() || nameRaw; formDoNome = mPipe[2].trim() }
  const formulario = String(body.formulario || body.form || body.form_name || '').trim() || formDoNome || wh.name || null
  // Nome fica limpo (só o nome do lead); o formulário/webhook aparece no CRM como selo separado

  // Respostas do formulário: todo campo extra que o Zapier mandar vira pergunta → resposta (na ordem enviada)
  const usados = new Set(['name', 'full_name', 'phone', 'phone_number', 'email', 'notes', 'campaign',
    'formulario', 'form', 'form_name', map.name, map.phone, map.email, map.notes, map.campaign].filter(Boolean))
  const respostas = Object.entries(body)
    .filter(([k, v]) => !usados.has(k) && v !== null && v !== undefined && String(v).trim() !== '' && typeof v !== 'object')
    .map(([k, v]) => ({ p: k.replace(/_/g, ' ').trim(), r: String(v).trim() }))

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

  if (leadErr) return new Response(JSON.stringify({ error: leadErr.message }), { status: 500, headers })

  await supabase.from('webhooks').update({ leads_count: (wh.leads_count || 0) + 1 }).eq('id', wh.id)
  if (seller_id) await supabase.from('sellers').update({ last_lead_at: new Date().toISOString() }).eq('id', seller_id)

  return new Response(JSON.stringify({ success: true, lead_id: lead.id, empresa: empresaLead, seller_id, distribuicao, formulario, respostas: respostas.length }), { status: 200, headers })
})
