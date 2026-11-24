const assert = require("node:assert/strict");
const test = require("node:test");
const { completarDaPagina } = require("../src/paginas");

test("ignora o placeholder None ao extrair a imagem da página", async (t) => {
    const fetchOriginal = global.fetch;
    global.fetch = async () => ({
        ok: true,
        text: async () => '<meta property="og:image" content="None">',
    });
    t.after(() => {
        global.fetch = fetchOriginal;
    });

    const noticia = {
        link: "https://g1.globo.com/economia/noticia/2026/11/24/artigo.ghtml",
        tempo_publicacao: "",
        imagem: "",
    };

    await completarDaPagina([noticia]);

    assert.equal(noticia.imagem, "");
});

test("preserva a URL de imagem válida dos metadados", async (t) => {
    const fetchOriginal = global.fetch;
    global.fetch = async () => ({
        ok: true,
        text: async () => '<meta property="og:image" content="https://example.com/image.jpg">',
    });
    t.after(() => {
        global.fetch = fetchOriginal;
    });

    const noticia = {
        link: "https://g1.globo.com/economia/noticia/2026/11/24/artigo.ghtml",
        tempo_publicacao: "",
        imagem: "",
    };

    await completarDaPagina([noticia]);

    assert.equal(noticia.imagem, "https://example.com/image.jpg");
});

test("prioriza og:image do artigo do R7 sobre a miniatura do card", async (t) => {
    const fetchOriginal = global.fetch;
    let requisicoes = 0;
    global.fetch = async () => {
        requisicoes++;
        return {
            ok: true,
            text: async () => '<meta property="og:image" content="https://cdn.example.com/image.jpg?width=1200&amp;height=630">',
        };
    };
    t.after(() => {
        global.fetch = fetchOriginal;
    });

    const noticia = {
        site: "r7",
        link: "https://noticias.r7.com/economia/artigo/",
        tempo_publicacao: "2026-11-23T12:00:00-03:00",
        imagem: "https://img.r7.com/images/agencia-estado-02122025171241331",
    };

    await completarDaPagina([noticia]);

    assert.equal(requisicoes, 1);
    assert.equal(
        noticia.imagem,
        "https://cdn.example.com/image.jpg?width=1200&height=630"
    );
});

test("deixa a imagem do R7 vazia se o artigo não fornecer og:image", async (t) => {
    const fetchOriginal = global.fetch;
    global.fetch = async () => ({
        ok: true,
        text: async () => "<html><head></head><body></body></html>",
    });
    t.after(() => {
        global.fetch = fetchOriginal;
    });

    const noticia = {
        site: "r7",
        link: "https://noticias.r7.com/economia/artigo/",
        tempo_publicacao: "2026-11-23T12:00:00-03:00",
        imagem: "https://img.r7.com/images/agencia-estado-02122025171241331",
    };

    await completarDaPagina([noticia]);

    assert.equal(noticia.imagem, "");
});
