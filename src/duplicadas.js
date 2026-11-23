const { consultarIA, ErroAgente, ErroPrazo } = require("./ia");
const { normalizar, esperar } = require("./util");

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
// jaPublicadas: notícias recentes do banco, só para comparação; não são devolvidas nem contam no limite
async function combinarSites(listas, agentes, jaPublicadas = []) {
    const escolhidas = jaPublicadas.map((noticia) => ({ noticia, chave: radicais(noticia.titulo), existente: true }));
    const novas = () => escolhidas.filter((e) => !e.existente).length;
    const estatisticas = { consultas: 0, repetidasIA: 0, prazo: Date.now() + COMPARACAO_MAX_MS, prazoEsgotado: false };
    const maior = Math.max(0, ...listas.map((l) => l.length));
    for (let i = 0; i < maior && novas() < LIMITE_TOTAL; i++) {
        for (const lista of listas) {
            if (novas() >= LIMITE_TOTAL) break;
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
    return escolhidas.filter((e) => !e.existente).map((e) => e.noticia);
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

module.exports = { combinarSites };
