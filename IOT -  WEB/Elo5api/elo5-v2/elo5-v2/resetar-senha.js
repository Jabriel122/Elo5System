// Redefine a senha de um usuário (não existe "esqueci a senha" por e-mail).
// Uso:  node resetar-senha.js email@exemplo.com NovaSenha123
// No Docker:  docker compose exec elo5 node resetar-senha.js email@exemplo.com NovaSenha123
const db = require('./db');

const [email, senha] = process.argv.slice(2);
if (!email || !senha || senha.length < 8) {
  console.error('Uso: node resetar-senha.js email@exemplo.com NovaSenha (mínimo 8 caracteres)');
  process.exit(1);
}
if (!db.trocarSenha(email, senha)) {
  console.error('Usuário não encontrado: ' + email);
  process.exit(1);
}
console.log('Senha alterada para ' + email);
