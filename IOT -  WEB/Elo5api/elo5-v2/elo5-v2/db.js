// Banco de dados improvisado em arquivo JSON (data/db.json).
// Serve para o projeto de estudo; para produção troque por um banco de verdade.
// Todas as funções são síncronas e gravam o arquivo inteiro a cada mudança
// (escreve num arquivo temporário e renomeia, para não corromper se cair a luz no meio).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { users: [], config: {} };
let mtimeLido = 0;

function carregar() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(db.users)) db.users = [];
    if (!db.config || typeof db.config !== 'object') db.config = {};
    mtimeLido = fs.statSync(DB_FILE).mtimeMs;
  } catch (erro) {
    // Não apaga nem sobrescreve um arquivo que não conseguiu ler
    console.error('[DB] ' + DB_FILE + ' está corrompido: ' + erro.message);
    process.exit(1);
  }
}

// Se outro processo (ex.: resetar-senha.js) mudou o arquivo, lê de novo antes de usar
function sincronizar() {
  try {
    if (fs.statSync(DB_FILE).mtimeMs !== mtimeLido) carregar();
  } catch (_) { /* arquivo ainda não existe */ }
}

function salvar() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
  mtimeLido = fs.statSync(DB_FILE).mtimeMs;
}

if (fs.existsSync(DB_FILE)) carregar();

// Código que quem não é o primeiro usuário precisa informar para se cadastrar
// (como o cartão libera a entrada na sala, o cadastro não pode ser aberto a qualquer um).
// Vem da variável CODIGO_CADASTRO ou é gerado uma vez e guardado no db.json.
if (!process.env.CODIGO_CADASTRO && !db.config.codigoCadastro) {
  db.config.codigoCadastro = crypto.randomBytes(4).toString('hex').toUpperCase();
  salvar();
}

function codigoCadastro() {
  sincronizar();
  return process.env.CODIGO_CADASTRO || db.config.codigoCadastro;
}

// ---------- Senhas (scrypt, nativo do Node) ----------
function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, sal, 64);
  return 'scrypt$' + sal.toString('hex') + '$' + hash.toString('hex');
}

function conferirSenha(senha, guardada) {
  const partes = String(guardada || '').split('$');
  if (partes.length !== 3 || partes[0] !== 'scrypt') return false;
  const esperado = Buffer.from(partes[2], 'hex');
  const obtido = crypto.scryptSync(senha, Buffer.from(partes[1], 'hex'), esperado.length);
  return crypto.timingSafeEqual(esperado, obtido);
}

// Hash de uma senha qualquer, usado para gastar o mesmo tempo quando o e-mail não existe
const HASH_FALSO = hashSenha(crypto.randomBytes(8).toString('hex'));

// ---------- Usuários ----------
const normEmail = e => String(e || '').trim().toLowerCase();

function acharPorEmail(email) {
  sincronizar();
  const alvo = normEmail(email);
  return db.users.find(u => u.email === alvo) || null;
}

function acharPorId(id) {
  sincronizar();
  return db.users.find(u => u.id === id) || null;
}

function acharPorCartao(uid) {
  sincronizar();
  return uid ? db.users.find(u => u.cartaoUid === uid) || null : null;
}

function totalUsuarios() {
  sincronizar();
  return db.users.length;
}

// Dados que podem ir para o navegador (nunca a senha)
function publico(u) {
  return { id: u.id, nome: u.nome, email: u.email, matricula: u.matricula, cartaoUid: u.cartaoUid, admin: u.admin };
}

function criarUsuario({ nome, email, matricula, cartaoUid, senha }) {
  sincronizar();
  const usuario = {
    id: crypto.randomUUID(),
    nome,
    email: normEmail(email),
    matricula: matricula || null,
    cartaoUid: cartaoUid || null,
    senhaHash: hashSenha(senha),
    admin: db.users.length === 0,   // o primeiro cadastro é o administrador
    criadoEm: new Date().toISOString()
  };
  db.users.push(usuario);
  salvar();
  return usuario;
}

function trocarSenha(email, novaSenha) {
  sincronizar();
  const u = acharPorEmail(email);
  if (!u) return false;
  u.senhaHash = hashSenha(novaSenha);
  salvar();
  return true;
}

module.exports = {
  DB_FILE, codigoCadastro, hashSenha, conferirSenha, HASH_FALSO,
  acharPorEmail, acharPorId, acharPorCartao, totalUsuarios, criarUsuario, trocarSenha, publico
};
