-- Aplicado em 17/11/2026: Documentação de obra só para venda da própria iCasas (terreno + construção).
-- Leads de empreendimentos de outras construtoras (origem "Empreendimentos" ou outra campanha) não geram documentação.
create or replace function public.lead_vai_para_documentacao(p_formulario text, p_origin text)
returns boolean language sql immutable as $$
  select coalesce(lower(trim(p_origin)),'') <> 'empreendimentos'
     and (
       nullif(trim(coalesce(p_formulario,'')),'') is null                    -- sem campanha (manual, indicação, NexGen...)
       or upper(trim(p_formulario)) in ('TERRENO E CONSTRUÇÃO','CASA E CONSTRUÇÃO')
     )
$$;

create or replace function public.criar_obra_doc_ao_fechar()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if new.stage = 'won'
     and (tg_op = 'INSERT' or old.stage is distinct from 'won')
     and coalesce(new.empresa,'') = 'construtora'
     and public.lead_vai_para_documentacao(new.formulario, new.origin) then
    if not exists (select 1 from doc_obras where lead_id = new.id) then
      insert into doc_obras (nome, endereco, corretor_id, empresa, lead_id)
      values (nome_sem_anuncio(new.name), nullif(trim(coalesce(new.address,'')), ''),
              new.seller_id, 'construtora', new.id);
    end if;
  end if;
  return new;
end; $function$;
