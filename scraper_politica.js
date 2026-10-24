const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs').promises;
const { existsSync } = require('fs');

if (existsSync(".env")) process.loadEnvFile(".env");

const normalizar = (texto) => texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const LIMITE_POR_SITE = 15;
const LIMITE_TOTAL = 30;
// Semelhança de palavras entre títulos (0 a 1). A partir de CERTA, é repetida sem consultar a IA;
// entre DUVIDOSA e CERTA, a IA decide; abaixo de DUVIDOSA, é outra notícia.
const SIMILARIDADE_CERTA = 0.75;
const SIMILARIDADE_DUVIDOSA = 0.3;
// Usada no lugar da IA quando ela não está configurada ou falha
const SIMILARIDADE_MINIMA = 0.5;
const MAX_CANDIDATAS_IA = 5;
// Tempo total que a IA pode gastar comparando notícias em cada execução; depois disso, só semelhança de palavras
const COMPARACAO_MAX_MS = Number(process.env.AI_COMPARACAO_MAX_MS || 5 * 60_000);
const MAX_FALHAS_SEGUIDAS = 3;

const PALAVRAS_IGNORADAS = new Set(
    ("a o e de da do das dos em no na nos nas um uma uns umas por para com sem sob sobre que se ao aos à às " +
        "como mais menos ser ter diz dizem apos ate entre contra pelo pela pelos pelas seu sua seus suas veja")
        .split(" ")
        .map((p) => normalizar(p))
);

// Radical de 5 letras para "sigilo"/"sigilos" e "deputado"/"deputados" contarem como a mesma palavra
const radicais = (titulo) =>
    new Set(
        normalizar(titulo)
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((p) => p.length > 1 && !PALAVRAS_IGNORADAS.has(p))
            .map((p) => p.slice(0, 5))
    );

// Coeficiente de Dice: 2 × palavras em comum / total de palavras dos dois títulos
function similaridade(a, b) {
    if (!a.size || !b.size) return 0;
    let comuns = 0;
    for (const p of a) if (b.has(p)) comuns++;
    return (2 * comuns) / (a.size + b.size);
}

// Intercala os sites (1ª de cada, 2ª de cada...) para o limite total não favorecer nenhum deles
async function combinarSites(listas, agentes) {
    const escolhidas = [];
    const estatisticas = { consultas: 0, repetidasIA: 0, prazo: Date.now() + COMPARACAO_MAX_MS, prazoEsgotado: false };
    const maior = Math.max(0, ...listas.map((l) => l.length));
    for (let i = 0; i < maior && escolhidas.length < LIMITE_TOTAL; i++) {
        for (const lista of listas) {
            if (escolhidas.length >= LIMITE_TOTAL) break;
            const noticia = lista[i];
            if (!noticia) continue;

            const chave = radicais(noticia.titulo);
            const candidatas = escolhidas
                .filter((e) => e.noticia.site !== noticia.site)
                .map((e) => ({ e, s: similaridade(e.chave, chave) }))
                .filter((c) => c.s >= SIMILARIDADE_DUVIDOSA)
                .sort((a, b) => b.s - a.s);

            let igual;
            let motivo;
            if (candidatas[0]?.s >= SIMILARIDADE_CERTA) {
                igual = candidatas[0].e;
                motivo = `semelhança ${candidatas[0].s.toFixed(2)}`;
            } else if (candidatas.length) {
                ({ igual, motivo } = await verificarRepetida(noticia, candidatas.slice(0, MAX_CANDIDATAS_IA), agentes, estatisticas));
            }

            if (igual) {
                console.log(`🔁 [${noticia.site}] "${noticia.titulo}" descartada (${motivo}): igual a [${igual.noticia.site}] "${igual.noticia.titulo}"`);
                continue;
            }
            escolhidas.push({ noticia, chave });
        }
    }
    if (estatisticas.consultas) {
        console.log(`🤖 ${estatisticas.consultas} comparações feitas pela IA, ${estatisticas.repetidasIA} repetidas encontradas.`);
    }
    return escolhidas.map((e) => e.noticia);
}

const PROMPT_REPETIDA =
    "Você compara manchetes de sites de notícias diferentes. Diga se a manchete NOVA relata o mesmo fato que alguma " +
    "manchete da LISTA. Tratar do mesmo tema ou citar as mesmas pessoas não basta: precisa ser o mesmo acontecimento. " +
    "Responda só com o número da manchete da lista que relata o mesmo fato, ou 0 se nenhuma relatar.";

async function verificarRepetida(noticia, candidatas, agentes, estatisticas) {
    const porPalavras = () => {
        const c = candidatas.find((c) => c.s >= SIMILARIDADE_MINIMA);
        return { igual: c?.e, motivo: c && `semelhança ${c.s.toFixed(2)}` };
    };
    if (estatisticas.prazoEsgotado) return porPalavras();

    const descrever = (n) => `${n.titulo}${n.resumo ? ` — ${n.resumo.slice(0, 200)}` : ""}`;
    const mensagens = [
        { role: "system", content: PROMPT_REPETIDA },
        {
            role: "user",
            content: `NOVA: ${descrever(noticia)}\n\nLISTA:\n${candidatas.map((c, i) => `${i + 1}. ${descrever(c.e.noticia)}`).join("\n")}`,
        },
    ];

    try {
        await esperar(Number(process.env.AI_INTERVALO_MS ?? 1000));
        estatisticas.consultas++;
        const { valor } = await consultarIA(mensagens, agentes, {
            temperatura: 0,
            prazo: estatisticas.prazo,
            interpretar: (texto) => {
                const numero = Number(texto.match(/\d+/)?.[0]);
                if (!Number.isInteger(numero) || numero < 0 || numero > candidatas.length) {
                    throw new ErroAgente(`resposta inesperada: "${texto.slice(0, 60)}"`);
                }
                return numero;
            },
        });
        if (!valor) return {};
        estatisticas.repetidasIA++;
        return { igual: candidatas[valor - 1].e, motivo: "IA" };
    } catch (err) {
        if (err instanceof ErroPrazo) {
            estatisticas.prazoEsgotado = true;
            console.warn(`⏱️  Tempo máximo da comparação por IA (${Math.round(COMPARACAO_MAX_MS / 1000)}s) esgotado; as próximas comparações usam só a semelhança de palavras.`);
        } else {
            console.warn(`⚠️  IA não conseguiu comparar "${noticia.titulo}" (${err.message}); usando só a semelhança de palavras.`);
        }
        return porPalavras();
    }
}

// card: cada notícia; titulo: elemento com o título (padrão: o próprio card).
// O link vem do seletor "link" ou, se omitido, do <a> que envolve o título ou do primeiro <a> do card.
const SITES = {
    g1: {
        url: "https://g1.globo.com/politica/",
        card: ".feed-post-body",
        titulo: "a.feed-post-link",
        resumo: ".feed-post-body-resumo",
        tempo: ".feed-post-datetime",
    },
    r7: {
        url: "https://noticias.r7.com/brasilia/",
        card: "article.b-ultimas__item",
        titulo: ".b-ultimas__item-content > a[title]",
        tempo: ".b-ultimas__item-author span",
        // O R7 exibe "Seção / HÁ 35 MINUTOS"
        formatarTempo: (t) => {
            const tempo = t.split("/").pop().trim().toLowerCase();
            return tempo.charAt(0).toUpperCase() + tempo.slice(1);
        },
    },
    band: {
        url: "https://www.band.com.br/politica",
        card: "a[href^='/politica/']:has(h2, h3, h4, p)",
        titulo: "h2, h3, h4, p",
    },
};

async function salvarNoSupabase(noticias) {
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
    const porLink = new Map(noticias.filter((n) => n.link).map((n) => [n.link, n]));
    const linhas = [...porLink.values()];

    const { error } = await supabase.from("noticias").upsert(linhas, { onConflict: "link" });
    if (error) throw new Error(`Erro ao salvar no Supabase: ${error.message}`);

    console.log(`✅ ${linhas.length} notícias enviadas ao Supabase (novas inseridas, existentes atualizadas).`);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT_COMENTARIO =
    "Você é um comentarista político imparcial. Escreva um comentário curto (2 a 3 frases), em português do Brasil, " +
    "analisando a notícia. Não tome partido e não invente fatos além do que foi informado. Responda só com o comentário.";

// Provedores compatíveis com a API da OpenAI. Cada modelo da lista vira um agente na cadeia de fallback.
const PROVEDORES = {
    personalizado: { urlEnv: "AI_BASE_URL", chaveEnv: "AI_API_KEY", chaveOpcional: true, modelosEnv: "AI_MODEL" },
    gemini: {
        url: "https://generativelanguage.googleapis.com/v1beta/openai",
        chaveEnv: "GEMINI_API_KEY",
        modelosEnv: "GEMINI_MODELS",
        modelos: "gemini-2.5-flash,gemini-2.5-flash-lite",
    },
    groq: {
        url: "https://api.groq.com/openai/v1",
        chaveEnv: "GROQ_API_KEY",
        modelosEnv: "GROQ_MODELS",
        modelos: "llama-3.3-70b-versatile,llama-3.1-8b-instant",
    },
    github: {
        url: "https://models.github.ai/inference",
        chaveEnv: "GH_MODELS_TOKEN",
        modelosEnv: "GH_MODELS",
        modelos: "openai/gpt-4.1-mini",
    },
    openrouter: {
        url: "https://openrouter.ai/api/v1",
        chaveEnv: "OPENROUTER_API_KEY",
        modelosEnv: "OPENROUTER_MODELS",
        modelos: "meta-llama/llama-3.3-70b-instruct:free",
    },
    ollama: { url: "http://localhost:11434/v1", urlEnv: "OLLAMA_BASE_URL", modelosEnv: "OLLAMA_MODELS", modelos: "llama3.2" },
};

// Ollama não tem chave para indicar que está configurado, então só entra se listado em AI_PROVEDORES
const ORDEM_PADRAO = ["personalizado", "gemini", "groq", "github", "openrouter"];

const lista = (texto) => (texto || "").split(",").map((s) => s.trim()).filter(Boolean);

function montarAgentes() {
    const env = process.env;
    const explicito = Boolean(env.AI_PROVEDORES);
    const nomes = explicito ? lista(env.AI_PROVEDORES.toLowerCase()) : ORDEM_PADRAO;
    const agentes = [];

    for (const nome of nomes) {
        const p = PROVEDORES[nome];
        if (!p) {
            console.warn(`⚠️  Provedor de IA desconhecido: "${nome}". Disponíveis: ${Object.keys(PROVEDORES).join(", ")}`);
            continue;
        }
        const baseUrl = (p.urlEnv && env[p.urlEnv]) || p.url;
        const chave = p.chaveEnv ? env[p.chaveEnv] : undefined;
        const modelos = lista((p.modelosEnv && env[p.modelosEnv]) || p.modelos);

        if (!baseUrl || !modelos.length || (p.chaveEnv && !p.chaveOpcional && !chave)) {
            if (explicito) console.warn(`⚠️  Provedor "${nome}" listado em AI_PROVEDORES, mas sem configuração: ignorado.`);
            continue;
        }
        for (const modelo of modelos) {
            agentes.push({
                nome: `${nome}/${modelo}`,
                baseUrl: baseUrl.replace(/\/+$/, ""),
                chave,
                modelo,
                pausadoAte: 0,
                falhasSeguidas: 0,
                desativado: false,
                gerados: 0,
            });
        }
    }
    return agentes;
}

class ErroAgente extends Error {
    constructor(mensagem, { pausaMs = 0, desativar = false } = {}) {
        super(mensagem);
        this.pausaMs = pausaMs;
        this.desativar = desativar;
    }
}

class ErroPrazo extends Error {
    constructor() {
        super("tempo máximo esgotado");
    }
}

function tempoDeEspera(resp, corpo) {
    const retryAfter = resp.headers.get("retry-after");
    if (retryAfter) {
        const segundos = Number(retryAfter);
        if (segundos > 0) return segundos * 1000;
        const data = Date.parse(retryAfter);
        if (data) return Math.max(data - Date.now(), 1000);
    }
    // O Gemini informa a espera no corpo: "retryDelay": "37s"
    const retryDelay = corpo.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    if (retryDelay) return Math.ceil(Number(retryDelay[1]) * 1000);
    return 60_000;
}

async function chamarAgente(agente, mensagens, temperatura, timeoutMs) {
    let resp;
    try {
        resp = await fetch(`${agente.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(agente.chave && { Authorization: `Bearer ${agente.chave}` }),
            },
            body: JSON.stringify({
                model: agente.modelo,
                temperature: temperatura,
                messages: mensagens,
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        throw new ErroAgente(`falha de conexão (${err.cause?.code || err.name})`, { pausaMs: 30_000 });
    }

    const corpo = await resp.text();
    if (resp.ok) {
        let texto;
        try {
            texto = JSON.parse(corpo).choices?.[0]?.message?.content?.trim();
        } catch {
            throw new ErroAgente("resposta inválida (não é JSON)");
        }
        if (!texto) throw new ErroAgente("resposta sem conteúdo");
        return texto;
    }

    const mensagem = `HTTP ${resp.status}: ${corpo.replace(/\s+/g, " ").slice(0, 200)}`;
    // 429: limite de requisições/tokens do plano gratuito
    if (resp.status === 429) throw new ErroAgente(mensagem, { pausaMs: tempoDeEspera(resp, corpo) });
    // 401/403: chave inválida; 402: sem créditos; 404: modelo inexistente
    if ([401, 402, 403, 404].includes(resp.status)) throw new ErroAgente(mensagem, { desativar: true });
    if (resp.status >= 500) throw new ErroAgente(mensagem, { pausaMs: 30_000 });
    // 400/413 etc.: problema com esta requisição (ex.: texto grande demais para o modelo)
    throw new ErroAgente(mensagem);
}

// Tenta cada agente disponível uma vez, sem esperar pausas; se nenhum responder, desiste na hora.
// "interpretar" pode lançar ErroAgente para recusar a resposta. "prazo" (timestamp) limita o tempo total.
async function consultarIA(mensagens, agentes, { temperatura = 0.7, interpretar = (t) => t, prazo } = {}) {
    for (const agente of agentes) {
        if (agente.desativado || agente.pausadoAte > Date.now()) continue;
        if (prazo && Date.now() >= prazo) throw new ErroPrazo();
        const timeoutMs = Math.min(60_000, prazo ? prazo - Date.now() : Infinity);
        try {
            const valor = interpretar(await chamarAgente(agente, mensagens, temperatura, timeoutMs));
            agente.falhasSeguidas = 0;
            return { valor, agente };
        } catch (err) {
            // A requisição foi cortada pelo prazo, não por culpa do agente
            if (prazo && Date.now() >= prazo) throw new ErroPrazo();

            let situacao = "pulando para o próximo agente";
            if (err.desativar) {
                agente.desativado = true;
                situacao = "agente desativado nesta execução";
            } else if (++agente.falhasSeguidas >= MAX_FALHAS_SEGUIDAS) {
                agente.desativado = true;
                situacao = `${MAX_FALHAS_SEGUIDAS} falhas seguidas, agente desativado nesta execução`;
            } else if (err.pausaMs) {
                agente.pausadoAte = Date.now() + err.pausaMs;
                situacao = `agente em pausa por ${Math.round(err.pausaMs / 1000)}s`;
            }
            console.warn(`⚠️  ${agente.nome} falhou (${err.message}); ${situacao}.`);
        }
    }
    throw new Error("nenhum agente de IA disponível conseguiu responder");
}

async function comentarNoticias(noticias, agentes) {
    for (const [i, noticia] of noticias.entries()) {
        if (i > 0) await esperar(Number(process.env.AI_INTERVALO_MS ?? 1000));
        try {
            const { valor, agente } = await consultarIA(
                [
                    { role: "system", content: PROMPT_COMENTARIO },
                    { role: "user", content: `Título: ${noticia.titulo}\nResumo: ${noticia.resumo || "(sem resumo)"}` },
                ],
                agentes
            );
            noticia.comentario = valor;
            agente.gerados++;
        } catch (err) {
            throw new Error(`Não foi possível gerar o comentário de "${noticia.titulo}" (${err.message}). Nada foi salvo.`);
        }
    }
    const usados = agentes.filter((a) => a.gerados).map((a) => `${a.nome}: ${a.gerados}`).join(", ");
    console.log(`🤖 ${noticias.length} comentários gerados${usados ? ` (${usados})` : ""}.`);
}

async function rasparSite(context, nomeSite, site, termos) {
    const page = await context.newPage();
    try {
        console.log(`[${nomeSite}] Acessando ${site.url}...`);
        await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForSelector(site.card, { timeout: 30_000 });

        const brutos = await page.$$eval(
            site.card,
            (cards, s) => {
                const limpar = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : "");
                return cards.map((card) => {
                    const tituloEl = s.titulo ? card.querySelector(s.titulo) : card;
                    const linkEl = s.link
                        ? card.querySelector(s.link)
                        : tituloEl?.closest("a") || (card.matches("a") ? card : card.querySelector("a"));
                    return {
                        titulo: limpar(tituloEl),
                        href: linkEl?.getAttribute("href") || "",
                        resumo: s.resumo ? limpar(card.querySelector(s.resumo)) : "",
                        tempo: s.tempo ? limpar(card.querySelector(s.tempo)) : "",
                    };
                });
            },
            { titulo: site.titulo, link: site.link, resumo: site.resumo, tempo: site.tempo }
        );

        const noticias = [];
        const vistos = new Set();
        for (const { titulo, href, resumo, tempo } of brutos) {
            if (noticias.length >= LIMITE_POR_SITE) break;
            if (!titulo || !href) continue;

            const link = new URL(href, site.url).href;
            if (vistos.has(link)) continue;
            vistos.add(link);

            const texto = normalizar(`${titulo} ${resumo}`);
            if (termos.length && !termos.some((t) => texto.includes(t))) continue;

            noticias.push({
                site: nomeSite,
                titulo,
                link,
                resumo,
                tempo_publicacao: site.formatarTempo && tempo ? site.formatarTempo(tempo) : tempo,
            });
        }
        console.log(`[${nomeSite}] ${noticias.length} notícias encontradas.`);
        return noticias;
    } finally {
        await page.close();
    }
}

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

    const noticias = await combinarSites(listas, agentes);

    await comentarNoticias(noticias, agentes);

    await fs.writeFile("noticias_politica.json", JSON.stringify(noticias, null, 4), "utf-8");
    console.log(`✅ Scraping concluído! ${noticias.length} notícias de ${nomesSites.length - falhas.length}/${nomesSites.length} sites salvas em 'noticias_politica.json'.`);

    await salvarNoSupabase(noticias);

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