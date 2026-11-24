const express = require('express');
const mqtt = require('mqtt');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');


const app = express();
// Atrás do Apache/Nginx (ou do Docker) o IP e o HTTPS vêm nos cabeçalhos X-Forwarded-*.
// Só são aceitos de redes privadas/locais; para mudar, defina TRUST_PROXY.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '10kb' }));


// Cabeçalhos básicos de segurança
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});


// BROKER_URL só é usada para testes locais; normalmente vale o HiveMQ
const BROKER_URL = process.env.BROKER_URL || 'mqtt://broker.hivemq.com:1883';


// O projeto tem dois ESPs, cada um publicando no seu tópico:
//   ESP do RACK : porta, PIR, distância, temperatura e umidade
//   ESP do NFC  : cartao_uid (cartão aproximado) e botao_saida (botão de saída)
// Os tópicos precisam ser IGUAIS aos dos sketches (MQTT_TOPIC de cada um).
const TOPIC_SENSORS = 'elo5-system/sensores/dados';
const TOPIC_NFC     = 'elo5-system/nfc/eventos';


// =====================================================================
// MODO DO CARTÃO NFC
//   true  = segue o fluxo completo do Fluxo-Elo5Sys.drawio: os sensores só valem
//           enquanto houver alguém na sala (alguém que passou um cartão autorizado).
//   false = os sensores (PIR, porta, distância) valem sempre, mesmo sem o ESP
//           do NFC ligado (útil para testar só o ESP do rack).
// =====================================================================
const EXIGIR_CARTAO = true;

// Com mais de uma pessoa na sala, quem aperta o botão de saída precisa também
// passar o cartão (antes ou depois do botão) dentro deste tempo.
const JANELA_SAIDA_MS = 15000;


// 4 a 10 bytes em hexadecimal separados por ":" (o UID vem de fora, então é validado)
const UID_VALIDO = /^[0-9A-F]{2}(:[0-9A-F]{2}){3,9}$/;


// =====================================================================
// LOGIN / CADASTRO
// Usuários ficam em data/db.json (veja db.js). A sessão é um cookie HttpOnly
// com um código aleatório; as sessões ficam em memória (reiniciar o servidor
// desloga todo mundo).
// =====================================================================
const COOKIE = 'elo5_sid';
const SESSAO_MS = 8 * 3600e3;
const sessoes = new Map();   // token -> { userId, exp }


function lerCookie(req, nome) {
  const bruto = String(req.headers.cookie || '');
  for (const parte of bruto.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}


function usuarioLogado(req) {
  const token = lerCookie(req, COOKIE);
  const s = token ? sessoes.get(token) : null;
  if (!s) return null;
  if (s.exp < Date.now()) { sessoes.delete(token); return null; }
  return db.acharPorId(s.userId);
}


function abrirSessao(req, res, usuario) {
  const token = crypto.randomBytes(32).toString('hex');
  sessoes.set(token, { userId: usuario.id, exp: Date.now() + SESSAO_MS });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSAO_MS / 1000}` + (req.secure ? '; Secure' : ''));
}


function fecharSessao(req, res) {
  const token = lerCookie(req, COOKIE);
  if (token) sessoes.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}


// Limite de tentativas erradas (evita adivinhar senha ou código de cadastro)
const tentativas = new Map();   // chave -> { n, ate, visto }


function estaBloqueado(chave) {
  const t = tentativas.get(chave);
  return !!t && t.ate > Date.now();
}


function registrarFalha(chave, max) {
  const t = tentativas.get(chave) || { n: 0, ate: 0, visto: 0 };
  if (t.ate && t.ate <= Date.now()) { t.n = 0; t.ate = 0; }
  t.n++;
  t.visto = Date.now();
  if (t.n >= max) { t.ate = Date.now() + 60e3; t.n = 0; }
  tentativas.set(chave, t);
}


setInterval(() => {
  const agora = Date.now();
  for (const [k, s] of sessoes) if (s.exp < agora) sessoes.delete(k);
  for (const [k, t] of tentativas) if (t.ate < agora && agora - t.visto > 15 * 60e3) tentativas.delete(k);
}, 10 * 60e3).unref();


const exigeJson = (req, res) => {
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    res.status(415).json({ erro: 'Requisição inválida.' });
    return false;
  }
  return true;
};


const textoSimples = v => (typeof v === 'string' ? v.trim() : '');
const temControle = v => /[\u0000-\u001f\u007f]/.test(v);


// Aceita "01:02:03:04", "01020304" ou minúsculas e devolve "01:02:03:04"
function normalizarUid(valor) {
  let v = textoSimples(valor).toUpperCase().replace(/\s+/g, '');
  if (v === '') return '';
  if (!v.includes(':') && /^[0-9A-F]+$/.test(v) && v.length % 2 === 0) v = v.match(/../g).join(':');
  return UID_VALIDO.test(v) ? v : null;
}


function codigoConfere(informado) {
  const a = Buffer.from(String(informado).trim().toUpperCase());
  const b = Buffer.from(String(db.codigoCadastro()).toUpperCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}


// ---------- Rotas de autenticação (as únicas abertas, além das páginas de login) ----------
const PAGINAS_ABERTAS = new Set(['/login.html', '/cadastro.html', '/estilo.css', '/auth.css']);
const API_ABERTA = new Set(['/api/auth/estado', '/api/auth/login', '/api/auth/cadastro']);


app.get('/api/auth/estado', (req, res) => {
  // a tela de cadastro só pede o código quando já existe algum usuário
  res.json({ primeiroUsuario: db.totalUsuarios() === 0 });
});


app.post('/api/auth/login', (req, res) => {
  if (!exigeJson(req, res)) return;
  const email = textoSimples(req.body && req.body.email).toLowerCase();
  const senha = typeof (req.body && req.body.senha) === 'string' ? req.body.senha : '';
  const chaveEmail = 'login|' + req.ip + '|' + email;
  const chaveIp = 'login-ip|' + req.ip;


  if (estaBloqueado(chaveEmail) || estaBloqueado(chaveIp)) {
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
  }


  const usuario = db.acharPorEmail(email);
  // Confere a senha mesmo sem usuário, para a resposta demorar igual
  const ok = db.conferirSenha(senha.slice(0, 128), usuario ? usuario.senhaHash : db.HASH_FALSO) && !!usuario;
  if (!ok) {
    registrarFalha(chaveEmail, 5);
    registrarFalha(chaveIp, 20);
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }


  abrirSessao(req, res, usuario);
  res.json({ ok: true });
});


app.post('/api/auth/cadastro', (req, res) => {
  if (!exigeJson(req, res)) return;
  const b = req.body || {};
  const nome = textoSimples(b.nome);
  const email = textoSimples(b.email).toLowerCase();
  const matricula = textoSimples(b.matricula);
  const senha = typeof b.senha === 'string' ? b.senha : '';
  const cartaoUid = normalizarUid(b.cartao);
  const primeiro = db.totalUsuarios() === 0;
  const chaveCodigo = 'cadastro-ip|' + req.ip;


  if (estaBloqueado(chaveCodigo)) {
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
  }
  if (nome.length < 2 || nome.length > 60 || temControle(nome)) return res.status(400).json({ erro: 'Informe o nome (2 a 60 caracteres).' });
  if (email.length > 254 || !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
  if (matricula !== '' && !/^[0-9A-Za-z-]{1,20}$/.test(matricula)) return res.status(400).json({ erro: 'Matrícula inválida (use letras, números ou hífen).' });
  if (cartaoUid === null) return res.status(400).json({ erro: 'UID do cartão inválido. Exemplo: 01:02:03:04' });
  if (senha.length < 8 || senha.length > 128) return res.status(400).json({ erro: 'A senha precisa ter de 8 a 128 caracteres.' });


  if (!primeiro && !codigoConfere(b.codigo || '')) {
    registrarFalha(chaveCodigo, 5);
    return res.status(403).json({ erro: 'Código de cadastro incorreto.' });
  }
  if (db.acharPorEmail(email)) return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });
  if (cartaoUid && db.acharPorCartao(cartaoUid)) return res.status(409).json({ erro: 'Este cartão já está cadastrado para outra pessoa.' });


  const usuario = db.criarUsuario({ nome, email, matricula: matricula || null, cartaoUid: cartaoUid || null, senha });
  console.log('[AUTH] Usuário cadastrado:', usuario.email, usuario.admin ? '(administrador)' : '');
  abrirSessao(req, res, usuario);
  res.status(201).json({ ok: true });
});


// ---------- Tudo o que não for acima exige login ----------
app.use((req, res, next) => {
  const logado = usuarioLogado(req);


  if (req.path === '/login.html' && logado) return res.redirect('/');
  if (logado || PAGINAS_ABERTAS.has(req.path) || API_ABERTA.has(req.path)) {
    req.usuario = logado;
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Faça login.' });
  res.redirect('/login.html');
});


app.get('/api/auth/eu', (req, res) => {
  res.json(db.publico(req.usuario));
});


app.post('/api/auth/logout', (req, res) => {
  if (!exigeJson(req, res)) return;
  fecharSessao(req, res);
  res.json({ ok: true });
});


// Servir os arquivos do site da pasta public (já atrás do login)
app.use(express.static(path.join(__dirname, 'public')));


// =====================================================================
// FAIXAS DE CLIMA PARA SERVIDOR (ajuste aqui se precisar)
//   IDEAL   : dentro da faixa ideal
//   ATENÇÃO : fora da faixa ideal, mas ainda dentro do limite aceitável
//   CRÍTICO : fora do limite aceitável
// Temperatura: recomendada 18–27 °C e aceitável 15–32 °C (ASHRAE, classe A1).
// Umidade: faixa prática de 40–60 % UR, aceitável 20–80 % UR. (A ASHRAE
// define a umidade por ponto de orvalho, então esta é uma simplificação.)
// =====================================================================
const FAIXAS_CLIMA = {
  temp: { idealMin: 18, idealMax: 27, limiteMin: 15, limiteMax: 32 },  // °C
  umid: { idealMin: 40, idealMax: 60, limiteMin: 20, limiteMax: 80 }   // % UR
};


const RANK_NIVEL = { IDEAL: 0, ATENCAO: 1, CRITICO: 2 };


function classificarClima(temp, umid) {
  if (temp === null || umid === null) {
    return { nivel: 'SEM_LEITURA', motivos: ['SENSOR SEM LEITURA'] };
  }


  let nivel = 'IDEAL';
  const motivos = [];


  const avaliar = (valor, faixa, nome) => {
    let nivelItem = 'IDEAL';
    if (valor < faixa.limiteMin)      { nivelItem = 'CRITICO'; motivos.push(`${nome} MUITO BAIXA`); }
    else if (valor > faixa.limiteMax) { nivelItem = 'CRITICO'; motivos.push(`${nome} MUITO ALTA`); }
    else if (valor < faixa.idealMin)  { nivelItem = 'ATENCAO'; motivos.push(`${nome} BAIXA`); }
    else if (valor > faixa.idealMax)  { nivelItem = 'ATENCAO'; motivos.push(`${nome} ALTA`); }
    if (RANK_NIVEL[nivelItem] > RANK_NIVEL[nivel]) nivel = nivelItem;
  };


  avaliar(temp, FAIXAS_CLIMA.temp, 'TEMPERATURA');
  avaliar(umid, FAIXAS_CLIMA.umid, 'UMIDADE');


  return { nivel, motivos };
}


// Aceita só números plausíveis (o broker é público: qualquer um pode publicar)
function numeroEntre(valor, min, max) {
  return Number.isFinite(valor) && valor >= min && valor <= max ? valor : null;
}


// =====================================================================
// ÚLTIMAS LEITURAS DOS SENSORES
// Cada ESP manda só os seus campos (o do NFC não sabe se a porta está aberta, por
// exemplo), então cada mensagem atualiza apenas os campos que trouxe e o resto
// vale pela última leitura recebida do outro ESP.
// =====================================================================
const CAMPOS_SENSOR = ['porta_aberta', 'pir_movimento', 'distancia_cm', 'temperatura_c', 'umidade_pct'];
const ultimasLeituras = {
  porta_aberta: false,
  pir_movimento: false,
  distancia_cm: null,
  temperatura_c: null,
  umidade_pct: null
};


// =====================================================================
// CLIMA DA SALA (painel da página)
// A situação só muda depois de 3 leituras seguidas, para o ruído do sensor
// na borda de uma faixa (ex.: 27,0 / 27,1 / 26,9) não ficar piscando.
// =====================================================================
const LEITURAS_PARA_CONFIRMAR = 3;
const MAX_HISTORICO_CLIMA = 300;   // ~5 min a 1 leitura por segundo


let climaEstavel = { chave: null, nivel: null, motivos: [] };
let climaPendente = null;
let climaContagem = 0;
let climaAtual = { temperatura: null, umidade: null, nivel: null, motivos: [] };
let historicoClima = [];


function atualizarClima(s) {
  const temp = numeroEntre(s.temperatura_c, -40, 125);
  const umid = numeroEntre(s.umidade_pct, 0, 100);
  const clima = classificarClima(temp, umid);


  if (temp !== null && umid !== null) {
    historicoClima.push({ t: Date.now(), temp, umid });
    if (historicoClima.length > MAX_HISTORICO_CLIMA) historicoClima.shift();
  }


  const chave = clima.nivel + '|' + clima.motivos.join('+');
  if (chave === climaEstavel.chave) {
    climaPendente = null;
    climaContagem = 0;
  } else {
    if (chave === climaPendente) climaContagem++;
    else { climaPendente = chave; climaContagem = 1; }


    if (climaEstavel.chave === null || climaContagem >= LEITURAS_PARA_CONFIRMAR) {
      climaEstavel = { chave, nivel: clima.nivel, motivos: clima.motivos };
      climaPendente = null;
      climaContagem = 0;
    }
  }


  climaAtual = { temperatura: temp, umidade: umid, nivel: climaEstavel.nivel, motivos: climaEstavel.motivos };
}


// =====================================================================
// SALA E LOGS DO RACK - segue o fluxo do arquivo Fluxo-Elo5Sys.drawio
//
//  OCIOSO : ninguém na sala (só existe com EXIGIR_CARTAO = true)
//  ATIVO  : tem gente na sala; os sensores valem e o ID da pessoa que entrou por
//           último aparece em todos os logs.
//           PIR: sem movimento -> registra uma vez; com movimento -> vale a porta:
//             porta aberta  -> registra "aberta" + distância e REPETE até fechar
//             porta fechada -> registra "fechada" uma vez só
//  SAINDO : alguém apertou o botão de saída mas deixou a porta aberta; os logs se
//           repetem até a porta fechar
//
// Várias pessoas podem estar na sala ao mesmo tempo: cada cartão autorizado
// passado entra na lista; a saída é pelo botão (veja JANELA_SAIDA_MS).
// =====================================================================
const sala = {
  pessoas: new Map(),   // uid -> { uid, nome, matricula, entrada }
  ultimo: null,         // uid de quem entrou por último
  saindo: null,         // pessoa que saiu deixando a porta aberta
  pirEstado: null,      // 'SEM' | 'COM' (último estado já registrado)
  portaEstado: null,    // 'FECHADA' | 'ABERTA' (último estado já registrado)
  ociosoLogado: false,  // "Nenhum cartão passado" é registrado uma vez só
  pendente: null        // { tipo: 'botao' | 'cartao', uid, ts } esperando a outra metade da saída
};


function resetarSala() {
  sala.pessoas.clear();
  sala.ultimo = null;
  sala.saindo = null;
  sala.pirEstado = null;
  sala.portaEstado = null;
  sala.ociosoLogado = false;
  sala.pendente = null;
}


function fase() {
  if (sala.saindo) return 'SAINDO';
  if (sala.pessoas.size > 0 || !EXIGIR_CARTAO) return 'ATIVO';
  return 'OCIOSO';
}


function pendenteValido(tipo) {
  const p = sala.pendente;
  if (p && Date.now() - p.ts > JANELA_SAIDA_MS) sala.pendente = null;
  return sala.pendente && (!tipo || sala.pendente.tipo === tipo) ? sala.pendente : null;
}


// Dados de identificação que vão em cada log
function ctxPessoa(p, extras = 0) {
  if (!p.uid) return { cartaoUid: null, idNfc: '—', pessoa: null };
  return {
    cartaoUid: p.uid,
    idNfc: `${p.nome} (${p.uid})` + (extras > 0 ? ` +${extras}` : ''),
    pessoa: p.matricula ? `${p.matricula} - ${p.nome}` : p.nome
  };
}


function ctxAtual() {
  const quem = sala.saindo || (sala.ultimo && sala.pessoas.get(sala.ultimo));
  if (!quem) return { cartaoUid: null, idNfc: '—', pessoa: null };
  return ctxPessoa(quem, sala.saindo ? sala.pessoas.size : sala.pessoas.size - 1);
}


// Histórico em memória (os mais novos primeiro)
const MAX_LOGS = 1000;
let historicoLogs = [];
let seqLog = 0;


// Sem "ctx", o log usa quem está na sala agora
function registrarLog({ ctx, porta = '—', movimento = '—', aproximacao = '—', evento, classe }) {
  const c = ctx || ctxAtual();


  const novoLog = {
    id: ++seqLog,
    ts: Date.now(),
    cartaoUid: c.cartaoUid,
    idNfc: c.idNfc,
    pessoa: c.pessoa || null,
    porta,
    movimento,
    aproximacao,
    decisao: evento,
    statusClass: classe
  };


  historicoLogs.unshift(novoLog);
  if (historicoLogs.length > MAX_LOGS) historicoLogs.pop();


  console.log('[API] Log registrado:', novoLog);
}


// "Saiu e deixou a porta aberta?" - tira a pessoa da sala e registra a saída
function sairDaSala(quem, S) {
  registrarLog({ ctx: ctxPessoa(quem), porta: S.textoPorta, evento: 'ID NFC - SAINDO', classe: 'atencao' });
  sala.pessoas.delete(quem.uid);
  sala.pendente = null;
  if (sala.ultimo === quem.uid) sala.ultimo = [...sala.pessoas.keys()].pop() || null;


  if (S.portaAberta) {
    // "Saiu e deixou a porta aberta" -> os logs continuam repetindo
    sala.saindo = quem;
    registrarLog({ ctx: ctxPessoa(quem), porta: 'ABERTA', movimento: S.textoMov, aproximacao: S.textoDistancia, evento: 'SAIU E DEIXOU A PORTA ABERTA', classe: 'alerta' });
  } else {
    encerrarSaida();
  }
}


// Depois da saída (porta fechada): se ficou alguém, a sala continua; senão volta ao início
function encerrarSaida() {
  sala.saindo = null;
  if (sala.pessoas.size === 0) {
    resetarSala();
  } else {
    sala.pirEstado = null;
    sala.portaEstado = null;
  }
}


// Retorna true quando a mensagem já foi tratada por completo (não segue para os sensores)
function tratarCartao(uid, S) {
  const usuario = db.acharPorCartao(uid);


  if (!usuario) {
    // Sem permissão -> "Acesso negado" nos logs
    registrarLog({ ctx: { cartaoUid: uid, idNfc: uid, pessoa: null }, evento: 'ACESSO NEGADO', classe: 'alerta' });
    if (fase() === 'OCIOSO') { sala.ociosoLogado = true; return true; }
    return false;
  }


  const dentro = sala.pessoas.get(uid);
  if (dentro) {
    // Quem já está na sala passou o cartão de novo: é a identificação de quem vai sair
    if (pendenteValido('botao')) { sairDaSala(dentro, S); return true; }
    sala.pendente = { tipo: 'cartao', uid, ts: Date.now() };
    return false;
  }


  // Com permissão -> "Acesso permitido" + o ID do cartão em todos os logs seguintes
  const pessoa = { uid, nome: usuario.nome, matricula: usuario.matricula, entrada: Date.now() };
  sala.pessoas.set(uid, pessoa);
  sala.ultimo = uid;
  sala.pirEstado = null;
  sala.portaEstado = null;
  sala.ociosoLogado = false;
  registrarLog({ ctx: ctxPessoa(pessoa), evento: 'ACESSO PERMITIDO', classe: 'ok' });
  return false;   // segue para os sensores na mesma mensagem: "Ao entrar na sala ativará o sensor PIR"
}


// "Para sair da sala tem que apertar o botão"
function tratarBotao(S) {
  if (sala.pessoas.size === 0) {
    // botão sem ninguém registrado na sala (modo sem cartão)
    registrarLog({ porta: S.textoPorta, evento: 'ID NFC - SAINDO', classe: 'atencao' });
    if (S.portaAberta) {
      sala.saindo = { uid: null, nome: '—', matricula: null };
      registrarLog({ ctx: { cartaoUid: null, idNfc: '—', pessoa: null }, porta: 'ABERTA', movimento: S.textoMov, aproximacao: S.textoDistancia, evento: 'SAIU E DEIXOU A PORTA ABERTA', classe: 'alerta' });
    } else {
      resetarSala();
    }
    return true;
  }


  const cartao = pendenteValido('cartao');
  if (cartao && sala.pessoas.has(cartao.uid)) { sairDaSala(sala.pessoas.get(cartao.uid), S); return true; }


  if (sala.pessoas.size === 1) { sairDaSala([...sala.pessoas.values()][0], S); return true; }


  // Mais de uma pessoa: espera o cartão de quem está saindo
  sala.pendente = { tipo: 'botao', uid: null, ts: Date.now() };
  return true;
}


function processarRack(s, ev) {
  const portaAberta = s.porta_aberta === true;
  const movimento   = s.pir_movimento === true;
  const S = {
    portaAberta,
    textoPorta: portaAberta ? 'ABERTA' : 'FECHADA',
    textoMov: movimento ? 'MOVIMENTAÇÃO' : '—',
    textoDistancia: Number.isFinite(s.distancia_cm) ? `${s.distancia_cm} cm` : 'FORA DE ALCANCE'
  };
  pendenteValido();   // descarta uma saída pendente que passou do prazo


  // ---------- "Passou o cartão e é válido?" ----------
  if (ev.cartao && tratarCartao(ev.cartao, S)) return;


  // ---------- Botão de saída ----------
  if (ev.botaoSaida && fase() !== 'OCIOSO' && tratarBotao(S)) return;


  // ---------- OCIOSO: "Nenhum cartão passado" ----------
  if (fase() === 'OCIOSO') {
    if (!sala.ociosoLogado) {
      registrarLog({ evento: 'NENHUM CARTÃO PASSADO', classe: 'ok' });
      sala.ociosoLogado = true;
    }
    return;
  }


  // ---------- SAINDO: saiu e deixou a porta aberta ----------
  if (sala.saindo) {
    if (portaAberta) {
      registrarLog({ porta: 'ABERTA', movimento: S.textoMov, aproximacao: S.textoDistancia, evento: 'SAIU E DEIXOU A PORTA ABERTA', classe: 'alerta' });
    } else {
      registrarLog({ porta: 'FECHADA', movimento: S.textoMov, evento: 'PORTA FECHADA', classe: 'ok' });
      encerrarSaida();
    }
    return;
  }


  // ---------- ATIVO ----------
  // "Tem movimento?"
  if (!movimento) {
    // Não -> "Sem movimento", registra uma vez e não repete
    if (sala.pirEstado !== 'SEM') {
      registrarLog({ movimento: 'SEM MOVIMENTO', evento: 'SEM MOVIMENTO', classe: 'ok' });
      sala.pirEstado = 'SEM';
      sala.portaEstado = null;
    }
    return;
  }


  // Sim -> "Movimentação" (indica que tem alguém na sala)
  if (sala.pirEstado !== 'COM') {
    registrarLog({ movimento: 'MOVIMENTAÇÃO', evento: 'HÁ ALGUÉM NA SALA', classe: 'atencao' });
    sala.pirEstado = 'COM';
    sala.portaEstado = null;
  }


  // "A porta do rack está aberta?"
  if (portaAberta) {
    // Sim -> "Aberto" + distância em cm; "Dados repetirão até a porta fechar"
    sala.portaEstado = 'ABERTA';
    registrarLog({ porta: 'ABERTA', movimento: 'MOVIMENTAÇÃO', aproximacao: S.textoDistancia, evento: 'PORTA ABERTA', classe: 'atencao' });
  } else if (sala.portaEstado !== 'FECHADA') {
    // Não -> "Fechado" + "Sem aproximação (porta fechada)", registra uma vez e não repete
    sala.portaEstado = 'FECHADA';
    registrarLog({ porta: 'FECHADA', movimento: 'MOVIMENTAÇÃO', aproximacao: 'PORTA FECHADA', evento: 'PORTA FECHADA', classe: 'ok' });
  }
}


const mqttClient = mqtt.connect(BROKER_URL);


mqttClient.on('connect', () => {
  console.log('[API] Conectada ao Broker MQTT!');
  mqttClient.subscribe([TOPIC_SENSORS, TOPIC_NFC]);
});


mqttClient.on('error', (error) => {
  console.error('[MQTT] Erro:', error.message);
});


mqttClient.on('message', (topic, payload) => {
  try {
    const dados = JSON.parse(payload.toString());
    if (dados === null || typeof dados !== 'object') return;


    // Só os campos que a mensagem trouxe atualizam as últimas leituras
    for (const campo of CAMPOS_SENSOR) {
      if (campo in dados) ultimasLeituras[campo] = dados[campo];
    }


    // Eventos do ESP do NFC (valem só para esta mensagem, não são guardados)
    const cartao = typeof dados.cartao_uid === 'string' ? dados.cartao_uid.toUpperCase() : null;
    const ev = {
      cartao: cartao !== null && UID_VALIDO.test(cartao) ? cartao : null,
      botaoSaida: dados.botao_saida === true
    };


    if ('temperatura_c' in dados || 'umidade_pct' in dados) atualizarClima(ultimasLeituras);
    processarRack(ultimasLeituras, ev);
  } catch (error) {
    console.error('[API] Erro no JSON:', error.message);
  }
});


// ---------------------------------------------------------------------
// API
// ---------------------------------------------------------------------
const STATUS_VALIDOS = ['ok', 'atencao', 'alerta'];


function numeroDaQuery(valor) {
  return typeof valor === 'string' && valor.trim() !== '' && Number.isFinite(Number(valor)) ? Number(valor) : null;
}


function cartoesVistos() {
  const mapa = new Map();
  for (const log of historicoLogs) {
    if (log.cartaoUid && !mapa.has(log.cartaoUid)) {
      const u = db.acharPorCartao(log.cartaoUid);
      mapa.set(log.cartaoUid, {
        uid: log.cartaoUid,
        rotulo: u ? `${u.nome} (${log.cartaoUid})` : `${log.cartaoUid} (negado)`
      });
    }
  }
  return [...mapa.values()];
}


function resumoSala() {
  const pessoas = [...sala.pessoas.values()].map(p => ({ uid: p.uid, nome: p.nome, matricula: p.matricula, entrada: p.entrada }));
  return {
    fase: fase(),
    contagem: pessoas.length,
    pessoas,
    saidaPendente: !!pendenteValido('botao'),   // botão apertado, falta o cartão de quem sai
    saidaPendenteAte: pendenteValido('botao') ? sala.pendente.ts + JANELA_SAIDA_MS : null
  };
}


// Logs com filtros opcionais na URL:
//   de, ate      : intervalo (milissegundos desde 1970)
//   status       : ok, atencao, alerta (separados por vírgula)
//   cartao       : UID do cartão, ou "_nenhum" para logs sem cartão
//   portaAberta  : 1 = só logs com a porta aberta
//   limite       : máximo de linhas devolvidas (padrão 200, máximo 500)
app.get('/api/sensores/logs', (req, res) => {
  const q = req.query || {};


  const de = numeroDaQuery(q.de);
  const ate = numeroDaQuery(q.ate);
  const status = typeof q.status === 'string' ? q.status.split(',').filter(s => STATUS_VALIDOS.includes(s)) : [];
  const cartao = typeof q.cartao === 'string' ? q.cartao.toUpperCase() : '';
  const soPortaAberta = q.portaAberta === '1';
  const limite = Math.min(Math.max(parseInt(q.limite, 10) || 200, 1), 500);


  const filtrados = historicoLogs.filter(log =>
    (de === null || log.ts >= de) &&
    (ate === null || log.ts <= ate) &&
    (status.length === 0 || status.includes(log.statusClass)) &&
    (cartao === '' || (cartao === '_NENHUM' ? log.cartaoUid === null : log.cartaoUid === cartao)) &&
    (!soPortaAberta || log.porta === 'ABERTA')
  );


  res.json({
    logs: filtrados.slice(0, limite),
    total: filtrados.length,
    totalGeral: historicoLogs.length,
    cartoes: cartoesVistos(),
    sala: resumoSala(),
    clima: { ...climaAtual, faixas: FAIXAS_CLIMA, historico: historicoClima }
  });
});


// Último log registrado (usado na página da câmera)
app.get('/api/sensores/ultimo', (req, res) => {
  res.json({
    ultimoLog: historicoLogs[0] || null,
    sala: resumoSala()
  });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[API] ELO5 System rodando na porta ${PORT}`);
  if (db.totalUsuarios() === 0) {
    console.log('[AUTH] Nenhum usuário ainda: o primeiro cadastro (em /cadastro.html) vira administrador.');
  } else {
    console.log('[AUTH] Código para novos cadastros: ' + db.codigoCadastro());
  }
});
