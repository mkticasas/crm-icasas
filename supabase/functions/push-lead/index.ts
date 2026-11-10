// push-lead — envia notificação push do CRM iCasas
// Chamadas aceitas:
//  1) Trigger do banco (header x-push-token): { lead_id, novo } → avisa o corretor do lead (+ admins se lead novo)
//  2) App logado (Authorization: Bearer <jwt do usuário>): { teste: true } → envia um teste para os aparelhos do próprio usuário
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-push-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const BASE_URL = "https://mkticasas.github.io/crm-icasas/";

async function enviar(sellerIds: string[], payload: Record<string, unknown>) {
  if (!sellerIds.length) return { enviados: 0, falhas: 0 };
  const { data: subs } = await db.from("push_subscriptions").select("*").in("seller_id", sellerIds);
  let enviados = 0, falhas = 0;
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24, urgency: "high" },
      );
      enviados++;
    } catch (e) {
      falhas++;
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("id", s.id);
      console.error("push falhou", code, (e as Error).message);
    }
  }));
  return { enviados, falhas };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { data: cfg } = await db.from("push_config").select("*").eq("id", 1).single();
    if (!cfg) return json({ erro: "push não configurado" }, 500);
    webpush.setVapidDetails("mailto:mkt@icasasconstrutora.com.br", cfg.vapid_public, cfg.vapid_private);

    const body = await req.json().catch(() => ({}));

    // 1) Disparo pelo banco
    if (req.headers.get("x-push-token")) {
      if (req.headers.get("x-push-token") !== cfg.trigger_token) return json({ erro: "token inválido" }, 401);
      const { data: lead } = await db.from("leads").select("id,name,phone,origin,product,seller_id,empresa").eq("id", body.lead_id).single();
      if (!lead) return json({ erro: "lead não encontrado" }, 404);
      const detalhe = [lead.origin, lead.product].filter(Boolean).join(" · ");
      const base = { url: `${BASE_URL}?lead=${lead.id}`, leadId: lead.id, tag: `lead-${lead.id}` };

      const r1 = lead.seller_id
        ? await enviar([lead.seller_id], {
            ...base,
            title: "🏠 Lead novo para você",
            body: `${lead.name || "Sem nome"}${detalhe ? " — " + detalhe : ""}`,
          })
        : { enviados: 0, falhas: 0 };

      let r2 = { enviados: 0, falhas: 0 };
      if (body.novo) {
        const { data: admins } = await db.from("sellers").select("id,name,nickname").eq("role", "admin");
        const { data: dono } = lead.seller_id
          ? await db.from("sellers").select("name,nickname").eq("id", lead.seller_id).single()
          : { data: null };
        const ids = (admins || []).map((a) => a.id).filter((id) => id !== lead.seller_id);
        r2 = await enviar(ids, {
          ...base,
          title: "📥 Novo lead no CRM",
          body: `${lead.name || "Sem nome"} → ${dono ? (dono.nickname || dono.name) : "sem corretor"}${detalhe ? " · " + detalhe : ""}`,
        });
      }
      return json({ corretor: r1, admins: r2 });
    }

    // 2) Teste pelo app
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ erro: "não autenticado" }, 401);
    const { data: seller } = await db.from("sellers").select("id").eq("auth_user_id", u.user.id).single();
    if (!seller) return json({ erro: "usuário sem vendedor" }, 403);
    if (body.teste) {
      const r = await enviar([seller.id], {
        title: "CRM iCasas",
        body: "Notificações ativadas neste aparelho ✅",
        url: BASE_URL,
        tag: "teste",
      });
      return json(r);
    }
    return json({ erro: "nada a fazer" }, 400);
  } catch (e) {
    console.error(e);
    return json({ erro: (e as Error).message }, 500);
  }
});
