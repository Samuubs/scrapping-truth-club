-- Execute no SQL Editor do painel do Supabase.

create table if not exists public.noticias (
    id bigint generated always as identity primary key,
    site text not null,
    titulo text not null,
    link text not null unique,
    resumo text,
    tempo_publicacao text,
    coletado_em timestamptz not null default now()
);

-- Comentário gerado por IA (também cria a coluna em tabelas já existentes)
alter table public.noticias add column if not exists comentario text;

-- O comentário é obrigatório. ATENÇÃO: apaga, sem volta, as notícias antigas sem comentário.
delete from public.noticias where comentario is null or btrim(comentario) = '';
alter table public.noticias alter column comentario set not null;
alter table public.noticias drop constraint if exists noticias_comentario_preenchido;
alter table public.noticias add constraint noticias_comentario_preenchido check (btrim(comentario) <> '');

create index if not exists noticias_coletado_em_idx on public.noticias (coletado_em desc);

-- Busca por assunto em português (título + resumo), sem acentos e maiúsculas
create index if not exists noticias_busca_idx on public.noticias
    using gin (to_tsvector('portuguese', titulo || ' ' || coalesce(resumo, '')));

-- O app (chave anon) só pode ler; o scraper grava com a chave service_role, que ignora RLS
alter table public.noticias enable row level security;

drop policy if exists "leitura publica" on public.noticias;
create policy "leitura publica" on public.noticias
    for select to anon, authenticated using (true);
