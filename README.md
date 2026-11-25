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