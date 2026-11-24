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
