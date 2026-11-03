## ADDED Requirements

### Requirement: O painel lê também o cluster da OCI, só leitura

Quando a configuração listar um cluster além do EKS em `clusters`, o servidor SHALL observar os
Deployments e os CronJobs dos namespaces dele com as mesmas regras do EKS (virada pela revisão,
estados por release, linha de base no boot). A credencial SHALL ser de uma ServiceAccount do OKE com
permissão só de `get`, `list` e `watch` em `apps/deployments` e `batch/cronjobs`, ligada só nos
namespaces observados, guardada num Secret do EKS fora do git. O painel SHALL NOT usar chave de API
da OCI.

#### Scenario: Virada do ia-rag
- **WHEN** a pipeline do `winker/ia-rag` faz `helm upgrade` no OKE com a imagem do commit `c13dc62…`
- **THEN** o painel mostra a virada da release no mesmo cartão do merge e da pipeline desse commit, com as réplicas na versão nova

#### Scenario: Configuração sem outros clusters
- **WHEN** a configuração não tem `clusters`
- **THEN** o painel funciona como antes, só com o EKS, e o rodapé não mostra outro cluster

### Requirement: Cluster sem credencial não muda o comportamento dos projetos dele

A credencial de cada cluster além do EKS SHALL vir de um diretório próprio, montado de um Secret
opcional, com o endereço da API, o token e a CA. Enquanto ela não estiver lá, a fonte do cluster SHALL
aparecer como não configurada, e os projetos com release nele SHALL seguir a regra de quem não tem
cluster: a pipeline verde é o fim do deploy. O endereço da API SHALL ser `https`; outro esquema conta
como credencial ausente, para o token nunca sair em texto aberto.

#### Scenario: Secret do OKE ainda não criado
- **WHEN** a configuração lista o cluster `oci` e o Secret dele não existe, e a pipeline do `ia-rag` fica verde
- **THEN** o rodapé mostra "Cluster OCI" não configurado, o cartão do `ia-rag` fecha como "No ar" sem o passo da virada e sem "Nenhuma virada vista", e o EKS segue como está

### Requirement: O cluster faz parte da identidade da release

Uma release de outro cluster SHALL ser escrita `<cluster>:<namespace>/<release>` na configuração e na
tag `deploy` dos monitores; sem prefixo, ela SHALL ser do EKS. Releases de mesmo namespace e nome em
clusters diferentes SHALL ser tratadas como releases diferentes, inclusive na memória das versões
vistas usada no boot. O cartão SHALL mostrar o cluster ao lado de uma release que não é do EKS.

#### Scenario: Mesmo nome nos dois clusters
- **WHEN** existe `ia/ia-rag` no EKS e `oci:ia/ia-rag` no OKE, e só o do OKE vira
- **THEN** só a release do OKE aparece virando, e o boot seguinte não toma uma pela outra

### Requirement: Cada cluster é uma fonte com estado próprio

O rodapé SHALL mostrar "Cluster OCI" (o rótulo do cluster na configuração, o nome em maiúsculas
quando não houver) separado do "Cluster EKS". Quando o OKE não responder, só as
releases dele SHALL aparecer como não confirmadas; o EKS SHALL continuar como está.

#### Scenario: OCI fora do ar
- **WHEN** a API do OKE para de responder durante uma virada do EKS
- **THEN** o rodapé marca "Cluster OCI" sem leitura, a virada do EKS continua confirmada, e as releases do OKE aparecem como não confirmadas

### Requirement: Como voltar, no cluster certo

O comando "Como voltar" de uma release do OKE SHALL trazer, junto das linhas, a indicação de que roda
no cluster da OCI, porque o painel não sabe o nome do contexto `kubectl` de quem copia.

#### Scenario: Voltar o ia-process-document
- **WHEN** alguém abre "Como voltar" num deploy do `ia-process-document`
- **THEN** o comando vem com a indicação de que é no cluster da OCI, além das linhas `set image` e `rollout status`

### Requirement: A conferência de cobertura inclui o OKE

A conferência de cobertura SHALL listar também o que roda no OKE e cruzar com a configuração e as
tags dos monitores, com as mesmas regras de lacuna e de exclusão com motivo.

#### Scenario: Release do OKE sem monitor
- **WHEN** uma release roda no OKE e nenhum monitor tem a tag `deploy` apontando para ela
- **THEN** o relatório a lista como lacuna
