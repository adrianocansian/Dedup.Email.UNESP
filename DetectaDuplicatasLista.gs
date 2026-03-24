/**
 * ============================================================
 *  DetectaDuplicatasLista.gs
 *  Google Apps Script — Move duplicatas de listas de e-mail
 * ============================================================
 *
 *  COMO INSTALAR:
 *  1. Acesse https://script.google.com/ e crie um novo projeto.
 *  2. Cole TODO este código no editor.
 *  3. Ajuste as constantes em CONFIG (abaixo) conforme necessário.
 *  4. Execute a função `configurarGatilho` UMA VEZ para agendar
 *     a execução automática diária.
 *  5. Autorize as permissões solicitadas pelo Google.
 *
 *  EXECUÇÃO MANUAL:
 *  Basta clicar em "Executar" com a função `moverDuplicatas`
 *  selecionada no menu do Apps Script.
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────
//  CONFIGURAÇÕES — ajuste aqui
// ─────────────────────────────────────────────────────────────
const CONFIG = {

  // Endereço (ou parte dele) que identifica a lista
  LISTA_EMAIL: "lista.docentes@unesp.br",

  // Headers que caracterizam mensagens desta lista
  // (basta UM deles estar presente no raw content)
  HEADERS_LISTA: [
    "Precedence: list",
    "Mailing-List:",
    "lista.docentes@unesp.br",
    "List-Id:",
  ],

  // Marcadores de início de mensagem encaminhada
  // (qualquer variação comum em PT/EN)
  MARCADORES_FORWARD: [
    "---------- Forwarded message ---------",
    "---------- Mensagem encaminhada ----------",
    "-------- Forwarded Message --------",
    "-----Original Message-----",
    "Begin forwarded message",
    "Início da mensagem encaminhada",
  ],

  // Label que receberá as duplicatas (será criado automaticamente)
  LABEL_DUPLICATAS: "Duplicatas/Lista",

  // Label para marcar mensagens como "originais já verificados"
  // (evita reprocessar nas próximas execuções)
  LABEL_PROCESSADO: "Duplicatas/Verificado",

  // Quantos dias para trás a busca deve olhar (0 = sem limite de data)
  DIAS_BUSCA: 30,

  // Tamanho mínimo do corpo normalizado para considerar como duplicata
  // (evita falsos positivos em mensagens muito curtas)
  TAMANHO_MINIMO_CORPO: 80,

  // Se true, apenas loga no console sem mover nada (modo teste)
  MODO_TESTE: false,

  // Se true, gera um relatório por e-mail ao final
  ENVIAR_RELATORIO: false,
  EMAIL_RELATORIO: Session.getActiveUser().getEmail(),
};


// ─────────────────────────────────────────────────────────────
//  PONTO DE ENTRADA PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * Busca mensagens da lista, detecta duplicatas e as move.
 * Esta é a função principal — execute-a manualmente ou via gatilho.
 */
function moverDuplicatas() {
  Logger.log("=== Iniciando detecção de duplicatas ===");

  const labelDuplicatas = obterOuCriarLabel(CONFIG.LABEL_DUPLICATAS);
  const labelProcessado  = obterOuCriarLabel(CONFIG.LABEL_PROCESSADO);

  // 1. Buscar threads candidatas (da lista, ainda não verificadas)
  const threads = buscarThreadsDaLista();
  Logger.log(`Threads encontradas: ${threads.length}`);

  // 2. Extrair mensagens individuais com seus fingerprints
  const mensagens = extrairMensagens(threads);
  Logger.log(`Mensagens individuais para análise: ${mensagens.length}`);

  // 3. Agrupar por fingerprint e identificar duplicatas
  const grupos = agruparPorFingerprint(mensagens);

  // 4. Mover duplicatas
  const relatorio = processarDuplicatas(grupos, labelDuplicatas, labelProcessado);

  // 5. Marcar todas as mensagens analisadas como "verificado"
  marcarThreadsComoVerificadas(threads, labelProcessado);

  // 6. Relatório final
  Logger.log(`\n=== RESULTADO ===`);
  Logger.log(`Grupos com duplicatas: ${relatorio.grupos}`);
  Logger.log(`Mensagens movidas:     ${relatorio.movidas}`);
  Logger.log(`Mensagens mantidas:    ${relatorio.mantidas}`);

  if (CONFIG.ENVIAR_RELATORIO) {
    enviarRelatorio(relatorio);
  }
}


// ─────────────────────────────────────────────────────────────
//  1. BUSCA DE THREADS
// ─────────────────────────────────────────────────────────────

function buscarThreadsDaLista() {
  let query = `{to:${CONFIG.LISTA_EMAIL} from:${CONFIG.LISTA_EMAIL} cc:${CONFIG.LISTA_EMAIL}}`;
  query += ` -label:${CONFIG.LABEL_PROCESSADO.replace("/", "-")}`;

  if (CONFIG.DIAS_BUSCA > 0) {
    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - CONFIG.DIAS_BUSCA);
    const dataFormatada = Utilities.formatDate(dataLimite, "GMT-3", "yyyy/MM/dd");
    query += ` after:${dataFormatada}`;
  }

  Logger.log(`Query Gmail: ${query}`);

  const threads = [];
  let inicio = 0;
  const lote = 50;

  while (true) {
    const loteAtual = GmailApp.search(query, inicio, lote);
    if (loteAtual.length === 0) break;
    threads.push(...loteAtual);
    inicio += lote;
    if (loteAtual.length < lote) break;
  }

  return threads;
}


// ─────────────────────────────────────────────────────────────
//  2. EXTRAÇÃO DE MENSAGENS E FINGERPRINT
// ─────────────────────────────────────────────────────────────

function extrairMensagens(threads) {
  const mensagens = [];

  for (const thread of threads) {
    const msgs = thread.getMessages();

    for (const msg of msgs) {
      // Inclui qualquer mensagem da thread — algumas são reenviadas
      // diretamente sem os headers de lista, mas o conteúdo é o mesmo.
      const corpo = extrairCorpoRelevante(msg);
      if (!corpo || corpo.length < CONFIG.TAMANHO_MINIMO_CORPO) continue;

      const fingerprint = gerarFingerprint(corpo, msg.getSubject());

      mensagens.push({
        msg,
        thread,
        fingerprint,
        assunto:  msg.getSubject(),
        remetente: msg.getFrom(),
        data:     msg.getDate(),
        id:       msg.getId(),
      });
    }
  }

  return mensagens;
}

/**
 * Verifica se a mensagem pertence à lista analisando o raw content.
 * Isso detecta headers como "Precedence: list" e "Mailing-List:".
 */
function ehDaLista(msg) {
  try {
    const raw = msg.getRawContent();
    // Só analisa os primeiros 4KB (onde ficam os headers)
    const cabecalho = raw.substring(0, 4096);

    return CONFIG.HEADERS_LISTA.some(h =>
      cabecalho.toLowerCase().includes(h.toLowerCase())
    );
  } catch (e) {
    // Se não conseguir ler o raw, usa critério mais simples
    const corpo = msg.getBody();
    return CONFIG.HEADERS_LISTA.some(h =>
      corpo.toLowerCase().includes(h.toLowerCase())
    );
  }
}

/**
 * Extrai o corpo da mensagem a partir do marcador de forward,
 * pulando o mini-cabeçalho (De/From, Data/Date, Subject, To, Cc, Reply-To)
 * para que variações de lista, horário e destinatário não afetem o fingerprint.
 * Se não houver marcador de forward, usa o corpo completo.
 */
function extrairCorpoRelevante(msg) {
  let corpo = msg.getPlainBody() || msg.getBody();

  // Localiza o marcador de forward
  let posForward = -1;
  for (const marcador of CONFIG.MARCADORES_FORWARD) {
    const idx = corpo.indexOf(marcador);
    if (idx !== -1) {
      posForward = idx;
      break;
    }
  }

  if (posForward !== -1) {
    corpo = corpo.substring(posForward);

    // Pula o mini-cabeçalho do forward (De/From, Date/Data, Subject, To, Cc, etc.)
    // Essas linhas variam entre remetentes e não devem compor o hash.
    const linhas = corpo.split("\n");
    let inicioCorpo = 0;

    // Prefixos de cabeçalho em PT e EN, com ou sem asteriscos (markdown)
    const reHeader = /^\s*\*?(de|from|data|date|subject|assunto|to|para|cc|reply-to|bcc)\*?\s*:/i;
    const reSeparador = /^[-─=]{5,}/;

    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i].trim();
      if (linha === "" || reSeparador.test(linha) || reHeader.test(linha)) {
        inicioCorpo = i + 1;
      } else {
        break;
      }
    }

    corpo = linhas.slice(inicioCorpo).join("\n");
  }

  return normalizarTexto(corpo);
}

/**
 * Normaliza o texto para comparação:
 * - Converte para minúsculas
 * - Remove espaços/quebras extras
 * - Remove timestamps e variações de data
 * - Remove assinaturas comuns
 */
function normalizarTexto(texto) {
  return texto
    .toLowerCase()
    // Remove asteriscos de formatação markdown (*texto* → texto)
    .replace(/\*([^*]+)\*/g, "$1")
    // Remove tags de lista de e-mail: [lista.xxx], [ppgcc], [Divulgação] etc.
    .replace(/\[[^\]]{1,40}\]/g, "")
    // Remove datas numéricas: dd/mm/yyyy, mm/dd/yyyy, yyyy-mm-dd
    .replace(/\d{1,4}[-\/]\d{1,2}[-\/]\d{2,4}/g, "DATA")
    // Remove datas por extenso em PT e EN: "20 de mar. de 2026", "20 March 2026"
    .replace(/\d{1,2}\s+(de\s+)?[a-záéíóúâêîôûãõçàüñ.]{3,9}(\.?)\s+(de\s+)?\d{4}/gi, "DATA")
    // Remove horários
    .replace(/\d{1,2}:\d{2}(:\d{2})?(\s?(am|pm|GMT|UTC|BRT)[-+\d]*)?/gi, "HORA")
    // Remove URLs
    .replace(/https?:\/\/\S+/gi, "URL")
    // Remove e-mails individuais
    .replace(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi, "EMAIL")
    // Remove números longos (IDs, protocolos, editais como 02/2026)
    .replace(/\b\d{2,}\/\d{4}\b/g, "ID")
    .replace(/\b[a-z]*\d{4,}[a-z\d]*\b/gi, "ID")
    // Remove caracteres de citação (>) de e-mails encaminhados
    .replace(/^>+\s?/gm, "")
    // Colapsa espaços/tabs/newlines múltiplos
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Gera uma chave de agrupamento baseada no assunto normalizado.
 * Usa a string diretamente como chave (sem hash), evitando problemas
 * de codificação UTF-16 que corrompem o computeDigest.
 */
function gerarFingerprint(_, assunto) {
  return normalizarAssunto(assunto);
}



/**
 * Normaliza o assunto removendo:
 * - Prefixos de lista: [lista.docentes], [lista.ppgcc], etc.
 * - Prefixos de ação: Fwd:, Re:, Enc:, RES:, ENC: (e combinações)
 * - Tags de categoria: [Divulgação], [IMPORTANTE], etc.
 * - Números de edital/ano: 02/2026, nº 02, n. 02
 * - Espaços extras
 */
function normalizarAssunto(assunto) {
  if (!assunto) return "";
  return assunto
    // Remove bytes nulos (UTF-16LE tem \x00 entre cada char)
    .replace(/\x00/g, "")
    // Minúsculas
    .toLowerCase()
    // Remove prefixos de lista: [lista.xxx]
    .replace(/\[lista\.[^\]]+\]/gi, "")
    // Remove prefixos de ação: Fwd:, Re:, Enc:, RES:, ENC: (repetidos)
    .replace(/(\s*(fwd|fw|enc|res|rv|re)\s*:\s*)+/gi, " ")
    // Remove tags entre colchetes: [Divulgação], [URGENTE], [IMPORTANTE], etc.
    .replace(/\[[^\]]{1,40}\]/g, "")
    // Remove "nº", "n.", "n°", "nro" seguido de número
    .replace(/n[°ºro\.\s]*\s*\d+/gi, "")
    // Remove padrões de edital/ano: 02/2026
    .replace(/\d{1,4}\/\d{4}/g, "")
    // Remove anos isolados: 2026, 2025
    .replace(/\b(19|20)\d{2}\b/g, "")
    // Colapsa espaços
    .replace(/\s+/g, " ")
    .trim();
}


// ─────────────────────────────────────────────────────────────
//  3. AGRUPAMENTO POR CHAVE
// ─────────────────────────────────────────────────────────────

function agruparPorFingerprint(mensagens) {
  const mapa = {};

  for (const m of mensagens) {
    if (!mapa[m.fingerprint]) {
      mapa[m.fingerprint] = [];
    }
    mapa[m.fingerprint].push(m);
  }

  // Retorna apenas grupos com mais de uma mensagem (duplicatas reais)
  return Object.values(mapa).filter(g => g.length > 1);
}


// ─────────────────────────────────────────────────────────────
//  4. PROCESSAMENTO DAS DUPLICATAS
// ─────────────────────────────────────────────────────────────

function processarDuplicatas(grupos, labelDuplicatas, labelProcessado) {
  const relatorio = { grupos: grupos.length, movidas: 0, mantidas: 0, detalhes: [] };

  for (const grupo of grupos) {
    // Ordena por data: a mais antiga é considerada o "original"
    grupo.sort((a, b) => a.data - b.data);

    const original   = grupo[0];
    const duplicatas = grupo.slice(1);

    Logger.log(`\nGrupo de duplicatas (${grupo.length} msgs):`);
    Logger.log(`  ORIGINAL:  [${original.data.toLocaleString()}] ${original.remetente} — "${original.assunto}"`);

    relatorio.mantidas++;

    for (const dup of duplicatas) {
      Logger.log(`  DUPLICATA: [${dup.data.toLocaleString()}] ${dup.remetente} — "${dup.assunto}"`);

      if (!CONFIG.MODO_TESTE) {
        try {
          dup.thread.addLabel(labelDuplicatas);
          dup.thread.moveToArchive();
          dup.thread.addLabel(labelDuplicatas);
        } catch (e) {
          Logger.log(`  ERRO ao mover: ${e.message}`);
        }
      } else {
        Logger.log(`  [MODO TESTE] — não movido`);
      }

      relatorio.movidas++;
    }

    relatorio.detalhes.push({
      chave:      original.fingerprint,
      total:      grupo.length,
      assunto:    original.assunto,
      original:   original.remetente,
      duplicatas: duplicatas.map(d => d.remetente),
    });
  }

  return relatorio;
}


// ─────────────────────────────────────────────────────────────
//  5. MARCAR THREADS COMO VERIFICADAS
// ─────────────────────────────────────────────────────────────

function marcarThreadsComoVerificadas(threads, labelProcessado) {
  if (CONFIG.MODO_TESTE) return;

  const LOTE = 100;
  for (let i = 0; i < threads.length; i += LOTE) {
    const lote = threads.slice(i, i + LOTE);
    lote.forEach(t => {
      try { t.addLabel(labelProcessado); } catch (_) {}
    });
  }
}


// ─────────────────────────────────────────────────────────────
//  UTILITÁRIOS
// ─────────────────────────────────────────────────────────────

function obterOuCriarLabel(nome) {
  let label = GmailApp.getUserLabelByName(nome);
  if (!label) {
    label = GmailApp.createLabel(nome);
    Logger.log(`Label criado: "${nome}"`);
  }
  return label;
}

function enviarRelatorio(relatorio) {
  const linhas = relatorio.detalhes.map(d =>
    `• "${d.assunto}"\n  Original: ${d.original}\n  Duplicatas (${d.duplicatas.length}): ${d.duplicatas.join(", ")}`
  ).join("\n\n");

  const corpo = `Relatório — Duplicatas de Lista\n\n`
    + `Grupos encontrados : ${relatorio.grupos}\n`
    + `Mensagens movidas  : ${relatorio.movidas}\n`
    + `Mensagens mantidas : ${relatorio.mantidas}\n\n`
    + `DETALHES:\n${linhas || "(nenhuma duplicata encontrada)"}`;

  GmailApp.sendEmail(
    CONFIG.EMAIL_RELATORIO,
    `[Apps Script] Duplicatas de lista — ${new Date().toLocaleDateString("pt-BR")}`,
    corpo
  );
}


// ─────────────────────────────────────────────────────────────
//  DIAGNÓSTICO — execute para depurar quando não há matches
// ─────────────────────────────────────────────────────────────

/**
 * Imprime nos logs o assunto normalizado e o fingerprint de cada mensagem.
 * Execute esta função para confirmar que duplicatas recebem a mesma chave.
 */
function diagnosticar() {
  Logger.log("=== MODO DIAGNÓSTICO ===\n");

  const threads = buscarThreadsDaLista();
  Logger.log(`Threads encontradas: ${threads.length}\n`);

  let idx = 0;
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      idx++;
      const assuntoNorm = normalizarAssunto(msg.getSubject());
      const corpo       = extrairCorpoRelevante(msg);
      const fp          = gerarFingerprint(corpo, msg.getSubject());

      Logger.log(`──── MSG #${idx} ────────────────────────`);
      Logger.log(`De:         ${msg.getFrom()}`);
      Logger.log(`Assunto:    ${msg.getSubject()}`);
      Logger.log(`Data:       ${msg.getDate()}`);
      Logger.log(`É da lista: ${ehDaLista(msg)}`);
      Logger.log(`Assunto normalizado: "${assuntoNorm}"`);
      Logger.log(`Fingerprint/chave:   "${fp}"`);
      Logger.log(`Corpo norm. (300 chars):\n${corpo ? corpo.substring(0, 300) : "(vazio)"}`);
      Logger.log("─────────────────────────────────────────\n");
    }
  }

  Logger.log("=== FIM DO DIAGNÓSTICO ===");
}


// ─────────────────────────────────────────────────────────────
//  AGENDAMENTO AUTOMÁTICO (execute UMA VEZ)
// ─────────────────────────────────────────────────────────────

/**
 * Cria um gatilho diário para executar `moverDuplicatas` automaticamente.
 * Execute esta função APENAS UMA VEZ via menu do Apps Script.
 */

/**
 * Remove o label "Verificado" de todas as threads marcadas,
 * permitindo que sejam reprocessadas na próxima execução de moverDuplicatas.
 * Use sempre que quiser forçar uma nova varredura completa.
 */
function resetarVerificados() {
  const labelProcessado = GmailApp.getUserLabelByName(CONFIG.LABEL_PROCESSADO);
  if (!labelProcessado) {
    Logger.log("Label de verificados não encontrado — nada a resetar.");
    return;
  }

  let total = 0;
  let inicio = 0;
  const lote = 100;

  while (true) {
    const threads = labelProcessado.getThreads(inicio, lote);
    if (threads.length === 0) break;
    threads.forEach(t => {
      try { t.removeLabel(labelProcessado); total++; } catch (_) {}
    });
    inicio += lote;
    if (threads.length < lote) break;
  }

  Logger.log(`Label "Verificado" removido de ${total} thread(s). Pronto para reprocessar.`);
}

function configurarGatilho() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "moverDuplicatas")
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("moverDuplicatas")
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  Logger.log("Gatilho diário criado com sucesso.");
}

/**
 * Remove todos os gatilhos do projeto.
 */
function removerGatilhos() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log("Todos os gatilhos removidos.");
}
