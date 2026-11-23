const { consultarIA, ErroAgente, ErroRecusa } = require("./ia");
const { esperar } = require("./util");

// O prompt real fica no secret/.env PROMPT_COMENTARIO; este é só um padrão genérico
const PROMPT_COMENTARIO =
    process.env.PROMPT_COMENTARIO ||
    "Você é um comentarista político imparcial. Escreva um comentário curto (2 a 3 frases), em português do Brasil, " +
    "analisando a notícia. Não tome partido e não invente fatos. Responda só com o comentário, sem aspas.";

// Trechos do prompt que, se aparecerem na resposta, indicam que a IA o repetiu
const TRECHOS_PROMPT = PROMPT_COMENTARIO.split(/[.:!?]\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 30);

// Frases típicas de recusa ou de resposta fora do formato pedido
const PADROES_RECUSA = [
    /n[aã]o (posso|consigo|sou capaz|tenho como)/i,
    /^(desculp|lament|infelizmente)/i,
    /\bcomo (um )?(modelo|assistente|ia|intelig[eê]ncia artificial)\b/i,
    /\b(I can(no|')t|I'm (sorry|unable)|as an AI)\b/i,
    /pol[ií]ticas? de (uso|conte[uú]do)/i,
];

function validarComentario(texto) {
    const limpo = texto.replace(/^["'“]+|["'”]+$/g, "").trim();
    if (limpo.length < 40) throw new ErroAgente(`resposta curta demais: "${limpo.slice(0, 60)}"`);
    if (PADROES_RECUSA.some((p) => p.test(limpo))) throw new ErroAgente(`recusa: "${limpo.slice(0, 80)}"`, { recusa: true });
    const minusculo = limpo.toLowerCase();
    if (TRECHOS_PROMPT.some((t) => minusculo.includes(t))) throw new ErroAgente("resposta repete o prompt", { recusa: true });
    return limpo;
}

async function comentarNoticias(noticias, agentes) {
    const comentadas = [];
    for (const [i, noticia] of noticias.entries()) {
        if (i > 0) await esperar(Number(process.env.AI_INTERVALO_MS ?? 1000));
        try {
            const { valor, agente } = await consultarIA(
                [
                    { role: "system", content: PROMPT_COMENTARIO },
                    { role: "user", content: `Título: ${noticia.titulo}\nResumo: ${noticia.resumo || "(sem resumo)"}` },
                ],
                agentes,
                { interpretar: validarComentario }
            );
            noticia.comentario = valor;
            agente.gerados++;
            comentadas.push(noticia);
        } catch (err) {
            if (err instanceof ErroRecusa) {
                console.warn(`🚫 [${noticia.site}] "${noticia.titulo}" descartada: todos os agentes recusaram comentá-la.`);
                continue;
            }
            throw new Error(`Não foi possível gerar o comentário de "${noticia.titulo}" (${err.message}). Nada foi salvo.`);
        }
    }
    const usados = agentes.filter((a) => a.gerados).map((a) => `${a.nome}: ${a.gerados}`).join(", ");
    console.log(`🤖 ${comentadas.length} comentários gerados${usados ? ` (${usados})` : ""}.`);
    return comentadas;
}

module.exports = { comentarNoticias };
