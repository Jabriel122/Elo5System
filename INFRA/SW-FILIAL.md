# Documentação de Infraestrutura — SW-FILIAL

## 1. Identificação e Hardware (`show version` / `show running-config`)
* **Hostname:** `SW-FILIAL`[cite: 9, 15]
* **Modelo:** Cisco Catalyst `WS-C2960S-24TD-L` (revisão `J0`, Version ID `V04`, Top Assembly `800-30933-04` rev `C0`)[cite: 10]
* **Sistema Operativo (IOS):** Cisco IOS Software `15.0(2)SE6` (`version 15.0`), imagem `C2960S-UNIVERSALK9-M`[cite: 9, 10, 15]
* **Arquivo em Flash / Bootloader:** `flash:/c2960s-universalk9-mz.150-2.SE6/c2960s-universalk9-mz.150-2.SE6.bin` | Bootloader `12.2(55r)SE` (`C2960S-HBOOT-M`)[cite: 9]
* **Interfaces e Memória:** 26 Gigabit Ethernet, 2 Ten Gigabit Ethernet, 1 FastEthernet, 4 Virtual Ethernet | 131072K bytes[cite: 10]
* **Números de Série:** Sistema `FOC1807Z0QD` | Placa-mãe `FOC180353H8` | Fonte `LIT17461LHN` | Daughterboard `FOC18061VJ1`[cite: 10]
* **MAC Base:** `2C:3E:CF:05:67:80`[cite: 10]
* **Config-Register / Password Recovery:** `0xF` / Ativo (`enabled`)[cite: 10]
* **Uptime e Última Alteração:** Uptime 1h 11m (power-on `01:27:22 UTC Wed Mar 30 2011`) | Última alteração `01:58:17 UTC` | NVRAM `01:29:24 UTC`[cite: 9, 15]
* **Acesso e Banner:** Consola `COM5` (PuTTY) | Banner ativo: `Welcome to Elo5System = CTI SW-FILIAL`[cite: 11]

## 2. Mapa de VLANs, SVIs e Sub-redes (`show vlan brief` / `show ip interface brief` / `show running-config`)
| VLAN ID | Nome | Status L2 | Endereço IP / Máscara | CIDR | Estado SVI (`Status/Protocol`) | Portas em `show vlan brief` | Observações |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `1` | `default`[cite: 16] | `active`[cite: 16] | `unassigned` (`shutdown`)[cite: 11, 16] | — | `administratively down / down`[cite: 16] | `Gi1/0/15`–`22`, `Gi1/0/24`, `Te1/0/1`–`2`[cite: 16] | VLAN padrão; `Gi1/0/24` configurada em `trunk`[cite: 12] |
| `5` | `Vlan_Colab`[cite: 16] | `active`[cite: 16] | `172.16.23.33` / `255.255.255.224`[cite: 11] | `/27`[cite: 11] | `up / down`[cite: 16] | `Gi1/0/1`–`Gi1/0/12`[cite: 16] | Sub-rede `172.16.23.x` (difere de `172.23.46.33/27` no `SW-MATRIZ`); protocolo `down` sem porta ativa[cite: 11, 16] |
| `8` | `Vlan_TI`[cite: 16] | `active`[cite: 16] | `172.16.23.65` / `255.255.255.224`[cite: 11] | `/27`[cite: 11] | `up / down`[cite: 16] | `Gi1/0/23`[cite: 16] | Sub-rede `172.16.23.x`; protocolo `down` sem porta ativa[cite: 11, 16] |
| `10` | `Vlan_IoT`[cite: 16] | `active`[cite: 16] | `172.16.23.97` / `255.255.255.252`[cite: 11] | `/30`[cite: 11] | `up / down`[cite: 16] | `Gi1/0/13`–`Gi1/0/14`[cite: 16] | Sub-rede `172.16.23.x`; protocolo `down` sem porta ativa[cite: 11, 16] |
| `1002`–`1005` | `fddi-default` / `token-ring-default` / `fddinet-default` / `trnet-default`[cite: 16] | `act/unsup`[cite: 16] | — | — | — | Nenhuma[cite: 16] | VLANs legadas padrão do IOS[cite: 16] |

## 3. Portas e Enlace Trunk
| Interface | Config / VLAN | Allowed VLANs / Observação Config | Estado (`Status/Protocol`) | Observações Técnicas |
| :--- | :--- | :--- | :--- | :--- |
| `Gi1/0/1`–`Gi1/0/2`[cite: 14] | `access` / VLAN `5` (`Vlan_Colab`)[cite: 14, 16] | Sem `shutdown` explícito[cite: 14] | `down / down`[cite: 16] | Sem enlace ativo na coleta[cite: 16] |
| `Gi1/0/3`–`Gi1/0/12`[cite: 13, 14] | `access` / VLAN `5` (`Vlan_Colab`)[cite: 13, 14, 16] | `shutdown`[cite: 13, 14] | `administratively down / down`[cite: 16] | Desativadas administrativamente[cite: 16] |
| `Gi1/0/13`–`Gi1/0/14`[cite: 13] | `access` / VLAN `10` (`Vlan_IoT`)[cite: 13, 16] | Sem `shutdown` explícito[cite: 13] | `down / down`[cite: 16] | Sem enlace ativo na coleta[cite: 16] |
| `Gi1/0/15`–`Gi1/0/22`[cite: 12, 13] | Padrão VLAN `1` (`default`) em `show vlan brief`[cite: 16] | `shutdown` (sem `access vlan` explícito na config)[cite: 12, 13] | `administratively down / down`[cite: 16] | Desativadas administrativamente[cite: 16] |
| `Fa0`[cite: 13] | `unassigned`[cite: 16] | `shutdown`[cite: 13] | `administratively down / down`[cite: 16] | Desativada administrativamente[cite: 16] |
| `Gi1/0/23`[cite: 12] | `access` / VLAN `8` (`Vlan_TI`)[cite: 12, 16] | `trunk allowed vlan 3,5,8,10,99` (residual)[cite: 12] | `down / down`[cite: 16] | Linha `trunk allowed` residual sob `switchport mode access`[cite: 12] |
| `Gi1/0/24`[cite: 12] | `trunk`[cite: 12] | `trunk allowed vlan 3,5,8,10,99`[cite: 12] | `down / down`[cite: 16] | Inclui VLAN `5` (diferente do trunk no `SW-MATRIZ`); confirmar com `show interfaces trunk`[cite: 12] |
| `Gi1/0/25`–`26`, `Te1/0/1`–`2`[cite: 12] | `Te1/0/1`–`2` na VLAN `1` em `show vlan brief`[cite: 16] | Sem linha customizada na config[cite: 12] | `down / down`[cite: 16] | Confirmar `Gi1/0/25`–`26` na saída completa de `show vlan brief` / `show interfaces status`[cite: 12, 16] |

## 4. Ocorrências e Pendências Reais
* **Nenhuma interface ou protocolo `up` na coleta:** Todas as SVIs (`Vlan5`, `Vlan8`, `Vlan10` em `up/down`; `Vlan1` em `admin down/down`) e interfaces físicas estão com protocolo `down`[cite: 16].
* **Divergência de sub-redes IP em relação ao `SW-MATRIZ`:** As SVIs `Vlan5` (`172.16.23.33/27`), `Vlan8` (`172.16.23.65/27`) e `Vlan10` (`172.16.23.97/30`) utilizam `172.16.23.x`, enquanto no `SW-MATRIZ` utilizam `172.23.46.x`[cite: 7, 11].
* **VLANs `3` e `99` ausentes no banco de VLANs:** Não aparecem em `show vlan brief`, embora `3,5,8,10,99` figurem em `trunk allowed` na `Gi1/0/24` e na linha residual da `Gi1/0/23`[cite: 12, 16].
* **Configuração não salva na NVRAM e segurança:** Última alteração (`01:58:17 UTC`) posterior à NVRAM (`01:29:24 UTC`); `no service password-encryption` ativo e `login` nas linhas VTY sem `transport input` explícito no trecho coletado[cite: 11, 15].
* **Pendências de coleta:** Saídas de `show interfaces trunk` e `show interfaces status` no `SW-FILIAL`, além de `show ip route` / default gateway se aplicável.
