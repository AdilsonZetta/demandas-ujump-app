# Demandas UJUMP

PWA em português para acompanhar as demandas ativas de Eventos UJUMP no celular. O site é estático e lê a planilha pública ao abrir, ao tocar em Atualizar, ao puxar a lista e quando o app volta ao foco.

Grupo Zetta | Eventos UJUMP

Endereço publicado: https://adilsonzetta.github.io/demandas-ujump-app/

A lista é a aba Acompanhamento. Os números do topo vêm da aba Resumo. O CSV público não envia CORS; o app lê o endpoint gviz com `tqx=out:json;responseHandler:`, que responde JavaScript. O service worker busca a planilha na rede primeiro e só usa a última leitura quando não há conexão.
