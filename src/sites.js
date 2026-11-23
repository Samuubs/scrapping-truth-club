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
    },
    band: {
        url: "https://www.band.com.br/politica",
        rss: "https://www.band.com.br/rss/politica.xml",
        rssFallback: {
            url: "https://news.google.com/rss/search?q=site%3Aband.com.br%2Fpolitica&hl=pt-BR&gl=BR&ceid=BR%3Apt-419",
            dominio: "band.com.br",
        },
    },
};

module.exports = { SITES };
