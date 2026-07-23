# DESIGN.md

## Direção visual

Dashboard dark-first para operação técnica, com superfícies foscas em preto marrom acinzentado e acento dourado inspirado no logotipo oficial da @goldneuron.io. A identidade deve ser reconhecível sem prejudicar leitura, estados semânticos ou cores próprias dos canais Meta.

A estratégia é restrita: neutros dominam a interface e o dourado aparece apenas em ações primárias, foco, seleção e informações que exigem atenção. Profundidade vem da luminosidade entre superfícies e de bordas completas, nunca de brilho.

## Tokens principais

| Papel | Claro | Escuro |
|---|---|---|
| Fundo | `#F3F4F7` | `oklch(13% .008 55)` |
| Superfície | `#FFFFFF` | `oklch(18% .010 55)` |
| Superfície secundária | `#F4F5F9` | `oklch(16% .009 55)` |
| Texto | `#0A0D15` | `oklch(93% .008 75)` |
| Muted | `#5B6473` | `oklch(67% .010 65)` |
| Acento gold | `#B77900` | `oklch(74% .145 78)` |
| Acento hover | `#8F5B00` | `oklch(63% .130 72)` |
| Acento soft | `#FFF6DF` | `oklch(24% .030 72)` |
| Foco | `rgba(183,121,0,.42)` | `oklch(74% .145 78 / .58)` |

- Botão gold em tema claro usa fundo escuro `#956000` com texto branco.
- Botão gold em tema escuro usa fundo `oklch(55% .120 70)` com texto branco.
- Verde permanece reservado para sucesso; vermelho para erro; azul para informação.
- WhatsApp, Messenger e Instagram preservam suas cores de produto.
- Não usar glows, halos pulsantes, blur decorativo, glassmorphism ou gradientes ornamentais.
- No tema escuro, elevação é indicada por superfícies progressivamente mais claras e bordas, sem sombras visíveis.

## Tipografia e componentes

- Família única: Inter com fallback de sistema.
- Escala compacta e fixa, adequada a dashboard.
- Mesma linguagem de botões, campos, badges e estados em todas as telas.
- Estados obrigatórios: hover, focus-visible, active, disabled, loading, error.
- Movimento de 150–250 ms e alternativa para `prefers-reduced-motion`.

## Uso do logotipo

- Arquivo local, sem carregamento remoto em runtime.
- Fundo transparente.
- Usar o símbolo completo em login, boas-vindas, sidebar e favicon.
- Nunca aplicar badge, moldura, sombra ou fundo preto atrás do símbolo.
- Em fundos claros, preservar espaço livre ao redor e aumentar o símbolo quando necessário, sem criar uma base de contraste.
- Alt text: `@goldneuron.io`.

## Tela inicial institucional

- Papel: apresentar o ecossistema Goldneuron.io, NeurOS e NeuroHub Meta antes do acesso autenticado.
- Composição aprovada: manifesto central minimalista, sem card flutuante e sem layout promocional em duas colunas.
- Masthead: lockup NeuroHub Meta / @goldneuron.io à esquerda e acesso ao painel sempre visível à direita.
- Manifesto: símbolo dourado, headline “Inteligência aplicada às conexões que movem sua operação.” e texto específico sobre WhatsApp Business, Messenger, Instagram, Goldneuron.io e NeurOS.
- CTAs institucionais permanecem em destaque; “Acessar o painel” é secundário, mas disponível sem rolagem em desktop.
- Rodapé da viewport identifica as integrações oficiais Meta em uma linha compacta.
- Desktop usa a largura disponível; mobile alinha o manifesto à esquerda, empilha CTAs e permite quebra dos canais.
- Não duplicar assinatura, não criar cards aninhados e não adicionar métricas, ilustrações genéricas ou efeitos luminosos.

### Decision log

- Prioridade institucional escolhida em vez de entrada operacional direta.
- Manifesto central escolhido em vez de composição editorial em duas colunas ou mapa do ecossistema.
- O fluxo `welcomeEnter` e a persistência de primeira visita permanecem inalterados.

## Conteúdo e atribuição

- Aplicação: `NeuroHub Meta` e `by @goldneuron.io`.
- Autenticação: copy direto; não exibir eyebrow de operação, badge de acesso restrito ou nota redundante sobre sessão/tokens.
- CTAs externos apontam para `https://goldneuron.io`.
- Não exibir ZDG/Z-PRO.
- Preservar copyright, LICENSE e proveniência upstream em documentação legal, sem promovê-los na UI.
