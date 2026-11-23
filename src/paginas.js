const { chromium } = require("playwright");
const { normalizar } = require("./util");

// Ex.: "04/11/2026 14:30", no horário de Brasília
const formatarHora = (data) =>
    new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: "America/Sao_Paulo",
    })
        .format(data)
        .replace(", ", " ");

const UNIDADES_MS = { minuto: 60_000, hora: 3_600_000, dia: 86_400_000 };

// Converte textos como "Há 45 minutos" ou "Seção / HÁ 2 HORAS" em data aproximada
function dataRelativa(texto) {
    const m = normalizar(texto || "").match(/ha\s+(\d+)\s+(minuto|hora|dia)/);
    return m ? new Date(Date.now() - Number(m[1]) * UNIDADES_MS[m[2]]) : null;
}

const metaConteudo = (html, nomes) =>
    html
        .match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["'](?:${nomes})["'][^>]*>`, "i"))?.[0]
        ?.match(/content=["']([^"']+)["']/i)?.[1];

// Data de publicação e og:image/twitter:image da página da notícia
function lerPagina(html, link) {
    const publicado =
        metaConteudo(html, "article:published_time|datePublished") ||
        html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1];
    const data = publicado ? new Date(publicado) : null;
    const imagem = metaConteudo(html, "og:image|twitter:image");
    return {
        data: data && !isNaN(data) ? data : null,
        imagem: imagem ? new URL(imagem.replace(/&amp;/g, "&"), link).href : "",
    };
}

async function baixarHtml(link) {
    try {
        const resp = await fetch(link, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(15_000),
        });
        return resp.ok ? await resp.text() : null;
    } catch {
        return null;
    }
}

async function completarDaPagina(noticias) {
    // Sites como a Band bloqueiam o fetch (HTTP 403); nesses casos a página é aberta no navegador
    let navegador;
    const htmlPeloNavegador = async (link) => {
        navegador ??= chromium.launch({ headless: true });
        const page = await (await navegador).newPage();
        try {
            await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
            return await page.content();
        } catch {
            return null;
        } finally {
            await page.close();
        }
    };

    let semData = 0;
    try {
        await Promise.all(
            noticias.map(async (n) => {
                const dataFeed = n.tempo_publicacao ? new Date(n.tempo_publicacao) : null;
                const dataValida = dataFeed && !Number.isNaN(dataFeed.getTime()) ? dataFeed : null;
                const linkGoogleNoticias = new URL(n.link).hostname === "news.google.com";
                const html = dataValida && (n.imagem || linkGoogleNoticias)
                    ? null
                    : (await baixarHtml(n.link)) ?? (await htmlPeloNavegador(n.link));
                const pagina = html ? lerPagina(html, n.link) : {};
                let data = pagina.data || dataRelativa(n.tempo_publicacao) || dataValida;
                // Sem data na página nem no card: usa o momento da coleta
                if (!data) {
                    data = new Date();
                    semData++;
                }
                n.tempo_publicacao = formatarHora(data);
                n.imagem ||= pagina.imagem || "";
            })
        );
    } finally {
        if (navegador) await (await navegador).close();
    }
    const comImagem = noticias.filter((n) => n.imagem).length;
    console.log(`🕒 ${noticias.length - semData}/${noticias.length} notícias com horário de publicação (demais com o da coleta); 🖼️  ${comImagem}/${noticias.length} com imagem.`);
}

module.exports = { completarDaPagina };
