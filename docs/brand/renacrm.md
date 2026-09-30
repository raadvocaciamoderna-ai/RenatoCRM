# Identidade deste fork

Personalização autorizada pelo proprietário de `raadvocaciamoderna-ai/RenatoCRM`, em 30/09/2026. Não é proposta de alteração da identidade do projeto upstream.

A arte aprovada em conversa é adaptada à geometria nativa de `lib/branding/desenho.ts`, com símbolo R, nome RenaCrm em caminhos e a paleta sálvia/creme existente. Fontes SVG: `renacrm-logo.svg`, `renacrm-logo-dark.svg` e `renacrm-icon.svg`. Tipografia vetorizada: DejaVu Sans Bold.

Destino: núcleo deste fork, apenas apresentação. Não requer extensão, migração ou nova configuração. `resolveBranding` atualiza o padrão legado sem logo própria, inclusive quando persistido pelo instalador. Um nome diferente ou logo configurada segue tendo precedência.

Living System Checklist: entrada em `resolveBranding` e `desenho.ts`; consumidores `MarcaDoProduto`, Sidebar e `app/icon.tsx`; registro pelo commit; visível em `/login` e navegação de `/app`; configuração existente em `/admin/marca` e `/app/settings/marca`; sem automação, handoff ou anti-morte aplicável à arte estática; rollback pelo commit e retorno às configurações de marca existentes. Não há peça arquitetural nova.
