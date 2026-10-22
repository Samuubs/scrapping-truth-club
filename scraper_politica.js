const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs').promises;
const { existsSync } = require('fs');

if (existsSync(".env")) process.loadEnvFile(".env");

const normalizar = (texto) => texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const SITES = {
    g1: {
        url: "https://g1.globo.com/politica/",
        card: ".feed-post-body",
        titulo: "a.feed-post-link",
        resumo: ".feed-post-body-resumo",
        tempo: ".feed-post-datetime",
    },
};

async function salvarNoSupabase(nomeSite, noticias) {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.log("ℹ️  SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não definidos: envio ao Supabase ignorado.");
        return;
    }
    if (noticias.length === 0) return;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
    });

    // O Postgres rejeita upsert com o mesmo link repetido no mesmo lote
    const porLink = new Map(noticias.filter((n) => n.link).map((n) => [n.link, { site: nomeSite, ...n }]));
    const linhas = [...porLink.values()];

    const { error } = await supabase.from("noticias").upsert(linhas, { onConflict: "link" });
    if (error) throw new Error(`Erro ao salvar no Supabase: ${error.message}`);

    console.log(`✅ ${linhas.length} notícias enviadas ao Supabase (novas inseridas, existentes atualizadas).`);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT_COMENTARIO =
    "Você é um comentarista político imparcial. Escreva um comentário curto (2 a 3 frases), em português do Brasil, " +
    "analisando a notícia. Não tome partido e não invente fatos além do que foi informado. Responda só com o comentário.";

async function gerarComentario(noticia) {
    const { AI_BASE_URL, AI_API_KEY, AI_MODEL } = process.env;
    const tentativas = 4;

    for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
        let resp;
        try {
            resp = await fetch(`${AI_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(AI_API_KEY && { Authorization: `Bearer ${AI_API_KEY}` }),
                },
                body: JSON.stringify({
                    model: AI_MODEL,
                    temperature: 0.7,
                    messages: [
                        { role: "system", content: PROMPT_COMENTARIO },
                        { role: "user", content: `Título: ${noticia.titulo}\nResumo: ${noticia.resumo || "(sem resumo)"}` },
                    ],
                }),
                signal: AbortSignal.timeout(60_000),
            });
        } catch (err) {
            if (tentativa === tentativas) throw err;
            await esperar(5_000 * tentativa);
            continue;
        }

        if (resp.ok) {
            const data = await resp.json();
            const comentario = data.choices?.[0]?.message?.content?.trim();
            if (!comentario) throw new Error("resposta da IA sem conteúdo");
            return comentario;
        }

        const corpo = await resp.text();
        // 429 = limite de requisições do plano gratuito; 5xx = instabilidade do provedor
        const temporario = resp.status === 429 || resp.status >= 500;
        if (!temporario || tentativa === tentativas) {
            throw new Error(`HTTP ${resp.status}: ${corpo.slice(0, 300)}`);
        }
        const retryAfter = Number(resp.headers.get("retry-after"));
        const espera = retryAfter > 0 ? retryAfter * 1000 : 10_000 * 2 ** (tentativa - 1);
        console.log(`⏳ IA retornou ${resp.status}; nova tentativa em ${Math.round(espera / 1000)}s...`);
        await esperar(espera);
    }
}

async function comentarNoticias(noticias) {
    const { AI_BASE_URL, AI_MODEL } = process.env;
    if (!AI_BASE_URL || !AI_MODEL) {
        console.log("ℹ️  AI_BASE_URL/AI_MODEL não definidos: geração de comentários ignorada.");
        return;
    }

    let gerados = 0;
    for (const [i, noticia] of noticias.entries()) {
        if (i > 0) await esperar(Number(process.env.AI_INTERVALO_MS ?? 1000));
        try {
            noticia.comentario = await gerarComentario(noticia);
            gerados++;
        } catch (err) {
            noticia.comentario = null;
            console.warn(`⚠️  Falha ao comentar "${noticia.titulo}": ${err.message}`);
        }
    }
    console.log(`🤖 ${gerados}/${noticias.length} comentários gerados com ${AI_MODEL}.`);
}

async function rasparNoticiasPolitica(nomeSite, site, assuntos) {
    const { url } = site;
    const termos = assuntos.split(",").map((t) => normalizar(t.trim())).filter(Boolean);

    // Inicializa o navegador
    const browser = await chromium.launch({ headless: true });

    // Cria um novo contexto de navegação (corrige o erro de 'browser.new_page is not a function')
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log(`Acessando ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Espera o contêiner principal das notícias carregar
    await page.waitForSelector(site.card);

    // Seleciona todos os cards de notícia do feed
    const posts = await page.$$(site.card);

    const noticias = [];

    for (const post of posts) {
        if (noticias.length >= 15) break;

        const tituloElement = await post.$(site.titulo);

        if (tituloElement) {
            const titulo = await tituloElement.innerText();
            const href = await tituloElement.getAttribute("href");
            const link = href ? new URL(href, url).href : "";

            const resumoElement = site.resumo ? await post.$(site.resumo) : null;
            const resumo = resumoElement ? await resumoElement.innerText() : "";

            const tempoElement = site.tempo ? await post.$(site.tempo) : null;
            const tempo = tempoElement ? await tempoElement.innerText() : "";

            const texto = normalizar(`${titulo} ${resumo}`);
            if (termos.length && !termos.some((t) => texto.includes(t))) continue;

            noticias.push({
                titulo: titulo.trim(),
                link: link,
                resumo: resumo.trim(),
                tempo_publicacao: tempo.trim()
            });
        }
    }

    await browser.close();

    await comentarNoticias(noticias);

    await fs.writeFile("noticias_politica.json", JSON.stringify(noticias, null, 4), "utf-8");
    console.log(`✅ Scraping concluído com sucesso! ${noticias.length} notícias salvas em 'noticias_politica.json'.`);

    await salvarNoSupabase(nomeSite, noticias);
}

const args = process.argv.slice(2);
const siteArg = args.find((a) => a.startsWith("--site="));
const nomeSite = siteArg ? siteArg.slice("--site=".length) : "g1";
const assuntos = args.filter((a) => a !== siteArg).join(" ");

if (!SITES[nomeSite]) {
    console.error(`Site desconhecido: "${nomeSite}". Disponíveis: ${Object.keys(SITES).join(", ")}`);
    process.exit(1);
}

rasparNoticiasPolitica(nomeSite, SITES[nomeSite], assuntos).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
});