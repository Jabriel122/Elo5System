1. Regra de Ouro da Estrutura (Onde rodar comandos)
Comandos do Git (status, pull, merge, push): sempre na raiz do repositório (...\Elo5System).

Comandos do Node (npm install, node server.js): sempre dentro da subpasta específica da aplicação (ex.: IOT -  WEB\Elo5api\elo5-v2\elo5-v2), nunca na raiz — a menos que você queira gerenciar um projeto global lá.

2. Ciclo Diário: Antes de Começar a Codar
Sempre execute essa sequência na raiz para garantir que seu branch pessoal (CRISTIANO) receba o código mais recente da equipe (devlop em minúsculo) sem erros de digitação:

PowerShell
# 1. Vai para o branch compartilhado (use a tecla TAB para autocompletar)
git checkout devlop

# 2. Puxa as novidades da equipe do GitHub
git pull

# 3. Volta para o seu branch de trabalho
git checkout CRISTIANO

# 4. Incorpora as novidades do devlop no seu branch
git merge devlop
(Se abrir o VS Code ou Vim pedindo mensagem de merge, apenas salve e feche o arquivo).

3. Ciclo de Desenvolvimento: Salvando seu Trabalho
Trabalhe exclusivamente no branch CRISTIANO. Quando terminar uma funcionalidade ou ajuste:

PowerShell
# 1. Confere onde você está e quais arquivos mudou (garante que node_modules não aparece)
git status

# 2. Prepara os arquivos alterados
git add .

# 3. Cria o ponto de salvamento com uma mensagem clara
git commit -m "feat: descrição objetiva do que foi feito"

# 4. Envia para a nuvem (seu backup no GitHub)
git push
4. Ciclo de Entrega: Mandando para a Equipe (devlop)
Quando sua parte estiver testada e pronta para ser integrada ao projeto principal:

Garanta que você deu git push no branch CRISTIANO.

Acesse o repositório no GitHub.

Abra um Pull Request (PR) configurando:

Base: devlop (destino)

Compare: CRISTIANO (origem)

5. Checklist Rápido de Prevenção
Escreveu o nome do branch? Digite as 3 primeiras letras (ex.: git checkout dev) e aperte TAB. O terminal completa com as maiúsculas/minúsculas exatas.

Vai instalar um pacote (npm install)? Digite pwd (ou olhe o caminho no prompt) para ter certeza de que está na pasta onde fica o package.json daquele módulo, e não na raiz Elo5System.

Ficou na dúvida do estado atual? Rode git status — ele sempre diz em qual branch você está e o que precisa fazer em seguida.




Preocupações:

1. Segredos, Senhas e Credenciais (Segurança)
O .gitignore barra arquivos .env, mas não impede alguém de escrever uma senha diretamente dentro de um .js ou .ino (hardcoded).

Risco no seu projeto: senhas de Wi-Fi no ESP32, credenciais/tokens do broker MQTT, chaves de API e segredos de autenticação (JWT/sessão) no elo5-v2.

O que fazer:

Crie um arquivo .env.example (commitado no Git) apenas com as chaves vazias (MQTT_BROKER=, MQTT_USER=, PORT=3000) para a equipe saber o que configurar.

No firmware do ESP32 (.ino), separe as credenciais em um arquivo secrets.h (já bloqueado pelo seu .gitignore) e deixe um secrets.example.h no repositório.

2. Reprodutibilidade do Ambiente (Versões e Dependências)
Pelo log do seu git merge, o repositório mistura firmware (Arduino/Wokwi), backend Node.js (Elo5Sys e elo5-v2) e Docker.

O que fazer:

Sempre commite o package-lock.json: ele garante que todos da equipe instalem exatamente a mesma versão das bibliotecas (express, mqtt, cors), evitando o clássico "na minha máquina funciona".

Padronize a versão do Node: adicione um arquivo .nvmrc (ex.: 22) ou o campo "engines": { "node": ">=20.0.0" } no package.json.

Mantenha o libraries.txt atualizado nas pastas do ESP32/Wokwi para que qualquer colega compile o firmware sem ficar caçando biblioteca.

3. Dados Locais e Banco em Arquivo (db.json)
No git merge apareceu o arquivo elo5-v2/data/db.json rastreado no Git.

Risco: se cada integrante testar cadastro/login localmente e commitar o db.json alterado, vocês terão conflitos de merge constantes e dados de teste sobrescrevendo os da equipe.

O que fazer: se o db.json for apenas banco local de desenvolvimento, adicione-o ao .gitignore após dar git rm --cached nele, mantendo apenas um db.example.json limpo como modelo inicial.

4. Higiene do Repositório (Pastas de Backup e Nomes com Espaços)
No log apareceram pastas como bk/index_bk2.html, server_BK3.js e caminhos com espaços duplos (IOT -  WEB/NFC - Meio Project/).

O que fazer:

Pare de criar arquivos _bk2, _bk3: o próprio Git já é o histórico de versões. Arquivos duplicados confundem a equipe sobre qual servidor (server.js vs serverbk4.js) realmente está em produção.

Evite espaços e acentos em pastas novas: prefira kebab-case (ex.: iot-web/elo5-api), pois espaços quebram scripts de terminal, Dockerfiles e pipelines CI/CD com facilidade.

5. Proteção de Branches e Fluxo de Merge
Proteja main e devlop no GitHub: configure Branch Protection Rules para exigir Pull Request antes de mesclar na devlop ou main, bloqueando git push --force acidental que apagaria o trabalho dos colegas.

Checklist antes de cada Pull Request:

Testou o código localmente após dar git merge devlop no seu branch?

Rodou git status para confirmar que não há arquivos temporários ou senhas?

Escreveu commits claros (feat:, fix:, docs:, chore:)?

6. Documentação Viva (README.md)
Como você acabou de iniciar o README.md, garanta que ele responda rápido a três perguntas para qualquer pessoa (ou avaliador) que abrir o repositório:

Arquitetura: como o ESP32, o broker MQTT, a API Node.js e o frontend se comunicam.

Como rodar: passo a passo tanto manual (npm install + node server.js) quanto automatizado (docker compose up).

Contratos de comunicação: quais tópicos MQTT (ex.: elo5/acesso, elo5/temperatura) e quais rotas HTTP (POST /login, GET /status) o sistema usa.