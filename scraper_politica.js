const fs = require("fs").promises;
const { existsSync } = require("fs");

// Antes dos requires: os módulos leem process.env ao serem carregados
if (existsSync(".env")) process.loadEnvFile(".env");

const { chromium } = require("playwright");
const { SITES } = require("./src/sites");
const { normalizar, lista } = require("./src/util");
const { montarAgentes } = require("./src/ia");
const { rasparSite } = require("./src/scraping");
const { combinarSites } = require("./src/duplicadas");
const { completarDaPagina } = require("./src/paginas");
const { comentarNoticias } = require("./src/comentarios");
const { clienteSupabase, buscarExistentes, salvarNoSupabase } = require("./src/supabase");

async function rasparNoticiasPolitica(nomesSites, assuntos) {
    const termos = assuntos.split(",").map((t) => normalizar(t.trim())).filter(Boolean);

    const agentes = montarAgentes();
    if (!agentes.length) {
        throw new Error("Nenhum provedor de IA configurado. Os comentários são obrigatórios: configure ao menos um provedor.");
    }
    console.log(`🤖 Cadeia de IA: ${agentes.map((a) => a.nome).join(" → ")}`);

    const browser = await chromium.launch({ headless: true });
    let resultados;
    try {
        const context = await browser.newContext();
        resultados = await Promise.allSettled(
            nomesSites.map((nome) => rasparSite(context, nome, SITES[nome], termos))
        );
    } finally {
        await browser.close();
    }

    const listas = [];
    const falhas = [];
    resultados.forEach((r, i) => {
        if (r.status === "fulfilled") listas.push(r.value);
        else {
            falhas.push(nomesSites[i]);
            console.error(`❌ [${nomesSites[i]}] Falha no scraping: ${r.reason?.message?.split("\n")[0]}`);
        }
    });

    const supabase = clienteSupabase();
    const existentes = await buscarExistentes(supabase, listas.flat().map((n) => n.link));
    const listasNovas = listas.map((l) => l.filter((n) => !existentes.links.has(n.link)));
    const ignoradas = listas.flat().length - listasNovas.flat().length;
    if (ignoradas) console.log(`⏭️  ${ignoradas} notícias já estavam no banco e foram ignoradas.`);

    const noticias = await combinarSites(listasNovas, agentes, existentes.recentes);

    if (!noticias.length) {
        console.log("ℹ️  Nenhuma notícia nova nesta execução.");
    } else {
        await completarDaPagina(noticias);

        const comentadas = await comentarNoticias(noticias, agentes);

        await fs.writeFile("noticias_politica.json", JSON.stringify(comentadas, null, 4), "utf-8");
        console.log(`✅ Scraping concluído! ${comentadas.length} notícias de ${nomesSites.length - falhas.length}/${nomesSites.length} sites salvas em 'noticias_politica.json'.`);

        await salvarNoSupabase(supabase, comentadas);
    }

    if (falhas.length) throw new Error(`Os seguintes sites falharam: ${falhas.join(", ")}`);
}

const args = process.argv.slice(2);
const siteArg = args.find((a) => a.startsWith("--site="));
const nomesSites = siteArg ? lista(siteArg.slice("--site=".length).toLowerCase()) : Object.keys(SITES);
const assuntos = args.filter((a) => a !== siteArg).join(" ");

const desconhecidos = nomesSites.filter((nome) => !SITES[nome]);
if (!nomesSites.length || desconhecidos.length) {
    console.error(`Site desconhecido: "${desconhecidos.join(", ")}". Disponíveis: ${Object.keys(SITES).join(", ")}`);
    process.exit(1);
}

rasparNoticiasPolitica([...new Set(nomesSites)], assuntos).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
});
