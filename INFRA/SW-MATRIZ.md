# Documentação de Infraestrutura — SW-MATRIZ

## 1. Identificação e Hardware (`show version` / `show running-config`)
* **Hostname:** `SW-MATRIZ`[cite: 3, 4]
* **Modelo:** Cisco Catalyst `WS-C2960S-24TD-L` (revisão `J0`, Version ID `V04`)[cite: 4]
* **Sistema Operativo (IOS):** Cisco IOS Software `15.0(2)SE6` (`version 15.0`), imagem `C2960S-UNIVERSALK9-M`[cite: 3, 4]
* **Arquivo em Flash:** `flash:/c2960s-universalk9-mz.150-2.SE6/c2960s-universalk9-mz.150-2.SE6.bin`[cite: 4]
* **Interfaces:** 26 Gigabit Ethernet, 2 Ten Gigabit Ethernet, 1 FastEthernet, 6 Virtual Ethernet[cite: 4]
* **Número de Série do Sistema:** `FOC1806V0U8` (Placa-mãe: `FOC18061YL4` | Fonte: `DCA1749M8C6`)[cite: 5]
* **MAC Base:** `2C:3E:CF:5E:D1:00`[cite: 4, 5]
* **Config-Register / Password Recovery:** `0xF` / Ativo (`enabled`)[cite: 4, 5]
* **Spanning Tree:** `pvst` com `spanning-tree extend system-id`[cite: 4]
* **Uptime na coleta:** 40 minutos[cite: 4]
* **Acesso e Banner:** Consola `COM5` (PuTTY) | Banner ativo: `Welcome to Elo5System = CTI SW-MATRIZ`[cite: 1, 8]

## 2. Mapa de VLANs, SVIs e Sub-redes (`show vlan brief` / `show running-config`)
| VLAN ID | Nome | Status L2 | Endereço IP / Máscara | CIDR | Estado SVI | Portas em `show vlan brief` | Observações |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `1` | `default`[cite: 6] | `active`[cite: 6] | `no ip address` (`shutdown`)[cite: 7] | — | `admin down / down`[cite: 7] | `Gi1/0/24`[cite: 6] | VLAN padrão e *Native VLAN* no trunk da `Gi1/0/24` (confirmar saída de `show interfaces trunk`) |
| `3` | `Vlan_Srv`[cite: 6] | `active`[cite: 6] | `172.23.46.2` / `255.255.255.240`[cite: 7] | `/28`[cite: 7] | `up / down`[cite: 7] | `Gi1/0/1`–`3`, `Gi1/0/22`–`23`[cite: 5, 6, 7] | Permitida no trunk da `Gi1/0/24`[cite: 7] |
| `5` | `Vlan_Colab`[cite: 6] | `active`[cite: 6] | `172.23.46.33` / `255.255.255.224`[cite: 7] | `/27`[cite: 7] | `up / up`[cite: 7] | `Gi1/0/4`–`6`[cite: 5, 6] | Sustentada pela `Gi1/0/4` (`up/up`); **não consta** na lista permitida do trunk `Gi1/0/24`[cite: 7] |
| `8` | `Vlan_TI`[cite: 6] | `active`[cite: 6] | `172.23.46.65` / `255.255.255.224`[cite: 7] | `/27`[cite: 7] | `up / down`[cite: 7] | `Gi1/0/8`–`10`[cite: 5, 6] | Permitida no trunk da `Gi1/0/24`[cite: 7] |
| `10` | `Vlan_IoT`[cite: 6] | `active`[cite: 6] | `172.23.46.97` / `255.255.255.252`[cite: 7] | `/30`[cite: 7] | `up / down`[cite: 7] | `Gi1/0/11`[cite: 5, 6] | Permitida no trunk da `Gi1/0/24`[cite: 7] |
| `99` | `Default`[cite: 6] | `active`[cite: 6] | `no ip address`[cite: 7] | — | `up / down`[cite: 7] | `Gi1/0/7`, `Gi1/0/12`–`21`, `Te1/0/1`–`2`[cite: 5, 6, 7] | Permitida no trunk da `Gi1/0/24`[cite: 7] |
| `1002`–`1005` | `fddi-default` / `token-ring-default` / `fddinet-default` / `trnet-default`[cite: 6] | `act/unsup`[cite: 6] | — | — | — | Nenhuma[cite: 6] | VLANs legadas padrão do IOS[cite: 6] |

## 3. Interfaces em Destaque e Trunk
| Interface | Modo / VLAN | Encapsulamento / Allowed VLANs | Estado Atual | Tabela MAC / Contadores | Observações Técnicas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Gi1/0/4` | `access` / VLAN `5` (`Vlan_Colab`)[cite: 5, 6] | — | `up / up`[cite: 7] | Sem MACs aprendidos na coleta[cite: 8] | Sustenta a SVI `Vlan5` (`172.23.46.33/27`)[cite: 7]; host sem tráfego recente ou em repouso |
| `Gi1/0/22` | `access` / VLAN `3` (`Vlan_Srv`)[cite: 7] | `trunk allowed vlan 3,5,8,10` (residual)[cite: 7] | `down / down`[cite: 6, 7] | — | Linha `trunk allowed` residual sob `switchport mode access`[cite: 7] |
| `Gi1/0/24` | `trunk` (`on`)[cite: 7] | `802.1q` / Native `1` / Allowed `3,8,10,99`[cite: 7] | `down / down` (`notconnect`)[cite: 6, 7] | `0 input errors`, `0 CRC`, `0 output errors`; sem MACs após queda | Mídia `10/100/1000BaseTX`, `Auto-duplex/speed`; VLAN `5` ausente da lista permitida[cite: 7] |
| `Gi1/0/7`, `Gi1/0/12`–`21`, `Fa0` | `access` / VLAN `99` (e `Fa0`)[cite: 4, 5, 6] | — | `administratively down / down`[cite: 4, 5, 6] | — | Desativadas administrativamente (`shutdown`)[cite: 4, 5, 6] |

## 4. Ocorrências e Pendências Reais
* **Queda de link na `Gi1/0/24`:** Passou a `down/down` (`notconnect`) sem erros físicos/CRC (`14` pacotes de entrada e `311` de saída antes da queda).
* **VLAN `5` fora do trunk `Gi1/0/24`:** A VLAN `5` (`172.23.46.33/27`) está ativa e com SVI `up/up`, mas não consta na lista `3,8,10,99` permitida na `Gi1/0/24`[cite: 7].
* **Tabela MAC vazia na `Gi1/0/4`:** Interface e SVI `Vlan5` estão `up/up`, mas `show mac address-table interface GigabitEthernet1/0/4` não retornou MACs na coleta[cite: 7, 8].
* **Configuração residual e segurança:** `Gi1/0/22` tem `trunk allowed` residual em modo `access`[cite: 7]; `no service password-encryption` está ativo e não há alteração recente gravada na NVRAM[cite: 3].
* **Pendências de coleta:** Saídas de `show interfaces trunk` e `show ip interface brief` do `SW-MATRIZ`, tabela de rotas/gateway (`show ip route`), descrição das portas e registro de backup (`startup-config`).
