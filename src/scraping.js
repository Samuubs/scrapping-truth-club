const { normalizar } = require("./util");

const LIMITE_POR_SITE = 15;
const MAX_ROLAGENS = Number(process.env.MAX_ROLAGENS || 15);
const ROLAGEM_ESPERA_MS = 700;

function decodificarXml(texto) {
    return texto
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&#x([0-9a-f]+);/gi, (_, codigo) => String.fromCodePoint(parseInt(codigo, 16)))
        .replace(/&#(\d+);/g, (_, codigo) => String.fromCodePoint(Number(codigo)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

function valorXml(xml, tag) {
    const conteudo = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1];
    return conteudo ? decodificarXml(conteudo).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
}

function atributoXml(xml, tag, atributo) {
    const elemento = xml.match(new RegExp(`<${tag}\\b([^>]*)>`, "i"))?.[1];
    const valor = elemento?.match(new RegExp(`(?:^|\\s)${atributo}=["']([^"']+)["']`, "i"))?.[1];
    return valor ? decodificarXml(valor) : "";
}

function analisarRss(xml, dominioFonte) {
    if (!/<rss\b/i.test(xml)) throw new Error("A resposta da Band não contém um feed RSS válido.");

    return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
        .map(([, item]) => {
            const fonteUrl = atributoXml(item, "source", "url");
            if (dominioFonte) {
                if (!fonteUrl) return null;
                const dominio = new URL(fonteUrl).hostname.toLowerCase();
                if (dominio !== dominioFonte && !dominio.endsWith(`.${dominioFonte}`)) return null;
            }

            const fonte = valorXml(item, "source");
            let titulo = valorXml(item, "title");
            const sufixoFonte = ` - ${fonte}`;
            if (fonte && titulo.toLowerCase().endsWith(sufixoFonte.toLowerCase())) {
                titulo = titulo.slice(0, -sufixoFonte.length);
            }
            return {
                titulo,
                href: valorXml(item, "link"),
                resumo: dominioFonte ? "" : valorXml(item, "description"),
                tempo: valorXml(item, "pubDate"),
                imagem:
                    atributoXml(item, "enclosure", "url") ||
                    atributoXml(item, "media:content", "url") ||
                    atributoXml(item, "media:thumbnail", "url"),
            };
        })
        .filter(Boolean);
}

async function rasparFeed(nomeSite, site, termos) {
    console.log(`[${nomeSite}] Acessando feed ${site.rss}...`);
    const fetchFeed = (url) => fetch(url, {
        headers: {
            Accept: "application/rss+xml, application/xml, text/xml",
            "User-Agent": "scrapping-truth-club/1.0",
        },
        signal: AbortSignal.timeout(30_000),
    });
    let url = site.rss;
    let resposta = await fetchFeed(url);
    if (resposta.status === 403 && site.rssFallback) {
        url = site.rssFallback.url;
        console.warn(`[${nomeSite}] RSS oficial bloqueado (HTTP 403); usando o feed público do Google Notícias.`);
        resposta = await fetchFeed(url);
    }
    if (!resposta.ok) throw new Error(`O feed RSS respondeu HTTP ${resposta.status} (${url}).`);

    const brutos = analisarRss(await resposta.text(), url === site.rssFallback?.url ? site.rssFallback.dominio : "");
    const noticias = [];
    const vistos = new Set();
    for (const { titulo, href, resumo, tempo, imagem } of brutos) {
        if (noticias.length >= LIMITE_POR_SITE) break;
        if (!titulo || !href) continue;

        const url = new URL(href, site.url);
        url.search = "";
        url.hash = "";
        const link = url.href;
        if (vistos.has(link)) continue;
        vistos.add(link);

        const texto = normalizar(`${titulo} ${resumo}`);
        if (termos.length && !termos.some((t) => texto.includes(t))) continue;

        noticias.push({
            site: nomeSite,
            titulo,
            link,
            resumo,
            tempo_publicacao: tempo,
            imagem: imagem ? new URL(imagem, site.url).href : "",
        });
    }
    console.log(`[${nomeSite}] ${noticias.length} notícias encontradas.`);
    return noticias;
}

// Rola uma tela por vez (para as imagens com lazy-load carregarem) até ter "minimo" cards,
// a página parar de crescer ou atingir MAX_ROLAGENS
async function rolarPagina(page, seletorCard, minimo) {
    let anterior = await page.locator(seletorCard).count();
    let parada = 0;
    let rolagens = 0;
    while (rolagens < MAX_ROLAGENS && parada < 3 && !(minimo && anterior >= minimo)) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(ROLAGEM_ESPERA_MS);
        rolagens++;
        const atual = await page.locator(seletorCard).count();
        const noFim = await page.evaluate(() => window.innerHeight + window.scrollY >= document.body.scrollHeight - 5);
        parada = atual === anterior && noFim ? parada + 1 : 0;
        anterior = atual;
    }
    return { rolagens, cards: anterior };
}

async function rasparSite(context, nomeSite, site, termos) {
    if (site.rss) return rasparFeed(nomeSite, site, termos);

    const page = await context.newPage();
    try {
        console.log(`[${nomeSite}] Acessando ${site.url}...`);
        await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForSelector(site.card, { timeout: 30_000 });

        // Com filtro de assunto não dá para saber quantos cards bastam; sem filtro, folga para cards inválidos
        const { rolagens, cards } = await rolarPagina(page, site.card, termos.length ? 0 : LIMITE_POR_SITE * 2);
        if (rolagens) console.log(`[${nomeSite}] ${rolagens} rolagens, ${cards} cards na página.`);

        const brutos = await page.$$eval(
            site.card,
            (cards, s) => {
                const limpar = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : "");
                // Imagens com lazy-load guardam o endereço em data-* ou srcset até aparecerem na tela
                const imagem = (card) => {
                    const img = card.querySelector(s.imagem || "img");
                    if (!img) return "";
                    const srcset = img.getAttribute("srcset") || img.dataset.srcset ||
                        img.closest("picture")?.querySelector("source")?.getAttribute("srcset") || "";
                    return [img.currentSrc, img.getAttribute("src"), img.dataset.src, img.dataset.lazySrc,
                    img.dataset.original, srcset.split(",")[0].trim().split(/\s+/)[0]]
                        .find((u) => u && !u.startsWith("data:")) || "";
                };
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
                        imagem: imagem(card),
                    };
                });
            },
            { titulo: site.titulo, link: site.link, resumo: site.resumo, tempo: site.tempo, imagem: site.imagem }
        );

        const noticias = [];
        const vistos = new Set();
        for (const { titulo, href, resumo, tempo, imagem } of brutos) {
            if (noticias.length >= LIMITE_POR_SITE) break;
            if (!titulo || !href) continue;

            // Sem query/hash para "?utm_source=..." ou "#trecho" não virarem outro link
            const url = new URL(href, site.url);
            url.search = "";
            url.hash = "";
            const link = url.href;
            if (vistos.has(link)) continue;
            vistos.add(link);

            const texto = normalizar(`${titulo} ${resumo}`);
            if (termos.length && !termos.some((t) => texto.includes(t))) continue;

            noticias.push({
                site: nomeSite,
                titulo,
                link,
                resumo,
                tempo_publicacao: tempo,
                imagem: imagem ? new URL(imagem, site.url).href : "",
            });
        }
        console.log(`[${nomeSite}] ${noticias.length} notícias encontradas.`);
        return noticias;
    } finally {
        await page.close();
    }
}

module.exports = { rasparSite };
