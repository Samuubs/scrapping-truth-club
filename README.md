# scrapping-truth-club

Script em Node.js que usa o [Playwright](https://playwright.dev/) para coletar notícias de política de sites de notícias e salvá-las em JSON, com filtro opcional por assunto.

## Requisitos

- Node.js
- Dependências do projeto e o navegador Chromium do Playwright:

```powershell
yarn install
npx playwright install chromium
```

## Uso básico

```powershell
node scraper_politica.js [--site=<nome>] [assunto1, assunto2, ...]
```

| Argumento | Obrigatório | Padrão | Descrição |
|---|---|---|---|
| `--site=<nome>` | Não | `g1` | Site a ser raspado (precisa estar cadastrado em `SITES`). |
| assuntos | Não | nenhum | Termos separados por vírgula para filtrar as notícias. |

O resultado é salvo em `noticias_politica.json`, na pasta onde o comando foi executado.

## Casos de uso

### 1. Coletar as últimas notícias de política

```powershell
node scraper_politica.js
```

Coleta até 15 notícias do feed de política do g1, sem filtro.

### 2. Filtrar por um assunto

```powershell
node scraper_politica.js meta
```

Mantém apenas as notícias que contêm "meta" no **título** ou no **resumo**.

- A busca não diferencia maiúsculas de minúsculas nem acentos: `flavio` encontra "Flávio".
- A busca é por trecho de texto, então `meta` também encontra palavras como "metade" ou "metas".

### 3. Filtrar por uma frase

```powershell
node scraper_politica.js "flavio bolsonaro"
node scraper_politica.js flavio bolsonaro
```

Os dois comandos são equivalentes: palavras sem vírgula entre elas formam **uma única frase**. A notícia precisa conter o trecho exato "flavio bolsonaro".

### 4. Filtrar por vários assuntos

```powershell
node scraper_politica.js "meta, tse, flavio bolsonaro"
```

Os termos separados por vírgula são combinados com **OU**: a notícia entra no resultado se contiver **qualquer um** deles.

> Para exigir que a notícia contenha **todos** os termos, troque `termos.some` por `termos.every` em `scraper_politica.js`.

### 5. Escolher o site

```powershell
node scraper_politica.js --site=g1 "eleições"
```

O argumento `--site` pode vir em qualquer posição. Se o site não estiver cadastrado, o script mostra os sites disponíveis e termina com erro:

```
Site desconhecido: "folha". Disponíveis: g1
```

### 6. Raspar outra seção do g1

As outras editorias do g1 usam o mesmo layout de feed. Basta cadastrar uma nova entrada com a URL da seção e os mesmos seletores:

```js
g1_economia: {
    url: "https://g1.globo.com/economia/",
    card: ".feed-post-body",
    titulo: "a.feed-post-link",
    resumo: ".feed-post-body-resumo",
    tempo: ".feed-post-datetime",
},
```

```powershell
node scraper_politica.js --site=g1_economia "juros, inflação"
```

### 7. Adicionar um novo site

Inclua uma entrada no objeto `SITES` em `scraper_politica.js`:

```js
outro_site: {
    url: "https://exemplo.com/politica/",
    card: "...",    // seletor de cada notícia no feed
    titulo: "...",  // <a> com o título e o link, dentro do card
    resumo: "...",  // opcional
    tempo: "...",   // opcional
},
```

- `card` e `titulo` são obrigatórios. O `titulo` precisa ser um link (`<a>`) com `href`.
- `resumo` e `tempo` são opcionais. Se forem omitidos, os campos saem vazios no JSON.
- Links relativos (ex.: `/noticia/...`) são convertidos em URLs absolutas a partir da `url` do site.

Para descobrir os seletores, abra a página no navegador, clique com o botão direito em uma notícia e use **Inspecionar**.

## Formato da saída

`noticias_politica.json`:

```json
[
    {
        "titulo": "Quem ganhou as eleições de 2026 para senador?",
        "link": "https://g1.globo.com/politica/eleicoes/2026/noticia/...",
        "resumo": "Os dois candidatos mais votados em cada estado...",
        "tempo_publicacao": "Há 5 minutos",
        "comentario": "A eleição de dois senadores por estado..."
    }
]
```

| Campo | Descrição |
|---|---|
| `titulo` | Título da notícia. |
| `link` | URL absoluta da notícia. |
| `resumo` | Subtítulo/resumo exibido no feed (pode ser vazio). |
| `tempo_publicacao` | Tempo relativo exibido pelo site (ex.: "Há 2 horas"); pode ser vazio. |
| `comentario` | Comentário gerado por IA. Só aparece se a IA estiver configurada; fica `null` se a geração falhar. |

## Comentários gerados por IA (opcional)

Para cada notícia coletada, o script pede a um modelo de linguagem um comentário curto e imparcial, com base no título e no resumo. **Todas** as notícias são comentadas a cada execução, inclusive as que já tinham comentário (o comentário anterior é substituído).

Funciona com qualquer API compatível com a da OpenAI. Configure no `.env`:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `AI_BASE_URL` | Sim | URL base da API (sem `/chat/completions`). |
| `AI_MODEL` | Sim | Nome do modelo. |
| `AI_API_KEY` | Depende | Chave do provedor. Não é necessária no Ollama. |
| `AI_INTERVALO_MS` | Não | Pausa entre notícias, em ms (padrão `1000`). |

Opções gratuitas (os nomes de modelo mudam com o tempo; confira no site do provedor):

| Provedor | `AI_BASE_URL` | `AI_MODEL` (exemplo) |
|---|---|---|
| [Google Gemini](https://aistudio.google.com/apikey) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| [Groq](https://console.groq.com/keys) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| [GitHub Models](https://github.com/marketplace/models) (token com `models:read`) | `https://models.github.ai/inference` | `openai/gpt-4.1-mini` |
| [OpenRouter](https://openrouter.ai/models?q=free) | `https://openrouter.ai/api/v1` | um modelo terminado em `:free` |
| [Ollama](https://ollama.com) (local, sem chave) | `http://localhost:11434/v1` | `llama3.2` |

- Sem `AI_BASE_URL`/`AI_MODEL`, a etapa é ignorada e o campo `comentario` não é enviado ao Supabase (comentários já gravados não são apagados).
- Se o provedor retornar `429` (limite do plano gratuito) ou erro `5xx`, o script tenta de novo até 4 vezes, esperando cada vez mais. Se ainda falhar, a notícia fica com `comentario: null` e o scraping continua.
- Para mudar o tom ou o tamanho do comentário, edite `PROMPT_COMENTARIO` em `scraper_politica.js`.
- Se você já tinha criado a tabela no Supabase, execute `supabase/schema.sql` de novo para criar a coluna `comentario`.
- Em planos gratuitos, alguns provedores (como o Gemini) podem usar os dados enviados para melhorar seus modelos.

## Envio ao Supabase (opcional)

1. Crie um projeto em [supabase.com](https://supabase.com) e execute `supabase/schema.sql` no **SQL Editor**.
2. Copie `.env.example` para `.env` e preencha `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` (Project Settings > API).
3. Rode o script normalmente. Além do JSON, as notícias são gravadas na tabela `noticias`, usando `link` como chave para evitar duplicatas.

Sem o `.env`, o script só gera o JSON. A chave `service_role` é secreta: no app, use apenas a chave `anon`, que tem permissão só de leitura.

## Execução automática com GitHub Actions

O workflow [.github/workflows/scraper.yml](.github/workflows/scraper.yml) roda o scraper nos servidores do GitHub, sem filtro de assunto, e grava as notícias no Supabase.

### Configuração

1. Envie o projeto para o GitHub (`git push`). O `.env` está no `.gitignore` e **não** é enviado.
2. No repositório, acesse **Settings > Secrets and variables > Actions > New repository secret** e crie:

   | Nome | Valor |
   |---|---|
   | `SUPABASE_URL` | URL do projeto no Supabase |
   | `SUPABASE_SERVICE_ROLE_KEY` | Chave `service_role` do Supabase |
   | `AI_API_KEY` | Chave do provedor de IA (opcional) |

   Para os comentários por IA, crie também, na aba **Variables** da mesma página, as variáveis `AI_BASE_URL` e `AI_MODEL` (veja [Comentários gerados por IA](#comentários-gerados-por-ia-opcional)). Sem elas, o workflow roda normalmente, só que sem comentários.

3. Na aba **Actions**, confirme que os workflows estão habilitados.

Se algum secret estiver faltando, a execução falha logo no primeiro passo com uma mensagem indicando o que configurar.

### Rodar manualmente

Na aba **Actions**, selecione **Scraper de notícias** e clique em **Run workflow**. Use isso para testar a configuração sem esperar o próximo horário.

### Alterar a frequência

Edite a linha `cron` no workflow. O horário é sempre em **UTC** (Brasília = UTC−3):

| Expressão | Frequência |
|---|---|
| `"0 * * * *"` | A cada hora (padrão) |
| `"*/30 * * * *"` | A cada 30 minutos |
| `"0 */3 * * *"` | A cada 3 horas |
| `"0 9-23 * * *"` | De hora em hora, das 6h às 20h de Brasília |

Para raspar outro site cadastrado, altere `--site=g1` no passo **Executar scraper** ou adicione mais uma linha `node scraper_politica.js --site=<nome>`.

### Acompanhar as execuções

Cada execução aparece na aba **Actions**, com o log completo. Os valores dos secrets aparecem como `***` nos logs.

### Observações

- O GitHub pode atrasar execuções agendadas em alguns minutos, principalmente em horários de pico.
- Em repositórios **públicos**, os agendamentos são desativados após 60 dias sem atividade no repositório. Reative na aba **Actions** ou faça um commit.
- Em repositórios **privados**, as execuções consomem os minutos incluídos no seu plano do GitHub.
- Quem tem permissão de escrita no repositório pode alterar o workflow e ter acesso aos secrets. Dê esse acesso só a pessoas de confiança.
- Se a chave `service_role` vazar, gere uma nova no Supabase e atualize o secret.

## Limitações

- **Máximo de 15 notícias** por execução. O limite é aplicado **depois** do filtro.
- **Só a primeira carga da página é lida.** O script não rola o feed nem clica em "Veja mais", então filtros muito específicos podem retornar poucos ou nenhum resultado.
- **O arquivo de saída é sobrescrito** a cada execução, independentemente do site.
- **Os seletores dependem do layout do site.** Se o site mudar o HTML, o script pode parar de encontrar notícias, ou ficar esperando até o tempo limite em `waitForSelector`. Nesse caso, atualize os seletores em `SITES`.
- O filtro olha apenas o título e o resumo do feed, não o texto completo da notícia.
