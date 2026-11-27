# Aprovação no Apps Script

O app no celular só lê a planilha. Quem grava a aprovação é este script, ligado à planilha `1ShHyseBI4PANomqr2oaHipg-GZYTsfbM4gBuggFmeZ4`. Ele roda como você e só aceita a decisão se o PIN estiver certo.

Ao aprovar, o script marca a linha em **Solicitações** como `Aprovada` e cria o próximo item `P-xx` no topo de **Acompanhamento**, com situação `A fazer`. A data de conclusão fica em branco para você combinar depois. Recusar só atualiza a solicitação.

A ação `complete` conclui uma demanda `P-xx`. Em **Acompanhamento** ela grava `Situação` = `Concluído` e `Data de conclusão` = hoje (America/Sao_Paulo). Em **Realizadas** ela acrescenta uma linha com o mesmo ID, o título, o próximo passo, `Sistema` = `Eventos UJUMP`, a data de hoje, `Situação` = `Concluído` e a observação de quem concluiu. Não preenche nível nem créditos, para não alterar a soma da franquia.

O `health` continua devolvendo `ok` e `ready`, e também lista `actions`: `health`, `approve`, `reject`, `complete`.

Para publicar esta versão sem trocar o URL: **Implantar → Gerenciar implantações → Editar (lápis) → Versão: Nova versão → Implantar**.

## 1. Colar o código

1. Abra a planilha.
2. **Extensões → Apps Script**.
3. Apague o conteúdo de `Código.gs`.
4. Cole todo o arquivo `Code.gs` deste diretório.
5. Se quiser, crie o arquivo `appsscript.json` com o conteúdo do repositório. O fuso deve ficar `America/Sao_Paulo`.
6. Salve (Ctrl+S). O nome do projeto pode ser `Aprovação UJUMP`.

## 2. Criar o PIN

1. No editor, **Configurações do projeto** (engrenagem).
2. **Propriedades do script → Adicionar propriedade do script**.
3. Propriedade: `APPROVAL_PIN`
4. Valor: um PIN que só você conhece, por exemplo 6 dígitos.
5. Salve as propriedades.

Sem essa propriedade o app da web recusa toda aprovação.

## 3. Criar a aba Solicitações

1. No editor, escolha a função `setupSolicitacoes`.
2. Clique em **Executar**.
3. Autorize o acesso à planilha na primeira vez.
4. Volte à planilha. A aba **Solicitações** deve ter o cabeçalho, as datas em `dd/MM/aaaa` e a lista na coluna Status: `Aguardando aprovação`, `Aprovada`, `Recusada`.

Para lançar um pedido, preencha **Solicitante** e **Demanda**. O script completa o ID (`S-01`), a data do pedido e o status se estiverem vazios. A coluna **Item criado** recebe o `P-xx` quando alguém aprova no app.

## 4. Publicar o app da web

1. **Implantar → Nova implantação**.
2. Tipo: **App da Web**.
3. **Executar como:** Eu.
4. **Quem pode acessar:** Qualquer pessoa.
5. Implante e copie o URL que termina em `/exec`.

`Qualquer pessoa` deixa o celular chamar o script sem login do Google. O PIN é o que impede um estranho de aprovar.

## 5. Ligar o PWA

No arquivo `config.js` do site, cole o URL em `approvalWebAppUrl` e publique de novo. Enquanto o valor estiver vazio, a aba **Aguardando aprovação** mostra os pedidos com os botões desligados.

`setupSolicitacoes` também grava um pedido de teste, se a aba ainda não tiver linhas: **S-01**, solicitante **Fred**, demanda **Demanda de exemplo para teste**, status **Aguardando aprovação**. Rodar de novo não duplica esse pedido.

Se você mudar o código depois, use **Implantar → Gerenciar implantações → Editar → Nova versão**. O URL `/exec` continua o mesmo.
