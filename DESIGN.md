# DESIGN.md

## Direção visual

Dashboard dark-first para operação técnica, com neutros profundos e acento dourado inspirado no logotipo oficial da @goldneuron.io. A identidade deve ser reconhecível sem prejudicar leitura, estados semânticos ou cores próprias dos canais Meta.

## Tokens principais

| Papel | Claro | Escuro |
|---|---|---|
| Fundo | `#F5F5F6` | `#07090F` |
| Superfície | `#FFFFFF` | `#11141D` |
| Texto | `#111217` | `#F2F0E9` |
| Muted | `#5F6470` | `#A2A7B2` |
| Acento gold | `#B77900` | `#F2B930` |
| Acento hover | `#8F5B00` | `#D99A04` |
| Acento soft | `#FFF6DF` | `#2B210E` |
| Foco | `rgba(183,121,0,.42)` | `rgba(242,185,48,.42)` |

- Botão gold em tema claro usa fundo escuro `#956000` com texto branco.
- Botão gold em tema escuro usa fundo `#9C6100` com texto branco.
- Verde permanece reservado para sucesso; vermelho para erro; azul para informação.
- WhatsApp, Messenger e Instagram preservam suas cores de produto.

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
- Em fundos claros, manter uma base escura discreta para preservar contraste das linhas douradas.
- Alt text: `@goldneuron.io`.

## Conteúdo e atribuição

- Aplicação: `Meta AppHub` e `by @goldneuron.io`.
- CTAs externos apontam para `https://goldneuron.io`.
- Não exibir ZDG/Z-PRO.
- Preservar copyright, LICENSE e proveniência upstream em documentação legal, sem promovê-los na UI.
