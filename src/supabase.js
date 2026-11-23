const { createClient } = require("@supabase/supabase-js");

// Janela de notícias já publicadas usada para detectar o mesmo fato vindo de outro site
const HORAS_HISTORICO = Number(process.env.HORAS_HISTORICO || 48);

function clienteSupabase() {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.log("ℹ️  SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não definidos: sem consulta nem envio ao Supabase.");
        return null;
    }
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

async function buscarExistentes(supabase, links) {
    if (!supabase) return { links: new Set(), recentes: [] };
    const desde = new Date(Date.now() - HORAS_HISTORICO * 3_600_000).toISOString();
    const [porLink, recentes] = await Promise.all([
        links.length ? supabase.from("noticias").select("link").in("link", links) : { data: [] },
        supabase.from("noticias").select("site, titulo, resumo, link").gte("coletado_em", desde),
    ]);
    const erro = porLink.error || recentes.error;
    if (erro) throw new Error(`Erro ao consultar o Supabase: ${erro.message}`);
    return { links: new Set(porLink.data.map((n) => n.link)), recentes: recentes.data };
}

async function salvarNoSupabase(supabase, noticias) {
    if (!supabase || noticias.length === 0) return;

    // O Postgres rejeita upsert com o mesmo link repetido no mesmo lote
    const porLink = new Map(noticias.filter((n) => n.link).map((n) => [n.link, n]));
    const linhas = [...porLink.values()];

    // ignoreDuplicates: não sobrescreve notícias já salvas (ex.: duas execuções simultâneas)
    const { error } = await supabase.from("noticias").upsert(linhas, { onConflict: "link", ignoreDuplicates: true });
    if (error) throw new Error(`Erro ao salvar no Supabase: ${error.message}`);

    console.log(`✅ ${linhas.length} notícias novas enviadas ao Supabase.`);
}

module.exports = { clienteSupabase, buscarExistentes, salvarNoSupabase };
