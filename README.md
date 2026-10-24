# scrapping-truth-club

Script em Node.js que usa o [Playwright](https://playwright.dev/) para coletar notícias de política de vários sites de notícias (g1, R7 e Band) ao mesmo tempo e salvá-las em JSON, com filtro opcional por assunto.

## Requisitos

- Node.js
- Dependências do projeto e o navegador Chromium do Playwright:

```powershell
yarn install
npx playwright install chromium
```

## Uso básico

```powershell
node scraper_politica.js [--site=<nome1,nome2,...>] [assunto1, assunto2, ...]
```

| Argumento | Obrigatório | Padrão | Descrição |
|---|---|---|---|
| `--site=<nomes>` | Não | todos | Sites a serem raspados, separados por vírgula (precisam estar cadastrados em `SITES`). |
| assuntos | Não | nenhum | Termos separados por vírgula para filtrar as notícias. |

Sites cadastrados:

| Nome | Página | Resumo | Tempo de publicação |
|---|---|---|---|
| `g1` | [g1.globo.com/politica](https://g1.globo.com/politica/) | Sim | Sim |
| `r7` | [noticias.r7.com/brasilia](https://noticias.r7.com/brasilia/) | Não | Sim |
| `band` | [band.com.br/politica](https://www.band.com.br/politica) | Não | Não |

Os sites são raspados em paralelo. O resultado de todos é salvo junto em `noticias_politica.json`, na pasta onde o comando foi executado.

## Casos de uso

### 1. Coletar as últimas notícias de política

```powershell
node scraper_politica.js
```

Coleta até 15 notícias de cada site cadastrado (g1, R7 e Band), sem filtro, e junta tudo em no máximo **30 notícias**, sem repetir a mesma notícia de sites diferentes (veja [Notícias repetidas e limite total](#notícias-repetidas-e-limite-total)).

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

### 5. Escolher os sites

```powershell
node scraper_politica.js --site=g1 "eleições"
node scraper_politica.js --site=r7,band "eleições"
```

Sem `--site`, todos os sites são raspados. O argumento pode vir em qualquer posição. Se algum site não estiver cadastrado, o script mostra os sites disponíveis e termina com erro, sem raspar nada:

```
Site desconhecido: "folha". Disponíveis: g1, r7, band
```

Se um site falhar durante o scraping (fora do ar, layout alterado etc.), os outros continuam normalmente: as notícias deles são salvas no JSON e no Supabase, e no final o script termina com erro (código 1) indicando quais sites falharam.

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
    titulo: "...",  // elemento com o título, dentro do card (opcional)
    link: "...",    // <a> com o link, dentro do card (opcional)
    resumo: "...",  // opcional
    tempo: "...",   // opcional
    formatarTempo: (t) => t, // opcional: ajusta o texto do tempo
},
```

- `card` é obrigatório. Os outros campos são opcionais.
- Sem `titulo`, o texto do próprio card é usado como título.
- Sem `link`, o link vem do `<a>` que envolve o título. Se não houver, vem do próprio card (quando ele é um `<a>`) ou do primeiro `<a>` dentro dele.
- Sem `resumo` ou `tempo`, os campos saem vazios no JSON.
- Links relativos (ex.: `/noticia/...`) são convertidos em URLs absolutas a partir da `url` do site. Notícias repetidas na mesma página são descartadas.
- `card` pode usar `:has(...)`, como na Band: `a[href^='/politica/']:has(h2, h3)` seleciona os links de notícia que contêm um título.

O site novo passa a ser raspado automaticamente junto com os outros. Para testar só ele, use `--site=outro_site`.

Para descobrir os seletores, abra a página no navegador, clique com o botão direito em uma notícia e use **Inspecionar**.

## Notícias repetidas e limite total

Depois de raspar os sites, o script junta os resultados assim:

1. **Intercala os sites**: 1ª notícia de cada site, depois a 2ª de cada site, e assim por diante. Como os feeds começam pelas mais recentes, todos os sites ficam representados e nenhum ocupa o limite sozinho.
2. **Descarta notícias repetidas entre sites**: compara cada notícia com as já escolhidas de outros sites (veja abaixo). Se for o mesmo fato, ela é descartada e o log mostra o motivo e qual foi mantida:
   ```
   🔁 [r7] "Campanhas de Flávio e Lula aceitam abrir sigilos..." descartada (IA): igual a [band] "Campanhas de Lula e Flávio entram em acordo sobre quebra de sigilo..."
   ```
3. **Para em 30 notícias** no total.

### Como as repetidas são detectadas

Primeiro, os títulos são comparados pelas palavras em comum, sem acentos, sem palavras como "de", "para" e "que", e considerando só as 5 primeiras letras de cada palavra (assim "sigilo" e "sigilos" contam como iguais). O resultado é uma semelhança de 0 a 1:

| Semelhança | Decisão |
|---|---|
| `0.75` ou mais | Repetida, sem consultar a IA. |
| De `0.3` a `0.75` | **A IA decide.** Ela recebe a notícia nova e até 5 notícias parecidas de outros sites (título e resumo) e responde qual relata o mesmo fato, ou nenhuma. |
| Menos de `0.3` | Notícia diferente, sem consultar a IA. |

A IA é orientada a considerar repetida só quando for o **mesmo acontecimento**, e não apenas o mesmo tema ou as mesmas pessoas. Ela usa a mesma cadeia de provedores dos [comentários](#comentários-gerados-por-ia), com o mesmo fallback entre agentes. Se um agente responder algo que não seja um número válido, o próximo é consultado.

**A comparação por IA tem tempo máximo** de 5 minutos por execução (variável `AI_COMPARACAO_MAX_MS`). Quando o tempo acaba, a consulta em andamento é interrompida e as comparações restantes são decididas só pela semelhança: a partir de `0.5`, a notícia é considerada repetida. O mesmo acontece numa comparação em que nenhum agente consegue responder. Nos dois casos, o log avisa, e a comparação nunca interrompe o script.

No fim, o log mostra quantas comparações foram feitas pela IA. Cada notícia gera no máximo uma consulta, então são no máximo 30 consultas a mais por execução. Em geral são bem menos: no teste com as notícias do dia, foram 8.

### Configuração

As constantes ficam no início de `scraper_politica.js`:

| Constante | Padrão | Descrição |
|---|---|---|
| `LIMITE_POR_SITE` | `15` | Notícias coletadas de cada site antes de juntar. |
| `LIMITE_TOTAL` | `30` | Máximo de notícias no resultado final. |
| `SIMILARIDADE_CERTA` | `0.75` | A partir daqui, é repetida sem consultar a IA. |
| `SIMILARIDADE_DUVIDOSA` | `0.3` | Abaixo daqui, é outra notícia sem consultar a IA. |
| `SIMILARIDADE_MINIMA` | `0.5` | Limite usado quando a IA não responde ou o tempo máximo da comparação acaba. |
| `MAX_CANDIDATAS_IA` | `5` | Quantas notícias parecidas são enviadas à IA em cada consulta. |

- **Diminuir** `SIMILARIDADE_DUVIDOSA` faz a IA analisar mais pares: pega mais repetições escritas de forma bem diferente, mas gasta mais consultas.
- **Aumentar** `SIMILARIDADE_CERTA` deixa mais casos para a IA decidir, em vez de descartar direto.

## Formato da saída

`noticias_politica.json`:

```json
[
    {
        "site": "g1",
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
| `site` | Nome do site de origem (`g1`, `r7`, `band`...). |
| `titulo` | Título da notícia. |
| `link` | URL absoluta da notícia. |
| `resumo` | Subtítulo/resumo exibido no feed (pode ser vazio). |
| `tempo_publicacao` | Tempo relativo exibido pelo site (ex.: "Há 2 horas"); pode ser vazio. |
| `comentario` | Comentário gerado por IA. Sempre preenchido: se a IA não conseguir comentar alguma notícia, nada é salvo. |

## Comentários gerados por IA

Para cada notícia coletada, o script pede a um modelo de linguagem um comentário curto e imparcial, com base no título e no resumo. **Todas** as notícias são comentadas a cada execução, inclusive as que já tinham comentário (o comentário anterior é substituído).

**O comentário é obrigatório.** O script não roda sem pelo menos um provedor de IA configurado. Se alguma notícia ficar sem comentário, o script para com erro (código 1) e **não grava nada**: nem o JSON, nem o Supabase. A geração de comentários não tem tempo máximo total.

### Provedores e cadeia de fallback

Basta preencher no `.env` a chave de **um ou mais** provedores gratuitos. Cada modelo de cada provedor vira um **agente**, e os agentes formam uma cadeia: se um falhar (por exemplo, por limite de tokens), a mesma notícia é enviada ao próximo.

| Provedor | Chave | Modelos (variável e padrão) |
|---|---|---|
| [Google Gemini](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` | `GEMINI_MODELS` = `gemini-2.5-flash,gemini-2.5-flash-lite` |
| [Groq](https://console.groq.com/keys) | `GROQ_API_KEY` | `GROQ_MODELS` = `llama-3.3-70b-versatile,llama-3.1-8b-instant` |
| [GitHub Models](https://github.com/marketplace/models) | `GH_MODELS_TOKEN` (token com `models:read`) | `GH_MODELS` = `openai/gpt-4.1-mini` |
| [OpenRouter](https://openrouter.ai/models?q=free) | `OPENROUTER_API_KEY` | `OPENROUTER_MODELS` = `meta-llama/llama-3.3-70b-instruct:free` |
| [Ollama](https://ollama.com) (local) | não tem | `OLLAMA_MODELS` = `llama3.2` (URL em `OLLAMA_BASE_URL`) |
| Personalizado | `AI_API_KEY` (opcional) | `AI_MODEL` (URL em `AI_BASE_URL`) |

Com as chaves do Gemini e do Groq preenchidas, por exemplo, a cadeia fica assim:

```
🤖 Cadeia de IA: gemini/gemini-2.5-flash → gemini/gemini-2.5-flash-lite → groq/llama-3.3-70b-versatile → groq/llama-3.1-8b-instant
```

- **Ordem:** por padrão, `personalizado, gemini, groq, github, openrouter`, e só entram os provedores com chave. Para mudar a ordem ou incluir o Ollama, use `AI_PROVEDORES` (ex.: `AI_PROVEDORES=groq,gemini,ollama`).
- **Modelos:** as variáveis `*_MODELS` aceitam uma lista separada por vírgula, em ordem de preferência. Vários modelos do mesmo provedor ajudam porque, em geral, cada modelo tem sua própria cota. Os nomes mudam com o tempo; confira no site do provedor.
- **Configuração antiga:** quem usava só `AI_BASE_URL`/`AI_MODEL`/`AI_API_KEY` não precisa mudar nada. Esse provedor vira o `personalizado`, primeiro da cadeia.

### O que acontece quando um agente falha

Se um agente falhar, o script passa **na hora** para o próximo agente disponível, sem esperar.

| Erro | Ação |
|---|---|
| `401`/`403` (chave inválida), `402` (sem créditos), `404` (modelo inexistente) | O agente é desativado até o fim da execução. |
| `429` (limite de tokens/requisições) | O agente fica em pausa pelo tempo indicado pelo provedor (padrão 60s) e é pulado enquanto estiver pausado. |
| `5xx`, falha de conexão ou tempo de resposta acima de 60s | O agente fica em pausa por 30s. |
| `400`/`413` ou resposta inválida | Pula para o próximo agente. |

**Qualquer agente que falhe 3 vezes seguidas**, por qualquer motivo, é desativado até o fim da execução. Um sucesso zera essa contagem.

**Se nenhum agente estiver disponível** (todos desativados, em pausa ou com falha naquela consulta), o script não espera:
- na **comparação** de notícias, usa só a semelhança de palavras e continua;
- no **comentário**, para imediatamente com erro e não grava nada.

No fim, o log mostra quantos comentários cada agente gerou.

| Outras variáveis | Padrão | Descrição |
|---|---|---|
| `AI_INTERVALO_MS` | `1000` | Pausa entre uma consulta e outra, em ms. |
| `AI_COMPARACAO_MAX_MS` | `300000` | Tempo máximo total da comparação de notícias por IA em cada execução, em ms. |

### Observações

- Configure mais de um provedor. Como o script desiste na hora quando nenhum agente está disponível, uma instabilidade curta num único provedor já é suficiente para a execução falhar. No GitHub Actions, o GitHub Models já entra na cadeia automaticamente.
- Para mudar o tom ou o tamanho do comentário, edite `PROMPT_COMENTARIO` em `scraper_politica.js`.
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
   | `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` | Chaves dos provedores de IA (opcionais; crie só as que tiver) |

   Para mudar a ordem da cadeia de IA, crie também, na aba **Variables** da mesma página, a variável `AI_PROVEDORES` (veja [Comentários gerados por IA](#comentários-gerados-por-ia)). Um provedor personalizado também funciona, com as variáveis `AI_BASE_URL`/`AI_MODEL` e o secret `AI_API_KEY`.

   O **GitHub Models** já funciona no workflow sem configuração, usando o token da própria execução (permissão `models: read`). Por isso, mesmo sem nenhuma chave, o workflow gera comentários, e ele também serve de último recurso quando os outros provedores atingem o limite. Para usar um token pessoal no lugar, crie o secret `GH_MODELS_TOKEN`. O GitHub não aceita secrets com nome começando por `GITHUB_`.

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

Por padrão, o workflow raspa todos os sites cadastrados. Para raspar só alguns, adicione `--site=<nomes>` no passo **Executar scraper** (ex.: `node scraper_politica.js --site=g1,r7`). Se algum site falhar, a execução aparece como falha na aba **Actions**, mas as notícias dos outros sites são gravadas mesmo assim.

### Acompanhar as execuções

Cada execução aparece na aba **Actions**, com o log completo. Os valores dos secrets aparecem como `***` nos logs.

### Observações

- O GitHub pode atrasar execuções agendadas em alguns minutos, principalmente em horários de pico.
- Em repositórios **públicos**, os agendamentos são desativados após 60 dias sem atividade no repositório. Reative na aba **Actions** ou faça um commit.
- Em repositórios **privados**, as execuções consomem os minutos incluídos no seu plano do GitHub.
- Quem tem permissão de escrita no repositório pode alterar o workflow e ter acesso aos secrets. Dê esse acesso só a pessoas de confiança.
- Se a chave `service_role` vazar, gere uma nova no Supabase e atualize o secret.

## Limitações

- **Máximo de 15 notícias por site e 30 no total** em cada execução. Os limites são aplicados **depois** do filtro.
- **A detecção de repetidas vale só dentro da mesma execução.** Uma notícia gravada no Supabase numa execução anterior pode reaparecer com o título de outro site. A IA também pode errar, principalmente em notícias diferentes sobre um mesmo assunto em andamento.
- **Só a primeira carga da página é lida.** O script não rola o feed nem clica em "Veja mais", então filtros muito específicos podem retornar poucos ou nenhum resultado.
- **O arquivo de saída é sobrescrito** a cada execução.
- **R7 e Band não exibem resumo no feed**, então o filtro por assunto olha só o título nesses sites. A Band também não exibe o tempo de publicação.
- **O feed do R7 mistura editorias.** A página de Brasília lista as últimas notícias do portal, que podem incluir assuntos fora de política.
- **Os seletores dependem do layout do site.** Se o site mudar o HTML, o script pode parar de encontrar notícias, ou ficar esperando até o tempo limite em `waitForSelector`. Nesse caso, atualize os seletores em `SITES`.
- O filtro olha apenas o título e o resumo do feed, não o texto completo da notícia.
