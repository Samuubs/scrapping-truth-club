const { lista } = require("./util");

const MAX_FALHAS_SEGUIDAS = 3;

// Provedores compatíveis com a API da OpenAI. Cada modelo da lista vira um agente na cadeia de fallback.
const PROVEDORES = {
    gemini: {
        url: "https://generativelanguage.googleapis.com/v1beta/openai",
        chaveEnv: "GEMINI_API_KEY",
        modelosEnv: "GEMINI_MODELS",
        modelos: "gemma-4-31b-it",
    },
    groq: {
        url: "https://api.groq.com/openai/v1",
        chaveEnv: "GROQ_API_KEY",
        modelosEnv: "GROQ_MODELS",
        modelos: "openai/gpt-oss-120b,openai/gpt-oss-20b",
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
};

// Ollama não tem chave para indicar que está configurado, então só entra se listado em AI_PROVEDORES
const ORDEM_PADRAO = ["groq", "gemini", "github", "openrouter"];

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
    constructor(mensagem, { pausaMs = 0, desativar = false, recusa = false } = {}) {
        super(mensagem);
        this.pausaMs = pausaMs;
        this.desativar = desativar;
        this.recusa = recusa;
    }
}

class ErroRecusa extends Error {
    constructor() {
        super("todos os agentes recusaram");
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
    let tentativas = 0;
    let recusas = 0;
    for (const agente of agentes) {
        if (agente.desativado || agente.pausadoAte > Date.now()) continue;
        if (prazo && Date.now() >= prazo) throw new ErroPrazo();
        const timeoutMs = Math.min(60_000, prazo ? prazo - Date.now() : Infinity);
        tentativas++;
        try {
            const valor = interpretar(await chamarAgente(agente, mensagens, temperatura, timeoutMs));
            agente.falhasSeguidas = 0;
            return { valor, agente };
        } catch (err) {
            // A requisição foi cortada pelo prazo, não por culpa do agente
            if (prazo && Date.now() >= prazo) throw new ErroPrazo();

            let situacao = "pulando para o próximo agente";
            // Recusa depende do conteúdo, não do agente: não conta para desativá-lo
            if (err.recusa) {
                recusas++;
            } else if (err.desativar) {
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
    if (tentativas && recusas === tentativas) throw new ErroRecusa();
    throw new Error("nenhum agente de IA disponível conseguiu responder");
}

module.exports = { montarAgentes, consultarIA, ErroAgente, ErroRecusa, ErroPrazo };
