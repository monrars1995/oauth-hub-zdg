# PRODUCT.md

## Produto

**Meta AppHub** é o hub operacional da @goldneuron.io para configurar múltiplos aplicativos Meta, conectar canais oficiais de WhatsApp Business, Messenger e Instagram, receber webhooks assinados e encaminhá-los com segurança a sistemas autorizados.

## Registro

- Tipo: dashboard administrativo / ferramenta operacional.
- Usuários: equipe técnica e operadores autorizados da @goldneuron.io.
- Uso principal: configuração de apps Meta, onboarding de canais, observação de eventos, roteamento de webhooks e geração controlada de evidências para App Review.
- Ambientes: desenvolvimento local e produção HTTPS em instância single-node; evolução futura para banco transacional quando houver múltiplas réplicas.

## Princípios

1. Segurança fail-closed em autenticação, OAuth, webhooks e encaminhamentos.
2. Nenhum segredo ou token no navegador, logs, repositório ou respostas públicas.
3. Ações externas de escrita exigem confirmação explícita.
4. Interface funcional, densa e familiar, sem promoção de marcas upstream.
5. Atribuição upstream preservada apenas nos arquivos legais e de proveniência exigidos pela AGPL-3.0.

## Marca visível

- Nome: **Meta AppHub**.
- Crédito: **by @goldneuron.io**.
- Site: <https://goldneuron.io>.
- Logotipo: `public/assets/goldneuron_logo_mark.svg`, obtido da fonte oficial <https://neuros.codes/brand/goldneuron_logo_mark.svg>.
- Não exibir ZDG ou Z-PRO na aplicação.

## Fora de escopo desta mudança

- Conectar ou desconectar ativos reais da Meta.
- Executar chamadas de escrita do sandbox de evidências.
- Deploy em produção.
- Migrar a persistência para PostgreSQL nesta etapa.
