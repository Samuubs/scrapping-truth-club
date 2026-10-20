const { chromium } = require('playwright');
const fs = require('fs').promises;

async function rasparNoticiasPolitica() {
    const url = "https://g1.globo.com/politica/";
    
    // Inicializa o navegador
    const browser = await chromium.launch({ headless: true });
    
    // Cria um novo contexto de navegação (corrige o erro de 'browser.new_page is not a function')
    const context = await browser.newContext();
    const page = await context.newPage();
    
    console.log(`Acessando ${url}...`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    
    // Espera o contêiner principal das notícias carregar
    await page.waitForSelector(".feed-post-body");
    
    // Seleciona todos os cards de notícia do feed
    const posts = await page.$$(".feed-post-body");
    
    const noticias = [];
    
    const limite = Math.min(posts.length, 15);
    for (let i = 0; i < limite; i++) {
        const post = posts[i];
        
        const tituloElement = await post.$("a.feed-post-link");
        
        if (tituloElement) {
            const titulo = await tituloElement.innerText();
            const link = await tituloElement.getAttribute("href");
            
            const resumoElement = await post.$(".feed-post-body-resumo");
            const resumo = resumoElement ? await resumoElement.innerText() : "";
            
            const tempoElement = await post.$(".feed-post-datetime");
            const tempo = tempoElement ? await tempoElement.innerText() : "";
            
            noticias.push({
                titulo: titulo.trim(),
                link: link,
                resumo: resumo.trim(),
                tempo_publicacao: tempo.trim()
            });
        }
    }
    
    await browser.close();
    
    await fs.writeFile("noticias_politica.json", JSON.stringify(noticias, null, 4), "utf-8");
    console.log(`✅ Scraping concluído com sucesso! ${noticias.length} notícias salvas em 'noticias_politica.json'.`);
}

rasparNoticiasPolitica();