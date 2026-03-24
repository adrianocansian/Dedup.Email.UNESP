# DetectaDuplicatasLista

Google Apps Script que detecta e arquiva automaticamente e-mails duplicados recebidos de listas de discussão no Gmail. Útil quando a mesma mensagem chega múltiplas vezes por ter sido encaminhada por remetentes diferentes ou redistribuída por sublistas.

---

## Problema que resolve

Listas de e-mail institucionais frequentemente geram duplicatas: a mensagem original chega diretamente, e minutos depois chega novamente encaminhada por colegas ou redistribuída por outras sublistas — cada cópia com remetente diferente, pequenas variações de texto antes do marcador de forward e assunto levemente modificado (com prefixos como `Fwd:`, `[lista.ppgcc]`, `[Divulgação]`, etc.). O script identifica essas cópias e move as redundantes para um label dedicado, mantendo apenas o original mais antigo na caixa de entrada.

---

## Pré-requisitos

- Conta Google com Gmail
- Acesso ao [Google Apps Script](https://script.google.com)
- Permissões de leitura e escrita no Gmail (concedidas na primeira execução)

---

## Instalação

1. Acesse [script.google.com](https://script.google.com) e crie um novo projeto.
2. Apague o conteúdo padrão do editor e cole o conteúdo de `DetectaDuplicatasLista.gs`.
3. Ajuste as constantes em `CONFIG` conforme a sua lista (veja seção abaixo).
4. Salve o projeto (`Ctrl+S`).
5. Execute a função `configurarGatilho` **uma única vez** para agendar a execução automática diária.
6. Autorize as permissões solicitadas pelo Google na janela que aparecer.

---

## Configuração

Todas as opções ficam no objeto `CONFIG` no topo do arquivo:

| Parâmetro | Padrão | Descrição |
|---|---|---|
| `LISTA_EMAIL` | `lista.docentes@unesp.br` | Endereço da lista monitorada. Usado na query de busca do Gmail. |
| `HEADERS_LISTA` | `["Precedence: list", "Mailing-List:", ...]` | Headers presentes no raw content que identificam mensagens da lista. Basta um deles estar presente. |
| `MARCADORES_FORWARD` | `["---------- Forwarded message", ...]` | Variações do separador de mensagem encaminhada em PT e EN. |
| `LABEL_DUPLICATAS` | `Duplicatas/Lista` | Label aplicado às mensagens identificadas como duplicatas. Criado automaticamente se não existir. |
| `LABEL_PROCESSADO` | `Duplicatas/Verificado` | Label interno aplicado a threads já analisadas para evitar reprocessamento. Criado automaticamente. |
| `DIAS_BUSCA` | `30` | Janela de tempo retroativa da busca em dias. Use `0` para sem limite. |
| `TAMANHO_MINIMO_CORPO` | `80` | Tamanho mínimo (em chars) do corpo normalizado para que uma mensagem seja considerada. Evita falsos positivos em mensagens muito curtas. |
| `MODO_TESTE` | `false` | Quando `true`, apenas loga o que seria feito sem mover nada. **Use sempre para validar antes da primeira execução real.** |
| `ENVIAR_RELATORIO` | `false` | Quando `true`, envia um resumo por e-mail ao final de cada execução. |
| `EMAIL_RELATORIO` | (usuário ativo) | Destinatário do relatório. Por padrão, o próprio usuário do script. |

---

## Como usar

### Teste antes de mover qualquer coisa

Com `MODO_TESTE: true`, selecione a função `moverDuplicatas` no dropdown e clique em **Executar**. Os logs mostrarão os grupos detectados e o que seria movido, sem alterar nada no Gmail.

### Execução real

Mude `MODO_TESTE: false` e execute `moverDuplicatas`. As duplicatas serão arquivadas e receberão o label `Duplicatas/Lista`.

### Agendamento automático

Execute a função `configurarGatilho` uma única vez. Isso cria um gatilho que roda `moverDuplicatas` todos os dias às 6h automaticamente.

---

## Funções disponíveis

| Função | Descrição |
|---|---|
| `moverDuplicatas()` | **Função principal.** Busca, detecta e move duplicatas. |
| `diagnosticar()` | Imprime nos logs o assunto normalizado e a chave de agrupamento de cada mensagem encontrada. Útil para verificar se a detecção está correta antes de executar. |
| `resetarVerificados()` | Remove o label `Duplicatas/Verificado` de todas as threads, forçando que sejam reprocessadas na próxima execução. Use após alterar configurações ou para varredura retroativa. |
| `configurarGatilho()` | Cria o gatilho diário de execução automática. Execute apenas uma vez. |
| `removerGatilhos()` | Remove todos os gatilhos do projeto. |

---

## Como funciona

### 1. Busca de threads

A query enviada ao Gmail combina `to:`, `from:` e `cc:` com o endereço da lista, excluindo threads já marcadas como `Duplicatas/Verificado` e respeitando a janela de `DIAS_BUSCA` dias.

### 2. Identificação de mensagens da lista

Para cada mensagem nas threads encontradas, o script inspeciona os primeiros 4 KB do raw content buscando pelos headers configurados em `HEADERS_LISTA` (`Precedence: list`, `Mailing-List:`, etc.). Mensagens encaminhadas diretamente (sem esses headers) são incluídas mesmo assim, pois a thread já foi pré-filtrada pela query.

### 3. Geração da chave de agrupamento

O assunto de cada mensagem passa por uma normalização que remove:

- Prefixos de lista: `[lista.docentes]`, `[lista.ppgcc]`, etc.
- Prefixos de ação: `Fwd:`, `Fw:`, `Re:`, `Enc:`, `RES:`, `ENC:` (e combinações)
- Tags entre colchetes: `[Divulgação]`, `[URGENTE]`, `[IMPORTANTE]`, etc.
- Numeração de edital: `nº 02`, `n. 02`, `02/2026`
- Anos: `2026`, `2025`
- Espaços extras e bytes nulos (UTF-16LE)

O resultado normalizado é usado diretamente como chave de agrupamento.

**Exemplo:**

| Assunto original | Chave gerada |
|---|---|
| `[lista.docentes] [Divulgação] Edital nº 02/2026 PROPe - Apoio à Publicação` | `edital / prope - apoio à publicação` |
| `[lista.ppgcc] Fwd: [lista.docentes] [Divulgação] Edital nº 02/2026 PROPe...` | `edital / prope - apoio à publicação` |
| `Fwd: [lista.tecadmin] [Divulgação] Edital nº 02/2026 PROPe...` | `edital / prope - apoio à publicação` |

### 4. Deduplicação

Mensagens com a mesma chave são agrupadas. Dentro de cada grupo, a mensagem **mais antiga** é mantida na inbox como original. As demais são arquivadas e marcadas com `Duplicatas/Lista`.

### 5. Controle de reprocessamento

Após a varredura, todas as threads analisadas recebem o label `Duplicatas/Verificado` para não serem reprocessadas nas execuções seguintes.

---

## Adaptando para outra lista

Para monitorar uma lista diferente, altere apenas `LISTA_EMAIL` e, se necessário, ajuste `HEADERS_LISTA` para refletir os headers específicos daquela lista. Todo o restante da lógica é genérico.

---

## Solução de problemas

**Nenhuma mensagem encontrada**
Verifique se `LISTA_EMAIL` corresponde ao endereço que aparece nos campos `To`, `From` ou `Cc` das mensagens. Execute `diagnosticar()` para inspecionar a query gerada.

**Duplicatas não detectadas**
Execute `diagnosticar()` e compare o campo `Fingerprint/chave` entre as mensagens suspeitas. Se as chaves diferirem, o assunto tem alguma variação não coberta pelas regras de normalização — ajuste `normalizarAssunto()` conforme necessário.

**Falsos positivos (mensagens diferentes agrupadas)**
Ocorre quando dois assuntos distintos produzem a mesma chave após a normalização. Reduza o escopo das remoções em `normalizarAssunto()` para preservar mais do texto original.

**Threads já verificadas não reaparecem**
Execute `resetarVerificados()` para limpar o label de controle e forçar uma nova varredura completa.

---

## Licença

Uso livre. Sem garantias.
